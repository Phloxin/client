// libavcodec's VA-API H264 or AV1 encoder behind a DMA-BUF import and the VA-API video processor
// (D1, D3, D4, D6, D7), as the encoder spike's m6 program drives them. AV1 (`av1_vaapi`) as AV1
// step 2 Q8 sets it up: the same context and rules, with the settings of the AV1 spike.

use std::{ffi::CString, ptr, sync::Arc, time::Instant};

use ffmpeg_sys_next as ff;

use super::{
    DmaBufFrame,
    preview::{PreviewFrame, VaapiPreview},
    va,
};
use crate::{
    Error, VideoCodec,
    video::{
        EncoderConfig, FrameEncoder, Packet, Preview,
        ffi::{self, Buffer, Codec, Frame, Graph, Options, check},
        preview::PreviewWorker,
        sizing::{EncodeLimits, Resizes, encoded_size},
    },
};

/// The software format FFmpeg uses for a DRM fourcc the video processor takes.
fn sw_format(fourcc: u32) -> Option<ff::AVPixelFormat> {
    use ff::AVPixelFormat::*;
    Some(match &fourcc.to_le_bytes() {
        b"XR24" => AV_PIX_FMT_BGR0,
        b"AR24" => AV_PIX_FMT_BGRA,
        b"XB24" => AV_PIX_FMT_RGB0,
        b"AB24" => AV_PIX_FMT_RGBA,
        b"NV12" => AV_PIX_FMT_NV12,
        _ => return None,
    })
}

fn fourcc_text(fourcc: u32) -> String {
    String::from_utf8_lossy(&fourcc.to_le_bytes()).into_owned()
}

/// A DRM frame descriptor for `frame` with duplicates of its file descriptors, in a buffer that
/// closes them. Nothing is left open when it fails.
fn descriptor_for(frame: &DmaBufFrame) -> Result<(*mut u8, Buffer), Error> {
    if frame.objects.is_empty() || frame.objects.len() > 4 || frame.planes.is_empty() || frame.planes.len() > 4 {
        return Err(Error::Media(format!("DMA-BUF with {} objects and {} planes", frame.objects.len(), frame.planes.len())));
    }
    // Owned until the descriptor's buffer takes them over.
    let fds = frame
        .objects
        .iter()
        .map(|object| object.fd.try_clone().map_err(|e| Error::io("duplicate DMA-BUF", e)))
        .collect::<Result<Vec<_>, _>>()?;
    // SAFETY: a zeroed descriptor is a valid empty one.
    let mut descriptor: Box<ff::AVDRMFrameDescriptor> = Box::new(unsafe { std::mem::zeroed() });
    for ((slot, object), fd) in descriptor.objects.iter_mut().zip(&frame.objects).zip(fds) {
        slot.fd = std::os::fd::IntoRawFd::into_raw_fd(fd);
        slot.size = object.size;
        slot.format_modifier = object.modifier;
        descriptor.nb_objects += 1;
    }
    descriptor.nb_layers = 1;
    let layer = &mut descriptor.layers[0];
    layer.format = frame.fourcc;
    layer.nb_planes = frame.planes.len() as i32;
    for (slot, plane) in layer.planes.iter_mut().zip(&frame.planes) {
        slot.object_index = plane.object as i32;
        slot.offset = plane.offset as isize;
        slot.pitch = plane.pitch as isize;
    }
    // From here the buffer owns the descriptor and closes the duplicates, also on failure.
    let (data, buffer) = va::descriptor_buffer(descriptor)?;
    Ok((data, Buffer(buffer)))
}

/// The import and colour conversion for one kind of input frame.
struct Import {
    fourcc: u32,
    width: u32,
    height: u32,
    drm_frames: Buffer,
    va_frames: Buffer,
    // Owns the filter contexts.
    _graph: Graph,
    source: *mut ff::AVFilterContext,
    sink: *mut ff::AVFilterContext,
    out_width: u32,
    out_height: u32,
}

