// libavcodec's Quick Sync (`h264_qsv`) or NVENC (`h264_nvenc`) H264 encoder behind our own D3D11
// video processor (.plans/native-media-engine-m7-4-windows-encoder.md, N5 to N9), with the
// options the two Windows encoder spikes settled (M7 plan, sections 8 and 9). Sizes are limited
// as on Linux (.plans/native-media-engine-m7-5-windows-capture.md, C8).

use std::{ptr, sync::Arc, time::Instant};

use ffmpeg_sys_next as ff;

use super::{
    D3d11Frame,
    convert::Converter,
    device::{Device, Vendor},
    preview::{D3d11Preview, PreviewFrame},
};
use crate::{
    Error,
    video::{
        EncoderConfig, FrameEncoder, Packet, Preview,
        ffi::{self, Buffer, Codec, Frame, Options, check},
        preview::PreviewWorker,
        sizing::{EncodeLimits, Resizes, encoded_size},
    },
};

/// The sizes encoded on Windows (M7.5 C8): a smaller picture is scaled up to the least, a larger
/// one down to fit the most, as the driver's limits do on Linux.
const LIMITS: EncodeLimits = EncodeLimits { min: (160, 120), max: (4096, 2304) };

/// Which of libavcodec's encoders runs, from the adapter's vendor (N4).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Backend {
    /// `h264_qsv`, fed Quick Sync frames mapped from the D3D11 textures.
    QuickSync,
    /// `h264_nvenc`, fed the D3D11 textures.
    Nvenc,
}

impl Backend {
    fn name(self) -> &'static str {
        match self {
            Backend::QuickSync => "h264_qsv",
            Backend::Nvenc => "h264_nvenc",
        }
    }

    /// Rows of the converted textures for a picture `height` high: Quick Sync reads past a
    /// texture that is not a multiple of 16 rows (M7 plan F7), NVENC takes the picture's size.
    fn rows(self, height: u32) -> u32 {
        match self {
            Backend::QuickSync => height.div_ceil(16) * 16,
            Backend::Nvenc => height,
        }
    }

    /// The rate control's maximum for a bitrate: VBR with the maximum at the target, which on
    /// Quick Sync means 1 % above it (N6, N7).
    fn max_rate(self, bitrate: u64) -> u64 {
        match self {
            Backend::QuickSync => bitrate + bitrate / 100,
            Backend::Nvenc => bitrate,
        }
    }
}

/// NVENC's rate control buffer, 250 ms of the bitrate, following it (N7, as on Linux).
fn buffer_bits(bitrate: u64) -> i32 {
    (bitrate / 4).min(i32::MAX as u64) as i32
}

/// The least Quick Sync's buffer is opened with (N6, M7 plan F5).
const QUICK_SYNC_LEAST_BUFFER: u64 = 2_000_000;

/// Quick Sync's rate control buffer, fixed at opening: a quarter of the opening bitrate, not
/// less than `QUICK_SYNC_LEAST_BUFFER` (N6). It cannot change on the open encoder (F1).
fn quick_sync_buffer_bits(bitrate: u64) -> i32 {
    (bitrate / 4).max(QUICK_SYNC_LEAST_BUFFER).min(i32::MAX as u64) as i32
}

/// The conversion for one input size and output size.
struct Import {
    width: u32,
    height: u32,
    out_width: u32,
    out_height: u32,
    converter: Converter,
    /// Quick Sync's frames context derived from the converter's textures.
    qsv_frames: Option<Buffer>,
}

/// An open encoder.
struct Open {
    codec: Codec,
    /// The size it encodes at.
    size: (u32, u32),
    /// The bitrate in its context: the bitrate asked for times the frame rate divisor (N8).
    bitrate: u64,
    /// Nothing encoded yet: the first frame is a key frame.
    fresh: bool,
}

