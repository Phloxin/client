//! WASAPI process-loopback backend: per-app / system audio capture.
//!
//! Uses `ActivateAudioInterfaceAsync` with
//! `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`:
//!   - window share  -> INCLUDE_TARGET_PROCESS_TREE of the window's process
//!   - system        -> EXCLUDE_TARGET_PROCESS_TREE of this (silent) helper
//!                      process, i.e. capture everything
//!   - exclude-self  -> EXCLUDE_TARGET_PROCESS_TREE of the Electron main
//!                      process (our parent), silencing the whole app tree
//!                      including Chromium's audio service - no call echo
//!
//! Process loopback is a virtual render device: it has no fixed mix format,
//! so we simply request the pipeline wire format (48kHz f32 stereo) at
//! Initialize. Availability is probed at runtime (documented for
//! Windows 10 20348+ but reported working on 2004+) - never assumed from the
//! OS version.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use windows::core::{implement, IUnknown, Interface, Ref, Result as WinResult, HRESULT};
use windows::Win32::Foundation::{CloseHandle, HWND, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
  ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
  IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
  IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
  AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
  AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
  AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
  PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
  PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, PROCESS_LOOPBACK_MODE,
  VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, WAVEFORMATEX,
};
use windows::Win32::System::Com::StructuredStorage::{
  PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0,
};
use windows::Win32::System::Com::{CoInitializeEx, BLOB, COINIT_MULTITHREADED};
use windows::Win32::System::Diagnostics::ToolHelp::{
  CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
};
use windows::Win32::System::Threading::{CreateEventW, GetCurrentProcessId, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;
use windows::Win32::UI::WindowsAndMessaging::GetWindowThreadProcessId;

use crate::{AudioApp, Capabilities, CHANNELS, FRAME_SAMPLES_PER_CH, SAMPLE_RATE};

const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
/// 200ms WASAPI buffer (in 100ns units) - roomy enough that a delayed drain
/// never drops audio.
const BUFFER_DURATION_HNS: i64 = 2_000_000;

pub enum Mode {
  IncludeTree(u32),
  ExcludeTree(u32),
}

pub fn parse_mode(mode: &str, targets: Option<&[String]>) -> Result<Mode, String> {
  match mode {
    "app" => {
      let target = targets
        .and_then(|t| t.first())
        .ok_or("per-app capture needs a target window or pid")?;
      Ok(Mode::IncludeTree(resolve_target_pid(target)?))
    }
    // Exclude the (silent) capture helper itself = capture everything.
    "system" => Ok(Mode::ExcludeTree(std::process::id())),
    // Exclude the Electron main process tree = everything except our app.
    "system-exclude-self" => Ok(Mode::ExcludeTree(parent_pid().unwrap_or(std::process::id()))),
    other => Err(format!("unknown capture mode '{other}'")),
  }
}

/// Accepts an Electron desktopCapturer source id ("window:HWND:instance") or
/// a raw pid string, and resolves it to the owning process id.
fn resolve_target_pid(target: &str) -> Result<u32, String> {
  if let Some(rest) = target.strip_prefix("window:") {
    let hwnd_raw: isize = rest
      .split(':')
      .next()
      .and_then(|h| h.parse().ok())
      .ok_or_else(|| format!("bad window target '{target}'"))?;
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(HWND(hwnd_raw as *mut core::ffi::c_void), Some(&mut pid)) };
    if pid == 0 {
      return Err(format!("window {hwnd_raw} has no owning process (closed?)"));
    }
    Ok(pid)
  } else {
    target.parse().map_err(|_| format!("bad capture target '{target}'"))
  }
}

fn parent_pid() -> Option<u32> {
  let self_pid = std::process::id();
  unsafe {
    let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
    let mut entry = PROCESSENTRY32W {
      dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32,
      ..Default::default()
    };
    let mut parent = None;
    if Process32FirstW(snapshot, &mut entry).is_ok() {
      loop {
        if entry.th32ProcessID == self_pid {
          parent = Some(entry.th32ParentProcessID);
          break;
        }
        if Process32NextW(snapshot, &mut entry).is_err() {
          break;
        }
      }
    }
    let _ = CloseHandle(snapshot);
    parent
  }
}

// ─── Async activation ────────────────────────────────────────────

#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivateHandler {
  tx: mpsc::Sender<WinResult<IAudioClient>>,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivateHandler_Impl {
  fn ActivateCompleted(&self, op: Ref<IActivateAudioInterfaceAsyncOperation>) -> WinResult<()> {
    let result = (|| -> WinResult<IAudioClient> {
      let op = op.ok()?;
      let mut hr = HRESULT::default();
      let mut interface: Option<IUnknown> = None;
      unsafe { op.GetActivateResult(&mut hr, &mut interface)? };
      hr.ok()?;
      interface.ok_or_else(windows::core::Error::empty)?.cast()
    })();
    let _ = self.tx.send(result);
    Ok(())
  }
}

