// Screen capture on Linux (.plans/native-media-engine-m5b-capture.md): the desktop portal's
// ScreenCast for the choice, PipeWire for the frames, which reach the encoder as the DMA-BUFs
// the compositor made (or, when that cannot be agreed, from memory through an upload).
//
// One thread of its own runs the portal calls (on a small executor that stays in this module)
// and then PipeWire's loop. Frames wait there, newest first, until the pipeline takes one. A
// DMA-BUF taken goes back to the compositor when the pipeline asks for the next.

mod egl;
mod portal;
mod stream;
mod upload;

use std::{
    os::fd::OwnedFd,
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use super::DmaBufFrame;
use crate::{
    Error,
    source::{CaptureReport, SourceControl, check_fps},
    video::{FrameProducer, Produced, bucket::TokenBucket},
};

/// What the capture reports.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CaptureEvent {
    /// The person chose and frames flow.
    Ready(CaptureInfo),
    /// The person said no in the dialog.
    Cancelled,
    /// The portal or PipeWire is not there or failed.
    Failed(String),
    /// The source changed its size (a resized window).
    Changed { width: u32, height: u32 },
    /// The stream ended by itself (stopped from the compositor, the window closed).
    Ended,
}

/// What was agreed with the compositor.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptureInfo {
    pub width: u32,
    pub height: u32,
    /// DRM fourcc, `XR24` for BGRx.
    pub fourcc: u32,
    /// The DMA-BUF modifier, `None` on the memory path.
    pub modifier: Option<u64>,
    pub dmabuf: bool,
    /// For the next capture, so the portal may not need to ask again.
    pub restore_token: Option<String>,
    /// `monitor` or `window`.
    pub source: &'static str,
    /// `embedded` or `none`.
    pub cursor: &'static str,
}

/// A frame as PipeWire handed it over.
pub(crate) enum Raw {
    DmaBuf(DmaBufFrame),
    /// A mapped memory buffer: `height` lines of `stride` bytes at address `data`. Valid while
    /// its buffer is held, copied only when the pipeline takes it.
    Memory { width: u32, height: u32, fourcc: u32, stride: usize, data: usize },
}

/// A PipeWire buffer: its address, and the generation it was added in, so that a buffer added
/// later at the same address is not taken for it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct BufferId {
    pub address: usize,
    pub generation: u64,
}

/// A frame waiting for the pipeline, with the PipeWire buffer it holds.
pub(crate) struct Held {
    pub buffer: Option<BufferId>,
    pub raw: Raw,
    pub arrived: Instant,
}

/// What the PipeWire loop is told by other threads.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum ToLoop {
    /// A buffer the pipeline is done with.
    Release(BufferId),
    Stop,
    /// The DMA-BUF import failed, ask for memory buffers.
    Memory,
}

#[derive(Default)]
pub(crate) struct State {
    pub pending: Option<Held>,
    pub ended: bool,
    pub delivered: u64,
    pub taken: u64,
    pub dropped: u64,
    pub path: &'static str,
}

/// Between the PipeWire loop and the pipeline.
#[derive(Default)]
pub(crate) struct Shared {
    pub state: Mutex<State>,
    pub changed: Condvar,
    pub to_loop: Mutex<Option<pipewire::channel::Sender<ToLoop>>>,
    pub stop: AtomicBool,
    /// What was sent toward the loop, for the tests.
    #[cfg(test)]
    pub sent: Mutex<Vec<ToLoop>>,
}

impl Shared {
    pub fn send(&self, message: ToLoop) {
        #[cfg(test)]
        if let Ok(mut sent) = self.sent.lock() {
            sent.push(message);
        }
        if let Ok(to_loop) = self.to_loop.lock()
            && let Some(to_loop) = to_loop.as_ref()
        {
            let _ = to_loop.send(message);
        }
    }
}

type Events = Arc<dyn Fn(CaptureEvent) + Send + Sync>;