/// libavcodec's Quick Sync or NVENC encoder fed with D3D11 textures.
pub struct D3d11Encoder {
    /// The sharer's preview, started on the first offer (M6 preview step 3). It goes first, as
    /// `kept` does (W7): its frames are references into the import's pool.
    preview: Option<PreviewWorker<PreviewFrame>>,
    config: EncoderConfig,
    device: Arc<Device>,
    backend: Backend,
    /// Quick Sync's device, derived from the D3D11 device.
    qsv: Option<Buffer>,
    /// The last converted frame, for a key frame when nothing new comes (M5b D6). It goes
    /// before the import whose pool it is from.
    kept: Option<Frame>,
    import: Option<Import>,
    /// The import and encoder `new` opened, for a first frame of the size it was given (N4, C7).
    provisional: bool,
    resizes: Resizes,
    open: Option<Open>,
    packet: ffi::Packet,
    pts: i64,
}

// SAFETY: the FFmpeg objects are only touched by the thread that owns the encoder.
unsafe impl Send for D3d11Encoder {}

impl D3d11Encoder {
    /// The encoder for the device's vendor. It is opened here once for an input of `first` (the
    /// pattern's size, or the captured item's: M7.5 C7), so that an encoder that does not open
    /// fails the source (N4); a first frame of that size is encoded with it.
    pub(crate) fn new(config: EncoderConfig, device: Arc<Device>, first: (u32, u32)) -> Result<Self, Error> {
        if config.width < 16 || config.height < 16 || config.width > 4096 || config.height > 4096 {
            return Err(Error::invalid(format!("size {}x{} is not in 16 to 4096", config.width, config.height)));
        }
        crate::source::check_fps(config.fps)?;
        ffi::quiet_logs();
        let backend = match device.vendor {
            Vendor::Intel => Backend::QuickSync,
            Vendor::Nvidia => Backend::Nvenc,
        };
        let name = backend.name();
        let adapter = device.adapter.clone();
        let on = move |e: Error| Error::Media(format!("{name} on {adapter}: {e}"));
        let named = std::ffi::CString::new(name).map_err(|_| Error::Media("encoder name".into()))?;
        // SAFETY: a lookup by name.
        if unsafe { ff::avcodec_find_encoder_by_name(named.as_ptr()) }.is_null() {
            return Err(on(Error::Media(format!("this FFmpeg has no {name} encoder"))));
        }
        let qsv = match backend {
            Backend::QuickSync => {
                let mut qsv = ptr::null_mut();
                // SAFETY: qsv receives a new reference on success.
                let code = unsafe { ff::av_hwdevice_ctx_create_derived(&mut qsv, ff::AVHWDeviceType::AV_HWDEVICE_TYPE_QSV, device.ffmpeg.0, 0) };
                check(code, "Quick Sync device from the D3D11 device").map_err(&on)?;
                Some(Buffer(qsv))
            }
            Backend::Nvenc => None,
        };
        // SAFETY: plain allocation.
        let packet = ffi::Packet(unsafe { ff::av_packet_alloc() });
        if packet.0.is_null() {
            return Err(Error::Media("av_packet_alloc failed".into()));
        }
        let mut encoder = D3d11Encoder {
            preview: None,
            config,
            device,
            backend,
            qsv,
            kept: None,
            import: None,
            provisional: false,
            resizes: Resizes::default(),
            open: None,
            packet,
            pts: 0,
        };
        if first.0 == 0 || first.1 == 0 {
            return Err(Error::invalid(format!("first input {}x{} is empty", first.0, first.1)));
        }
        let size = encoded_size(first.0, first.1, (config.width, config.height), LIMITS);
        let import = encoder.build_import(first, size).map_err(&on)?;
        let open = encoder.open_encoder(&import, config.start_bitrate).map_err(&on)?;
        encoder.import = Some(import);
        encoder.open = Some(open);
        encoder.provisional = true;
        Ok(encoder)
    }

