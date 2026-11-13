// Screen capture on Windows (.plans/native-media-engine-m7-5-windows-capture.md): Windows Graphics
// Capture of the monitor or the window the host names (no dialog, the client's own picker chose:
// C1), its frames handed to the encoder as the capture's own BGRA textures on the encoder's D3D11
// device, with no copy (C3 to C5).
//
// One thread of its own makes the item, the device, the frame pool and the session
// (`session.rs`) and then waits for the stop. Frames arrive on the pool's own threads (it is free
// threaded) and wait, newest first, until the pipeline takes one, as on Linux. A frame holds the
// capture's frame object, so its buffer goes back to the pool when the pipeline drops the frame.

mod session;

use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use super::{D3d11Encoder, D3d11Frame, device::Device};
use crate::{
    Error,
    source::{CaptureReport, SourceControl, check_fps},
    video::{EncoderConfig, FrameProducer, Produced, VideoPipeline, bucket::TokenBucket},
};

pub use session::{init_runtime, make_dpi_aware};

/// What to capture (C1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CaptureTarget {
    /// A window, by its handle.
    Window(u64),
    /// The monitor that holds this point, in physical pixels of the virtual screen.
    Monitor { x: i32, y: i32 },
}

/// What the capture reports.
#[derive(Clone, Debug, PartialEq)]
pub enum CaptureEvent {
    /// Frames flow (or the first did not come within a few seconds).
    Ready(CaptureInfo),
    /// The capture could not start or broke.
    Failed(String),
    /// The captured content changed its size (a resized window, C6).
    Changed { width: u32, height: u32 },
    /// The item went away by itself (the window closed, C11).
    Ended,
}

/// What is captured.
#[derive(Clone, Debug, PartialEq)]
pub struct CaptureInfo {
    /// The item's size when the capture started.
    pub width: u32,
    pub height: u32,
    /// `monitor` or `window`.
    pub source: &'static str,
    /// The adapter the capture and the encoder share (C4).
    pub adapter: String,
    /// Whether Windows still draws its border around the captured item (C10), `None` when it
    /// did not say.
    pub border: Option<bool>,
    /// The capture's least time between frames in milliseconds (C9), `None` when Windows has no
    /// such setting.
    pub min_update_ms: Option<f64>,
}

/// The frame waiting for the pipeline, and the counters.
#[derive(Default)]
pub(crate) struct State {
    pub pending: Option<D3d11Frame>,
    pub ended: bool,
    pub delivered: u64,
    pub taken: u64,
    pub dropped: u64,
}

/// Between the capture's threads and the pipeline.
#[derive(Default)]
pub(crate) struct Shared {
    pub state: Mutex<State>,
    pub changed: Condvar,
    pub stop: AtomicBool,
    /// The device and the item's size, once the capture has started.
    pub started: Mutex<Option<(Arc<Device>, (u32, u32))>>,
}

type Events = Arc<dyn Fn(CaptureEvent) + Send + Sync>;

/// A screen capture through Windows Graphics Capture. Dropping it stops the capture.
pub struct ScreenCapture {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl ScreenCapture {
    /// Starts capturing `target` (the primary monitor when `None`), at most `max_fps` frames a
    /// second where Windows can limit it (C9). A target that does not exist is an error here
    /// (C2). `events` hears the outcome and what follows, from the capture's threads.
    pub fn start(
        target: Option<CaptureTarget>,
        max_fps: Option<u32>,
        events: impl Fn(CaptureEvent) + Send + Sync + 'static,
    ) -> Result<ScreenCapture, Error> {
        if let Some(fps) = max_fps {
            check_fps(fps)?;
        }
        // Kept for the process from here on, if the process did not do it at its start (M7.5b Z2).
        init_runtime();
        let resolved = session::resolve(target).map_err(Error::invalid)?;
        let shared = Arc::new(Shared::default());
        let events: Events = Arc::new(events);
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("pylon-media capture".into())
            .spawn(move || session::run(resolved, max_fps, thread_shared, events))
            .map_err(|e| Error::io("capture thread", e))?;
        Ok(ScreenCapture { shared, thread: Some(thread) })
    }