/// A screen capture through the portal. Dropping it stops the capture and closes the portal's
/// session.
pub struct ScreenCapture {
    shared: Arc<Shared>,
    thread: Option<JoinHandle<()>>,
}

impl ScreenCapture {
    /// Starts asking the portal, `restore_token` first, for at most `max_fps` frames a second
    /// from the compositor. `events` hears the outcome and what follows, from the capture's
    /// thread. There is no timeout: a person may take long.
    pub fn start(
        restore_token: Option<String>,
        max_fps: Option<u32>,
        events: impl Fn(CaptureEvent) + Send + Sync + 'static,
    ) -> Result<ScreenCapture, Error> {
        if let Some(fps) = max_fps {
            check_fps(fps)?;
        }
        let shared = Arc::new(Shared::default());
        let events: Events = Arc::new(events);
        let thread_shared = shared.clone();
        let thread = std::thread::Builder::new()
            .name("pylon-media capture".into())
            .spawn(move || run(restore_token, max_fps, thread_shared, events))
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
            taken: None,
            upload: None,
        })
    }
}

impl ScreenCapture {
    /// Tells the capture to stop without waiting for it. Its producers end at their next call.
    pub fn stop(&self) {
        self.shared.stop.store(true, Ordering::Relaxed);
        self.shared.send(ToLoop::Stop);
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

/// How often the portal phase looks at the stop flag.
const STOP_POLL: Duration = Duration::from_millis(100);

fn run(restore_token: Option<String>, max_fps: Option<u32>, shared: Arc<Shared>, events: Events) {
    use futures_util::future::{Either, select};
    let stop = shared.clone();
    let stopped = async move {
        while !stop.stop.load(Ordering::Relaxed) {
            async_io::Timer::after(STOP_POLL).await;
        }
    };
    let outcome = async_io::block_on(async {
        match select(Box::pin(portal::start(restore_token)), Box::pin(stopped)).await {
            Either::Left((outcome, _)) => Some(outcome),
            Either::Right(_) => None,
        }
    });
    let started = match outcome {
        // Stopped while the person was choosing. Dropping the request's connection ends it.
        None => return finish(&shared),
        Some(Ok(portal::Outcome::Cancelled)) => {
            tracing::info!("screen capture cancelled in the portal");
            events(CaptureEvent::Cancelled);
            return finish(&shared);
        }
        Some(Err(message)) => {
            failed(&shared, &events, message);
            return finish(&shared);
        }
        Some(Ok(portal::Outcome::Started(started))) => started,
    };
    let portal::Started { screencast, session, remote, node_id, restore_token, size, source, cursor } = *started;
    let remote: OwnedFd = remote;
    let context = stream::Context { restore_token, source, cursor, portal_size: size, max_fps };
    if let Err(message) = stream::run(remote, node_id, context, shared.clone(), events.clone()) {
        failed(&shared, &events, message);
    }
    finish(&shared);
    if let Err(error) = async_io::block_on(session.close()) {
        tracing::debug!(%error, "portal session close");
    }
    drop(screencast);
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

/// Marks the capture over for the pipeline.
fn finish(shared: &Shared) {
    if let Ok(mut state) = shared.state.lock() {
        state.ended = true;
        state.pending = None;
    }
    shared.changed.notify_all();
}

/// The longest a wait goes without looking at the stop flag.
const WAIT_STEP: Duration = Duration::from_millis(20);

/// The capture's frames for one pipeline (D5): the newest wins, no more than `fps` a second.
pub struct CaptureProducer {
    shared: Arc<Shared>,
    interval: Duration,
    /// A token bucket that fills at `fps`.
    bucket: TokenBucket,
    /// The DMA-BUF the pipeline has last been given. It is held until a newer frame is handed
    /// over, because the pipeline may encode that frame again while nothing new comes.
    taken: Option<BufferId>,
    upload: Option<upload::Upload>,
}

impl CaptureProducer {
    fn release(&mut self) {
        if let Some(buffer) = self.taken.take() {
            self.shared.send(ToLoop::Release(buffer));
        }
    }

    fn stopped(&self, control: &SourceControl, state: &State) -> bool {
        control.stopped() || state.ended || self.shared.stop.load(Ordering::Relaxed)
    }

    /// The report's capture counters from `state`.
    fn report(state: &State, control: &SourceControl) {
        let report = CaptureReport {
            frames_delivered: state.delivered,
            frames_taken: state.taken,
            frames_dropped_rate: state.dropped,
            buffer_path: state.path,
        };
        control.update_report(|r| r.capture = Some(report));
    }

    /// The frame for the pipeline from `held`, with `copied` the bytes of a memory frame. The
    /// buffer of the frame before goes back now that there is a newer one.
    fn frame(&mut self, held: Held, copied: Option<Vec<u8>>) -> Result<DmaBufFrame, Error> {
        self.release();
        match (held.raw, copied) {
            (Raw::DmaBuf(mut frame), _) => {
                self.taken = held.buffer;
                frame.capture_time = held.arrived;
                Ok(frame)
            }
            (Raw::Memory { width, height, fourcc, stride, .. }, Some(bytes)) => {
                // Copied already, the buffer goes back at once.
                if let Some(buffer) = held.buffer {
                    self.shared.send(ToLoop::Release(buffer));
                }
                let upload = match &mut self.upload {
                    Some(upload) => upload,
                    None => self.upload.insert(upload::Upload::new()?),
                };
                upload.frame(width, height, fourcc, stride, &bytes, held.arrived)
            }
            (Raw::Memory { .. }, None) => Err(Error::Media("memory frame without its copy".into())),
        }
    }
}

/// A copy of the memory frame `raw` points to, `None` for a DMA-BUF.
///
/// # Safety
/// `raw` is pending in the capture's state and its lock is held, so its buffer is neither given
/// back nor removed meanwhile (`remove_buffer` takes the lock to drop it).
unsafe fn copy_memory(raw: &Raw) -> Option<Vec<u8>> {
    match raw {
        Raw::DmaBuf(_) => None,
        // SAFETY: the stream checked that `height` lines of `stride` bytes fit the mapped buffer.
        Raw::Memory { height, stride, data, .. } => {
            Some(unsafe { std::slice::from_raw_parts(*data as *const u8, stride * *height as usize) }.to_vec())
        }
    }
}

impl FrameProducer for CaptureProducer {
    type Frame = DmaBufFrame;
    fn next_frame(&mut self, control: &SourceControl, until: Instant) -> Result<Produced<DmaBufFrame>, Error> {
        let shared = self.shared.clone();
        let mut state = shared.state.lock().map_err(|_| Error::Media("capture state poisoned".into()))?;
        loop {
            Self::report(&state, control);
            if self.stopped(control, &state) {
                drop(state);
                self.release();
                return Ok(Produced::End);
            }
            let now = Instant::now();
            self.bucket.refill(now);
            if state.pending.is_some() && self.bucket.tokens >= 1.0 {
                let held = state.pending.take().expect("checked above");
                // Only a frame that has its token is copied, never one a newer frame replaces.
                // SAFETY: just taken out of the state, whose lock is still held.
                let copied = unsafe { copy_memory(&held.raw) };
                state.taken += 1;
                Self::report(&state, control);
                drop(state);
                self.bucket.tokens -= 1.0;
                return self.frame(held, copied).map(Produced::Frame);
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

impl Drop for CaptureProducer {
    fn drop(&mut self) {
        self.release();
    }
}

/// The screen source of the protocol: the capture through the hardware encoder, scaled down to
/// fit `max_width` by `max_height`, at most `fps` frames a second, in `codec`.
pub fn capture_source(
    capture: &ScreenCapture,
    fps: u32,
    max_width: u32,
    max_height: u32,
    max_bitrate: u64,
    codec: crate::VideoCodec,
) -> Result<Box<dyn crate::Source>, Error> {
    let producer = capture.producer(fps)?;
    let encoder = super::VaapiEncoder::with_codec(
        super::EncoderConfig {
            width: max_width,
            height: max_height,
            fps,
            start_bitrate: max_bitrate,
            filler: false,
        },
        codec,
    )?;
    Ok(Box::new(super::VideoPipeline::new(producer, encoder)))
}

/// `XR24` and the like for a fourcc.
pub fn fourcc_text(fourcc: u32) -> String {
    String::from_utf8_lossy(&fourcc.to_le_bytes()).into_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn producer(fps: u32) -> (CaptureProducer, Arc<Shared>) {
        let shared = Arc::new(Shared::default());
        let producer = CaptureProducer {
            shared: shared.clone(),
            interval: Duration::from_nanos(1_000_000_000 / fps as u64),
            bucket: TokenBucket::new(fps),
            taken: None,
            upload: None,
        };
        (producer, shared)
    }

    fn offer(shared: &Shared, n: u32) {
        offer_buffer(shared, n, None);
    }

    fn offer_buffer(shared: &Shared, n: u32, buffer: Option<BufferId>) {
        let frame = DmaBufFrame {
            width: n,
            height: 16,
            fourcc: u32::from_le_bytes(*b"XR24"),
            objects: vec![],
            planes: vec![],
            capture_time: Instant::now(),
        };
        let mut state = shared.state.lock().unwrap();
        state.delivered += 1;
        if state.pending.replace(Held { buffer, raw: Raw::DmaBuf(frame), arrived: Instant::now() }).is_some() {
            state.dropped += 1;
        }
        drop(state);
        shared.changed.notify_all();
    }

    fn sent(shared: &Shared) -> Vec<ToLoop> {
        shared.sent.lock().unwrap().clone()
    }

    #[test]
    fn a_taken_buffer_is_held_until_a_newer_frame() {
        let (mut producer, shared) = producer(50);
        let control = SourceControl::default();
        let soon = || Instant::now() + Duration::from_millis(5);
        let (a, b) = (BufferId { address: 0x1000, generation: 1 }, BufferId { address: 0x1000, generation: 2 });
        offer_buffer(&shared, 1, Some(a));
        assert_eq!(width(producer.next_frame(&control, soon()).unwrap()), Some(1));
        // Nothing new: the pipeline may still encode frame 1 again, its buffer stays.
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::Idle));
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::Idle));
        assert_eq!(sent(&shared), vec![]);
        offer_buffer(&shared, 2, Some(b));
        assert_eq!(width(producer.next_frame(&control, soon()).unwrap()), Some(2));
        assert_eq!(sent(&shared), vec![ToLoop::Release(a)]);
        // The end gives the last one back.
        finish(&shared);
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::End));
        assert_eq!(sent(&shared), vec![ToLoop::Release(a), ToLoop::Release(b)]);
    }

    #[test]
    fn stop_ends_the_producer_without_the_capture_thread() {
        let (mut producer, shared) = producer(50);
        let capture = ScreenCapture { shared: shared.clone(), thread: None };
        let control = SourceControl::default();
        offer(&shared, 1);
        capture.stop();
        assert!(matches!(producer.next_frame(&control, Instant::now() + Duration::from_secs(5)).unwrap(), Produced::End));
        assert_eq!(sent(&shared), vec![ToLoop::Stop]);
    }

    #[test]
    fn a_failure_while_stopping_is_not_reported() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        let events: Events = Arc::new(move |event| record.lock().unwrap().push(event));
        let shared = Shared::default();
        failed(&shared, &events, "PipeWire: gone".into());
        shared.stop.store(true, Ordering::Relaxed);
        failed(&shared, &events, "PipeWire: gone while stopping".into());
        assert_eq!(*seen.lock().unwrap(), vec![CaptureEvent::Failed("PipeWire: gone".into())]);
    }

