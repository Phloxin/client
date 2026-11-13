// The one D3D11 device the pattern producer or the capture, the video processor and the encoder
// share (.plans/native-media-engine-m7-4-windows-encoder.md, N4), on an adapter whose vendor has
// an encoder here: Intel's Quick Sync or NVIDIA's NVENC. For a capture it is the adapter that
// drives the captured monitor (.plans/native-media-engine-m7-5-windows-capture.md, C4).

use std::sync::Arc;

use ::windows::{
    Win32::{
        Foundation::HMODULE,
        Graphics::{
            Direct3D::{D3D_DRIVER_TYPE_UNKNOWN, D3D_FEATURE_LEVEL, D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_11_1},
            Direct3D11::{
                D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_CREATE_DEVICE_VIDEO_SUPPORT, D3D11_SDK_VERSION, D3D11CreateDevice, ID3D11Device,
                ID3D11DeviceContext, ID3D11Multithread,
            },
            Dxgi::{CreateDXGIFactory1, DXGI_ADAPTER_FLAG_SOFTWARE, IDXGIAdapter1, IDXGIFactory1},
        },
    },
    core::Interface,
};
use ffmpeg_sys_next as ff;

use crate::{
    Error,
    video::ffi::{Buffer, check},
};

/// Names the adapter to use, for tests: an index, `intel` or `nvidia`.
const ADAPTER_VARIABLE: &str = "PYLON_MEDIA_ADAPTER";

/// A vendor whose GPUs have an encoder here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Vendor {
    Intel,
    Nvidia,
}

impl Vendor {
    fn of(id: u32) -> Option<Vendor> {
        match id {
            0x8086 => Some(Vendor::Intel),
            0x10de => Some(Vendor::Nvidia),
            _ => None,
        }
    }
}

/// The D3D11 device, with FFmpeg's D3D11VA device context on it.
pub(crate) struct Device {
    /// FFmpeg's device context, which holds a reference to `device`.
    pub(crate) ffmpeg: Buffer,
    pub(crate) device: ID3D11Device,
    pub(crate) context: ID3D11DeviceContext,
    pub(crate) vendor: Vendor,
    /// The adapter as messages name it: its index and description.
    pub(crate) adapter: String,
}

// SAFETY: a D3D11 device is free threaded, its immediate context is serialized by the device's
// multithread protection (switched on in `open`), and FFmpeg's device context is only read.
unsafe impl Send for Device {}
unsafe impl Sync for Device {}

fn wide(text: &[u16]) -> String {
    let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
    String::from_utf16_lossy(&text[..end])
}

/// One DXGI adapter.
struct Adapter {
    index: u32,
    adapter: IDXGIAdapter1,
    description: String,
    vendor_id: u32,
    software: bool,
}

impl Adapter {
    fn name(&self) -> String {
        format!("adapter {} \"{}\"", self.index, self.description)
    }
}

fn adapters() -> Result<Vec<Adapter>, Error> {
    // SAFETY: plain COM calls, the results are owned.
    unsafe {
        let factory: IDXGIFactory1 = CreateDXGIFactory1().map_err(|e| Error::Media(format!("CreateDXGIFactory1: {e}")))?;
        let mut list = Vec::new();
        let mut index = 0;
        while let Ok(adapter) = factory.EnumAdapters1(index) {
            let desc = adapter.GetDesc1().map_err(|e| Error::Media(format!("adapter {index}: GetDesc1: {e}")))?;
            list.push(Adapter {
                index,
                adapter,
                description: wide(&desc.Description),
                vendor_id: desc.VendorId,
                software: desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE.0 as u32 != 0,
            });
            index += 1;
        }
        Ok(list)
    }
}

/// Whether `adapter` drives the monitor `monitor` (an `HMONITOR` as a number): one of its outputs
/// is that monitor.
#[cfg(feature = "capture")]
fn drives(adapter: &IDXGIAdapter1, monitor: isize) -> bool {
    let mut index = 0;
    // SAFETY: plain COM calls, the results are owned.
    while let Ok(output) = unsafe { adapter.EnumOutputs(index) } {
        if unsafe { output.GetDesc() }.is_ok_and(|desc| desc.Monitor.0 as isize == monitor) {
            return true;
        }
        index += 1;
    }
    false
}

