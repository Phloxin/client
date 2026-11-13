// Windows Graphics Capture's side (.plans/native-media-engine-m7-5-windows-capture.md, C1 to C6
// and C9 to C11): the item made from a window or a monitor without the system's picker, a free
// threaded pool of BGRA textures on the encoder's own device, the session with the cursor drawn
// in and, where Windows allows it, no border.

use std::{
    sync::{
        Arc, Condvar, Mutex, Once,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use ::windows::{
    Foundation::{TimeSpan, TypedEventHandler},
    Graphics::{
        Capture::{Direct3D11CaptureFrame, Direct3D11CaptureFramePool, GraphicsCaptureItem, GraphicsCaptureSession},
        DirectX::{Direct3D11::IDirect3DDevice, DirectXPixelFormat},
        SizeInt32,
    },
    Win32::{
        Foundation::{HWND, POINT},
        Graphics::{
            Direct3D11::{D3D11_TEXTURE2D_DESC, ID3D11Texture2D},
            Dxgi::IDXGIDevice,
            Gdi::{HMONITOR, MONITOR_DEFAULTTONEAREST, MONITOR_DEFAULTTONULL, MONITOR_DEFAULTTOPRIMARY, MonitorFromPoint, MonitorFromWindow},
        },
        System::{
            Com::CoIncrementMTAUsage,
            WinRT::{
                CreateDispatcherQueueController, DQTAT_COM_NONE, DQTYPE_THREAD_CURRENT, DispatcherQueueOptions,
                Direct3D11::{CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess},
                Graphics::Capture::IGraphicsCaptureItemInterop,
            },
        },
        UI::{
            HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetProcessDpiAwarenessContext},
            WindowsAndMessaging::{DispatchMessageW, IsWindow, MSG, MsgWaitForMultipleObjects, PM_REMOVE, PeekMessageW, QS_ALLINPUT, TranslateMessage},
        },
    },
    core::{IInspectable, Interface, factory},
};

use super::{CaptureEvent, CaptureInfo, CaptureTarget, Events, Shared, failed, finish};
use crate::video::windows::{D3d11Frame, Hold, device::Device};

/// The pool's buffers: one being encoded, one kept, one waiting, one for Windows to draw (C5).
const BUFFERS: i32 = 4;
const FORMAT: DirectXPixelFormat = DirectXPixelFormat::B8G8R8A8UIntNormalized;
/// Without a first frame this long after the start, `Ready` goes out anyway (as on Linux).
const READY_WITHOUT_FRAME: Duration = Duration::from_secs(3);
/// How often the capture's thread looks at the stop flag between messages.
const STOP_POLL: Duration = Duration::from_millis(50);
/// How long the capture waits at its end for the pipeline to let go of its frames.
const FRAMES_BACK: Duration = Duration::from_secs(1);

/// Makes the process per-monitor DPI aware, so that window and monitor sizes and points are
/// physical pixels (C1). Call it at start, before any window or monitor is looked at.
pub fn make_dpi_aware() {
    // SAFETY: a plain call.
    match unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) } {
        Ok(()) => tracing::debug!("per-monitor DPI aware"),
        // Also when it was set already, by a manifest or an earlier call.
        Err(error) => tracing::info!(%error, "per-monitor DPI awareness not set"),
    }
}

/// Keeps the process's multithreaded apartment, and with it the Windows Runtime, for the life of
/// the process (M7.5b Z2). Once, whoever calls first; never undone. Call it when a process that
/// will capture starts.
///
/// Without it the apartment lived only as long as the threads that had entered it: the capture's
/// own thread and Windows Graphics Capture's frame thread. When the last of them left, COM
/// unloaded GraphicsCapture.dll, and when that happened while the frame thread was still running
/// in the DLL, the process ended with an access violation in `GraphicsCapture.dll_unloaded`: about
/// half the teardowns (.plans/native-media-engine-m7-5b-capture-teardown.md, section 6).
pub fn init_runtime() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: a plain call. The cookie is never given back, so the apartment stays.
        match unsafe { CoIncrementMTAUsage() } {
            Ok(_cookie) => tracing::debug!("the process's multithreaded apartment is kept"),
            Err(error) => tracing::warn!(%error, "CoIncrementMTAUsage, the capture may crash at its end"),
        }
    });
}