/// The libavcodec encoder for a codec.
fn encoder_name(codec: VideoCodec) -> &'static std::ffi::CStr {
    match codec {
        VideoCodec::H264 => c"h264_vaapi",
        VideoCodec::Av1 => c"av1_vaapi",
    }
}

/// AV1's level, 5.1 as `seq_level_idx` 13, the router's `level-idx` (Q8). Unset, `av1_vaapi`
/// guesses one from size, rate and bitrate (4.1 at 1080p60, AV1 spike section 1).
const AV1_LEVEL: i32 = 13;

/// An open h264_vaapi or av1_vaapi encoder.
struct Open {
    codec: Codec,
    /// The size it encodes at.
    size: (u32, u32),
    bitrate: u64,
    divisor: u32,
    /// Nothing encoded yet: the first frame is a key frame.
    fresh: bool,
}

/// The rate control buffer, 250 ms of the configured bitrate (D22). It bounds a key frame.
fn buffer_bits(bitrate: u64) -> i32 {
    (bitrate / 4).min(i32::MAX as u64) as i32
}

/// libavcodec's `h264_vaapi` (or `av1_vaapi`) fed with DMA-BUFs.
pub struct VaapiEncoder {
    /// The sharer's preview, started on the first offer (R2). It goes first: its frames are
    /// references into the import's pool.
    preview: Option<PreviewWorker<PreviewFrame>>,
    config: EncoderConfig,
    codec: VideoCodec,
    va: Buffer,
    drm: Buffer,
    limits: EncodeLimits,
    /// The last converted frame, for a key frame when nothing new comes (M5b D6). It goes
    /// before the import whose pool it is from.
    kept: Option<Frame>,
    import: Option<Import>,
    resizes: Resizes,
    open: Option<Open>,
    packet: ffi::Packet,
    pts: i64,
    /// Makes every opening fail, to test that the running encoder stays.
    #[cfg(test)]
    fail_open: bool,
}

// SAFETY: the FFmpeg objects are only touched by the thread that owns the encoder.
unsafe impl Send for VaapiEncoder {}

impl VaapiEncoder {
    /// Opens the VA display and the DRM device and checks that the H264 encoder exists.
    pub fn new(config: EncoderConfig) -> Result<Self, Error> {
        Self::with_codec(config, VideoCodec::H264)
    }

    /// As `new`, for `codec`. The size limits are the driver's for that codec (Q8).
    pub fn with_codec(config: EncoderConfig, codec: VideoCodec) -> Result<Self, Error> {
        if config.width < 16 || config.height < 16 || config.width > 4096 || config.height > 4096 {
            return Err(Error::invalid(format!("size {}x{} is not in 16 to 4096", config.width, config.height)));
        }
        crate::source::check_fps(config.fps)?;
        ffi::quiet_logs();
        let va = ffi::device(ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI, va::RENDER_NODE)?;
        let drm = ffi::device(ff::AVHWDeviceType::AV_HWDEVICE_TYPE_DRM, va::RENDER_NODE)?;
        let name = encoder_name(codec);
        // SAFETY: a lookup by name.
        if unsafe { ff::avcodec_find_encoder_by_name(name.as_ptr()) }.is_null() {
            return Err(Error::Media(format!("this FFmpeg has no {} encoder", name.to_string_lossy())));
        }
        let limits = va::encode_limits(&va, codec)?;
        tracing::debug!(min = ?limits.min, max = ?limits.max, codec = codec.name(), "encode sizes of the driver");
        // SAFETY: plain allocation.
        let packet = ffi::Packet(unsafe { ff::av_packet_alloc() });
        if packet.0.is_null() {
            return Err(Error::Media("av_packet_alloc failed".into()));
        }
        Ok(VaapiEncoder {
            preview: None,
            config,
            codec,
            va,
            drm,
            limits,
            kept: None,
            import: None,
            resizes: Resizes::default(),
            open: None,
            packet,
            pts: 0,
            #[cfg(test)]
            fail_open: false,
        })
    }

