// Priority without elevation (smooth B3): the sidecar asks Windows for a higher CPU class, the
// media threads join MMCSS, and the D3D11 device asks for GPU priority. Never the realtime class,
// no helper, no registry. Every failure is logged and ignored. A no-op off Windows (and on
// Windows without `encode`, which brings the `windows` crate).
//
// PYLON_MEDIA_PRIORITY limits what is asked, a switch for support:
// - `off`: nothing.
// - `cpu`: the process's class (above normal) and the media threads (MMCSS `Capture` at high,
//   else above normal).
// - `gpu-thread`: also `IDXGIDevice::SetGPUThreadPriority(7)` on the capture's device.
// - `all` (the default): also the process's GPU scheduling class (high).
// `all` is the default although on the Intel laptop no level sent more frames than `off`: every
// call succeeds without elevation, `all` cost the load test's load nothing and cut the encode
// time by about a tenth, and the case it is for (an NVIDIA card held by an uncapped game) could
// not be measured there (smooth B3, decision revised by Fable at 04:55).

/// What `PYLON_MEDIA_PRIORITY` asks for, in the order each adds to the one before.
#[cfg_attr(not(all(target_os = "windows", feature = "encode")), allow(dead_code))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Level {
    Off,
    Cpu,
    GpuThread,
    All,
}

/// The level when the variable is not set (smooth B3, revised at 04:55).
#[cfg_attr(not(all(target_os = "windows", feature = "encode")), allow(dead_code))]
const DEFAULT: Level = Level::All;

#[cfg_attr(not(all(target_os = "windows", feature = "encode")), allow(dead_code))]
impl Level {
    fn name(self) -> &'static str {
        match self {
            Level::Off => "off",
            Level::Cpu => "cpu",
            Level::GpuThread => "gpu-thread",
            Level::All => "all",
        }
    }

    /// From the variable, once.
    fn get() -> Level {
        static LEVEL: std::sync::OnceLock<Level> = std::sync::OnceLock::new();
        *LEVEL.get_or_init(|| match std::env::var("PYLON_MEDIA_PRIORITY") {
            Err(_) => DEFAULT,
            Ok(text) => match text.as_str() {
                "off" => Level::Off,
                "cpu" => Level::Cpu,
                "gpu-thread" => Level::GpuThread,
                "all" => Level::All,
                _ => {
                    tracing::warn!(value = %text, default = DEFAULT.name(), "PYLON_MEDIA_PRIORITY is off, cpu, gpu-thread or all");
                    DEFAULT
                }
            },
        })
    }
}

#[cfg(all(target_os = "windows", feature = "encode"))]
mod imp {
    use ::windows::{
        Wdk::Graphics::Direct3D::{
            D3DKMT_SCHEDULINGPRIORITYCLASS, D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH, D3DKMTGetProcessSchedulingPriorityClass,
            D3DKMTSetProcessSchedulingPriorityClass,
        },
        Win32::{
            Foundation::HANDLE,
            Graphics::{Direct3D11::ID3D11Device, Dxgi::IDXGIDevice},
            System::Threading::{
                ABOVE_NORMAL_PRIORITY_CLASS, AVRT_PRIORITY_HIGH, AvRevertMmThreadCharacteristics, AvSetMmThreadCharacteristicsW,
                AvSetMmThreadPriority, GetCurrentProcess, GetCurrentThread, GetPriorityClass, GetThreadPriority, SetPriorityClass,
                SetThreadPriority, THREAD_PRIORITY_ABOVE_NORMAL,
            },
        },
        core::{Interface, w},
    };

    use super::Level;

    /// A process class as Windows names it.
    fn class_name(class: u32) -> String {
        match class {
            0x20 => "normal".into(),
            0x40 => "idle".into(),
            0x80 => "high".into(),
            0x100 => "realtime".into(),
            0x4000 => "below normal".into(),
            0x8000 => "above normal".into(),
            0 => "unknown (GetPriorityClass failed)".into(),
            other => format!("{other:#x}"),
        }
    }

    pub(super) fn process() {
        let level = Level::get();
        if level < Level::Cpu {
            tracing::info!(level = level.name(), "priority: nothing asked");
            return;
        }
        // SAFETY: plain calls on the current process's pseudo handle.
        let (set, class) = unsafe { (SetPriorityClass(GetCurrentProcess(), ABOVE_NORMAL_PRIORITY_CLASS), GetPriorityClass(GetCurrentProcess())) };
        let answer = match set {
            Ok(()) => "ok".to_owned(),
            Err(error) => error.to_string(),
        };
        tracing::info!(level = level.name(), asked = "process class above normal", %answer, class = class_name(class), "priority");
    }