    /// The size the open encoder runs at.
    #[cfg(test)]
    pub(crate) fn running_size(&self) -> Option<(u32, u32)> {
        self.open.as_ref().map(|open| open.size)
    }

    /// The import for frames like `frame` and the size they are encoded at. A new size is taken
    /// up by opening the encoder again only as D14 allows, until then frames are scaled to the
    /// size the encoder runs at.
    fn import_for(&mut self, frame: &D3d11Frame) -> Result<(), Error> {
        let wanted = encoded_size(frame.width, frame.height, (self.config.width, self.config.height), LIMITS);
        if std::mem::take(&mut self.provisional) {
            let fits = self
                .import
                .as_ref()
                .is_some_and(|import| (import.width, import.height, import.out_width, import.out_height) == (frame.width, frame.height, wanted.0, wanted.1));
            if fits {
                // The first frame's opening, as the first frame on Linux opens the encoder.
                self.resizes.decide(Instant::now(), wanted, None);
                return Ok(());
            }
            self.preview = None;
            self.kept = None;
            self.open = None;
            self.import = None;
        }
        let running = self.open.as_ref().map(|open| open.size);
        let (mut size, reopen) = self.resizes.decide(Instant::now(), wanted, running);
        if reopen && let Some(running) = running {
            // The preview's worker (with any frame it holds) and the kept frame are from the running
            // import's pool and go before it (W7).
            self.preview = None;
            self.kept = None;
            // The new encoder is opened before the running one goes, which stays if that fails.
            match self
                .build_import((frame.width, frame.height), size)
                .and_then(|import| Ok((self.open_encoder(&import, self.config.start_bitrate)?, import)))
            {
                Ok((open, import)) => {
                    tracing::info!(encoder = self.backend.name(), from = ?running, to = ?size, "encoder opened again at the new size");
                    self.open = Some(open);
                    self.import = Some(import);
                    return Ok(());
                }
                Err(error) => {
                    tracing::warn!(%error, encoder = self.backend.name(), from = ?running, to = ?size, "the encoder did not open at the new size, it stays at the running one");
                    size = running;
                }
            }
        }
        if let Some(import) = &self.import
            && (import.width, import.height, import.out_width, import.out_height) == (frame.width, frame.height, size.0, size.1)
        {
            return Ok(());
        }
        // A new input size needs a new video processor. The encoder takes its output as long as
        // the output size stays the same.
        self.import = None;
        self.import = Some(self.build_import((frame.width, frame.height), size)?);
        Ok(())
    }

    /// The video processor for `input` sized frames, putting out `size`, and for Quick Sync
    /// the frames context its textures are mapped to.
    fn build_import(&self, input: (u32, u32), size: (u32, u32)) -> Result<Import, Error> {
        let (out_width, out_height) = size;
        let rows = self.backend.rows(out_height);
        let converter = Converter::new(self.device.clone(), input, size, rows, self.config.fps)?;
        let qsv_frames = match &self.qsv {
            Some(qsv) => {
                let mut frames = ptr::null_mut();
                // SAFETY: frames receives a new reference on success.
                let code = unsafe {
                    ff::av_hwframe_ctx_create_derived(&mut frames, ff::AVPixelFormat::AV_PIX_FMT_QSV, qsv.0, converter.frames.0, 0)
                };
                check(code, "Quick Sync frames from the D3D11 textures")?;
                Some(Buffer(frames))
            }
            None => None,
        };
        tracing::info!(width = input.0, height = input.1, out_width, out_height, rows, "D3D11 import");
        Ok(Import { width: input.0, height: input.1, out_width, out_height, converter, qsv_frames })
    }

