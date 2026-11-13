// The sidecar: a host program starts it and drives one `pylon_media::Engine` with JSON lines on
// stdin and stdout (PROTOCOL.md). Logs go to stderr, stdout carries nothing but the protocol.
//
//   pylon-media-host [--insecure-plain] [--test-hooks]
//
// PYLON_MEDIA_LOG sets the log filter (default `info`).

mod protocol;

use std::{
    io::{BufRead, Write},
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, Sender},
    },
    time::{Duration, Instant},
};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use pylon_media::{
    CloseReason, Engine, Event, FileSource, OpenParams, Source, SyntheticSource, VideoCodec,
    video::{Preview, PreviewEvent},
};

use protocol::{ParseError, Reply, Request, SourceSpec};

#[cfg(all(feature = "capture", any(target_os = "linux", target_os = "windows")))]
use pylon_media::video::capture::{CaptureEvent, ScreenCapture};

/// A running screen capture, or nothing in a build without the feature.
#[cfg(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))))]
struct ScreenCapture;

#[cfg(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))))]
impl ScreenCapture {
    fn stop(&self) {}
}

/// Once the process has decided to exit, it is gone this long after whatever its threads do.
const EXIT_WATCHDOG: Duration = Duration::from_secs(2);

#[derive(Clone, Copy, Debug, Default)]
struct Flags {
    insecure_plain: bool,
    test_hooks: bool,
}

/// What the main loop waits on.
enum Input {
    Line(String),
    EndOfInput,
    Engine(Event),
    #[cfg_attr(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))), allow(dead_code))]
    Capture(CaptureNews),
    Preview(PreviewNews),
}

/// What the sharer's preview reports (M6 preview step 1). No `Debug`: it holds the picture (R5).
enum PreviewNews {
    /// The JPEG as base64.
    Picture { width: u32, height: u32, jpeg: String },
    /// The preview stopped (R4).
    Failed(String),
}

/// What the screen capture reports (M5b D8).
#[derive(Debug)]
#[cfg_attr(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))), allow(dead_code))]
enum CaptureNews {
    Ready(Reply),
    /// Never on Windows, where nobody is asked (M7.5 C2).
    #[cfg_attr(target_os = "windows", allow(dead_code))]
    Cancelled,
    Failed(String),
    Changed { width: u32, height: u32 },
    Ended,
}

enum Next {
    Continue,
    Exit(i32),
}

struct Host<W: FnMut(&str) -> bool> {
    flags: Flags,
    started_at: Instant,
    write: W,
    inputs: Sender<Input>,
    hello: bool,
    open_tried: bool,
    engine: Option<Engine>,
    source: Option<Box<dyn Source>>,
    started: bool,
    capture_tried: bool,
    capture: Option<ScreenCapture>,
    capture_ready: bool,
    /// The source's preview, once opened with a source that has a picture.
    preview: Option<Arc<Preview>>,
    /// Why there is none, for a source without a picture (R6).
    preview_refused: Option<&'static str>,
    /// Armed on the first decision to exit, `None` in tests.
    exit_watchdog: Option<Duration>,
    exiting: bool,
}

impl<W: FnMut(&str) -> bool> Host<W> {
    fn new(flags: Flags, write: W, inputs: Sender<Input>) -> Self {
        Host {
            exit_watchdog: None,
            exiting: false,
            flags,
            started_at: Instant::now(),
            write,
            inputs,
            hello: false,
            open_tried: false,
            engine: None,
            source: None,
            started: false,
            capture_tried: false,
            capture: None,
            capture_ready: false,
            preview: None,
            preview_refused: None,
        }
    }

    /// Writes one message. False once the host can no longer be reached.
    fn reply(&mut self, reply: Reply) -> bool {
        let t_ms = self.started_at.elapsed().as_secs_f64() * 1000.0;
        (self.write)(&reply.to_line(t_ms))
    }

    fn error(&mut self, message: impl Into<String>) -> Next {
        let message = message.into();
        tracing::warn!(%message, "error");
        self.go_on(Reply::Error { message, fatal: false })
    }

    fn go_on(&mut self, reply: Reply) -> Next {
        if self.reply(reply) {
            Next::Continue
        } else {
            self.host_gone()
        }
    }

    fn host_gone(&mut self) -> Next {
        tracing::error!("stdout is closed, stopping");
        self.close_engine(1);
        Next::Exit(1)
    }

    /// Stops the capture and the engine on the way to exiting with `code`.
    fn close_engine(&mut self, code: i32) {
        if !self.exiting {
            self.exiting = true;
            if let Some(after) = self.exit_watchdog {
                arm_watchdog(after, code, hard_exit);
            }
        }
        // The capture stops first, so a source waiting on it ends and the engine can be joined.
        if let Some(capture) = &self.capture {
            capture.stop();
        }
        if let Some(mut engine) = self.engine.take() {
            engine.close();
        }
        // After the engine, whose source takes frames from it. Closes the portal's session.
        self.capture = None;
    }

    /// Stops the engine, writes `closed` while it still can, and exits with `code`.
    fn finish(&mut self, reason: &'static str, code: i32) -> Next {
        self.close_engine(code);
        self.reply(Reply::Closed { reason });
        tracing::info!(reason, code, "exit");
        Next::Exit(code)
    }

    fn fatal(&mut self, message: impl Into<String>) -> Next {
        let message = message.into();
        tracing::error!(%message, "fatal");
        self.close_engine(1);
        self.reply(Reply::Error { message, fatal: true });
        self.finish("error", 1)
    }