    /// The frames for a pipeline at `fps`: no more than that many a second, the newest first.
    pub fn producer(&self, fps: u32) -> Result<CaptureProducer, Error> {
        check_fps(fps)?;
        Ok(CaptureProducer {
            shared: self.shared.clone(),
            interval: Duration::from_nanos(1_000_000_000 / fps as u64),
            bucket: TokenBucket::new(fps),
        })
    }

    /// The hardware encoder on the capture's device, for frames up to `max_width` by
    /// `max_height`, opened for the item's size (C7). Only once the capture has started.
    pub fn encoder(&self, fps: u32, max_width: u32, max_height: u32, max_bitrate: u64) -> Result<D3d11Encoder, Error> {
        let started = self.shared.started.lock().map_err(|_| Error::Media("capture state poisoned".into()))?.clone();
        let (device, size) = started.ok_or_else(|| Error::Media("the capture has not started".into()))?;
        let config = EncoderConfig { width: max_width, height: max_height, fps, start_bitrate: max_bitrate, filler: false };
        D3d11Encoder::new(config, device, size)
    }

    /// Tells the capture to stop without waiting for it. Its producers end at their next call.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        self.shared.changed.notify_all();
    }
}

impl Drop for ScreenCapture {
    fn drop(&mut self) {
        self.stop();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Reports a failure, unless the capture was stopped on purpose and this is its teardown.
fn failed(shared: &Shared, events: &Events, message: String) {
    if shared.stop.load(Ordering::Relaxed) {
        tracing::info!(%message, "screen capture stopped with an error");
        return;
    }
    tracing::error!(%message, "screen capture failed");
    events(CaptureEvent::Failed(message));
}

/// Marks the capture over for the pipeline. The waiting frame goes back.
fn finish(shared: &Shared) {
    let pending = match shared.state.lock() {
        Ok(mut state) => {
            state.ended = true;
            state.pending.take()
        }
        Err(_) => None,
    };
    drop(pending);
    shared.changed.notify_all();
}

/// The longest a wait goes without looking at the stop flag.
const WAIT_STEP: Duration = Duration::from_millis(20);

/// The capture's frames for one pipeline: the newest wins, no more than `fps` a second (as on
/// Linux, M5b D5).
pub struct CaptureProducer {
    shared: Arc<Shared>,
    interval: Duration,
    /// A token bucket that fills at `fps`.
    bucket: TokenBucket,
}

impl CaptureProducer {
    fn stopped(&self, control: &SourceControl, state: &State) -> bool {
        control.stopped() || state.ended || self.shared.stop.load(Ordering::Relaxed)
    }

    /// The report's capture counters from `state`.
    fn report(state: &State, control: &SourceControl) {
        let report = CaptureReport {
            frames_delivered: state.delivered,
            frames_taken: state.taken,
            frames_dropped_rate: state.dropped,
            buffer_path: "d3d11",
        };
        control.update_report(|r| r.capture = Some(report));
    }
}

impl FrameProducer for CaptureProducer {
    type Frame = D3d11Frame;
    fn next_frame(&mut self, control: &SourceControl, until: Instant) -> Result<Produced<D3d11Frame>, Error> {
        let shared = self.shared.clone();
        let mut state = shared.state.lock().map_err(|_| Error::Media("capture state poisoned".into()))?;
        loop {
            Self::report(&state, control);
            if self.stopped(control, &state) {
                return Ok(Produced::End);
            }
            let now = Instant::now();
            self.bucket.refill(now);
            if state.pending.is_some() && self.bucket.tokens >= 1.0 {
                let frame = state.pending.take().expect("checked above");
                state.taken += 1;
                Self::report(&state, control);
                drop(state);
                self.bucket.tokens -= 1.0;
                return Ok(Produced::Frame(frame));
            }
            let wake = if state.pending.is_some() {
                // A frame waits for its token. Newer ones may replace it meanwhile.
                now + Duration::from_secs_f64((1.0 - self.bucket.tokens) / self.bucket.fps)
            } else {
                if now >= until {
                    return Ok(Produced::Idle);
                }
                until
            };
            let wait = wake.saturating_duration_since(now).min(WAIT_STEP).max(Duration::from_micros(100));
            state = shared
                .changed
                .wait_timeout(state, wait)
                .map_err(|_| Error::Media("capture state poisoned".into()))?
                .0;
        }
    }

    fn interval(&self) -> Duration {
        self.interval
    }

    fn captures(&self) -> bool {
        true
    }
}

/// The screen source of the protocol: the capture through the hardware encoder, scaled down to
/// fit `max_width` by `max_height` (and up to the least size, C8), at most `fps` frames a second.
/// H264 only (AV1 step 2, Q2).
pub fn capture_source(
    capture: &ScreenCapture,
    fps: u32,
    max_width: u32,
    max_height: u32,
    max_bitrate: u64,
    codec: crate::VideoCodec,
) -> Result<Box<dyn crate::Source>, Error> {
    super::refuse_other_than_h264(codec)?;
    let producer = capture.producer(fps)?;
    let encoder = capture.encoder(fps, max_width, max_height, max_bitrate)?;
    Ok(Box::new(VideoPipeline::new(producer, encoder)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::frame_channel;

    #[test]
    fn a_target_that_does_not_exist_is_an_error() {
        // Window handles are multiples of 2 well below this, and nothing is this far out.
        for (target, wanted) in [
            (CaptureTarget::Window(0x7fff_fff1), "window 2147483633 does not exist"),
            (CaptureTarget::Window(0), "window 0 does not exist"),
            (CaptureTarget::Monitor { x: -1_000_000, y: -1_000_000 }, "no monitor at (-1000000, -1000000)"),
        ] {
            let Err(error) = ScreenCapture::start(Some(target), Some(60), |_| {}) else {
                panic!("{target:?} started");
            };
            assert!(error.to_string().contains(wanted), "{error}");
        }
        assert!(ScreenCapture::start(None, Some(0), |_| {}).is_err());
    }

    /// A small texture on `device` as a frame `n` wide.
    fn texture_frame(device: &Device, n: u32) -> D3d11Frame {
        use ::windows::Win32::Graphics::{
            Direct3D11::{D3D11_BIND_RENDER_TARGET, D3D11_TEXTURE2D_DESC, D3D11_USAGE_DEFAULT},
            Dxgi::Common::{DXGI_FORMAT_B8G8R8A8_UNORM, DXGI_SAMPLE_DESC},
        };
        let desc = D3D11_TEXTURE2D_DESC {
            Width: 64,
            Height: 16,
            MipLevels: 1,
            ArraySize: 1,
            Format: DXGI_FORMAT_B8G8R8A8_UNORM,
            SampleDesc: DXGI_SAMPLE_DESC { Count: 1, Quality: 0 },
            Usage: D3D11_USAGE_DEFAULT,
            BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
            CPUAccessFlags: 0,
            MiscFlags: 0,
        };
        let mut texture = None;
        // SAFETY: the description lives through the call.
        unsafe { device.device.CreateTexture2D(&desc, None, Some(&mut texture)) }.unwrap();
        D3d11Frame { texture: texture.unwrap(), width: n, height: 16, capture_time: Instant::now(), hold: None }
    }

    fn offer(shared: &Shared, frame: D3d11Frame) {
        let mut state = shared.state.lock().unwrap();
        state.delivered += 1;
        if state.pending.replace(frame).is_some() {
            state.dropped += 1;
        }
        drop(state);
        shared.changed.notify_all();
    }

    fn width(produced: Produced<D3d11Frame>) -> Option<u32> {
        match produced {
            Produced::Frame(frame) => Some(frame.width),
            _ => None,
        }
    }

    /// On the GPU (any session): run with `--ignored`. The Linux producer's test, with textures.
    #[test]
    #[ignore]
    fn gpu_newest_wins_and_the_rate_holds() {
        let device = Device::open().unwrap();
        let capture = ScreenCapture { shared: Arc::new(Shared::default()), thread: None };
        let shared = capture.shared.clone();
        let mut producer = capture.producer(50).unwrap();
        let control = SourceControl::default();
        let soon = || Instant::now() + Duration::from_millis(5);
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::Idle));
        offer(&shared, texture_frame(&device, 1));
        offer(&shared, texture_frame(&device, 2));
        assert_eq!(width(producer.next_frame(&control, soon()).unwrap()), Some(2));
        offer(&shared, texture_frame(&device, 3));
        let began = Instant::now();
        assert_eq!(width(producer.next_frame(&control, soon()).unwrap()), Some(3));
        assert!(began.elapsed() >= Duration::from_millis(8), "{:?}", began.elapsed());
        let began = Instant::now();
        let mut taken = 0;
        while began.elapsed() < Duration::from_millis(400) {
            for _ in 0..10 {
                offer(&shared, texture_frame(&device, 4));
            }
            if width(producer.next_frame(&control, Instant::now()).unwrap()).is_some() {
                taken += 1;
            }
        }
        assert!((18..=23).contains(&taken), "{taken} taken");
        let mut report = None;
        control.update_report(|r| report = r.capture.clone());
        let report = report.unwrap();
        assert_eq!(report.frames_taken, taken + 2);
        assert_eq!(report.buffer_path, "d3d11");
        assert!(report.frames_dropped_rate >= 100);
        capture.stop();
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::End));
    }

