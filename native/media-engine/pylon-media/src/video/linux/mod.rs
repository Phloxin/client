// The video pipeline's Linux half (.plans/native-media-engine-m7-2-seams.md, S3): raw frames
// as DMA-BUFs, libavcodec's VA-API encoder, the pattern producer's upload, and screen capture
// through the desktop portal and PipeWire.

#[cfg(feature = "capture")]
pub mod capture;
mod encoder;
mod pattern;
mod preview;
mod va;

use std::{os::fd::OwnedFd, time::Instant};

use super::{EncoderConfig, PatternKind, RawFrame, VideoPipeline};
use crate::{Error, VideoCodec, source::Source};

pub use encoder::VaapiEncoder;
pub use pattern::PatternProducer;

/// One memory object of a DMA-BUF frame.
#[derive(Debug)]
pub struct DmaBufObject {
    pub fd: OwnedFd,
    pub size: usize,
    pub modifier: u64,
}

/// One plane of a DMA-BUF frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct DmaBufPlane {
    pub object: usize,
    pub offset: usize,
    pub pitch: usize,
}

/// A raw frame on the GPU, as a capture would hand it over.
#[derive(Debug)]
pub struct DmaBufFrame {
    pub width: u32,
    pub height: u32,
    /// DRM fourcc, `XR24` for BGRx.
    pub fourcc: u32,
    pub objects: Vec<DmaBufObject>,
    pub planes: Vec<DmaBufPlane>,
    pub capture_time: Instant,
}

impl RawFrame for DmaBufFrame {
    fn capture_time(&self) -> Instant {
        self.capture_time
    }
}

/// The pattern source of the protocol: a test pattern through the hardware encoder of `codec`.
pub fn pattern_source(
    width: u32,
    height: u32,
    fps: u32,
    still: bool,
    kind: PatternKind,
    max_bitrate: u64,
    codec: VideoCodec,
) -> Result<Box<dyn Source>, Error> {
    let producer = PatternProducer::new(width, height, fps, still, kind)?;
    let encoder = VaapiEncoder::with_codec(
        EncoderConfig {
            width,
            height,
            fps,
            start_bitrate: max_bitrate,
            filler: false,
        },
        codec,
    )?;
    Ok(Box::new(VideoPipeline::new(producer, encoder)))
}

/// Whether this build on this machine encodes AV1 (Q2): FFmpeg has `av1_vaapi` and the driver
/// an AV1 Profile 0 encode config, asked of VA-API as for H264. No encoder is opened. Asked once
/// per process.
pub fn av1_encode_available() -> bool {
    static AVAILABLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *AVAILABLE.get_or_init(|| {
        use ffmpeg_sys_next as ff;
        super::ffi::quiet_logs();
        // SAFETY: a lookup by name.
        if unsafe { ff::avcodec_find_encoder_by_name(c"av1_vaapi".as_ptr()) }.is_null() {
            return false;
        }
        let available = super::ffi::device(ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, va::RENDER_NODE)
            .and_then(|display| va::encode_limits(&display, VideoCodec::Av1))
            .is_ok();
        tracing::info!(available, "AV1 encode");
        available
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EncodedFrame, SourceControl,
        source::frame_channel,
        video::{FrameProducer, Produced},
    };
    use std::{collections::VecDeque, time::Duration};

    /// Pattern frames from the producer each entry names, then nothing new.
    struct Patterns {
        producers: Vec<PatternProducer>,
        script: VecDeque<usize>,
    }
    impl FrameProducer for Patterns {
        type Frame = DmaBufFrame;
        fn next_frame(&mut self, control: &SourceControl, until: Instant) -> Result<Produced<DmaBufFrame>, Error> {
            match self.script.pop_front() {
                Some(which) => self.producers[which].next_frame(control, until),
                None => {
                    std::thread::sleep(until.saturating_duration_since(Instant::now()));
                    Ok(Produced::Idle)
                }
            }
        }

        fn interval(&self) -> Duration {
            Duration::from_nanos(1_000_000_000 / 60)
        }
    }

    /// On the GPU: run with `--ignored`. A window resized and then left still, through the real
    /// encoder. With PYLON_TEST_H264 set, the stream is written there.
    #[test]
    #[ignore]
    fn gpu_a_resize_then_stillness_takes_up_the_new_size() {
        let sizes = [(1280, 720), (1000, 600)];
        let producers = sizes.iter().map(|&(w, h)| PatternProducer::new(w, h, 60, false, PatternKind::Screen).unwrap()).collect();
        // Ten frames at the first size, five at the second, then still.
        let script = std::iter::repeat_n(0, 10).chain(std::iter::repeat_n(1, 5)).collect();
        let encoder = VaapiEncoder::new(EncoderConfig { width: 1920, height: 1080, fps: 60, start_bitrate: 4_000_000, filler: false }).unwrap();
        let mut pipeline = VideoPipeline::new(Patterns { producers, script }, encoder);
        let control = SourceControl::default();
        control.set_target_bitrate(4_000_000);
        let (sink, frames, _) = frame_channel(64);
        let began = Instant::now();
        while began.elapsed() < Duration::from_millis(1600) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        let frames: Vec<EncodedFrame> = frames.try_iter().collect();
        let keys = frames.iter().filter(|f| f.key).count();
        let at: Vec<usize> = frames.iter().enumerate().filter(|(_, f)| f.key).map(|(n, _)| n).collect();
        eprintln!("{} frames, key frames at {at:?}, encoder at {:?}", frames.len(), pipeline.encoder.running_size());
        // The fifteen frames, and the last one again at its own size.
        assert_eq!(frames.len(), 16);
        assert_eq!(keys, 2);
        assert!(frames.last().unwrap().key);
        assert_eq!(pipeline.encoder.running_size(), Some((1000, 600)));
        if let Ok(path) = std::env::var("PYLON_TEST_H264") {
            let stream: Vec<u8> = frames.iter().flat_map(|f| f.data.iter().copied()).collect();
            std::fs::write(path, stream).unwrap();
        }
    }

    /// On the GPU: run with `--ignored`. One in two frames kept, the second skipped and then
    /// nothing new, through the real encoder.
    #[test]
    #[ignore]
    fn gpu_a_skipped_frame_then_stillness_is_encoded() {
        let producers = vec![PatternProducer::new(1280, 720, 60, false, PatternKind::Screen).unwrap()];
        let encoder = VaapiEncoder::new(EncoderConfig { width: 1920, height: 1080, fps: 60, start_bitrate: 4_000_000, filler: false }).unwrap();
        let mut pipeline = VideoPipeline::new(Patterns { producers, script: VecDeque::from(vec![0, 0]) }, encoder);
        pipeline.cadence.index = 1;
        let control = SourceControl::default();
        control.set_target_bitrate(4_000_000);
        let (sink, frames, _) = frame_channel(64);
        let began = Instant::now();
        while began.elapsed() < Duration::from_millis(300) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        let frames: Vec<EncodedFrame> = frames.try_iter().collect();
        eprintln!("{} frames, skipped {}", frames.len(), control.take_report().frames_skipped_rate);
        assert_eq!(frames.len(), 2);
        assert!(frames[0].key && !frames[1].key && !frames[1].data.is_empty());
    }
}