/// The adapter `which` names (an index, `intel` or `nvidia`), else the one that drives `monitor`
/// when one is given (the captured screen, M7.5 C4), else the first hardware adapter whose
/// vendor has an encoder here.
fn choose(adapters: Vec<Adapter>, which: Option<&str>, monitor: Option<isize>) -> Result<(Adapter, Vendor), Error> {
    #[cfg(not(feature = "capture"))]
    let _ = monitor;
    #[cfg(feature = "capture")]
    if which.is_none()
        && let Some(monitor) = monitor
    {
        let found = adapters
            .into_iter()
            .find(|a| drives(&a.adapter, monitor))
            .ok_or_else(|| Error::Media(format!("no adapter drives the monitor {monitor:#x}")))?;
        return match Vendor::of(found.vendor_id) {
            Some(vendor) => Ok((found, vendor)),
            None => Err(Error::Media(format!("{} drives the captured monitor and (vendor {:#06x}) has no encoder here", found.name(), found.vendor_id))),
        };
    }
    let found = match which {
        Some(which) => {
            let wanted = match which.to_ascii_lowercase().as_str() {
                "intel" => Some(0x8086),
                "nvidia" => Some(0x10de),
                _ => None,
            };
            let index: Option<u32> = which.parse().ok();
            if wanted.is_none() && index.is_none() {
                return Err(Error::invalid(format!("{ADAPTER_VARIABLE}={which}: an index, intel or nvidia")));
            }
            adapters
                .into_iter()
                .find(|a| Some(a.vendor_id) == wanted || Some(a.index) == index)
                .ok_or_else(|| Error::Media(format!("{ADAPTER_VARIABLE}={which} names no adapter")))?
        }
        None => adapters
            .into_iter()
            .find(|a| !a.software && Vendor::of(a.vendor_id).is_some())
            .ok_or_else(|| Error::Media("no hardware adapter with an encoder here (Intel or NVIDIA)".into()))?,
    };
    match Vendor::of(found.vendor_id) {
        Some(vendor) => Ok((found, vendor)),
        None => Err(Error::Media(format!("{} (vendor {:#06x}) has no encoder here", found.name(), found.vendor_id))),
    }
}

impl Device {
    /// Runs `f` with the immediate context under FFmpeg's lock of the device (the one its own
    /// D3D11 code takes around the context), for a call that does not wait for the GPU (M6
    /// preview step 3, W3).
    pub(crate) fn with_context<R>(&self, f: impl FnOnce(&ID3D11DeviceContext) -> R) -> R {
        // SAFETY: FFmpeg's device context is initialised (`open`), which set its lock functions.
        let hw = unsafe { &*((*((*self.ffmpeg.0).data as *mut ff::AVHWDeviceContext)).hwctx as *const ff::AVD3D11VADeviceContext) };
        struct Unlock(Option<unsafe extern "C" fn(*mut std::ffi::c_void)>, *mut std::ffi::c_void);
        impl Drop for Unlock {
            fn drop(&mut self) {
                if let Some(unlock) = self.0 {
                    // SAFETY: the lock taken below, with its own context.
                    unsafe { unlock(self.1) };
                }
            }
        }
        if let Some(lock) = hw.lock {
            // SAFETY: FFmpeg's lock function with its own context.
            unsafe { lock(hw.lock_ctx) };
        }
        let _unlock = Unlock(hw.lock.and(hw.unlock), hw.lock_ctx);
        f(&self.context)
    }

    /// The device on the adapter of N4, with video support and multithread protection.
    pub(crate) fn open() -> Result<Arc<Device>, Error> {
        Self::open_for(None)
    }

    /// As `open`, but on the adapter that drives `monitor` (an `HMONITOR` as a number) when one
    /// is given and `PYLON_MEDIA_ADAPTER` is not set (M7.5 C4).
    pub(crate) fn open_for(monitor: Option<isize>) -> Result<Arc<Device>, Error> {
        let which = std::env::var(ADAPTER_VARIABLE).ok();
        let (adapter, vendor) = choose(adapters()?, which.as_deref(), monitor)?;
        let name = adapter.name();
        // SAFETY: COM calls on owned interfaces; FFmpeg's context takes its own reference.
        unsafe {
            let mut device: Option<ID3D11Device> = None;
            let mut level = D3D_FEATURE_LEVEL::default();
            D3D11CreateDevice(
                &adapter.adapter,
                D3D_DRIVER_TYPE_UNKNOWN,
                HMODULE::default(),
                D3D11_CREATE_DEVICE_VIDEO_SUPPORT | D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                Some(&[D3D_FEATURE_LEVEL_11_1, D3D_FEATURE_LEVEL_11_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                Some(&mut level),
                None,
            )
            .map_err(|e| Error::Media(format!("D3D11 device on {name}: {e}")))?;
            let device = device.ok_or_else(|| Error::Media(format!("D3D11 device on {name}: none made")))?;
            // As FFmpeg's own D3D11VA device does it. Quick Sync refuses the device without it.
            let multithread: ID3D11Multithread = device.cast().map_err(|e| Error::Media(format!("{name}: ID3D11Multithread: {e}")))?;
            let _ = multithread.SetMultithreadProtected(true);
            let context = device.GetImmediateContext().map_err(|e| Error::Media(format!("{name}: immediate context: {e}")))?;

            let ffmpeg = Buffer(ff::av_hwdevice_ctx_alloc(ff::AVHWDeviceType::AV_HWDEVICE_TYPE_D3D11VA));
            if ffmpeg.0.is_null() {
                return Err(Error::Media("av_hwdevice_ctx_alloc failed".into()));
            }
            let hw = (*((*ffmpeg.0).data as *mut ff::AVHWDeviceContext)).hwctx as *mut ff::AVD3D11VADeviceContext;
            // FFmpeg's context takes this reference and releases it when it goes.
            (*hw).device = device.clone().into_raw() as *mut _;
            check(ff::av_hwdevice_ctx_init(ffmpeg.0), &format!("FFmpeg's D3D11VA device on {name}"))?;
            tracing::info!(adapter = %name, ?vendor, level = format!("{:#x}", level.0), "D3D11 device");
            Ok(Arc::new(Device { ffmpeg, device, context, vendor, adapter: name }))
        }
    }
}
