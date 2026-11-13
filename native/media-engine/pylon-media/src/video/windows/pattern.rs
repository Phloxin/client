// The test pattern producer on Windows (.plans/native-media-engine-m7-4-windows-encoder.md, N10):
// frames drawn on the CPU as BGRx and uploaded into a BGRA D3D11 texture on the shared device,
// the way a capture will hand one over.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use ::windows::Win32::Graphics::{
    Direct3D11::{D3D11_BIND_RENDER_TARGET, D3D11_BIND_SHADER_RESOURCE, D3D11_SUBRESOURCE_DATA, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT},
    Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
};

use super::{D3d11Frame, device::Device};
use crate::{
    Error,
    source::{SourceControl, check_fps, frame_time, wait_until},
    video::{
        FrameProducer, Produced,
        pattern::{PatternDrawing, PatternKind},
    },
};

/// The test pattern as D3D11 textures: a screen-like picture (or the stress one), a frame counter
/// and a clock, and a full change of the picture every 10 seconds. `still`: the first frame,
/// unchanged.
pub struct PatternProducer {
    width: u32,
    height: u32,
    fps: u32,
    still: bool,
    drawing: PatternDrawing,
    /// The picture, `height` lines of `width * 4` bytes.
    picture: Vec<u8>,
    device: Arc<Device>,
    start: Option<Instant>,
    frame: u64,
}

impl PatternProducer {
    pub(crate) fn new(device: Arc<Device>, width: u32, height: u32, fps: u32, still: bool, kind: PatternKind) -> Result<Self, Error> {
        check_fps(fps)?;
        if !(16..=4096).contains(&width) || !(16..=4096).contains(&height) || width % 2 != 0 || height % 2 != 0 {
            return Err(Error::invalid(format!("pattern size {width}x{height}: even, 16 to 4096")));
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
            picture: vec![0; width as usize * height as usize * 4],
            device,
            start: None,
            frame: 0,
        })
    }

    /// Uploads the picture into a new texture.
    fn upload(&self, capture_time: Instant) -> Result<D3d11Frame, Error> {
        let desc = D3D11_TEXTURE2D_DESC {
            Width: self.width,
            Height: self.height,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: (D3D11_BIND_RENDER_TARGET.0 | D3D11_BIND_SHADER_RESOURCE.0) as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let data = D3D11_SUBRESOURCE_DATA { pSysMem: self.picture.as_ptr().cast(), SysMemPitch: self.width * 4, SysMemSlicePitch: 0 };
        let mut texture = None;
        // SAFETY: the description and the picture live through the call, which copies the picture.
        unsafe { self.device.device.CreateTexture2D(&desc, Some(&data), Some(&mut texture)) }
            .map_err(|e| Error::Media(format!("pattern texture: {e}")))?;
        let texture = texture.ok_or_else(|| Error::Media("pattern texture: none made".into()))?;
        Ok(D3d11Frame { texture, width: self.width, height: self.height, capture_time, hold: None })
    }
}

impl FrameProducer for PatternProducer {
    type Frame = D3d11Frame;
    // On its own clock: it waits for its next frame whatever `until` says.
    fn next_frame(&mut self, control: &SourceControl, _until: Instant) -> Result<Produced<D3d11Frame>, Error> {
        let start = *self.start.get_or_insert_with(Instant::now);
        let at = frame_time(start, self.frame, self.fps);
        if !wait_until(at, control) {
            return Ok(Produced::End);
        }
        if !self.still || self.frame == 0 {
            self.drawing.draw(self.frame, &mut self.picture, self.width as usize * 4);
        }
        self.frame += 1;
        self.upload(at).map(Produced::Frame)
    }

    fn interval(&self) -> Duration {
        Duration::from_nanos(1_000_000_000 / self.fps as u64)
    }

    // A still pattern hands over its first picture again and again (M6 preview step 1, 5.2 item 1).
    fn repeats_last(&self) -> bool {
        self.still && self.frame > 1
    }
}
