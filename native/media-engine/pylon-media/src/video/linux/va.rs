// The VA-API and DRM half of the raw FFmpeg calls of the encoder and the pattern producer:
// the render node, surfaces exported as DMA-BUFs, the driver's size limits, DRM descriptors.

use std::{
    ffi::{CStr, c_void},
    os::fd::{FromRawFd, OwnedFd},
    ptr,
};

use ffmpeg_sys_next as ff;

use crate::{
    Error, VideoCodec,
    video::{
        ffi::{Buffer, Frame, check},
        sizing::EncodeLimits,
    },
};

/// The render node both VA displays and the DRM device are opened on. Fixed to the first
/// render node for now (accepted in M5a), a choice among several GPUs comes later.
pub(crate) const RENDER_NODE: &CStr = c"/dev/dri/renderD128";

/// Exports a VA surface as a DMA-BUF frame with duplicated file descriptors, so the frame
/// outlives the surface going back to its pool.
pub(crate) fn export_surface(surface: &Frame, width: u32, height: u32, capture_time: std::time::Instant) -> Result<super::DmaBufFrame, Error> {
    use std::os::fd::BorrowedFd;
    // SAFETY: the mapped frame is owned by a guard, the descriptor belongs to it.
    unsafe {
        let exported = Frame::alloc()?;
        (*exported.0).format = ff::AVPixelFormat::AV_PIX_FMT_DRM_PRIME as i32;
        check(ff::av_hwframe_map(exported.0, surface.0, ff::AV_HWFRAME_MAP_READ as i32), "export the surface")?;
        let descriptor = &*((*exported.0).data[0] as *const ff::AVDRMFrameDescriptor);
        if descriptor.nb_layers != 1 {
            return Err(Error::Media(format!("exported surface has {} layers", descriptor.nb_layers)));
        }
        let mut objects = Vec::new();
        for object in &descriptor.objects[..descriptor.nb_objects as usize] {
            let fd = BorrowedFd::borrow_raw(object.fd)
                .try_clone_to_owned()
                .map_err(|e| Error::io("duplicate DMA-BUF", e))?;
            objects.push(super::DmaBufObject { fd, size: object.size, modifier: object.format_modifier });
        }
        let layer = &descriptor.layers[0];
        let planes = layer.planes[..layer.nb_planes as usize]
            .iter()
            .map(|p| super::DmaBufPlane { object: p.object_index as usize, offset: p.offset as usize, pitch: p.pitch as usize })
            .collect();
        Ok(super::DmaBufFrame {
            width,
            height,
            fourcc: layer.format,
            objects,
            planes,
            capture_time,
        })
    }
}

// The few libva calls the size limits need. The values are from va.h (libva 2.24).
const VA_PROFILE_H264_CONSTRAINED_BASELINE: i32 = 13;
const VA_PROFILE_AV1_PROFILE0: i32 = 32;
const VA_ENTRYPOINT_ENC_SLICE: i32 = 6;
const VA_ENTRYPOINT_ENC_SLICE_LP: i32 = 8;
const VA_CONFIG_ATTRIB_RT_FORMAT: i32 = 0;
const VA_CONFIG_ATTRIB_MAX_PICTURE_WIDTH: i32 = 18;
const VA_CONFIG_ATTRIB_MAX_PICTURE_HEIGHT: i32 = 19;
const VA_RT_FORMAT_YUV420: u32 = 1;
const VA_ATTRIB_NOT_SUPPORTED: u32 = 0x8000_0000;

#[repr(C)]
struct VaConfigAttrib {
    kind: i32,
    value: u32,
}

#[link(name = "va")]
unsafe extern "C" {
    fn vaGetConfigAttributes(display: *mut c_void, profile: i32, entrypoint: i32, list: *mut VaConfigAttrib, count: i32) -> i32;
    fn vaCreateConfig(
        display: *mut c_void,
        profile: i32,
        entrypoint: i32,
        list: *mut VaConfigAttrib,
        count: i32,
        config: *mut u32,
    ) -> i32;
    fn vaDestroyConfig(display: *mut c_void, config: u32) -> i32;
}