    /// An encoder for what `import` puts out, at `bitrate` (the level follows it).
    fn open_encoder(&self, import: &Import, bitrate: u64) -> Result<Open, Error> {
        let (width, height) = (import.out_width, import.out_height);
        let fps = self.config.fps as i32;
        let name = self.backend.name();
        // SAFETY: the context is owned by a guard, the frames context is a new reference.
        unsafe {
            let named = std::ffi::CString::new(name).map_err(|_| Error::Media("encoder name".into()))?;
            let codec = ff::avcodec_find_encoder_by_name(named.as_ptr());
            let context = Codec(ff::avcodec_alloc_context3(codec));
            if context.0.is_null() {
                return Err(Error::Media("avcodec_alloc_context3 failed".into()));
            }
            let c = context.0;
            (*c).width = width as i32;
            (*c).height = height as i32;
            (*c).time_base = ff::AVRational { num: 1, den: fps };
            (*c).framerate = ff::AVRational { num: fps, den: 1 };
            match &import.qsv_frames {
                Some(frames) => {
                    (*c).pix_fmt = ff::AVPixelFormat::AV_PIX_FMT_QSV;
                    (*c).hw_frames_ctx = frames.new_ref();
                }
                None => {
                    (*c).pix_fmt = ff::AVPixelFormat::AV_PIX_FMT_D3D11;
                    (*c).hw_frames_ctx = import.converter.frames.new_ref();
                }
            }
            // No key frames on a timer, no B frames, one slice (D4).
            (*c).gop_size = i32::MAX;
            (*c).max_b_frames = 0;
            (*c).slices = 1;
            (*c).bit_rate = bitrate as i64;
            (*c).rc_max_rate = self.backend.max_rate(bitrate) as i64;
            // BT.709 limited range in the VUI (D4).
            (*c).color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
            (*c).colorspace = ff::AVColorSpace::AVCOL_SPC_BT709;
            (*c).color_primaries = ff::AVColorPrimaries::AVCOL_PRI_BT709;
            (*c).color_trc = ff::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            let mut options = match self.backend {
                Backend::QuickSync => {
                    // HRD conformance off: the bitrate then changes on the open encoder (F1).
                    (*c).strict_std_compliance = -1; // FF_COMPLIANCE_UNOFFICIAL
                    (*c).rc_buffer_size = quick_sync_buffer_bits(bitrate);
                    Options::new(&[
                        // MFX_PROFILE_AVC_CONSTRAINED_BASELINE: "baseline" is plain Baseline here.
                        ("profile", "578".into()),
                        ("async_depth", "1".into()),
                        ("forced_idr", "1".into()),
                        ("look_ahead", "0".into()),
                        ("max_qp_p", "48".into()),
                    ])
                }
                Backend::Nvenc => {
                    (*c).rc_buffer_size = buffer_bits(bitrate);
                    Options::new(&[
                        ("preset", "p4".into()),
                        ("tune", "ull".into()),
                        ("zerolatency", "1".into()),
                        ("delay", "0".into()),
                        ("rc", "vbr".into()),
                        ("profile", "baseline".into()),
                        ("forced-idr", "1".into()),
                        // From nvenc-reconfig-no-idr.patch: a new bitrate without a key frame.
                        ("reconfig_idr", "0".into()),
                    ])
                }
            };
            check(ff::avcodec_open2(c, codec, &mut options.0), &format!("open {name}"))?;
            let left = options.left_over();
            if !left.is_empty() {
                let patch = if left.iter().any(|key| key == "reconfig_idr") { ": FFmpeg without nvenc-reconfig-no-idr.patch?" } else { "" };
                return Err(Error::Media(format!("{name} did not take {left:?}{patch}")));
            }
            match self.backend {
                Backend::QuickSync => tracing::info!(width, height, fps, bitrate, level = (*c).level, "h264_qsv open"),
                Backend::Nvenc => tracing::info!(width, height, fps, bitrate, level = (*c).level, "h264_nvenc open"),
            }
            Ok(Open { codec: context, size: (width, height), bitrate, fresh: true })
        }
    }
}