    fn line(&mut self, line: &str) -> Next {
        if line.trim().is_empty() {
            return Next::Continue;
        }
        let request = match protocol::parse(line) {
            Ok(request) => request,
            // A malformed `open` is a failed open, which ends the process like any other.
            Err(ParseError::Invalid { name, message }) if name == "open" && self.hello && !self.open_tried => {
                self.open_tried = true;
                return self.fatal(format!("open: {message}"));
            }
            Err(error) => return self.error(error.to_string()),
        };

        if !self.hello {
            return match request {
                Request::Close {} => self.finish("close", 0),
                Request::Hello { protocol: protocol::PROTOCOL } => {
                    self.hello = true;
                    let mut sources = vec!["file"];
                    if cfg!(all(feature = "encode", any(target_os = "linux", target_os = "windows"))) {
                        sources.push("pattern");
                    }
                    if cfg!(all(feature = "capture", any(target_os = "linux", target_os = "windows"))) {
                        sources.push("screen");
                    }
                    if self.flags.test_hooks {
                        sources.push("synthetic");
                    }
                    self.go_on(Reply::Hello {
                        protocol: protocol::PROTOCOL,
                        engine: env!("CARGO_PKG_VERSION"),
                        codecs: hello_codecs(),
                        sources,
                    })
                }
                Request::Hello { protocol } => self.fatal(format!("protocol {protocol} is not spoken here, only {}", protocol::PROTOCOL)),
                _ => self.error("hello must come first"),
            };
        }

        match request {
            Request::Hello { .. } => self.error("hello was already answered"),
            Request::Capture(protocol::Capture::Screen(screen)) => {
                if self.open_tried {
                    return self.error("capture must come before open");
                }
                if self.capture_tried {
                    return self.error("one capture per process");
                }
                self.capture_tried = true;
                match start_capture(screen, self.inputs.clone()) {
                    Ok(capture) => {
                        self.capture = Some(capture);
                        Next::Continue
                    }
                    Err(e) => self.fatal(format!("capture: {e}")),
                }
            }
            Request::Open(open) => self.open(open),
            Request::Start {} => {
                let Some(engine) = self.engine.as_mut() else {
                    return self.error("start before opened");
                };
                let Some(source) = self.source.take() else {
                    return self.error("already started");
                };
                match engine.start(source) {
                    Ok(()) => {
                        self.started = true;
                        Next::Continue
                    }
                    Err(e) => self.error(format!("start: {e}")),
                }
            }
            Request::Key(key) => {
                let Some(engine) = self.engine.as_ref() else {
                    return self.error("key before opened");
                };
                let result = protocol::decode_key(&key.key)
                    .and_then(|bytes| engine.set_key(key.format, key.epoch, bytes).map_err(|e| e.to_string()));
                match result {
                    Ok(()) => Next::Continue,
                    Err(e) => self.error(format!("key: {e}")),
                }
            }
            Request::SetMaxBitrate { bps } => {
                let Some(engine) = self.engine.as_ref() else {
                    return self.error("set_max_bitrate before opened");
                };
                match engine.set_max_bitrate(bps) {
                    Ok(()) => Next::Continue,
                    Err(e) => self.error(format!("set_max_bitrate: {e}")),
                }
            }
            Request::Preview(asked) => {
                if self.engine.is_none() {
                    return self.error("preview before opened");
                }
                if let Some(refused) = self.preview_refused {
                    return self.error(format!("preview: {refused}"));
                }
                let result = match &self.preview {
                    Some(preview) => preview.request(asked.to_engine()).map_err(|e| e.to_string()),
                    None => Err("this source has no picture to preview".into()),
                };
                match result {
                    Ok(()) => Next::Continue,
                    Err(e) => self.error(format!("preview: {e}")),
                }
            }
            Request::TestDropMedia { count } => {
                if !self.flags.test_hooks {
                    return self.error("test_drop_media is refused without --test-hooks");
                }
                let Some(engine) = self.engine.as_ref() else {
                    return self.error("test_drop_media before opened");
                };
                match engine.drop_media_packets(count) {
                    Ok(()) => Next::Continue,
                    Err(e) => self.error(format!("test_drop_media: {e}")),
                }
            }
            Request::Close {} => self.finish("close", 0),
        }
    }