    /// The size the open encoder runs at.
    #[cfg(test)]
    pub(crate) fn running_size(&self) -> Option<(u32, u32)> {
        self.open.as_ref().map(|open| open.size)
    }

    /// The import for frames like `frame` and the size they are encoded at. A new size is taken
    /// up by opening the encoder again only as D14 allows, until then frames are scaled to the
    /// size the encoder runs at.
    fn import_for(&mut self, frame: &DmaBufFrame) -> Result<(), Error> {
        let wanted = encoded_size(frame.width, frame.height, (self.config.width, self.config.height), self.limits);
        let running = self.open.as_ref().map(|open| open.size);
        let (mut size, reopen) = self.resizes.decide(Instant::now(), wanted, running);
        if reopen && let Some(running) = running {
            // The kept frame is from the running import's pool and goes before it.
            self.kept = None;
            // The new encoder is opened before the running one goes, which stays if that fails.
            match self.build_import(frame, size).and_then(|import| Ok((self.open_encoder(&import, self.config.start_bitrate)?, import))) {
                Ok((open, import)) => {
                    tracing::info!(from = ?running, to = ?size, "encoder opened again at the new size");
                    self.open = Some(open);
                    self.import = Some(import);
                    return Ok(());
                }
                Err(error) => {
                    tracing::warn!(%error, from = ?running, to = ?size, "the encoder did not open at the new size, it stays at the running one");
                    size = running;
                }
            }
        }
        if let Some(import) = &self.import
            && (import.fourcc, import.width, import.height, import.out_width, import.out_height)
                == (frame.fourcc, frame.width, frame.height, size.0, size.1)
        {
            return Ok(());
        }
        // A new kind of input needs new frames contexts and a new graph. The encoder takes the
        // graph's output as long as its size stays the same.
        self.import = None;
        self.import = Some(self.build_import(frame, size)?);
        Ok(())
    }