impl FrameEncoder for D3d11Encoder {
    type Frame = D3d11Frame;
    fn encode(&mut self, frame: &D3d11Frame, bitrate: u64, divisor: u32, key: bool) -> Result<Packet, Error> {
        self.import_for(frame)?;
        let Some(import) = &self.import else {
            return Err(Error::Media("no import".into()));
        };
        let converted = import.converter.convert(frame)?;
        // SAFETY: a new reference to a valid frame.
        let kept = unsafe { ff::av_frame_clone(converted.0) };
        self.kept = (!kept.is_null()).then_some(Frame(kept));
        self.encode_converted(converted, bitrate, divisor, key)
    }

    fn encode_kept(&mut self, bitrate: u64, divisor: u32, key: bool) -> Result<Option<Packet>, Error> {
        let Some(kept) = &self.kept else {
            return Ok(None);
        };
        // SAFETY: a new reference to a valid frame.
        let again = unsafe { ff::av_frame_clone(kept.0) };
        if again.is_null() {
            return Err(Error::Media("av_frame_clone failed".into()));
        }
        self.encode_converted(Frame(again), bitrate, divisor, key).map(Some)
    }

    fn resize_due(&self) -> Option<Instant> {
        self.open.as_ref().and(self.resizes.due())
    }

    fn offer_preview(&mut self, preview: &Arc<Preview>) -> bool {
        let (Some(kept), Some(import)) = (&self.kept, &self.import) else {
            return false;
        };
        // The picture's size in the texture, which may be taller (Quick Sync's rows).
        let (width, height) = (import.out_width, import.out_height);
        if self.preview.is_none() {
            let device = self.device.clone();
            match PreviewWorker::start(preview.clone(), move || Ok(D3d11Preview::new(device.clone()))) {
                Ok(worker) => self.preview = Some(worker),
                Err(error) => {
                    preview.fail(preview.current().0, format!("preview: {error}"));
                    return false;
                }
            }
        }
        // SAFETY: a new reference to a valid frame.
        let frame = unsafe { ff::av_frame_clone(kept.0) };
        if frame.is_null() {
            return false;
        }
        self.preview.as_ref().is_some_and(|worker| worker.offer(PreviewFrame { frame: Frame(frame), width, height }))
    }
}

impl D3d11Encoder {
    /// Encodes a converted frame, opening the encoder first if needed.
    fn encode_converted(&mut self, converted: Frame, bitrate: u64, divisor: u32, key: bool) -> Result<Packet, Error> {
        if self.open.is_none() {
            let Some(import) = &self.import else {
                return Err(Error::Media("no import".into()));
            };
            self.open = Some(self.open_encoder(import, self.config.start_bitrate)?);
        }
        let (Some(open), Some(import)) = (&mut self.open, &self.import) else {
            return Err(Error::Media("no encoder".into()));
        };
        // A new encoder starts with a key frame whether asked or not.
        let fresh = std::mem::take(&mut open.fresh);
        let key = key || fresh;
        let pts = self.pts;
        self.pts += 1;

        // SAFETY: frames are owned by guards, the codec lives in self.
        unsafe {
            // The frame rate stays: one frame in `divisor` gets `divisor` times the budget (N8).
            let given = bitrate.saturating_mul(u64::from(divisor.max(1)));
            if open.bitrate != given {
                // Changed on the open encoder with the next frame, no key frame (F1, F3).
                (*open.codec.0).bit_rate = given as i64;
                (*open.codec.0).rc_max_rate = self.backend.max_rate(given) as i64;
                open.bitrate = given;
            }
            // NVENC's buffer follows the bitrate asked for, not the one given: with a divisor the
            // encoder's clock runs `divisor` times fast, and a quarter of the asked bitrate is
            // 250 ms of real time. Never run (no NVENC hardware to try it on yet).
            if self.backend == Backend::Nvenc {
                let buffer = buffer_bits(bitrate);
                if (*open.codec.0).rc_buffer_size != buffer {
                    (*open.codec.0).rc_buffer_size = buffer;
                }
            }
            let input = match &import.qsv_frames {
                // Mapped, not copied: the Quick Sync frame refers to the D3D11 texture.
                Some(frames) => {
                    let mapped = Frame::alloc()?;
                    (*mapped.0).format = ff::AVPixelFormat::AV_PIX_FMT_QSV as i32;
                    (*mapped.0).hw_frames_ctx = frames.new_ref();
                    check(ff::av_hwframe_map(mapped.0, converted.0, ff::AV_HWFRAME_MAP_READ as i32), "map to Quick Sync")?;
                    check(ff::av_frame_copy_props(mapped.0, converted.0), "frame properties")?;
                    drop(converted);
                    mapped
                }
                None => converted,
            };
            (*input.0).pts = pts;
            (*input.0).pict_type = if key {
                ff::AVPictureType::AV_PICTURE_TYPE_I
            } else {
                ff::AVPictureType::AV_PICTURE_TYPE_NONE
            };
            check(ff::avcodec_send_frame(open.codec.0, input.0), "encode")?;
            drop(input);

            let received = ff::avcodec_receive_packet(open.codec.0, self.packet.0);
            if received == ff::AVERROR(ff::EAGAIN) {
                return Err(Error::Media("the encoder held a frame back".into()));
            }
            check(received, "encoded packet")?;
            let packet = &*self.packet.0;
            let data = std::slice::from_raw_parts(packet.data, packet.size as usize).to_vec();
            let is_key = packet.flags & ff::AV_PKT_FLAG_KEY as i32 != 0;
            ff::av_packet_unref(self.packet.0);
            Ok(Packet { data, key: is_key })
        }
    }
}