    fn open(&mut self, open: protocol::Open) -> Next {
        if self.open_tried {
            return self.error("one open per process");
        }
        self.open_tried = true;

        if open.e2ee.is_none() && !self.flags.insecure_plain {
            return self.fatal("open: e2ee null is refused without --insecure-plain");
        }
        let codec = open.video.codec.to_engine();
        // No AV1 on Windows in this step, whatever the source (AV1 step 2, Q2).
        if codec != VideoCodec::H264 && cfg!(target_os = "windows") {
            return self.fatal(format!("open: {} is not supported on Windows, only H264", codec.name()));
        }
        // Only the pattern and the screen have a picture to preview (R6).
        let preview_refused = match &open.source {
            SourceSpec::File { .. } => Some("the file source has no picture to preview"),
            SourceSpec::Synthetic { .. } => Some("the synthetic source has no picture to preview"),
            SourceSpec::Pattern(_) | SourceSpec::Screen(_) => None,
        };
        let mut source: Box<dyn Source> = match open.source {
            // Annex-B for H264, IVF for AV1 (Q9).
            SourceSpec::File { path, fps } => match FileSource::open_for(&path, fps, codec) {
                Ok(source) => Box::new(source),
                Err(e) => return self.fatal(format!("open: source: {e}")),
            },
            SourceSpec::Synthetic { fps } => {
                if !self.flags.test_hooks {
                    return self.fatal("open: the synthetic source is refused without --test-hooks");
                }
                if open.e2ee.is_some() {
                    return self.fatal("open: the synthetic source is only sent unencrypted");
                }
                if codec != VideoCodec::H264 {
                    return self.fatal("open: the synthetic source is H264 only");
                }
                match SyntheticSource::new(fps) {
                    Ok(source) => Box::new(source),
                    Err(e) => return self.fatal(format!("open: source: {e}")),
                }
            }
            SourceSpec::Pattern(pattern) => match pattern_source(&pattern, open.video.max_bitrate, codec) {
                Ok(source) => source,
                Err(e) => return self.fatal(format!("open: source: {e}")),
            },
            SourceSpec::Screen(screen) => {
                let capture = match (&self.capture, self.capture_ready) {
                    (Some(capture), true) => capture,
                    _ => return self.fatal("open: the screen source needs capture_ready first"),
                };
                match screen_source(capture, &screen, open.video.max_bitrate, codec) {
                    Ok(source) => source,
                    Err(e) => return self.fatal(format!("open: source: {e}")),
                }
            }
        };
        let e2ee = match open.e2ee.as_ref().map(protocol::E2ee::to_params).transpose() {
            Ok(e2ee) => e2ee,
            Err(e) => return self.fatal(format!("open: e2ee: {e}")),
        };
        let params = OpenParams {
            router_rtp_capabilities: open.router_rtp_capabilities,
            transport: open.transport,
            e2ee,
            video: open.video.to_params(),
        };
        // Made nothing until asked, on Linux and Windows (M6 preview step 3, W6).
        let preview = preview_refused.is_none()
            .then(|| preview(self.inputs.clone()))
            .filter(|preview| source.attach_preview(preview.clone()));
        let (engine, opened, events) = match Engine::open(params) {
            Ok(result) => result,
            Err(e) => return self.fatal(format!("open: {e}")),
        };
        self.preview = preview;
        self.preview_refused = preview_refused;
        self.engine = Some(engine);
        self.source = Some(source);
        forward(events, self.inputs.clone());
        self.go_on(Reply::Opened {
            dtls_parameters: opened.dtls_parameters,
            rtp_parameters: opened.rtp_parameters,
        })
    }

    fn engine_event(&mut self, event: Event) -> Next {
        match event {
            Event::IceState(state) => self.go_on(Reply::IceState { state }),
            Event::Connected => self.go_on(Reply::Connected {}),
            Event::KeyFrameRequest(kind) => self.go_on(Reply::KeyFrameRequest { kind }),
            Event::Stats(stats) => self.go_on(Reply::Stats(stats)),
            Event::Error { message, fatal } => self.go_on(Reply::Error { message, fatal }),
            Event::Closed(reason) => {
                // The engine stopped by itself: the transport is gone or a fatal error came first.
                let (reason, code) = match reason {
                    CloseReason::Requested => ("close", 0),
                    CloseReason::Disconnected => ("disconnected", 1),
                    CloseReason::Error => ("error", 1),
                };
                self.finish(reason, code)
            }
        }
    }

    fn capture_news(&mut self, news: CaptureNews) -> Next {
        match news {
            CaptureNews::Ready(reply) => {
                self.capture_ready = true;
                self.go_on(reply)
            }
            // The share is off. The host closes the sidecar.
            CaptureNews::Cancelled => self.go_on(Reply::CaptureCancelled {}),
            CaptureNews::Failed(message) => self.fatal(format!("capture: {message}")),
            CaptureNews::Changed { width, height } => self.go_on(Reply::CaptureChanged { width, height }),
            CaptureNews::Ended => self.finish("capture_ended", 0),
        }
    }

    fn preview_news(&mut self, news: PreviewNews) -> Next {
        match news {
            PreviewNews::Picture { width, height, jpeg } => self.go_on(Reply::Preview { width, height, jpeg: protocol::Jpeg(jpeg) }),
            // The preview stopped, the share goes on (R4).
            PreviewNews::Failed(message) => self.error(message),
        }
    }

    fn end_of_input(&mut self) -> Next {
        tracing::info!(started = self.started, "end of input");
        self.finish("end_of_input", 0)
    }
}

/// What `hello.codecs` says: H264 always, AV1 when this build on this machine encodes it (Q2).
fn hello_codecs() -> Vec<&'static str> {
    let mut codecs = vec![VideoCodec::H264.name()];
    if pylon_media::video::av1_encode_available() {
        codecs.push(VideoCodec::Av1.name());
    }
    codecs
}

/// The pattern source, or why there is none in this build.
#[cfg(all(feature = "encode", any(target_os = "linux", target_os = "windows")))]
fn pattern_source(pattern: &protocol::Pattern, max_bitrate: u64, codec: VideoCodec) -> Result<Box<dyn Source>, String> {
    let kind = match pattern.kind {
        protocol::PatternKind::Screen => pylon_media::video::PatternKind::Screen,
        protocol::PatternKind::Stress => pylon_media::video::PatternKind::Stress,
    };
    pylon_media::video::pattern_source(pattern.width, pattern.height, pattern.fps, pattern.still, kind, max_bitrate, codec)
        .map_err(|e| e.to_string())
}

#[cfg(not(all(feature = "encode", any(target_os = "linux", target_os = "windows"))))]
fn pattern_source(_pattern: &protocol::Pattern, _max_bitrate: u64, _codec: VideoCodec) -> Result<Box<dyn Source>, String> {
    if cfg!(feature = "encode") {
        return Err("the pattern source is not implemented on this system".into());
    }
    Err("the pattern source needs a sidecar built with the encode feature".into())
}