    /// In the desktop session, on the GPU: run with `--ignored` through runtask.ps1, capturing a
    /// still window of the test's own (its handle in PYLON_TEST_CAPTURE_WINDOW), else the primary
    /// monitor with nothing moving on it. Frames stop coming, and a key frame asked for then is
    /// made from the kept frame. With PYLON_TEST_H264 set, the stream is written there.
    #[test]
    #[ignore]
    fn gpu_desktop_a_still_screen_answers_a_key_frame_from_the_kept_frame() {
        let target = std::env::var("PYLON_TEST_CAPTURE_WINDOW").ok().map(|w| CaptureTarget::Window(w.parse().unwrap()));
        eprintln!("target {target:?}");
        let (tx, events) = std::sync::mpsc::channel();
        let capture = ScreenCapture::start(target, Some(60), move |event| {
            let _ = tx.send(event);
        })
        .unwrap();
        let info = match events.recv_timeout(Duration::from_secs(10)).unwrap() {
            CaptureEvent::Ready(info) => info,
            other => panic!("{other:?}"),
        };
        eprintln!("ready: {info:?}");
        let source = capture.producer(60).unwrap();
        let encoder = capture.encoder(60, 1920, 1080, 4_000_000).unwrap();
        let mut pipeline = VideoPipeline::new(source, encoder);
        let control = SourceControl::default();
        control.set_target_bitrate(4_000_000);
        let (sink, frames, _) = frame_channel(1024);
        let run_for = |pipeline: &mut VideoPipeline<CaptureProducer, D3d11Encoder>, ms: u64| {
            let began = Instant::now();
            while began.elapsed() < Duration::from_millis(ms) {
                assert!(pipeline.step(&sink, &control).unwrap());
            }
        };
        // The first frame, then a still screen.
        run_for(&mut pipeline, 1500);
        let delivered = |control: &SourceControl| {
            let mut report = None;
            control.update_report(|r| report = r.capture.clone());
            report.unwrap().frames_delivered
        };
        let before = delivered(&control);
        let sent_before = frames.try_iter().count();
        run_for(&mut pipeline, 3000);
        let still = delivered(&control) - before;
        let sent_still = frames.try_iter().count();
        eprintln!("first 1.5 s: {before} delivered, {sent_before} sent; next 3 s: {still} delivered, {sent_still} sent");
        let repeated_before = control.take_report().key_frames_repeated;
        control.want_key_frame();
        run_for(&mut pipeline, 1000);
        let report = control.take_report();
        let after: Vec<_> = frames.try_iter().collect();
        let keys = after.iter().filter(|f| f.key).count();
        eprintln!(
            "after the request: {} frames, {keys} key, forced {}, repeated {} (before {repeated_before}), delivered {}",
            after.len(),
            report.key_frames_forced,
            report.key_frames_repeated,
            report.capture.as_ref().map_or(0, |c| c.frames_delivered)
        );
        if let Ok(path) = std::env::var("PYLON_TEST_H264") {
            std::fs::write(path, after.iter().flat_map(|f| f.data.iter().copied()).collect::<Vec<u8>>()).unwrap();
        }
        // Still: at most a few frames (a clock, a cursor) in 3 s.
        assert!(still <= 10, "{still} frames on a still screen");
        assert!(keys >= 1, "no key frame after the request");
        assert_eq!(report.key_frames_repeated - repeated_before, 1, "the key frame was not made from the kept frame");
        drop(pipeline);
        drop(capture);
    }
}