/// Activate a process-loopback IAudioClient for `pid`. Must be called from a
/// COM-initialized thread.
fn activate_process_loopback(pid: u32, mode: PROCESS_LOOPBACK_MODE) -> Result<IAudioClient, String> {
  let params = AUDIOCLIENT_ACTIVATION_PARAMS {
    ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
    Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
      ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
        TargetProcessId: pid,
        ProcessLoopbackMode: mode,
      },
    },
  };
  let prop = PROPVARIANT {
    Anonymous: PROPVARIANT_0 {
      Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
        vt: VT_BLOB,
        wReserved1: 0,
        wReserved2: 0,
        wReserved3: 0,
        Anonymous: PROPVARIANT_0_0_0 {
          blob: BLOB {
            cbSize: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
            pBlobData: &params as *const _ as *mut u8,
          },
        },
      }),
    },
  };

  let (tx, rx) = mpsc::channel();
  let handler: IActivateAudioInterfaceCompletionHandler = ActivateHandler { tx }.into();
  // Keep the async operation alive until completion fires.
  let _op = unsafe {
    ActivateAudioInterfaceAsync(
      VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
      &IAudioClient::IID,
      Some(&prop),
      &handler,
    )
  }
  .map_err(|e| format!("process loopback activation: {e}"))?;

  rx.recv_timeout(Duration::from_secs(3))
    .map_err(|_| "process loopback activation timed out".to_string())?
    .map_err(|e| format!("process loopback unavailable: {e}"))
}

fn wire_format() -> WAVEFORMATEX {
  let block_align = (CHANNELS * 4) as u16;
  WAVEFORMATEX {
    wFormatTag: WAVE_FORMAT_IEEE_FLOAT,
    nChannels: CHANNELS as u16,
    nSamplesPerSec: SAMPLE_RATE,
    nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
    nBlockAlign: block_align,
    wBitsPerSample: 32,
    cbSize: 0,
  }
}

fn init_com() {
  // S_FALSE (already initialized) is fine; ignore the result.
  unsafe {
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
  }
}

// ─── Capabilities / app enumeration ──────────────────────────────

pub fn capabilities() -> Capabilities {
  // Throwaway activation against our own (silent) process: proves the
  // process-loopback virtual device exists on this Windows build.
  let available = thread::spawn(|| {
    init_com();
    activate_process_loopback(
      unsafe { GetCurrentProcessId() },
      PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
    )
    .is_ok()
  })
  .join()
  .unwrap_or(false);

  Capabilities {
    backend: if available { "wasapi-process-loopback".into() } else { "none".into() },
    per_app: available,
    exclude_self: available,
    system: available,
  }
}

pub fn list_apps() -> Result<Vec<AudioApp>, String> {
  // The Windows picker targets the shared window's process directly
  // (targets: [source id]), so no separate app list is needed.
  Ok(Vec::new())
}

// ─── Capture session ─────────────────────────────────────────────

pub fn spawn(
  mode: Mode,
  stop_flag: Arc<AtomicBool>,
  emit_frame: impl Fn(Vec<u8>) + Send + 'static,
  emit_error: impl Fn(String) + Send + 'static,
) -> thread::JoinHandle<()> {
  thread::spawn(move || {
    init_com();
    if let Err(err) = run_capture(mode, stop_flag, emit_frame) {
      emit_error(err);
    }
  })
}

fn run_capture(
  mode: Mode,
  stop_flag: Arc<AtomicBool>,
  emit_frame: impl Fn(Vec<u8>) + Send + 'static,
) -> Result<(), String> {
  let (pid, loopback_mode) = match mode {
    Mode::IncludeTree(pid) => (pid, PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE),
    Mode::ExcludeTree(pid) => (pid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE),
  };
  let client = activate_process_loopback(pid, loopback_mode)?;

  let format = wire_format();
  let event = unsafe { CreateEventW(None, false, false, None) }
    .map_err(|e| format!("capture event: {e}"))?;

  let result = (|| -> Result<(), String> {
    unsafe {
      client
        .Initialize(
          AUDCLNT_SHAREMODE_SHARED,
          AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
          BUFFER_DURATION_HNS,
          0,
          &format,
          None,
        )
        .map_err(|e| format!("audio client init: {e}"))?;
      client.SetEventHandle(event).map_err(|e| format!("event handle: {e}"))?;
    }
    let capture: IAudioCaptureClient =
      unsafe { client.GetService() }.map_err(|e| format!("capture client: {e}"))?;
    unsafe { client.Start() }.map_err(|e| format!("capture start: {e}"))?;

    let mut pending: Vec<f32> = Vec::with_capacity(FRAME_SAMPLES_PER_CH * CHANNELS * 4);
    let frame_len = FRAME_SAMPLES_PER_CH * CHANNELS;

    while !stop_flag.load(Ordering::SeqCst) {
      // Event-driven with a timeout fallback: process loopback events can be
      // sparse while the target is silent.
      unsafe {
        let _ = WaitForSingleObject(event, 20) == WAIT_OBJECT_0;
      }
      loop {
        let packet =
          unsafe { capture.GetNextPacketSize() }.map_err(|e| format!("packet size: {e}"))?;
        if packet == 0 {
          break;
        }
        let mut data: *mut u8 = std::ptr::null_mut();
        let mut frames = 0u32;
        let mut flags = 0u32;
        unsafe {
          capture
            .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
            .map_err(|e| format!("get buffer: {e}"))?;
        }
        let samples = frames as usize * CHANNELS;
        if flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32) != 0 {
          pending.extend(std::iter::repeat(0.0f32).take(samples));
        } else if !data.is_null() {
          let slice = unsafe { std::slice::from_raw_parts(data as *const f32, samples) };
          pending.extend_from_slice(slice);
        }
        unsafe {
          capture.ReleaseBuffer(frames).map_err(|e| format!("release buffer: {e}"))?;
        }
        while pending.len() >= frame_len {
          let frame: Vec<u8> = pending[..frame_len].iter().flat_map(|s| s.to_le_bytes()).collect();
          pending.drain(..frame_len);
          emit_frame(frame);
        }
      }
    }

    unsafe {
      let _ = client.Stop();
    }
    Ok(())
  })();

  unsafe {
    let _ = CloseHandle(event);
  }
  result
}