/// Starts the portal's screen capture, its news going into the main loop. The `target` is
/// ignored on Linux (M7.5 C1): the portal's dialog chooses.
#[cfg(all(feature = "capture", target_os = "linux"))]
fn start_capture(screen: protocol::ScreenCapture, inputs: Sender<Input>) -> Result<ScreenCapture, String> {
    let inputs = std::sync::Mutex::new(inputs);
    ScreenCapture::start(screen.restore_token, screen.max_fps, move |event| {
        let news = match event {
            CaptureEvent::Ready(info) => CaptureNews::Ready(Reply::CaptureReady {
                width: info.width,
                height: info.height,
                format: Some(pylon_media::video::capture::fourcc_text(info.fourcc)),
                modifier: info.modifier.map(|m| format!("{m:#018x}")),
                dmabuf: info.dmabuf,
                restore_token: info.restore_token,
            }),
            CaptureEvent::Cancelled => CaptureNews::Cancelled,
            CaptureEvent::Failed(message) => CaptureNews::Failed(message),
            CaptureEvent::Changed { width, height } => CaptureNews::Changed { width, height },
            CaptureEvent::Ended => CaptureNews::Ended,
        };
        if let Ok(inputs) = inputs.lock() {
            let _ = inputs.send(Input::Capture(news));
        }
    })
    .map_err(|e| e.to_string())
}

/// Starts Windows Graphics Capture of the target the host named (the primary monitor when none),
/// its news going into the main loop (M7.5 C1, C2, C12). `restore_token` is ignored here.
#[cfg(all(feature = "capture", target_os = "windows"))]
fn start_capture(screen: protocol::ScreenCapture, inputs: Sender<Input>) -> Result<ScreenCapture, String> {
    use pylon_media::video::capture::CaptureTarget;
    let target = screen.target.map(|target| match target {
        protocol::CaptureTarget::Window(handle) => CaptureTarget::Window(handle),
        protocol::CaptureTarget::Monitor { x, y } => CaptureTarget::Monitor { x, y },
    });
    let inputs = std::sync::Mutex::new(inputs);
    ScreenCapture::start(target, screen.max_fps, move |event| {
        let news = match event {
            CaptureEvent::Ready(info) => CaptureNews::Ready(Reply::CaptureReady {
                width: info.width,
                height: info.height,
                format: None,
                modifier: None,
                dmabuf: false,
                restore_token: None,
            }),
            CaptureEvent::Failed(message) => CaptureNews::Failed(message),
            CaptureEvent::Changed { width, height } => CaptureNews::Changed { width, height },
            CaptureEvent::Ended => CaptureNews::Ended,
        };
        if let Ok(inputs) = inputs.lock() {
            let _ = inputs.send(Input::Capture(news));
        }
    })
    .map_err(|e| e.to_string())
}

#[cfg(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))))]
fn start_capture(_screen: protocol::ScreenCapture, _inputs: Sender<Input>) -> Result<ScreenCapture, String> {
    if cfg!(feature = "capture") {
        return Err("screen capture is not implemented on this system".into());
    }
    Err("screen capture needs a sidecar built with the capture feature".into())
}

/// The screen source over a ready capture.
#[cfg(all(feature = "capture", any(target_os = "linux", target_os = "windows")))]
fn screen_source(capture: &ScreenCapture, screen: &protocol::Screen, max_bitrate: u64, codec: VideoCodec) -> Result<Box<dyn Source>, String> {
    pylon_media::video::capture::capture_source(capture, screen.fps, screen.max_width, screen.max_height, max_bitrate, codec)
        .map_err(|e| e.to_string())
}

#[cfg(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))))]
fn screen_source(_capture: &ScreenCapture, _screen: &protocol::Screen, _max_bitrate: u64, _codec: VideoCodec) -> Result<Box<dyn Source>, String> {
    if cfg!(feature = "capture") {
        return Err("the screen source is not implemented on this system".into());
    }
    Err("the screen source needs a sidecar built with the capture feature".into())
}

/// A preview whose pictures (as base64, made on the preview's own thread) and failures go into
/// the main loop, and from there only to stdout (R5).
fn preview(inputs: Sender<Input>) -> Arc<Preview> {
    let inputs = Mutex::new(inputs);
    Preview::new(move |event| {
        let news = match event {
            PreviewEvent::Picture(picture) => PreviewNews::Picture {
                width: picture.width,
                height: picture.height,
                jpeg: STANDARD.encode(&picture.jpeg),
            },
            PreviewEvent::Failed(message) => PreviewNews::Failed(message),
        };
        if let Ok(inputs) = inputs.lock() {
            let _ = inputs.send(Input::Preview(news));
        }
    })
}

/// Moves the engine's events into the main loop. Events that end without `Closed` mean the
/// engine's thread is gone, which closes the engine as an error.
fn forward(events: Receiver<Event>, inputs: Sender<Input>) {
    std::thread::spawn(move || forward_events(events, inputs));
}

fn forward_events(events: Receiver<Event>, inputs: Sender<Input>) {
    for event in events {
        let closed = matches!(event, Event::Closed(_));
        if inputs.send(Input::Engine(event)).is_err() || closed {
            return;
        }
    }
    let message = "the engine's thread ended without closing".to_string();
    tracing::error!(%message, "engine");
    let _ = inputs.send(Input::Engine(Event::Error { message, fatal: true }));
    let _ = inputs.send(Input::Engine(Event::Closed(CloseReason::Error)));
}

/// Calls `end` with `code` after `after`, on a thread of its own.
fn arm_watchdog(after: Duration, code: i32, end: impl FnOnce(i32) + Send + 'static) {
    let armed = std::thread::Builder::new().name("pylon-media-host exit".into()).spawn(move || {
        std::thread::sleep(after);
        end(code);
    });
    if let Err(error) = armed {
        tracing::error!(%error, "exit watchdog");
    }
}