    /// On the GPU: run with `--ignored`. A memory frame is copied when taken, its buffer goes
    /// back at once, and the upload encodes.
    #[test]
    #[ignore]
    fn gpu_a_memory_frame_is_uploaded_and_its_buffer_given_back() {
        let (mut producer, shared) = producer(60);
        let control = SourceControl::default();
        let (width, height, stride) = (640u32, 360u32, 640 * 4 + 64);
        let picture: Vec<u8> = (0..stride * height as usize).map(|i| (i % 251) as u8).collect();
        let id = BufferId { address: 0x5000, generation: 4 };
        let raw = Raw::Memory { width, height, fourcc: u32::from_le_bytes(*b"XR24"), stride, data: picture.as_ptr() as usize };
        shared.state.lock().unwrap().pending = Some(Held { buffer: Some(id), raw, arrived: Instant::now() });
        let Produced::Frame(frame) = producer.next_frame(&control, Instant::now()).unwrap() else {
            panic!("no frame");
        };
        assert_eq!((frame.width, frame.height), (width, height));
        assert_eq!(sent(&shared), vec![ToLoop::Release(id)]);
        let mut encoder =
            super::super::VaapiEncoder::new(super::super::EncoderConfig { width: 1920, height: 1080, fps: 60, start_bitrate: 2_000_000, filler: false })
                .unwrap();
        let packet = crate::video::FrameEncoder::encode(&mut encoder, &frame, 2_000_000, 1, true).unwrap();
        assert!(packet.key && !packet.data.is_empty());
        // Nothing is held for a memory frame, so the end gives nothing more back.
        finish(&shared);
        assert!(matches!(producer.next_frame(&control, Instant::now()).unwrap(), Produced::End));
        assert_eq!(sent(&shared), vec![ToLoop::Release(id)]);
    }