impl Drop for D3d11Encoder {
    fn drop(&mut self) {
        // The preview's worker, the encoder and the kept frame go before the textures and frames
        // contexts they hold (W7).
        self.preview = None;
        self.open = None;
        self.kept = None;
        self.import = None;
        self.qsv = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        SourceControl, h264,
        video::{FrameProducer, PatternKind, Produced, windows::PatternProducer},
    };

    /// The pipeline's device, and an encoder on it that may run at up to `width` by `height`.
    fn encoder(width: u32, height: u32, start_bitrate: u64) -> (Arc<Device>, D3d11Encoder) {
        let device = Device::open().unwrap();
        let config = EncoderConfig { width, height, fps: 60, start_bitrate, filler: false };
        let encoder = D3d11Encoder::new(config, device.clone(), (width, height)).unwrap();
        (device, encoder)
    }

    /// The NAL unit types of an access unit.
    fn nal_types(data: &[u8]) -> Vec<u8> {
        h264::nal_units(data).iter().map(|nal| h264::nal_type(nal)).collect()
    }

    /// `count` frames of the 1920x1080 pattern encoded one by one, `at(n)` giving the bitrate,
    /// divisor and key request of frame n.
    fn encode_pattern(encoder: &mut D3d11Encoder, device: Arc<Device>, count: u64, at: impl Fn(u64) -> (u64, u32, bool)) -> Vec<Packet> {
        let mut producer = PatternProducer::new(device, 1920, 1080, 60, false, PatternKind::Screen).unwrap();
        let control = SourceControl::default();
        (0..count)
            .map(|n| {
                let Produced::Frame(frame) = producer.next_frame(&control, Instant::now()).unwrap() else {
                    panic!("no pattern frame");
                };
                let (bitrate, divisor, key) = at(n);
                encoder.encode(&frame, bitrate, divisor, key).unwrap()
            })
            .collect()
    }

    fn write_packets(packets: &[Packet]) {
        if let Ok(path) = std::env::var("PYLON_TEST_H264") {
            let stream: Vec<u8> = packets.iter().flat_map(|p| p.data.iter().copied()).collect();
            std::fs::write(path, stream).unwrap();
        }
    }