    /// The DMA-BUF import and the video processor for frames like `frame`, putting out `size`.
    fn build_import(&self, frame: &DmaBufFrame, size: (u32, u32)) -> Result<Import, Error> {
        let format = sw_format(frame.fourcc)
            .ok_or_else(|| Error::Media(format!("DMA-BUF format {} is not supported", fourcc_text(frame.fourcc))))?;
        let (width, height) = (frame.width as i32, frame.height as i32);
        let (out_width, out_height) = size;

        // SAFETY: every pointer below is checked or owned by a guard that frees it.
        unsafe {
            let drm_frames = ffi::frames_context(&self.drm, ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME, format, width, height, 0)?;
            let mut va_frames = ptr::null_mut();
            check(
                ff::av_hwframe_ctx_create_derived(
                    &mut va_frames,
                    ff::AVPixelFormat::AV_PIX_FMT_VAAPI,
                    self.va.0,
                    drm_frames.0,
                    ff::AV_HWFRAME_MAP_DIRECT as i32,
                ),
                "VA frames for the DMA-BUF import",
            )?;
            let va_frames = Buffer(va_frames);

            let graph = Graph(ff::avfilter_graph_alloc());
            if graph.0.is_null() {
                return Err(Error::Media("avfilter_graph_alloc failed".into()));
            }
            let source = ff::avfilter_graph_alloc_filter(graph.0, ff::avfilter_get_by_name(c"buffer".as_ptr()), c"in".as_ptr());
            if source.is_null() {
                return Err(Error::Media("no buffer filter".into()));
            }
            let parameters = ff::av_buffersrc_parameters_alloc();
            if parameters.is_null() {
                return Err(Error::Media("av_buffersrc_parameters_alloc failed".into()));
            }
            (*parameters).format = ff::AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
            (*parameters).width = width;
            (*parameters).height = height;
            (*parameters).time_base = ff::AVRational { num: 1, den: self.config.fps as i32 };
            (*parameters).hw_frames_ctx = va_frames.0;
            (*parameters).color_range = ff::AVColorRange::AVCOL_RANGE_JPEG;
            (*parameters).color_space = ff::AVColorSpace::AVCOL_SPC_RGB;
            let set = ff::av_buffersrc_parameters_set(source, parameters);
            ff::av_free(parameters as *mut _);
            check(set, "buffer source parameters")?;
            check(ff::avfilter_init_str(source, ptr::null()), "buffer source")?;

            let mut sink = ptr::null_mut();
            check(
                ff::avfilter_graph_create_filter(
                    &mut sink,
                    ff::avfilter_get_by_name(c"buffersink".as_ptr()),
                    c"out".as_ptr(),
                    ptr::null(),
                    ptr::null_mut(),
                    graph.0,
                ),
                "buffer sink",
            )?;

            // NV12, BT.709 limited range, set explicitly (D4).
            let spec = format!(
                "scale_vaapi=w={out_width}:h={out_height}:format=nv12:out_color_matrix=bt709:out_range=limited:out_color_primaries=bt709:out_color_transfer=bt709"
            );
            let spec = CString::new(spec).map_err(|_| Error::Media("filter text".into()))?;
            let mut outputs = ff::avfilter_inout_alloc();
            let mut inputs = ff::avfilter_inout_alloc();
            if outputs.is_null() || inputs.is_null() {
                ff::avfilter_inout_free(&mut outputs);
                ff::avfilter_inout_free(&mut inputs);
                return Err(Error::Media("avfilter_inout_alloc failed".into()));
            }
            (*outputs).name = ff::av_strdup(c"in".as_ptr());
            (*outputs).filter_ctx = source;
            (*inputs).name = ff::av_strdup(c"out".as_ptr());
            (*inputs).filter_ctx = sink;
            let parsed = ff::avfilter_graph_parse_ptr(graph.0, spec.as_ptr(), &mut inputs, &mut outputs, ptr::null_mut());
            ff::avfilter_inout_free(&mut outputs);
            ff::avfilter_inout_free(&mut inputs);
            check(parsed, "video processor graph")?;
            check(ff::avfilter_graph_config(graph.0, ptr::null_mut()), "video processor graph config")?;

            tracing::info!(
                format = %fourcc_text(frame.fourcc),
                width = frame.width,
                height = frame.height,
                out_width,
                out_height,
                "DMA-BUF import"
            );
            Ok(Import {
                fourcc: frame.fourcc,
                width: frame.width,
                height: frame.height,
                drm_frames,
                va_frames,
                _graph: graph,
                source,
                sink,
                out_width,
                out_height,
            })
        }
    }

