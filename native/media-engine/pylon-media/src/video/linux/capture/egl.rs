// The DMA-BUF modifiers the GPU can import for a format, asked of EGL on the encoder's render
// node, as the references do (OBS, libwebrtc). Mesa answers EGL and VA-API imports from the same
// driver, so what EGL lists is what the video processor takes.

use std::{
    ffi::{CStr, c_char, c_void},
    ptr,
};

use crate::video::linux::va::RENDER_NODE;

type Display = *mut c_void;
type Device = *mut c_void;

const EGL_NONE: i32 = 0x3038;
const EGL_EXTENSIONS: i32 = 0x3055;
const EGL_PLATFORM_DEVICE_EXT: u32 = 0x313F;
const EGL_DRM_RENDER_NODE_FILE_EXT: i32 = 0x3377;
/// The implicit modifier: the buffer's layout is known to the driver alone.
pub(super) const DRM_FORMAT_MOD_INVALID: u64 = 0x00ff_ffff_ffff_ffff;

#[link(name = "EGL")]
unsafe extern "C" {
    fn eglGetProcAddress(name: *const c_char) -> *mut c_void;
    fn eglInitialize(display: Display, major: *mut i32, minor: *mut i32) -> u32;
    fn eglTerminate(display: Display) -> u32;
    fn eglQueryString(display: Display, name: i32) -> *const c_char;
}

type QueryDevices = unsafe extern "C" fn(max: i32, devices: *mut Device, count: *mut i32) -> u32;
type QueryDeviceString = unsafe extern "C" fn(device: Device, name: i32) -> *const c_char;
type GetPlatformDisplay = unsafe extern "C" fn(platform: u32, native: *mut c_void, attributes: *const i32) -> Display;
type QueryModifiers =
    unsafe extern "C" fn(display: Display, format: i32, max: i32, modifiers: *mut u64, external: *mut u32, count: *mut i32) -> u32;

/// An EGL entry point by name.
fn proc<T>(name: &CStr) -> Result<T, String> {
    // SAFETY: a lookup by name, the pointer is checked before it is used as a `T`.
    let found = unsafe { eglGetProcAddress(name.as_ptr()) };
    if found.is_null() {
        return Err(format!("EGL has no {}", name.to_string_lossy()));
    }
    // SAFETY: `T` is the function pointer type of that entry point.
    Ok(unsafe { std::mem::transmute_copy(&found) })
}

/// For each of `fourccs`, the modifiers the render node imports, the implicit one last.
pub(super) fn modifiers(fourccs: &[u32]) -> Result<Vec<(u32, Vec<u64>)>, String> {
    let query_devices: QueryDevices = proc(c"eglQueryDevicesEXT")?;
    let device_string: QueryDeviceString = proc(c"eglQueryDeviceStringEXT")?;
    let platform_display: GetPlatformDisplay = proc(c"eglGetPlatformDisplayEXT")?;
    let query_modifiers: QueryModifiers = proc(c"eglQueryDmaBufModifiersEXT")?;

    let mut devices = [ptr::null_mut(); 16];
    let mut count = 0;
    // SAFETY: the array holds 16 entries, count is written.
    if unsafe { query_devices(devices.len() as i32, devices.as_mut_ptr(), &mut count) } == 0 {
        return Err("eglQueryDevicesEXT failed".into());
    }
    let device = devices[..count.max(0) as usize]
        .iter()
        .copied()
        .find(|&device| {
            // SAFETY: a valid device, the string is owned by EGL.
            let node = unsafe { device_string(device, EGL_DRM_RENDER_NODE_FILE_EXT) };
            !node.is_null() && unsafe { CStr::from_ptr(node) } == RENDER_NODE
        })
        .ok_or_else(|| format!("no EGL device on {}", RENDER_NODE.to_string_lossy()))?;

    let attributes = [EGL_NONE];
    // SAFETY: a device from the list and a terminated attribute list.
    let display = unsafe { platform_display(EGL_PLATFORM_DEVICE_EXT, device, attributes.as_ptr()) };
    if display.is_null() {
        return Err("eglGetPlatformDisplayEXT failed".into());
    }
    // SAFETY: a display from EGL, the version is not needed.
    if unsafe { eglInitialize(display, ptr::null_mut(), ptr::null_mut()) } == 0 {
        return Err("eglInitialize failed".into());
    }
    let result = (|| {
        // SAFETY: an initialized display, the string is owned by EGL.
        let extensions = unsafe { eglQueryString(display, EGL_EXTENSIONS) };
        let extensions = if extensions.is_null() { String::new() } else { unsafe { CStr::from_ptr(extensions) }.to_string_lossy().into_owned() };
        if !extensions.split(' ').any(|e| e == "EGL_EXT_image_dma_buf_import_modifiers") {
            return Err("EGL lacks EGL_EXT_image_dma_buf_import_modifiers".to_string());
        }
        let mut lists = Vec::new();
        for &fourcc in fourccs {
            let mut count = 0;
            // SAFETY: asking for the count only.
            unsafe { query_modifiers(display, fourcc as i32, 0, ptr::null_mut(), ptr::null_mut(), &mut count) };
            let mut found = vec![0u64; count.max(0) as usize];
            let mut external = vec![0u32; found.len()];
            if !found.is_empty() {
                // SAFETY: both arrays hold `count` entries.
                unsafe { query_modifiers(display, fourcc as i32, count, found.as_mut_ptr(), external.as_mut_ptr(), &mut count) };
                found.truncate(count.max(0) as usize);
            }
            found.retain(|&m| m != DRM_FORMAT_MOD_INVALID);
            found.push(DRM_FORMAT_MOD_INVALID);
            lists.push((fourcc, found));
        }
        Ok(lists)
    })();
    // SAFETY: the display was initialized above.
    unsafe { eglTerminate(display) };
    result
}
