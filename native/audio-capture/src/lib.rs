#[macro_use]
extern crate napi_derive;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use napi::bindgen_prelude::*;
use napi::threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode};

#[cfg(target_os = "linux")]
mod linux;
mod stub;
#[cfg(target_os = "windows")]
mod windows;

/// Fixed wire format between the addon and the JS pipeline: every frame is
/// 10ms of interleaved f32le stereo at 48kHz (3840 bytes). Backends resample
/// or rechannel to this before emitting.
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: usize = 2;
pub const FRAME_MS: usize = 10;
pub const FRAME_SAMPLES_PER_CH: usize = (SAMPLE_RATE as usize / 1000) * FRAME_MS;
pub const FRAME_BYTES: usize = FRAME_SAMPLES_PER_CH * CHANNELS * 4;

#[napi(object)]
#[derive(Clone)]
pub struct Capabilities {
  /// Which capture backend is active: 'wasapi-process-loopback' | 'pipewire' | 'none'
  pub backend: String,
  /// Can capture a single application's audio (by PID on Windows, node on Linux)
  pub per_app: bool,
  /// Can capture system audio while excluding this app's own process tree
  pub exclude_self: bool,
  /// Can capture plain system-wide audio through this addon
  pub system: bool,
}

#[napi(object)]
#[derive(Clone)]
pub struct AudioApp {
  /// Backend-specific capture target: Windows = PID, Linux = PipeWire node id
  pub id: String,
  pub name: String,
  pub pid: Option<u32>,
  pub binary: Option<String>,
}

#[napi(object)]
pub struct CaptureOptions {
  /// 'stub' | 'app' | 'system' | 'system-exclude-self'
  pub mode: String,
  /// Capture targets for 'app' mode (AudioApp.id values)
  pub targets: Option<Vec<String>>,
}

#[napi]
pub fn capabilities() -> Capabilities {
  #[cfg(target_os = "linux")]
  {
    linux::capabilities()
  }
  #[cfg(target_os = "windows")]
  {
    windows::capabilities()
  }
  #[cfg(not(any(target_os = "linux", target_os = "windows")))]
  {
    Capabilities {
      backend: "none".into(),
      per_app: false,
      exclude_self: false,
      system: false,
    }
  }
}

#[napi]
pub fn list_apps() -> Result<Vec<AudioApp>> {
  #[cfg(target_os = "linux")]
  {
    linux::list_apps().map_err(|e| Error::new(Status::GenericFailure, e))
  }
  #[cfg(target_os = "windows")]
  {
    windows::list_apps().map_err(|e| Error::new(Status::GenericFailure, e))
  }
  #[cfg(not(any(target_os = "linux", target_os = "windows")))]
  {
    Ok(Vec::new())
  }
}

/// A running capture. Frames arrive on `on_frame` as Buffers of FRAME_BYTES
/// (10ms interleaved f32le stereo @ 48kHz), called from a capture thread via
/// a threadsafe function. Fatal capture errors arrive on `on_error`, after
/// which no more frames are delivered.
#[napi]
pub struct CaptureSession {
  stop_flag: Arc<AtomicBool>,
  join: Option<std::thread::JoinHandle<()>>,
  backend: String,
}

#[napi]
impl CaptureSession {
  #[napi(getter)]
  pub fn backend(&self) -> String {
    self.backend.clone()
  }

  #[napi]
  pub fn stop(&mut self) {
    self.stop_flag.store(true, Ordering::SeqCst);
    if let Some(join) = self.join.take() {
      let _ = join.join();
    }
  }
}

impl Drop for CaptureSession {
  fn drop(&mut self) {
    self.stop();
  }
}

#[napi]
pub fn start_capture(
  options: CaptureOptions,
  on_frame: ThreadsafeFunction<Buffer>,
  on_error: ThreadsafeFunction<String>,
) -> Result<CaptureSession> {
  let stop_flag = Arc::new(AtomicBool::new(false));

  let emit_frame = move |bytes: Vec<u8>| {
    on_frame.call(Ok(bytes.into()), ThreadsafeFunctionCallMode::NonBlocking);
  };
  let emit_error = move |msg: String| {
    on_error.call(Ok(msg), ThreadsafeFunctionCallMode::Blocking);
  };

  match options.mode.as_str() {
    "stub" => {
      let _ = &emit_error;
      let join = stub::spawn(stop_flag.clone(), emit_frame);
      Ok(CaptureSession {
        stop_flag,
        join: Some(join),
        backend: "stub".into(),
      })
    }
    #[cfg(target_os = "linux")]
    mode @ ("app" | "system" | "system-exclude-self") => {
      let parsed = linux::parse_mode(mode, options.targets.as_deref())
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
      let join = linux::spawn(parsed, stop_flag.clone(), emit_frame, emit_error);
      Ok(CaptureSession {
        stop_flag,
        join: Some(join),
        backend: "pipewire".into(),
      })
    }
    #[cfg(target_os = "windows")]
    mode @ ("app" | "system" | "system-exclude-self") => {
      let parsed = windows::parse_mode(mode, options.targets.as_deref())
        .map_err(|e| Error::new(Status::InvalidArg, e))?;
      let join = windows::spawn(parsed, stop_flag.clone(), emit_frame, emit_error);
      Ok(CaptureSession {
        stop_flag,
        join: Some(join),
        backend: "wasapi-process-loopback".into(),
      })
    }
    mode => {
      let _ = &emit_error;
      Err(Error::new(
        Status::InvalidArg,
        format!("capture mode '{mode}' is not supported by this build"),
      ))
    }
  }
}