    /// An encoder for what `import` puts out, at `bitrate` (the level follows it).
    fn open_encoder(&self, import: &Import, bitrate: u64) -> Result<Open, Error> {
        #[cfg(test)]
        if self.fail_open {
            return Err(Error::Media("opening fails in this test".into()));
        }
        let (width, height) = (import.out_width, import.out_height);
        let fps = self.config.fps as i32;
        // SAFETY: the context is owned by a guard, the frames context is a new reference.
        let name = encoder_name(self.codec);
        let name_text = name.to_string_lossy();
        unsafe {
            let codec = ff::avcodec_find_encoder_by_name(name.as_ptr());
            let context = Codec(ff::avcodec_alloc_context3(codec));
            if context.0.is_null() {
                return Err(Error::Media("avcodec_alloc_context3 failed".into()));
            }
            let c = context.0;
            (*c).width = width as i32;
            (*c).height = height as i32;
            (*c).time_base = ff::AVRational { num: 1, den: fps };
            (*c).framerate = ff::AVRational { num: fps, den: 1 };
            (*c).pix_fmt = ff::AVPixelFormat::AV_PIX_FMT_VAAPI;
            let frames = ff::av_buffersink_get_hw_frames_ctx(import.sink);
            if frames.is_null() {
                return Err(Error::Media("the video processor has no frames context".into()));
            }
            (*c).hw_frames_ctx = ff::av_buffer_ref(frames);
            // No key frames on a timer, no B frames (D4).
            (*c).gop_size = i32::MAX;
            (*c).max_b_frames = 0;
            (*c).bit_rate = bitrate as i64;
            (*c).rc_max_rate = bitrate as i64;
            (*c).rc_buffer_size = buffer_bits(bitrate);
            // BT.709 limited range in the VUI (D4).
            (*c).color_range = ff::AVColorRange::AVCOL_RANGE_MPEG;
            (*c).colorspace = ff::AVColorSpace::AVCOL_SPC_BT709;
            (*c).color_primaries = ff::AVColorPrimaries::AVCOL_PRI_BT709;
            (*c).color_trc = ff::AVColorTransferCharacteristic::AVCOL_TRC_BT709;
            let mut options = match self.codec {
                VideoCodec::H264 => Options::new(&[
                    ("profile", "constrained_baseline".into()),
                    ("rc_mode", "CBR".into()),
                    ("async_depth", "1".into()),
                    ("slices", "1".into()),
                    // From ffmpeg-vaapi-rate-change.patch: no filler NAL units (D7).
                    ("filler", u8::from(self.config.filler).to_string()),
                ]),
                // The AV1 spike's settings: one packet per frame needs async_depth 1, and the
                // patch's filler 0 keeps padding OBUs out.
                VideoCodec::Av1 => {
                    (*c).level = AV1_LEVEL;
                    Options::new(&[
                        ("rc_mode", "CBR".into()),
                        ("async_depth", "1".into()),
                        ("filler", u8::from(self.config.filler).to_string()),
                    ])
                }
            };
            check(ff::avcodec_open2(c, codec, &mut options.0), &format!("open {name_text}"))?;
            let left = options.left_over();
            if !left.is_empty() {
                return Err(Error::Media(format!(
                    "{name_text} did not take {left:?}: FFmpeg without ffmpeg-vaapi-rate-change.patch?"
                )));
            }
            tracing::info!(width, height, fps, bitrate, level = (*c).level, "{name_text} open");
            Ok(Open { codec: context, size: (width, height), bitrate, divisor: 1, fresh: true })
        }
    }

    /// A DRM PRIME frame for `frame`, with duplicates of its file descriptors.
    fn drm_frame(&self, frame: &DmaBufFrame) -> Result<Frame, Error> {
        let Some(import) = &self.import else {
            return Err(Error::Media("no import".into()));
        };
        let (data, buffer) = descriptor_for(frame)?;
        let drm = Frame::alloc()?;
        // SAFETY: the frame is fresh, data stays alive as long as buffer, which it takes over.
        unsafe {
            (*drm.0).format = ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
            (*drm.0).width = frame.width as i32;
            (*drm.0).height = frame.height as i32;
            (*drm.0).hw_frames_ctx = import.drm_frames.new_ref();
            (*drm.0).data[0] = data;
            (*drm.0).buf[0] = buffer.into_raw();
        }
        Ok(drm)
    }
}

impl VaapiEncoder {
    /// Imports `frame` and converts it to NV12 at the output size.
    fn convert(&mut self, frame: &DmaBufFrame, pts: i64) -> Result<Frame, Error> {
        let drm = self.drm_frame(frame)?;
        let Some(import) = &self.import else {
            return Err(Error::Media("no import".into()));
        };
        // SAFETY: frames are owned by guards, the graph lives in self.
        unsafe {
            let imported = Frame::alloc()?;
            (*imported.0).format = ff::AVPixelFormat::AV_PIX_FMT_VAAPI as i32;
            (*imported.0).hw_frames_ctx = import.va_frames.new_ref();
            check(ff::av_hwframe_map(imported.0, drm.0, ff::AV_HWFRAME_MAP_READ as i32), "import the DMA-BUF")?;
            drop(drm);
            (*imported.0).pts = pts;
            (*imported.0).color_range = ff::AVColorRange::AVCOL_RANGE_JPEG;
            (*imported.0).colorspace = ff::AVColorSpace::AVCOL_SPC_RGB;
            check(ff::av_buffersrc_add_frame_flags(import.source, imported.0, 0), "video processor in")?;
            drop(imported);
            let converted = Frame::alloc()?;
            check(ff::av_buffersink_get_frame(import.sink, converted.0), "video processor out")?;
            Ok(converted)
        }
    }

