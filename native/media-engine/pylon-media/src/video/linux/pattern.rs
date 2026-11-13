// The test pattern producer (D13): frames drawn on the CPU as BGRx, uploaded to a VA surface on
// a display of its own and exported as a DMA-BUF, the way a compositor hands one over.

use std::time::{Duration, Instant};

use ffmpeg_sys_next as ff;

use super::{DmaBufFrame, va};
use crate::{
    Error,
    source::{SourceControl, check_fps, frame_time, wait_until},
    video::{
        FrameProducer, Produced,
        ffi::{self, Buffer, Frame, check},
        pattern::{PatternDrawing, PatternKind},
    },
};

/// The test pattern as DMA-BUFs: a screen-like picture (or the stress one), a frame counter
/// and a clock, and a full change of the picture every 10 seconds. `still`: the first frame,
/// unchanged.
pub struct PatternProducer {
    width: u32,
    height: u32,
    fps: u32,
    still: bool,
    drawing: PatternDrawing,
    // The surfaces' display goes last, after the frames context and the picture.
    picture: Frame,
    surfaces: Buffer,
    _display: Buffer,
    start: Option<Instant>,
    frame: u64,
}

// SAFETY: the FFmpeg objects are only touched by the thread that owns the producer.
unsafe impl Send for PatternProducer {}

impl PatternProducer {
    pub fn new(width: u32, height: u32, fps: u32, still: bool, kind: PatternKind) -> Result<Self, Error> {
        check_fps(fps)?;
        if !(16..=4096).contains(&width) || !(16..=4096).contains(&height) || width % 2 != 0 || height % 2 != 0 {
            return Err(Error::invalid(format!("pattern size {width}x{height}: even, 16 to 4096")));
        }
        ffi::quiet_logs();
        let display = ffi::device(ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, va::RENDER_NODE)?;
        let surfaces = ffi::frames_context(
            &display,
            ff::AVPixelFormat::AV_PIX_FMT_VAAPI,
            ff::AVPixelFormat::AV_PIX_FMT_BGR0,
            width as i32,
            height as i32,
            4,
        )?;
        let picture = Frame::alloc()?;
        // SAFETY: a fresh frame gets its own buffer.
        unsafe {
            (*picture.0).format = ff::AVPixelFormat::AV_PIX_FMT_BGR0 as i32;
            (*picture.0).width = width as i32;
            (*picture.0).height = height as i32;
            check(ff::av_frame_get_buffer(picture.0, 0), "pattern picture")?;
        }
        let began = Instant::now();
        let drawing = PatternDrawing::new(width as usize, height as usize, fps, kind);
        tracing::info!(width, height, fps, still, ?kind, ms = began.elapsed().as_millis() as u64, "pattern producer");
        Ok(PatternProducer {
            width,
            height,
            fps,
            still,
            drawing,
            picture,
            surfaces,
            _display: display,
            start: None,
            frame: 0,
        })
    }

    /// Draws frame `n` into the picture.
    fn draw(&mut self, n: u64) -> Result<(), Error> {
        // SAFETY: the picture is ours and writable once nothing else references it.
        let (data, stride) = unsafe {
            check(ff::av_frame_make_writable(self.picture.0), "pattern picture")?;
            ((*self.picture.0).data[0], (*self.picture.0).linesize[0] as usize)
        };
        // SAFETY: the plane holds `height` lines of `stride` bytes.
        let picture = unsafe { std::slice::from_raw_parts_mut(data, stride * self.height as usize) };
        self.drawing.draw(n, picture, stride);
        Ok(())
    }

    /// Uploads the picture and exports the surface as a DMA-BUF.
    fn export(&self, capture_time: Instant) -> Result<DmaBufFrame, Error> {
        // SAFETY: frames are owned by guards, the descriptor belongs to the mapped frame.
        unsafe {
            let surface = Frame::alloc()?;
            check(ff::av_hwframe_get_buffer(self.surfaces.0, surface.0, 0), "pattern surface")?;
            check(ff::av_hwframe_transfer_data(surface.0, self.picture.0, 0), "pattern upload")?;
            va::export_surface(&surface, self.width, self.height, capture_time)
        }
    }
}

impl FrameProducer for PatternProducer {
    type Frame = DmaBufFrame;
    // On its own clock: it waits for its next frame whatever `until` says.
    fn next_frame(&mut self, control: &SourceControl, _until: Instant) -> Result<Produced<DmaBufFrame>, Error> {
        let start = *self.start.get_or_insert_with(Instant::now);
        let at = frame_time(start, self.frame, self.fps);
        if !wait_until(at, control) {
            return Ok(Produced::End);
        }
        if !self.still || self.frame == 0 {
            self.draw(self.frame)?;
        }
        self.frame += 1;
        self.export(at).map(Produced::Frame)
    }

    fn interval(&self) -> Duration {
        Duration::from_nanos(1_000_000_000 / self.fps as u64)
    }

    // A still pattern hands over its first picture again and again.
    fn repeats_last(&self) -> bool {
        self.still && self.frame > 1
    }
}