/// Ends the process now, without exit handlers that a hung thread could block.
fn hard_exit(code: i32) {
    eprintln!("pylon-media-host: exit did not finish within {} s, ending the process", EXIT_WATCHDOG.as_secs());
    // SAFETY: _exit has no preconditions and does not return.
    #[cfg(unix)]
    unsafe {
        libc::_exit(code)
    }
    // Not the C runtime's `_exit`, which takes its exit lock and calls `ExitProcess` here.
    #[cfg(windows)]
    {
        use windows::Win32::System::Threading::{GetCurrentProcess, TerminateProcess};
        // SAFETY: the current process's pseudo handle is always valid.
        if let Err(error) = unsafe { TerminateProcess(GetCurrentProcess(), code as u32) } {
            eprintln!("pylon-media-host: TerminateProcess: {error}");
        }
        // Never return from a hard exit. `abort` waits on nothing either, the code is lost.
        std::process::abort()
    }
}

/// Reads stdin line by line. End of input or a read error both mean the host is gone.
fn read_stdin(inputs: Sender<Input>) {
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        let mut buffer = Vec::new();
        loop {
            buffer.clear();
            match stdin.read_until(b'\n', &mut buffer) {
                Ok(0) => break,
                Ok(_) => {
                    let line = String::from_utf8_lossy(&buffer).into_owned();
                    if inputs.send(Input::Line(line)).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    tracing::error!(error = %e, "stdin");
                    break;
                }
            }
        }
        let _ = inputs.send(Input::EndOfInput);
    });
}

fn write_stdout(line: &str) -> bool {
    let mut out = std::io::stdout().lock();
    writeln!(out, "{line}").and_then(|()| out.flush()).is_ok()
}

fn usage() -> ! {
    eprintln!("usage: pylon-media-host [--insecure-plain] [--test-hooks]");
    std::process::exit(2);
}