    /// Whether frames like `frame` can be imported and converted, by doing it once without
    /// encoding (M5b D4: the compositor's buffers are checked before they are relied on).
    pub fn try_import(&mut self, frame: &DmaBufFrame) -> Result<(), Error> {
        self.import_for(frame)?;
        self.convert(frame, 0).map(drop)
    }
}

impl FrameEncoder for VaapiEncoder {
    type Frame = DmaBufFrame;
    fn encode(&mut self, frame: &DmaBufFrame, bitrate: u64, divisor: u32, key: bool) -> Result<Packet, Error> {
        self.import_for(frame)?;
        let pts = self.pts;
        let converted = self.convert(frame, pts)?;
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
        let Some(kept) = &self.kept else {
            return false;
        };
        if self.preview.is_none() {
            match PreviewWorker::start(preview.clone(), || Ok(VaapiPreview::default())) {
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
        self.preview.as_ref().is_some_and(|worker| worker.offer(PreviewFrame(Frame(frame))))
    }
}

impl VaapiEncoder {
    /// Encodes a converted frame, opening the encoder first if needed.
    fn encode_converted(&mut self, converted: Frame, bitrate: u64, divisor: u32, key: bool) -> Result<Packet, Error> {
        if self.open.is_none() {
            let Some(import) = &self.import else {
                return Err(Error::Media("no import".into()));
            };
            self.open = Some(self.open_encoder(import, self.config.start_bitrate)?);
        }
        let Some(open) = &mut self.open else {
            return Err(Error::Media("no encoder".into()));
        };
        // A new encoder starts with a key frame whether asked or not.
        let fresh = std::mem::take(&mut open.fresh);
        let key = key || fresh;
        let pts = self.pts;
        self.pts += 1;

        // SAFETY: frames are owned by guards, the codec lives in self.
        unsafe {
            if open.bitrate != bitrate {
                // With the patch the open encoder sends the new rate control with this frame.
                (*open.codec.0).bit_rate = bitrate as i64;
                (*open.codec.0).rc_max_rate = bitrate as i64;
                (*open.codec.0).rc_buffer_size = buffer_bits(bitrate);
                open.bitrate = bitrate;
            }
            if open.divisor != divisor {
                // The patch sends the frame rate with this frame, the per frame budget follows.
                (*open.codec.0).framerate = ff::AVRational { num: self.config.fps as i32, den: divisor.max(1) as i32 };
                open.divisor = divisor;
            }
            (*converted.0).pts = pts;
            (*converted.0).pict_type = if key {
                ff::AVPictureType::AV_PICTURE_TYPE_I
            } else {
                ff::AVPictureType::AV_PICTURE_TYPE_NONE
            };
            check(ff::avcodec_send_frame(open.codec.0, converted.0), "encode")?;
            drop(converted);

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

impl Drop for VaapiEncoder {
    fn drop(&mut self) {
        // The preview's worker, the encoder and the kept frame go before the graph whose frames
        // they hold.
        self.preview = None;
        self.open = None;
        self.kept = None;
        self.import = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Open file descriptors of this process on `path`.
    fn open_on(path: &std::path::Path) -> usize {
        std::fs::read_dir("/proc/self/fd")
            .unwrap()
            .filter_map(|entry| std::fs::read_link(entry.ok()?.path()).ok())
            .filter(|target| target == path)
            .count()
    }

    #[test]
    fn descriptors_close_their_duplicates() {
        let path = std::env::temp_dir().join(format!("pylon-media-descriptor-{}", std::process::id()));
        std::fs::write(&path, [0u8; 16]).unwrap();
        let path = path.canonicalize().unwrap();
        let object = || super::super::DmaBufObject {
            fd: std::fs::File::open(&path).unwrap().into(),
            size: 16,
            modifier: 0,
        };
        let frame = |objects: usize| DmaBufFrame {
            width: 16,
            height: 16,
            fourcc: u32::from_le_bytes(*b"XR24"),
            objects: (0..objects).map(|_| object()).collect(),
            planes: vec![super::super::DmaBufPlane { object: 0, offset: 0, pitch: 64 }],
            capture_time: Instant::now(),
        };
        let two = frame(2);
        assert_eq!(open_on(&path), 2);
        let (_, buffer) = descriptor_for(&two).unwrap();
        assert_eq!(open_on(&path), 4);
        drop(buffer);
        assert_eq!(open_on(&path), 2);
        // Too many objects: refused before anything is duplicated.
        let five = frame(5);
        assert!(descriptor_for(&five).is_err());
        assert_eq!(open_on(&path), 7);
        drop((two, five));
        assert_eq!(open_on(&path), 0);
        std::fs::remove_file(&path).unwrap();
    }

    /// On the GPU: run with `--ignored`.
    #[test]
    #[ignore]
    fn gpu_limits_tiny_inputs_and_a_failed_reopen() {
        use crate::{
            SourceControl,
            video::{FrameProducer, PatternKind, PatternProducer, Produced},
        };
        let mut encoder =
            VaapiEncoder::new(EncoderConfig { width: 1920, height: 1080, fps: 60, start_bitrate: 4_000_000, filler: false }).unwrap();
        eprintln!("driver limits for H264 encode: {:?}", encoder.limits);
        assert!(encoder.limits.max.0 >= 1920 && encoder.limits.max.1 >= 1080);
        let control = SourceControl::default();
        let frame = |w, h| {
            let Produced::Frame(frame) = PatternProducer::new(w, h, 60, false, PatternKind::Screen).unwrap().next_frame(&control, Instant::now()).unwrap() else {
                panic!("no pattern frame");
            };
            frame
        };
        // The smallest input the pattern makes is encoded at no less than the driver's minimum.
        let tiny = encoder.encode(&frame(16, 16), 4_000_000, 1, true).unwrap();
        assert!(!tiny.data.is_empty() && tiny.key);
        let size = encoder.open.as_ref().unwrap().size;
        eprintln!("16x16 encoded at {size:?}");
        assert!(size.0 >= encoder.limits.min.0 && size.1 >= encoder.limits.min.1);

        drop(encoder);

        let mut encoder =
            VaapiEncoder::new(EncoderConfig { width: 1920, height: 1080, fps: 60, start_bitrate: 4_000_000, filler: false }).unwrap();
        let (a, b) = (frame(1280, 720), frame(1000, 600));
        encoder.encode(&a, 4_000_000, 1, false).unwrap();
        assert_eq!(encoder.open.as_ref().unwrap().size, (1280, 720));
        let settle = |encoder: &mut VaapiEncoder| {
            let now = Instant::now();
            encoder.resizes.opened = Some(now - Duration::from_secs(2));
            encoder.resizes.wanted = Some(((1000, 600), now - Duration::from_secs(1)));
        };
        // Opening at the new size fails: the running encoder stays and goes on.
        settle(&mut encoder);
        encoder.fail_open = true;
        let kept = encoder.encode(&b, 4_000_000, 1, false).unwrap();
        assert!(!kept.data.is_empty() && !kept.key);
        assert_eq!(encoder.open.as_ref().unwrap().size, (1280, 720));
        // It opens when it can, with a key frame.
        encoder.fail_open = false;
        settle(&mut encoder);
        let reopened = encoder.encode(&b, 4_000_000, 1, false).unwrap();
        assert!(reopened.key);
        assert_eq!(encoder.open.as_ref().unwrap().size, (1000, 600));
    }

    #[test]
    fn formats() {
        assert_eq!(sw_format(u32::from_le_bytes(*b"XR24")), Some(ff::AVPixelFormat::AV_PIX_FMT_BGR0));
        assert_eq!(sw_format(u32::from_le_bytes(*b"YUYV")), None);
    }
}