/// A target looked up: the window (a handle as a number) or none, and the monitor (an
/// `HMONITOR` as a number) that holds it.
#[derive(Clone, Copy, Debug)]
pub(super) struct Resolved {
    window: Option<isize>,
    monitor: isize,
}

impl Resolved {
    fn source(&self) -> &'static str {
        if self.window.is_some() { "window" } else { "monitor" }
    }
}

/// The window or monitor `target` names, or why there is none (C2).
pub(super) fn resolve(target: Option<CaptureTarget>) -> Result<Resolved, String> {
    // SAFETY: plain calls on values that need not be valid handles.
    unsafe {
        match target {
            Some(CaptureTarget::Window(handle)) => {
                let hwnd = HWND(handle as usize as *mut _);
                if handle == 0 || !IsWindow(Some(hwnd)).as_bool() {
                    return Err(format!("window {handle} does not exist"));
                }
                // The monitor it is mostly on (C4).
                let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
                Ok(Resolved { window: Some(handle as isize), monitor: monitor.0 as isize })
            }
            Some(CaptureTarget::Monitor { x, y }) => {
                let monitor = MonitorFromPoint(POINT { x, y }, MONITOR_DEFAULTTONULL);
                if monitor.is_invalid() {
                    return Err(format!("no monitor at ({x}, {y})"));
                }
                Ok(Resolved { window: None, monitor: monitor.0 as isize })
            }
            None => {
                let monitor = MonitorFromPoint(POINT { x: 0, y: 0 }, MONITOR_DEFAULTTOPRIMARY);
                if monitor.is_invalid() {
                    return Err("no primary monitor".into());
                }
                Ok(Resolved { window: None, monitor: monitor.0 as isize })
            }
        }
    }
}

/// The WinRT device for the pool's threads.
struct Agile(IDirect3DDevice);

// SAFETY: the WinRT device made by CreateDirect3D11DeviceFromDXGIDevice is agile (free threaded),
// and the D3D11 device under it is multithread protected.
unsafe impl Send for Agile {}
unsafe impl Sync for Agile {}

impl Agile {
    // A method, so a closure takes the whole wrapper and not its field.
    fn get(&self) -> &IDirect3DDevice {
        &self.0
    }
}

/// The capture's frame object, given back to the pool when the frame that holds it goes. It is
/// counted, so that the pool is closed only once the pipeline has let go of its frames.
struct Returned(Direct3D11CaptureFrame, Arc<Outstanding>);

impl Returned {
    fn new(frame: Direct3D11CaptureFrame, outstanding: &Arc<Outstanding>) -> Returned {
        if let Ok(mut count) = outstanding.count.lock() {
            *count += 1;
        }
        Returned(frame, outstanding.clone())
    }
}

impl Drop for Returned {
    fn drop(&mut self) {
        let _ = self.0.Close();
        if let Ok(mut count) = self.1.count.lock() {
            *count = count.saturating_sub(1);
        }
        self.1.zero.notify_all();
    }
}

/// The frames out of the pool. The pool is closed only once they are back: closing it while the
/// pipeline still held a frame, or while the encoder was being torn down on the same device, ended
/// the process with an access violation after a resize (seen on the laptop). The pipeline drops
/// its encoder before its kept frame, so waiting for the frames also waits for the encoder.
#[derive(Default)]
struct Outstanding {
    count: Mutex<usize>,
    zero: Condvar,
}

impl Outstanding {
    /// Waits up to `most` for every frame to come back. False if some did not.
    fn wait_all_back(&self, most: Duration) -> bool {
        let Ok(count) = self.count.lock() else { return false };
        match self.zero.wait_timeout_while(count, most, |count| *count > 0) {
            Ok((count, _)) => *count == 0,
            Err(_) => false,
        }
    }
}