fn main() {
    let mut flags = Flags::default();
    for arg in std::env::args().skip(1) {
        match arg.as_str() {
            "--insecure-plain" => flags.insecure_plain = true,
            "--test-hooks" => flags.test_hooks = true,
            _ => usage(),
        }
    }

    let filter = std::env::var("PYLON_MEDIA_LOG").unwrap_or_else(|_| "info".into());
    let filter = tracing_subscriber::EnvFilter::try_new(&filter).unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info"));
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(filter)
        .init();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        crypto = pylon_media::CRYPTO_BACKEND,
        insecure_plain = flags.insecure_plain,
        test_hooks = flags.test_hooks,
        "pylon-media-host"
    );
    // Window and monitor sizes and points in physical pixels (M7.5 C1).
    #[cfg(all(feature = "capture", target_os = "windows"))]
    pylon_media::video::capture::make_dpi_aware();
    // The Windows Runtime for as long as the sidecar lives, so that no capture object outlives it
    // (M7.5b Z2).
    #[cfg(all(feature = "capture", target_os = "windows"))]
    pylon_media::video::capture::init_runtime();

    let (inputs, receiver) = mpsc::channel();
    read_stdin(inputs.clone());
    let mut host = Host::new(flags, write_stdout, inputs);
    host.exit_watchdog = Some(EXIT_WATCHDOG);
    let code = loop {
        let next = match receiver.recv() {
            Ok(Input::Line(line)) => host.line(&line),
            Ok(Input::Engine(event)) => host.engine_event(event),
            Ok(Input::Capture(news)) => host.capture_news(news),
            Ok(Input::Preview(news)) => host.preview_news(news),
            Ok(Input::EndOfInput) | Err(_) => host.end_of_input(),
        };
        if let Next::Exit(code) = next {
            break code;
        }
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn make(flags: Flags) -> (Host<impl FnMut(&str) -> bool>, std::rc::Rc<std::cell::RefCell<Vec<Value>>>) {
        let lines = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
        let sink = lines.clone();
        let write = move |line: &str| {
            sink.borrow_mut().push(serde_json::from_str(line).unwrap());
            true
        };
        let (inputs, _) = mpsc::channel();
        (Host::new(flags, write, inputs), lines)
    }

    fn open(e2ee: Value, source: Value) -> String {
        json!({ "open": {
            "router_rtp_capabilities": {},
            "transport": {},
            "e2ee": e2ee,
            "source": source,
            "video": { "start_bitrate": 1_500_000, "max_bitrate": 8_000_000 },
        }})
        .to_string()
    }

    fn e2ee() -> Value {
        json!({ "format": 1, "epoch": 0, "key": "AAECAwQFBgcICQoLDA0ODw==", "kid": 1, "counter": 1, "source": { "tag": 3, "stream_key": "s" } })
    }

    fn exit_code(next: Next) -> Option<i32> {
        match next {
            Next::Exit(code) => Some(code),
            Next::Continue => None,
        }
    }

    #[test]
    fn hello_first_and_protocol_checked() {
        let _serial = serial();
        let (mut host, lines) = make(Flags::default());
        assert_eq!(exit_code(host.line(r#"{"start": {}}"#)), None);
        assert_eq!(lines.borrow()[0]["error"]["fatal"], false);
        assert_eq!(exit_code(host.line(r#"{"hello": {"protocol": 1}}"#)), None);
        let sources = if cfg!(all(feature = "capture", any(target_os = "linux", target_os = "windows"))) {
            json!(["file", "pattern", "screen"])
        } else if cfg!(all(feature = "encode", any(target_os = "linux", target_os = "windows"))) {
            json!(["file", "pattern"])
        } else {
            json!(["file"])
        };
        assert_eq!(lines.borrow()[1]["hello"]["sources"], sources);
        // AV1 only where this build on this machine encodes it (Q2).
        let codecs = if pylon_media::video::av1_encode_available() { json!(["H264", "AV1"]) } else { json!(["H264"]) };
        assert_eq!(lines.borrow()[1]["hello"]["codecs"], codecs);
        if !cfg!(all(feature = "encode", target_os = "linux")) {
            assert_eq!(codecs, json!(["H264"]));
        }

        let (mut host, lines) = host_with_hooks();
        assert_eq!(exit_code(host.line(r#"{"hello": {"protocol": 2}}"#)), Some(1));
        assert_eq!(lines.borrow()[0]["error"]["fatal"], true);
        assert_eq!(lines.borrow()[1]["closed"]["reason"], "error");
    }

    fn host_with_hooks() -> (Host<impl FnMut(&str) -> bool>, std::rc::Rc<std::cell::RefCell<Vec<Value>>>) {
        make(Flags { insecure_plain: false, test_hooks: true })
    }

    #[test]
    fn plain_refused_without_flag() {
        let _serial = serial();
        let (mut host, lines) = make(Flags { insecure_plain: false, test_hooks: true });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(exit_code(host.line(&open(Value::Null, json!({ "synthetic": { "fps": 30 } })))), Some(1));
        let lines = lines.borrow();
        assert_eq!(lines[1]["error"]["fatal"], true);
        assert!(lines[1]["error"]["message"].as_str().unwrap().contains("--insecure-plain"));
        assert_eq!(lines[2]["closed"]["reason"], "error");
    }

    #[test]
    fn synthetic_refused_without_flag() {
        let _serial = serial();
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: false });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(exit_code(host.line(&open(Value::Null, json!({ "synthetic": { "fps": 30 } })))), Some(1));
        let lines = lines.borrow();
        assert!(lines[1]["error"]["message"].as_str().unwrap().contains("--test-hooks"));
        assert_eq!(lines[1]["error"]["fatal"], true);
    }

    #[cfg(not(all(feature = "encode", any(target_os = "linux", target_os = "windows"))))]
    #[test]
    fn pattern_refused_without_the_feature() {
        let _serial = serial();
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: true });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(lines.borrow()[0]["hello"]["sources"], json!(["file", "synthetic"]));
        let source = json!({ "pattern": { "width": 1920, "height": 1080, "fps": 60 } });
        assert_eq!(exit_code(host.line(&open(Value::Null, source))), Some(1));
        let lines = lines.borrow();
        assert_eq!(lines[1]["error"]["fatal"], true);
        let wanted = if cfg!(feature = "encode") { "not implemented on this system" } else { "encode feature" };
        assert!(lines[1]["error"]["message"].as_str().unwrap().contains(wanted), "{}", lines[1]);
    }

    #[cfg(not(all(feature = "capture", any(target_os = "linux", target_os = "windows"))))]
    #[test]
    fn capture_refused_without_the_feature() {
        let _serial = serial();
        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert!(!lines.borrow()[0]["hello"]["sources"].as_array().unwrap().contains(&json!("screen")));
        assert_eq!(exit_code(host.line(r#"{"capture": {"screen": {"restore_token": null}}}"#)), Some(1));
        let lines = lines.borrow();
        assert_eq!(lines[1]["error"]["fatal"], true);
        let wanted = if cfg!(feature = "capture") { "not implemented on this system" } else { "capture feature" };
        assert!(lines[1]["error"]["message"].as_str().unwrap().contains(wanted), "{}", lines[1]);
        assert_eq!(lines[2]["closed"]["reason"], "error");
    }

    #[test]
    fn screen_needs_a_ready_capture_and_capture_comes_first() {
        let _serial = serial();
        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        let source = json!({ "screen": { "fps": 60, "max_width": 1920, "max_height": 1080 } });
        assert_eq!(exit_code(host.line(&open(e2ee(), source))), Some(1));
        assert!(lines.borrow()[1]["error"]["message"].as_str().unwrap().contains("capture_ready first"), "{}", lines.borrow()[1]);

        // After an open, capture is refused but not fatal.
        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        host.open_tried = true;
        assert_eq!(exit_code(host.line(r#"{"capture": {"screen": {}}}"#)), None);
        assert_eq!(lines.borrow()[1]["error"]["message"], "capture must come before open");
        assert_eq!(lines.borrow()[1]["error"]["fatal"], false);
    }

    #[test]
    fn capture_news_is_reported() {
        let _serial = serial();
        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        let ready = Reply::CaptureReady {
            width: 1920,
            height: 1080,
            format: Some("XR24".into()),
            modifier: None,
            dmabuf: false,
            restore_token: None,
        };
        assert_eq!(exit_code(host.capture_news(CaptureNews::Ready(ready))), None);
        assert!(host.capture_ready);
        assert_eq!(exit_code(host.capture_news(CaptureNews::Changed { width: 800, height: 600 })), None);
        assert_eq!(exit_code(host.capture_news(CaptureNews::Cancelled)), None);
        assert_eq!(exit_code(host.capture_news(CaptureNews::Ended)), Some(0));
        let lines = lines.borrow();
        assert_eq!(lines[1]["capture_ready"]["width"], 1920);
        assert_eq!(lines[2]["capture_changed"]["height"], 600);
        assert!(lines[3].get("capture_cancelled").is_some());
        assert_eq!(lines[4]["closed"]["reason"], "capture_ended");

        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(exit_code(host.capture_news(CaptureNews::Failed("no portal".into()))), Some(1));
        assert_eq!(lines.borrow()[1]["error"]["fatal"], true);
        assert_eq!(lines.borrow()[1]["error"]["message"], "capture: no portal");
    }

    #[test]
    fn av1_opens_are_checked() {
        let _serial = serial();
        // The synthetic source stays H264 (Q9).
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: true });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        let mut line: Value = serde_json::from_str(&open(Value::Null, json!({ "synthetic": { "fps": 30 } }))).unwrap();
        line["open"]["video"]["codec"] = json!("AV1");
        assert_eq!(exit_code(host.line(&line.to_string())), Some(1));
        let wanted = if cfg!(target_os = "windows") { "not supported on Windows" } else { "H264 only" };
        assert!(lines.borrow()[1]["error"]["message"].as_str().unwrap().contains(wanted), "{}", lines.borrow()[1]);

        // A codec the protocol does not know is a failed open.
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: true });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        line["open"]["video"]["codec"] = json!("VP9");
        assert_eq!(exit_code(host.line(&line.to_string())), Some(1));
        assert_eq!(lines.borrow()[1]["error"]["message"], "open: the fields do not fit the message");

        // An AV1 file source reads IVF: an Annex-B file is refused.
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: true });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        let path = std::env::temp_dir().join(format!("pylon-media-host-test-{}.ivf", std::process::id()));
        std::fs::write(&path, [0, 0, 1, 0x65, 1]).unwrap();
        let mut line: Value = serde_json::from_str(&open(e2ee(), json!({ "file": { "path": path, "fps": 30 } }))).unwrap();
        line["open"]["video"]["codec"] = json!("AV1");
        let next = host.line(&line.to_string());
        std::fs::remove_file(&path).unwrap();
        assert_eq!(exit_code(next), Some(1));
        let wanted = if cfg!(target_os = "windows") { "not supported on Windows" } else { "not an IVF file" };
        assert!(lines.borrow()[1]["error"]["message"].as_str().unwrap().contains(wanted), "{}", lines.borrow()[1]);
    }

    #[test]
    fn preview_is_refused_before_open_and_for_sources_without_a_picture() {
        let _serial = serial();
        const PREVIEW: &str = r#"{"preview": {"fps": 5, "max_width": 480, "max_height": 270}}"#;
        let path = std::env::temp_dir().join(format!("pylon-media-host-preview-{}.h264", std::process::id()));
        std::fs::write(&path, [0, 0, 1, 0x65, 1]).unwrap();
        for (source, name) in [(json!({ "synthetic": { "fps": 30 } }), "synthetic"), (json!({ "file": { "path": path, "fps": 30 } }), "file")] {
            let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: true });
            host.line(r#"{"hello": {"protocol": 1}}"#);
            assert_eq!(exit_code(host.line(PREVIEW)), None);
            assert_eq!(lines.borrow()[1]["error"]["message"], "preview before opened");
            assert_eq!(lines.borrow()[1]["error"]["fatal"], false);
            let open = json!({ "open": {
                "router_rtp_capabilities": serde_json::from_str::<Value>(include_str!("../../pylon-media/testdata/router_rtp_capabilities.json")).unwrap(),
                "transport": serde_json::from_str::<Value>(include_str!("../../pylon-media/testdata/transport.json")).unwrap(),
                "e2ee": null,
                "source": source,
                "video": { "start_bitrate": 1_500_000, "max_bitrate": 8_000_000 },
            }});
            assert_eq!(exit_code(host.line(&open.to_string())), None);
            assert!(lines.borrow()[2].get("opened").is_some(), "{}", lines.borrow()[2]);
            // Not fatal (R6), and the session goes on.
            assert_eq!(exit_code(host.line(PREVIEW)), None);
            let wanted = format!("preview: the {name} source has no picture to preview");
            assert_eq!(lines.borrow()[3]["error"]["message"], wanted.as_str());
            assert_eq!(lines.borrow()[3]["error"]["fatal"], false);
            assert!(host.engine.is_some());
            assert_eq!(exit_code(host.line(r#"{"close": {}}"#)), Some(0));
        }
        std::fs::remove_file(&path).unwrap();
    }

    #[test]
    fn test_hook_refused_without_flag() {
        let _serial = serial();
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: false });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(exit_code(host.line(r#"{"test_drop_media": {"count": 5}}"#)), None);
        let lines = lines.borrow();
        assert_eq!(lines[1]["error"]["fatal"], false);
        assert!(lines[1]["error"]["message"].as_str().unwrap().contains("--test-hooks"));
    }

    #[test]
    fn bad_open_is_fatal_and_bad_lines_are_not() {
        let _serial = serial();
        let (mut host, lines) = make(Flags { insecure_plain: true, test_hooks: true });
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(exit_code(host.line("not json")), None);
        assert_eq!(exit_code(host.line(r#"{"dance": {}}"#)), None);
        assert_eq!(exit_code(host.line(r#"{"start": {}}"#)), None);
        // Parameters the engine cannot use: an error, no panic.
        assert_eq!(exit_code(host.line(&open(e2ee(), json!({ "file": { "path": "/nonexistent.h264", "fps": 30 } })))), Some(1));
        let lines = lines.borrow();
        assert_eq!(lines[1]["error"]["fatal"], false);
        assert_eq!(lines[2]["error"]["message"], "unknown message dance");
        assert_eq!(lines[3]["error"]["message"], "start before opened");
        assert_eq!(lines[4]["error"]["fatal"], true);
        assert_eq!(lines[5]["closed"]["reason"], "error");
    }

    #[test]
    fn bad_key_length_is_fatal_at_open() {
        let _serial = serial();
        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        let mut bad = e2ee();
        bad["key"] = json!("AAECAwQFBgcICQoLDA0O");
        let path = std::env::temp_dir().join(format!("pylon-media-host-test-{}.h264", std::process::id()));
        std::fs::write(&path, [0, 0, 1, 0x65, 1]).unwrap();
        let next = host.line(&open(bad, json!({ "file": { "path": path, "fps": 30 } })));
        std::fs::remove_file(&path).unwrap();
        assert_eq!(exit_code(next), Some(1));
        assert!(lines.borrow()[1]["error"]["message"].as_str().unwrap().contains("15 bytes"));
    }

    /// Held by `logged` and by every test that runs the host's code.
    ///
    /// tracing caches a callsite's interest for all threads the first time any thread reaches
    /// it. While `logged`'s subscriber is the only one alive, a callsite first reached by a
    /// thread with no subscriber is cached as "never", and `logged` misses its event.
    static SERIAL: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn serial() -> std::sync::MutexGuard<'static, ()> {
        SERIAL.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// What the host logs while `run` runs on this thread.
    fn logged(run: impl FnOnce()) -> String {
        let _serial = serial();
        #[derive(Clone, Default)]
        struct Buffer(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Buffer {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buffer = Buffer::default();
        let writer = buffer.clone();
        let subscriber = tracing_subscriber::fmt()
            .with_writer(move || writer.clone())
            .with_ansi(false)
            .with_env_filter(tracing_subscriber::EnvFilter::new("trace"))
            .finish();
        tracing::subscriber::with_default(subscriber, run);
        String::from_utf8(buffer.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn a_malformed_key_or_open_does_not_echo_the_key() {
        const SECRET: &str = "AAECAwQFBgcICQoLDA0ODw==";
        let mut replies = Vec::new();
        let log = logged(|| {
            // A malformed key after an open that failed, then a malformed open.
            let (mut host, lines) = make(Flags::default());
            host.line(r#"{"hello": {"protocol": 1}}"#);
            host.open_tried = true;
            host.line(&format!(r#"{{"key": {{"format": "{SECRET}", "epoch": 1, "key": "{SECRET}"}}}}"#));
            host.line(&format!(r#"{{"key": {{"format": 1, "epoch": 1, "key": "{SECRET}"}}, "close": {{}}}}"#));
            replies.extend(lines.borrow().iter().cloned());

            let (mut host, lines) = make(Flags::default());
            host.line(r#"{"hello": {"protocol": 1}}"#);
            let mut bad = e2ee();
            bad["kid"] = json!(SECRET);
            assert_eq!(exit_code(host.line(&open(bad, json!({ "file": { "path": "/x.h264", "fps": 30 } })))), Some(1));
            replies.extend(lines.borrow().iter().cloned());
        });
        // Hello and two errors for the keys, then hello, the open's fatal error and its close.
        assert_eq!(replies.len(), 6, "{replies:?}");
        assert_eq!(replies[4]["error"]["message"], "open: the fields do not fit the message");
        assert!(log.contains("the fields do not fit the message"), "{log}");
        let text = format!("{replies:?}");
        for (what, text) in [("replies", text.as_str()), ("log", log.as_str())] {
            assert!(!text.contains(SECRET) && !text.contains("AAECAw"), "{what}: {text}");
        }
    }

    #[test]
    fn watchdog_ends_after_its_time() {
        let (tx, rx) = mpsc::channel();
        let began = Instant::now();
        arm_watchdog(Duration::from_millis(50), 3, move |code| tx.send(code).unwrap());
        assert_eq!(rx.recv_timeout(Duration::from_secs(2)), Ok(3));
        assert!(began.elapsed() >= Duration::from_millis(50));
    }

    fn engine_events(inputs: &Receiver<Input>) -> Vec<Event> {
        inputs
            .try_iter()
            .map(|input| match input {
                Input::Engine(event) => event,
                _ => panic!("not an engine event"),
            })
            .collect()
    }

    #[test]
    fn engine_events_that_end_without_closed_close_as_an_error() {
        let (events, events_rx) = mpsc::channel();
        let (inputs, inputs_rx) = mpsc::channel();
        events.send(Event::Connected).unwrap();
        // The engine's thread is gone (a panic) without a last event.
        drop(events);
        forward_events(events_rx, inputs);
        let got = engine_events(&inputs_rx);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0], Event::Connected);
        assert!(matches!(&got[1], Event::Error { fatal: true, .. }));
        assert_eq!(got[2], Event::Closed(CloseReason::Error));

        let (events, events_rx) = mpsc::channel();
        let (inputs, inputs_rx) = mpsc::channel();
        events.send(Event::Closed(CloseReason::Requested)).unwrap();
        drop(events);
        forward_events(events_rx, inputs);
        assert_eq!(engine_events(&inputs_rx), vec![Event::Closed(CloseReason::Requested)]);
    }

    #[test]
    fn close_and_end_of_input_exit_0() {
        let _serial = serial();
        let (mut host, lines) = make(Flags::default());
        host.line(r#"{"hello": {"protocol": 1}}"#);
        assert_eq!(exit_code(host.line(r#"{"close": {}}"#)), Some(0));
        assert_eq!(lines.borrow()[1]["closed"]["reason"], "close");

        let (mut host, lines) = make(Flags::default());
        assert_eq!(exit_code(host.line(r#"{"close": {}}"#)), Some(0));
        assert_eq!(lines.borrow()[0]["closed"]["reason"], "close");

        let (mut host, lines) = make(Flags::default());
        assert_eq!(exit_code(host.end_of_input()), Some(0));
        assert_eq!(lines.borrow()[0]["closed"]["reason"], "end_of_input");
    }
}