    /// The thread's MMCSS registration, given back when it goes.
    pub struct Thread(Option<HANDLE>);

    impl Drop for Thread {
        fn drop(&mut self) {
            if let Some(handle) = self.0.take() {
                // SAFETY: the handle AvSetMmThreadCharacteristicsW gave this thread.
                let _ = unsafe { AvRevertMmThreadCharacteristics(handle) };
            }
        }
    }

    pub(super) fn media_thread() -> Thread {
        let level = Level::get();
        if level < Level::Cpu {
            return Thread(None);
        }
        let name = std::thread::current().name().unwrap_or("unnamed").to_owned();
        let mut task = 0u32;
        // SAFETY: plain calls for the calling thread; the task name is a static wide string.
        unsafe {
            match AvSetMmThreadCharacteristicsW(w!("Capture"), &mut task) {
                Ok(handle) => {
                    let answer = match AvSetMmThreadPriority(handle, AVRT_PRIORITY_HIGH) {
                        Ok(()) => "ok".to_owned(),
                        Err(error) => format!("MMCSS joined, its priority refused: {error}"),
                    };
                    let priority = GetThreadPriority(GetCurrentThread());
                    tracing::info!(thread = %name, asked = "MMCSS Capture at high", %answer, task, priority, "priority");
                    Thread(Some(handle))
                }
                Err(mmcss) => {
                    let answer = match SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_ABOVE_NORMAL) {
                        Ok(()) => "ok".to_owned(),
                        Err(error) => error.to_string(),
                    };
                    let priority = GetThreadPriority(GetCurrentThread());
                    tracing::info!(thread = %name, asked = "MMCSS Capture at high, else above normal", mmcss = %mmcss, above_normal = %answer, priority, "priority");
                    Thread(None)
                }
            }
        }
    }

    pub(super) fn gpu(device: &ID3D11Device) {
        let level = Level::get();
        if level < Level::GpuThread {
            return;
        }
        let thread = match device.cast::<IDXGIDevice>() {
            // SAFETY: plain COM calls on an owned interface.
            Ok(dxgi) => unsafe {
                let set = dxgi.SetGPUThreadPriority(7);
                let now = dxgi.GetGPUThreadPriority().map_or_else(|e| e.to_string(), |p| p.to_string());
                match set {
                    Ok(()) => format!("ok, now {now}"),
                    Err(error) => format!("{error}, now {now}"),
                }
            },
            Err(error) => format!("no IDXGIDevice: {error}"),
        };
        if level < Level::All {
            tracing::info!(level = level.name(), asked = "GPU thread priority 7", gpu_thread = %thread, "priority");
            return;
        }
        // SAFETY: plain calls on the current process's pseudo handle and an owned integer.
        let (status, class) = unsafe {
            let status = D3DKMTSetProcessSchedulingPriorityClass(GetCurrentProcess(), D3DKMT_SCHEDULINGPRIORITYCLASS_HIGH);
            let mut class = D3DKMT_SCHEDULINGPRIORITYCLASS(-1);
            let got = D3DKMTGetProcessSchedulingPriorityClass(GetCurrentProcess(), &mut class);
            (status, if got.is_ok() { class.0.to_string() } else { format!("unknown ({:#x})", got.0) })
        };
        let scheduling = if status.is_ok() { "ok".to_owned() } else { format!("refused, NTSTATUS {:#x}", status.0) };
        tracing::info!(
            level = level.name(),
            asked = "GPU thread priority 7, GPU scheduling class high",
            gpu_thread = %thread,
            %scheduling,
            class,
            "priority"
        );
    }
}

/// Asks for the process's class: above normal. Once, at the sidecar's start.
pub fn process() {
    #[cfg(all(target_os = "windows", feature = "encode"))]
    imp::process();
}

/// What a media thread holds for as long as it runs (its MMCSS registration on Windows).
#[must_use]
pub struct MediaThread {
    #[cfg(all(target_os = "windows", feature = "encode"))]
    _thread: imp::Thread,
}

/// The calling thread joins MMCSS (task `Capture`, high), else asks for above normal. Keep what
/// it gives for the thread's life.
pub fn media_thread() -> MediaThread {
    MediaThread {
        #[cfg(all(target_os = "windows", feature = "encode"))]
        _thread: imp::media_thread(),
    }
}

/// Asks for the GPU's priority for `device` (the capture's D3D11 device) and for the process's
/// GPU scheduling class, as far as the level allows.
#[cfg(all(target_os = "windows", feature = "encode"))]
pub(crate) fn gpu(device: &::windows::Win32::Graphics::Direct3D11::ID3D11Device) {
    imp::gpu(device);
}