/// What the event handlers share.
struct Live {
    info: CaptureInfo,
    events: Events,
    ready_sent: AtomicBool,
    outstanding: Arc<Outstanding>,
}

impl Live {
    /// `Ready`, once.
    fn ready(&self, with_frame: bool) {
        if self.ready_sent.swap(true, Ordering::Relaxed) {
            return;
        }
        let info = &self.info;
        tracing::info!(
            width = info.width,
            height = info.height,
            source = info.source,
            adapter = %info.adapter,
            border = ?info.border,
            min_update_ms = ?info.min_update_ms,
            with_frame,
            "capture ready"
        );
        (self.events)(CaptureEvent::Ready(info.clone()));
    }
}

/// The running capture's objects.
struct Started {
    item: GraphicsCaptureItem,
    pool: Direct3D11CaptureFramePool,
    session: GraphicsCaptureSession,
    arrived: i64,
    closed: i64,
    live: Arc<Live>,
}

impl Started {
    /// The first half of the end (M7.5b Z3): the handlers are removed and the session is closed, so
    /// nothing more is delivered. The pool stays open for the frames the pipeline still holds.
    fn stop_delivering(&self) {
        let removed = (self.pool.RemoveFrameArrived(self.arrived), self.item.RemoveClosed(self.closed));
        let session = self.session.Close();
        tracing::debug!(?removed, ?session, "capture stopped delivering");
    }

    /// The second half, once every frame is back (C5): the pool is closed, then the item, the pool
    /// and the session are released.
    fn close_pool(self) {
        let pool = self.pool.Close();
        tracing::debug!(?pool, "capture pool closed");
    }
}

/// The capture's thread: starts it, then waits until it is stopped or the item went away.
pub(super) fn run(resolved: Resolved, max_fps: Option<u32>, shared: Arc<Shared>, events: Events) {
    // No apartment of its own: the thread is in the process's multithreaded apartment, which
    // `init_runtime` keeps for the life of the process (M7.5b Z2). This thread ending must not end
    // it, or Windows unloads GraphicsCapture.dll while the capture's frame thread still runs in it.
    init_runtime();
    // The item's closed event comes through the thread that made the item, which needs a
    // dispatcher queue and must pump its messages: without them it never came on the laptop
    // (M7.5 C11). Frames come on the pool's own threads either way.
    let options = DispatcherQueueOptions {
        dwSize: size_of::<DispatcherQueueOptions>() as u32,
        threadType: DQTYPE_THREAD_CURRENT,
        apartmentType: DQTAT_COM_NONE,
    };
    // SAFETY: a plain call for this thread.
    let queue = match unsafe { CreateDispatcherQueueController(options) } {
        Ok(queue) => Some(queue),
        Err(error) => {
            tracing::warn!(%error, "no dispatcher queue for the capture's thread, a closed window may not end the capture");
            None
        }
    };
    let started = match start(resolved, max_fps, &shared, &events) {
        Ok(started) => started,
        Err(message) => {
            failed(&shared, &events, message);
            return finish(&shared);
        }
    };
    let began = Instant::now();
    while !shared.stop.load(Ordering::Relaxed) && !shared.state.lock().map_or(true, |state| state.ended) {
        if began.elapsed() >= READY_WITHOUT_FRAME && !started.live.ready_sent.load(Ordering::Relaxed) {
            tracing::warn!("no frame since the capture started, ready without one");
            started.live.ready(false);
        }
        pump(STOP_POLL);
    }
    // An orderly end (M7.5b Z3): nothing more is delivered (the waiting frame goes back and no new
    // one is kept), the handlers go and the session closes, then the pool closes once every frame
    // the pipeline held is back (C5). The pipeline lets go of its own when it stops.
    finish(&shared);
    started.stop_delivering();
    if !started.live.outstanding.wait_all_back(FRAMES_BACK) {
        tracing::warn!(after_ms = FRAMES_BACK.as_millis() as u64, "capture frames still held, the pool closes anyway");
    }
    started.close_pool();
    drop(queue);
}