/// The driver's `EncodeLimits` for `codec` on the VA display of `va`: Constrained Baseline for
/// H264, Profile 0 for AV1.
pub(crate) fn encode_limits(va: &Buffer, codec: VideoCodec) -> Result<EncodeLimits, Error> {
    let (profile, name) = match codec {
        VideoCodec::H264 => (VA_PROFILE_H264_CONSTRAINED_BASELINE, "H264"),
        VideoCodec::Av1 => (VA_PROFILE_AV1_PROFILE0, "AV1"),
    };
    // SAFETY: `va` is a VA-API device context, the config is destroyed before returning.
    unsafe {
        let device = (*va.0).data as *mut ff::AVHWDeviceContext;
        let display = (*((*device).hwctx as *mut ff::AVVAAPIDeviceContext)).display;
        let mut config = 0u32;
        let mut entrypoint = 0;
        for candidate in [VA_ENTRYPOINT_ENC_SLICE, VA_ENTRYPOINT_ENC_SLICE_LP] {
            let mut format = VaConfigAttrib { kind: VA_CONFIG_ATTRIB_RT_FORMAT, value: VA_RT_FORMAT_YUV420 };
            if vaCreateConfig(display, profile, candidate, &mut format, 1, &mut config) == 0 {
                entrypoint = candidate;
                break;
            }
        }
        if entrypoint == 0 {
            return Err(Error::Media(format!("the driver has no {name} encode config")));
        }
        let mut hwconfig = ff::AVVAAPIHWConfig { config_id: config };
        let constraints = ff::av_hwdevice_get_hwframe_constraints(va.0, &mut hwconfig as *mut _ as *const c_void);
        let mut attributes = [
            VaConfigAttrib { kind: VA_CONFIG_ATTRIB_MAX_PICTURE_WIDTH, value: 0 },
            VaConfigAttrib { kind: VA_CONFIG_ATTRIB_MAX_PICTURE_HEIGHT, value: 0 },
        ];
        let attributes_read =
            vaGetConfigAttributes(display, profile, entrypoint, attributes.as_mut_ptr(), 2) == 0;
        vaDestroyConfig(display, config);
        if constraints.is_null() {
            return Err(Error::Media(format!("the driver gave no surface limits for {name} encode")));
        }
        let c = &*constraints;
        let mut limits = EncodeLimits {
            min: (c.min_width.max(1) as u32, c.min_height.max(1) as u32),
            max: (c.max_width.max(0) as u32, c.max_height.max(0) as u32),
        };
        let mut constraints = constraints;
        ff::av_hwframe_constraints_free(&mut constraints);
        // A config maximum, where the driver has one, can only lower the surface maximum.
        let config_max = |value: u32| (attributes_read && value != 0 && value != VA_ATTRIB_NOT_SUPPORTED).then_some(value);
        if let Some(width) = config_max(attributes[0].value) {
            limits.max.0 = if limits.max.0 == 0 { width } else { limits.max.0.min(width) };
        }
        if let Some(height) = config_max(attributes[1].value) {
            limits.max.1 = if limits.max.1 == 0 { height } else { limits.max.1.min(height) };
        }
        if limits.max.0 == 0 || limits.max.1 == 0 {
            return Err(Error::Media(format!("the driver gave no maximum size for {name} encode")));
        }
        Ok(limits)
    }
}

/// Frees a DRM frame descriptor made by `drm_descriptor` and closes its file descriptors.
unsafe extern "C" fn free_descriptor(_opaque: *mut c_void, data: *mut u8) {
    // SAFETY: data came from Box::into_raw in drm_descriptor.
    let descriptor = unsafe { Box::from_raw(data as *mut ff::AVDRMFrameDescriptor) };
    for object in &descriptor.objects[..descriptor.nb_objects as usize] {
        // SAFETY: the descriptor owns these duplicates.
        drop(unsafe { OwnedFd::from_raw_fd(object.fd) });
    }
}

/// Wraps a heap descriptor whose file descriptors it owns in a buffer that frees both.
pub(crate) fn descriptor_buffer(descriptor: Box<ff::AVDRMFrameDescriptor>) -> Result<(*mut u8, *mut ff::AVBufferRef), Error> {
    let raw = Box::into_raw(descriptor) as *mut u8;
    // SAFETY: the buffer takes the box and frees it through free_descriptor.
    let buffer = unsafe {
        ff::av_buffer_create(raw, size_of::<ff::AVDRMFrameDescriptor>(), Some(free_descriptor), ptr::null_mut(), 0)
    };
    if buffer.is_null() {
        // SAFETY: the buffer was not made, the box is still ours.
        unsafe { free_descriptor(ptr::null_mut(), raw) };
        return Err(Error::Media("av_buffer_create failed".into()));
    }
    Ok((raw, buffer))
}
