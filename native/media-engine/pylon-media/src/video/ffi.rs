// Small owners and checks around the raw FFmpeg calls of the encoder and the pattern producer.

use std::{
    ffi::{CStr, CString},
    ptr,
};

use ffmpeg_sys_next as ff;

use crate::Error;

/// FFmpeg's text for an error code.
pub(crate) fn av_error(code: i32) -> String {
    let mut buffer = [0 as std::ffi::c_char; 256];
    // SAFETY: the buffer is writable and its length is passed.
    unsafe { ff::av_strerror(code, buffer.as_mut_ptr(), buffer.len()) };
    // SAFETY: av_strerror always writes a terminated string into the buffer.
    unsafe { CStr::from_ptr(buffer.as_ptr()) }.to_string_lossy().into_owned()
}

/// `code` as a result, with `what` in the error.
pub(crate) fn check(code: i32, what: &str) -> Result<i32, Error> {
    if code < 0 {
        return Err(Error::Media(format!("{what}: {} ({code})", av_error(code))));
    }
    Ok(code)
}

/// Keeps FFmpeg's own log to warnings and worse, once per process.
pub(crate) fn quiet_logs() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    // SAFETY: setting the log level has no preconditions.
    ONCE.call_once(|| unsafe { ff::av_log_set_level(ff::AV_LOG_WARNING as i32) });
}

/// An owned `AVBufferRef`.
pub(crate) struct Buffer(pub(crate) *mut ff::AVBufferRef);

impl Buffer {
    /// A new reference to the same buffer.
    pub(crate) fn new_ref(&self) -> *mut ff::AVBufferRef {
        // SAFETY: self.0 is a valid reference while self lives.
        unsafe { ff::av_buffer_ref(self.0) }
    }

    /// The reference, for an owner that unrefs it.
    pub(crate) fn into_raw(self) -> *mut ff::AVBufferRef {
        let raw = self.0;
        std::mem::forget(self);
        raw
    }
}

impl Drop for Buffer {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the reference is owned and unref'd once.
            unsafe { ff::av_buffer_unref(&mut self.0) };
        }
    }
}

/// An owned `AVFrame`.
pub(crate) struct Frame(pub(crate) *mut ff::AVFrame);

impl Frame {
    pub(crate) fn alloc() -> Result<Frame, Error> {
        // SAFETY: plain allocation.
        let frame = unsafe { ff::av_frame_alloc() };
        if frame.is_null() {
            return Err(Error::Media("av_frame_alloc failed".into()));
        }
        Ok(Frame(frame))
    }
}

impl Drop for Frame {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the frame is owned and freed once.
            unsafe { ff::av_frame_free(&mut self.0) };
        }
    }
}

/// An owned `AVPacket`.
pub(crate) struct Packet(pub(crate) *mut ff::AVPacket);

impl Drop for Packet {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the packet is owned and freed once.
            unsafe { ff::av_packet_free(&mut self.0) };
        }
    }
}

/// An owned filter graph.
pub(crate) struct Graph(pub(crate) *mut ff::AVFilterGraph);

impl Drop for Graph {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the graph is owned and freed once, its filters with it.
            unsafe { ff::avfilter_graph_free(&mut self.0) };
        }
    }
}

/// An owned codec context.
pub(crate) struct Codec(pub(crate) *mut ff::AVCodecContext);

impl Drop for Codec {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the context is owned and freed once.
            unsafe { ff::avcodec_free_context(&mut self.0) };
        }
    }
}

/// A device of `kind` opened on `on` (on Linux a VA-API or DRM device on the render node).
pub(crate) fn device(kind: ff::AVHWDeviceType, on: &CStr) -> Result<Buffer, Error> {
    let mut device = ptr::null_mut();
    // SAFETY: device receives a new reference on success.
    let code = unsafe { ff::av_hwdevice_ctx_create(&mut device, kind, on.as_ptr(), ptr::null_mut(), 0) };
    check(code, &format!("open {} on {}", device_name(kind), on.to_string_lossy()))?;
    Ok(Buffer(device))
}

fn device_name(kind: ff::AVHWDeviceType) -> &'static str {
    match kind {
        ff::AVHWDeviceType::AV_HWDEVICE_TYPE_VAAPI => "VA-API",
        ff::AVHWDeviceType::AV_HWDEVICE_TYPE_DRM => "DRM",
        _ => "device",
    }
}

/// A frames context of `format` holding `sw_format` pictures of `width` by `height`.
pub(crate) fn frames_context(
    device: &Buffer,
    format: ff::AVPixelFormat,
    sw_format: ff::AVPixelFormat,
    width: i32,
    height: i32,
    pool: i32,
) -> Result<Buffer, Error> {
    // SAFETY: the device is valid, the new context is filled in before init.
    unsafe {
        let frames = ff::av_hwframe_ctx_alloc(device.0);
        if frames.is_null() {
            return Err(Error::Media("av_hwframe_ctx_alloc failed".into()));
        }
        let frames = Buffer(frames);
        let context = (*frames.0).data as *mut ff::AVHWFramesContext;
        (*context).format = format;
        (*context).sw_format = sw_format;
        (*context).width = width;
        (*context).height = height;
        (*context).initial_pool_size = pool;
        check(ff::av_hwframe_ctx_init(frames.0), "frames context")?;
        Ok(frames)
    }
}

/// Sets string options in a dictionary for `avcodec_open2`.
pub(crate) struct Options(pub(crate) *mut ff::AVDictionary);

impl Options {
    pub(crate) fn new(pairs: &[(&str, String)]) -> Options {
        let mut options = Options(ptr::null_mut());
        for (key, value) in pairs {
            let (key, value) = (CString::new(*key).unwrap_or_default(), CString::new(value.as_str()).unwrap_or_default());
            // SAFETY: both strings are copied by av_dict_set.
            unsafe { ff::av_dict_set(&mut options.0, key.as_ptr(), value.as_ptr(), 0) };
        }
        options
    }

    /// The keys nobody took.
    pub(crate) fn left_over(&self) -> Vec<String> {
        let mut keys = Vec::new();
        let mut entry: *const ff::AVDictionaryEntry = ptr::null();
        loop {
            // SAFETY: iterating a valid (or null) dictionary.
            entry = unsafe { ff::av_dict_iterate(self.0, entry) };
            if entry.is_null() {
                break;
            }
            // SAFETY: entries carry terminated keys.
            keys.push(unsafe { CStr::from_ptr((*entry).key) }.to_string_lossy().into_owned());
        }
        keys
    }
}

impl Drop for Options {
    fn drop(&mut self) {
        // SAFETY: the dictionary is owned.
        unsafe { ff::av_dict_free(&mut self.0) };
    }
}