/// Waits up to `most` for messages to this thread and dispatches them.
fn pump(most: Duration) {
    // SAFETY: plain calls on this thread's own message queue.
    unsafe {
        MsgWaitForMultipleObjects(None, false, most.as_millis() as u32, QS_ALLINPUT);
        let mut message = MSG::default();
        while PeekMessageW(&mut message, None, 0, 0, PM_REMOVE).as_bool() {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn start(resolved: Resolved, max_fps: Option<u32>, shared: &Arc<Shared>, events: &Events) -> Result<Started, String> {
    let source = resolved.source();
    let device = Device::open_for(Some(resolved.monitor)).map_err(|e| e.to_string())?;
    let winrt = |what: &str, e: ::windows::core::Error| format!("Windows Graphics Capture: {what}: {e}");
    // SAFETY: WinRT and COM calls on owned objects; the handles were checked by `resolve` and a
    // window that went since then is an error of the call.
    unsafe {
        if !GraphicsCaptureSession::IsSupported().map_err(|e| winrt("IsSupported", e))? {
            return Err("Windows Graphics Capture is not supported on this system".into());
        }
        let interop = factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|e| winrt("item factory", e))?;
        let item: GraphicsCaptureItem = match resolved.window {
            Some(window) => interop
                .CreateForWindow(HWND(window as *mut _))
                .map_err(|e| format!("Windows Graphics Capture: window {window}: {e}"))?,
            None => interop
                .CreateForMonitor(HMONITOR(resolved.monitor as *mut _))
                .map_err(|e| format!("Windows Graphics Capture: monitor {:#x}: {e}", resolved.monitor))?,
        };
        let size = item.Size().map_err(|e| winrt("item size", e))?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err(format!("the {source} has no size ({}x{})", size.Width, size.Height));
        }
        let dxgi: IDXGIDevice = device.device.cast().map_err(|e| winrt("IDXGIDevice", e))?;
        let inspectable = CreateDirect3D11DeviceFromDXGIDevice(&dxgi).map_err(|e| winrt("WinRT device", e))?;
        let winrt_device: IDirect3DDevice = inspectable.cast().map_err(|e| winrt("IDirect3DDevice", e))?;
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(&winrt_device, FORMAT, BUFFERS, size).map_err(|e| winrt("frame pool", e))?;
        let session = pool.CreateCaptureSession(&item).map_err(|e| winrt("session", e))?;
        // The cursor in the picture, no border where Windows allows it (C10).
        if let Err(error) = session.SetIsCursorCaptureEnabled(true) {
            tracing::warn!(%error, "the cursor could not be drawn in");
        }
        if let Err(error) = session.SetIsBorderRequired(false) {
            tracing::info!(%error, "the capture border could not be turned off");
        }
        let border = session.IsBorderRequired().ok();
        // At most `max_fps` from Windows where it has the setting (C9). The token bucket limits
        // either way.
        if let Some(fps) = max_fps
            && let Err(error) = session.SetMinUpdateInterval(TimeSpan { Duration: 10_000_000 / i64::from(fps) })
        {
            tracing::info!(%error, fps, "the capture's least update interval could not be set");
        }
        let min_update_ms = session.MinUpdateInterval().ok().map(|t| t.Duration as f64 / 10_000.0);
        let info = CaptureInfo {
            width: size.Width as u32,
            height: size.Height as u32,
            source,
            adapter: device.adapter.clone(),
            border,
            min_update_ms,
        };
        if let Ok(mut started) = shared.started.lock() {
            *started = Some((device.clone(), (info.width, info.height)));
        }
        let live = Arc::new(Live { info, events: events.clone(), ready_sent: AtomicBool::new(false), outstanding: Arc::default() });

        let arrived = {
            let shared = shared.clone();
            let live = live.clone();
            let pool_size = Mutex::new(size);
            let device = Agile(winrt_device);
            TypedEventHandler::<Direct3D11CaptureFramePool, IInspectable>::new(move |pool, _| {
                if let Some(pool) = pool.as_ref() {
                    frames(pool, device.get(), &pool_size, &shared, &live);
                }
                Ok(())
            })
        };
        let arrived = pool.FrameArrived(&arrived).map_err(|e| winrt("FrameArrived", e))?;
        let closed = {
            let shared = shared.clone();
            let live = live.clone();
            TypedEventHandler::<GraphicsCaptureItem, IInspectable>::new(move |_, _| {
                item_closed(&shared, &live);
                Ok(())
            })
        };
        let closed = item.Closed(&closed).map_err(|e| winrt("Closed", e))?;
        session.StartCapture().map_err(|e| winrt("StartCapture", e))?;
        tracing::info!(source, width = size.Width, height = size.Height, buffers = BUFFERS, "capture started");
        Ok(Started { item, pool, session, arrived, closed, live })
    }
}

/// Takes every frame the pool has: the newest waits for the pipeline, an older one waiting is
/// replaced and counted as dropped (C5).
fn frames(pool: &Direct3D11CaptureFramePool, device: &IDirect3DDevice, pool_size: &Mutex<SizeInt32>, shared: &Shared, live: &Live) {
    while let Ok(frame) = pool.TryGetNextFrame() {
        let arrived = Instant::now();
        match frame_of(frame, arrived, pool, device, pool_size, live) {
            Ok(Some(frame)) => {
                live.ready(true);
                let replaced = match shared.state.lock() {
                    Ok(mut state) if !state.ended => {
                        state.delivered += 1;
                        let replaced = state.pending.replace(frame);
                        state.dropped += u64::from(replaced.is_some());
                        replaced
                    }
                    _ => None,
                };
                shared.changed.notify_all();
                // Its buffer goes back to the pool, outside the lock.
                drop(replaced);
            }
            Ok(None) => {}
            Err(error) => tracing::warn!(%error, "capture frame skipped"),
        }
    }
}

/// The pipeline's frame for `frame`, `None` when it has no picture. Remakes the pool when the
/// content's size changed (C6).
fn frame_of(
    frame: Direct3D11CaptureFrame,
    arrived: Instant,
    pool: &Direct3D11CaptureFramePool,
    device: &IDirect3DDevice,
    pool_size: &Mutex<SizeInt32>,
    live: &Live,
) -> Result<Option<D3d11Frame>, ::windows::core::Error> {
    let content = frame.ContentSize()?;
    if content.Width <= 0 || content.Height <= 0 {
        return Ok(None);
    }
    if let Ok(mut size) = pool_size.lock()
        && (content.Width, content.Height) != (size.Width, size.Height)
    {
        match pool.Recreate(device, FORMAT, BUFFERS, content) {
            Ok(()) => {
                tracing::info!(from = ?(size.Width, size.Height), to = ?(content.Width, content.Height), "capture pool remade at the content's size");
                *size = content;
                live.ready(true);
                (live.events)(CaptureEvent::Changed { width: content.Width as u32, height: content.Height as u32 });
            }
            Err(error) => tracing::warn!(%error, "the capture pool could not be remade"),
        }
    }
    let access: IDirect3DDxgiInterfaceAccess = frame.Surface()?.cast()?;
    // SAFETY: the surface is a D3D11 texture on our device.
    let texture: ID3D11Texture2D = unsafe { access.GetInterface()? };
    let mut desc = D3D11_TEXTURE2D_DESC::default();
    // SAFETY: a valid texture and description.
    unsafe { texture.GetDesc(&mut desc) };
    // The picture is the content, never more than the texture (a window that grew before the
    // pool was remade).
    let width = (content.Width as u32).min(desc.Width);
    let height = (content.Height as u32).min(desc.Height);
    Ok(Some(D3d11Frame { texture, width, height, capture_time: arrived, hold: Some(Hold(Box::new(Returned::new(frame, &live.outstanding)))) }))
}

/// The item went away by itself: the share ends (C11).
fn item_closed(shared: &Shared, live: &Live) {
    if shared.stop.load(Ordering::Relaxed) {
        return;
    }
    tracing::info!(source = live.info.source, "the captured item closed, screen capture ended");
    finish(shared);
    (live.events)(CaptureEvent::Ended);
}
