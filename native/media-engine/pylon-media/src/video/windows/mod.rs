// The video pipeline's Windows half (.plans/native-media-engine-m7-4-windows-encoder.md): raw
// frames as BGRA D3D11 textures on one device, our own D3D11 video processor, libavcodec's Quick
// Sync or NVENC encoder, the pattern producer's upload, and with the `capture` feature Windows
// Graphics Capture (`capture/`, .plans/native-media-engine-m7-5-windows-capture.md).

#[cfg(feature = "capture")]
pub mod capture;
mod convert;
mod device;
mod encoder;
mod pattern;
mod preview;

use std::time::Instant;

use ::windows::Win32::Graphics::Direct3D11::ID3D11Texture2D;

use super::{EncoderConfig, PatternKind, RawFrame, VideoPipeline};
use crate::{Error, source::Source};

pub use encoder::D3d11Encoder;
pub use pattern::PatternProducer;

/// A raw frame on the GPU: a BGRA texture on the pipeline's D3D11 device (N3). The picture is
/// the top left `width` by `height` of the texture, which may be larger (a captured window that
/// shrank, M7.5 C6).
#[derive(Debug)]
pub struct D3d11Frame {
    pub texture: ID3D11Texture2D,
    pub width: u32,
    pub height: u32,
    pub capture_time: Instant,
    /// What must live as long as the frame: the capture's own frame object, whose buffer goes back
    /// to the capture when this frame is dropped (M7.5 C5). `None` for the pattern. Held, never
    /// read.
    #[allow(dead_code)]
    pub(crate) hold: Option<Hold>,
}

/// Something a frame keeps alive until it is dropped.
#[cfg_attr(not(feature = "capture"), allow(dead_code))]
pub(crate) struct Hold(#[allow(dead_code)] pub(crate) Box<dyn Send + Sync>);

impl std::fmt::Debug for Hold {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Hold")
    }
}

impl RawFrame for D3d11Frame {
    fn capture_time(&self) -> Instant {
        self.capture_time
    }
}

/// The pattern source of the protocol: a test pattern through the hardware encoder. H264 only:
/// there is no AV1 encoder on Windows (AV1 step 2, Q2).
pub fn pattern_source(
    width: u32,
    height: u32,
    fps: u32,
    still: bool,
    kind: PatternKind,
    max_bitrate: u64,
    codec: crate::VideoCodec,
) -> Result<Box<dyn Source>, Error> {
    refuse_other_than_h264(codec)?;
    let device = device::Device::open()?;
    let producer = PatternProducer::new(device.clone(), width, height, fps, still, kind)?;
    let encoder = D3d11Encoder::new(
        EncoderConfig {
            width,
            height,
            fps,
            start_bitrate: max_bitrate,
            filler: false,
        },
        device,
        (width, height),
    )?;
    Ok(Box::new(VideoPipeline::new(producer, encoder)))
}

/// The encoders here are H264's (AV1 step 2, Q2).
pub(crate) fn refuse_other_than_h264(codec: crate::VideoCodec) -> Result<(), Error> {
    match codec {
        crate::VideoCodec::H264 => Ok(()),
        other => Err(Error::invalid(format!("{} is not supported on Windows, only H264", other.name()))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        EncodedFrame, SourceControl,
        source::frame_channel,
        video::{FrameProducer, Produced},
    };
    use std::{collections::VecDeque, sync::Arc, time::Duration};

    /// The pipeline's device, and an encoder on it that may run at up to `width` by `height`.
    fn encoder(width: u32, height: u32, start_bitrate: u64) -> (Arc<device::Device>, D3d11Encoder) {
        let device = device::Device::open().unwrap();
        let config = EncoderConfig { width, height, fps: 60, start_bitrate, filler: false };
        let encoder = D3d11Encoder::new(config, device.clone(), (width, height)).unwrap();
        (device, encoder)
    }

    /// Pattern frames from the producer each entry names, then nothing new.
    struct Patterns {
        producers: Vec<PatternProducer>,
        script: VecDeque<usize>,
    }
    impl FrameProducer for Patterns {
        type Frame = D3d11Frame;
        fn next_frame(&mut self, control: &SourceControl, until: Instant) -> Result<Produced<D3d11Frame>, Error> {
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

    fn write_stream(frames: &[EncodedFrame]) {
        if let Ok(path) = std::env::var("PYLON_TEST_H264") {
            let stream: Vec<u8> = frames.iter().flat_map(|f| f.data.iter().copied()).collect();
            std::fs::write(path, stream).unwrap();
        }
    }

    /// On the GPU: run with `--ignored`. A window resized and then left still, through the real
    /// encoder. With PYLON_TEST_H264 set, the stream is written there.
    #[test]
    #[ignore]
    fn gpu_a_resize_then_stillness_takes_up_the_new_size() {
        // The encoder's largest size is the first input's, so the encoder `new` opens is the
        // first frame's (on Linux this test runs the encoder at up to 1920x1080).
        let (device, encoder) = encoder(1280, 720, 4_000_000);
        let sizes = [(1280, 720), (1000, 600)];
        let producers = sizes
            .iter()
            .map(|&(w, h)| PatternProducer::new(device.clone(), w, h, 60, false, PatternKind::Screen).unwrap())
            .collect();
        // Ten frames at the first size, five at the second, then still.
        let script = std::iter::repeat_n(0, 10).chain(std::iter::repeat_n(1, 5)).collect();
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
        write_stream(&frames);
        // The fifteen frames, and the last one again at its own size.
        assert_eq!(frames.len(), 16);
        assert_eq!(keys, 2);
        assert!(frames.last().unwrap().key);
        assert_eq!(pipeline.encoder.running_size(), Some((1000, 600)));
    }

    /// On the GPU: run with `--ignored`. One in two frames kept, the second skipped and then
    /// nothing new, through the real encoder.
    #[test]
    #[ignore]
    fn gpu_a_skipped_frame_then_stillness_is_encoded() {
        let (device, encoder) = encoder(1280, 720, 4_000_000);
        let producers = vec![PatternProducer::new(device, 1280, 720, 60, false, PatternKind::Screen).unwrap()];
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