    #[test]
    fn memory_frames_are_copied_when_taken() {
        let shared = Shared::default();
        let mut bytes = vec![1u8; 64 * 2];
        let raw = Raw::Memory { width: 16, height: 2, fourcc: u32::from_le_bytes(*b"XR24"), stride: 64, data: bytes.as_ptr() as usize };
        shared.state.lock().unwrap().pending = Some(Held { buffer: None, raw, arrived: Instant::now() });
        // Changed after it was offered: the copy has what is there when it is taken.
        bytes[3] = 9;
        let state = shared.state.lock().unwrap();
        // SAFETY: pending, under the lock, `bytes` outlives the copy.
        let copied = unsafe { copy_memory(&state.pending.as_ref().unwrap().raw) }.unwrap();
        assert_eq!(copied.len(), 128);
        assert_eq!(copied[3], 9);
    }

    fn width(produced: Produced<DmaBufFrame>) -> Option<u32> {
        match produced {
            Produced::Frame(frame) => Some(frame.width),
            _ => None,
        }
    }

    #[test]
    fn newest_wins_and_the_rate_holds() {
        let (mut producer, shared) = producer(50);
        let control = SourceControl::default();
        let soon = || Instant::now() + Duration::from_millis(5);
        // Nothing yet: idle by the time asked for.
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::Idle));
        offer(&shared, 1);
        offer(&shared, 2);
        assert_eq!(width(producer.next_frame(&control, soon()).unwrap()), Some(2));
        // Half a token left: the next frame waits about 10 ms for its token.
        offer(&shared, 3);
        let began = Instant::now();
        assert_eq!(width(producer.next_frame(&control, soon()).unwrap()), Some(3));
        let waited = began.elapsed();
        assert!(waited >= Duration::from_millis(8), "{waited:?}");
        // Ten frames before every call for 0.4 s: about 20 go at 50 a second, the rest are
        // replaced by newer ones.
        let began = Instant::now();
        let mut taken = 0;
        while began.elapsed() < Duration::from_millis(400) {
            for _ in 0..10 {
                offer(&shared, 4);
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
        assert!(report.frames_dropped_rate >= 100);
        // The end of the capture ends the producer.
        finish(&shared);
        assert!(matches!(producer.next_frame(&control, soon()).unwrap(), Produced::End));
    }
}