    /// On the GPU: run with `--ignored`. A key frame asked for is an IDR with SPS and PPS, and
    /// no other key frame comes.
    #[test]
    #[ignore]
    fn gpu_a_forced_key_frame_is_an_idr_with_sps_and_pps() {
        let (device, mut encoder) = encoder(1920, 1080, 8_000_000);
        let packets = encode_pattern(&mut encoder, device, 180, |n| (8_000_000, 1, n == 90));
        write_packets(&packets);
        let keys: Vec<(usize, Vec<u8>)> = packets
            .iter()
            .enumerate()
            .filter(|(_, p)| p.key || nal_types(&p.data).iter().any(|t| matches!(t, 5 | 7 | 8)))
            .map(|(n, p)| (n, nal_types(&p.data)))
            .collect();
        eprintln!("key frames and their NAL units: {keys:?}");
        assert_eq!(keys.iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec![0, 90]);
        for (n, types) in &keys {
            assert!(packets[*n].key, "frame {n}");
            for wanted in [7, 8, 5] {
                assert!(types.contains(&wanted), "frame {n}: {types:?}");
            }
        }
    }

    /// On the GPU: run with `--ignored`. The bitrate changed on the open encoder, and one frame
    /// in two with twice the bitrate (N8), bring no key frame and no new encoder.
    #[test]
    #[ignore]
    fn gpu_a_bitrate_change_in_place_brings_no_key_frame() {
        let (device, mut encoder) = encoder(1920, 1080, 8_000_000);
        let first = encode_pattern(&mut encoder, device.clone(), 1, |_| (8_000_000, 1, false));
        let codec = encoder.open.as_ref().unwrap().codec.0;
        let schedule = |n: u64| match n {
            0..60 => (8_000_000, 1, false),
            60..120 => (3_000_000, 1, false),
            120..180 => (12_000_000, 1, false),
            _ => (3_000_000, 2, false),
        };
        let packets = encode_pattern(&mut encoder, device, 240, schedule);
        let all: Vec<Packet> = first.into_iter().chain(packets).collect();
        write_packets(&all);
        let sizes = |from: usize, to: usize| all[from..to].iter().map(|p| p.data.len() as u64).sum::<u64>() * 8 * 60 / (to - from) as u64;
        eprintln!(
            "bits per second at 60 frames a second: {} {} {} {}",
            sizes(1, 61),
            sizes(61, 121),
            sizes(121, 181),
            sizes(181, 241)
        );
        let keys: Vec<usize> = all
            .iter()
            .enumerate()
            .filter(|(_, p)| p.key || nal_types(&p.data).iter().any(|t| matches!(t, 5 | 7 | 8)))
            .map(|(n, _)| n)
            .collect();
        assert_eq!(keys, vec![0], "key frames at {keys:?}");
        let open = encoder.open.as_ref().unwrap();
        assert_eq!(open.codec.0, codec, "the encoder was opened again");
        assert_eq!(open.bitrate, 6_000_000);
    }

    #[test]
    fn rows_and_rates() {
        assert_eq!(Backend::QuickSync.rows(1080), 1088);
        assert_eq!(Backend::QuickSync.rows(720), 720);
        assert_eq!(Backend::QuickSync.rows(2), 16);
        assert_eq!(Backend::Nvenc.rows(1080), 1080);
        assert_eq!(Backend::QuickSync.max_rate(8_000_000), 8_080_000);
        assert_eq!(Backend::Nvenc.max_rate(8_000_000), 8_000_000);
        assert_eq!(quick_sync_buffer_bits(25_000_000), 6_250_000);
        assert_eq!(quick_sync_buffer_bits(4_000_000), 2_000_000);
        assert_eq!(buffer_bits(4_000_000), 1_000_000);
        // M7.5 C8.
        assert_eq!(encoded_size(100, 50, (1920, 1080), LIMITS), (160, 120));
        assert_eq!(encoded_size(5120, 2880, (8192, 8192), LIMITS), (4096, 2304));
        assert_eq!(encoded_size(1920, 1080, (1920, 1080), LIMITS), (1920, 1080));
    }
}
