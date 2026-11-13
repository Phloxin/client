// The sharer's preview (.plans/native-media-engine-m6-preview-1-engine.md, R1 to R8): on request,
// a few times a second, a small JPEG of the frame the encoder has just converted, made on a
// worker thread of its own so that nothing on the encode path waits for it.
//
// The portable parts are here, on any system and with no features: the request and its limits
// (R1), the fit of sizes, the slot that holds one frame and never blocks (R2), the rate and the
// first picture from the kept frame (R3), and the worker's loop. What scales the frame down and
// reads it back is per system (on Linux `linux/preview.rs`, VA-API; on Windows `windows/preview.rs`,
// a read back and `preview_cpu.rs`), the JPEG is libavcodec's (`jpeg.rs`).
//
// Preview pictures are the sharer's screen (R5): they go only to the `Preview`'s own callback,
// are never logged and never reach the transport.

use std::{
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

use crate::Error;

/// The most pictures a second a request may ask for (R1).
pub const MAX_FPS: u32 = 10;
/// The sides a request may ask for (R1).
pub const MIN_SIDE: u32 = 16;
pub const MAX_WIDTH: u32 = 1280;
pub const MAX_HEIGHT: u32 = 720;

/// What the host asks for: at most `fps` pictures a second, each fitted into `max_width` by
/// `max_height`. `fps` 0 stops the preview.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreviewRequest {
    pub fps: u32,
    pub max_width: u32,
    pub max_height: u32,
}

impl PreviewRequest {
    /// The limits of R1: `fps` 0 to 10, `max_width` 16 to 1280, `max_height` 16 to 720.
    pub fn check(&self) -> Result<(), Error> {
        if self.fps > MAX_FPS {
            return Err(Error::invalid(format!("preview fps {} is not in 0 to {MAX_FPS}", self.fps)));
        }
        if !(MIN_SIDE..=MAX_WIDTH).contains(&self.max_width) {
            return Err(Error::invalid(format!("preview max_width {} is not in {MIN_SIDE} to {MAX_WIDTH}", self.max_width)));
        }
        if !(MIN_SIDE..=MAX_HEIGHT).contains(&self.max_height) {
            return Err(Error::invalid(format!("preview max_height {} is not in {MIN_SIDE} to {MAX_HEIGHT}", self.max_height)));
        }
        Ok(())
    }

    /// The time between pictures, `None` when stopped.
    fn interval(&self) -> Option<Duration> {
        (self.fps > 0).then(|| Duration::from_nanos(1_000_000_000 / u64::from(self.fps)))
    }

    // Packed into the low 32 bits of the state: fps (8 bits), width and height (12 bits each).
    fn pack(&self) -> u64 {
        (u64::from(self.fps) << 24) | (u64::from(self.max_width) << 12) | u64::from(self.max_height)
    }

    fn unpack(bits: u64) -> Option<PreviewRequest> {
        let request = PreviewRequest {
            fps: ((bits >> 24) & 0xff) as u32,
            max_width: ((bits >> 12) & 0xfff) as u32,
            max_height: (bits & 0xfff) as u32,
        };
        (request.fps > 0).then_some(request)
    }
}

/// The size of a preview of a `width` by `height` frame: fitted into `max_width` by
/// `max_height` with its shape kept, never larger than the frame, even sides (R2).
pub fn fit(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    super::sizing::output_size(width, height, max_width, max_height)
}

/// One preview picture.
pub struct PreviewPicture {
    pub width: u32,
    pub height: u32,
    /// The JPEG file.
    pub jpeg: Vec<u8>,
}

// Never the picture's bytes (R5).
impl std::fmt::Debug for PreviewPicture {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreviewPicture")
            .field("width", &self.width)
            .field("height", &self.height)
            .field("bytes", &self.jpeg.len())
            .finish()
    }
}

/// What the preview tells its host.
#[derive(Debug)]
pub enum PreviewEvent {
    Picture(PreviewPicture),
    /// Making a picture failed: the preview has stopped (R4). A new request starts it again.
    Failed(String),
}

/// The preview of one source, shared by its host and its pipeline: the host asks with
/// `request`, the pictures come to the callback given to `new`, on the preview's own thread.
pub struct Preview {
    /// A generation counter (high 32 bits) and the packed request (low 32 bits), so that the
    /// pipeline reads both with one load and never waits.
    state: AtomicU64,
    on_event: Box<dyn Fn(PreviewEvent) + Send + Sync>,
}

impl std::fmt::Debug for Preview {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let (generation, request) = self.current();
        f.debug_struct("Preview").field("generation", &generation).field("request", &request).finish_non_exhaustive()
    }
}

impl Preview {
    /// A preview that makes nothing until asked, with `on_event` for its pictures and failures.
    pub fn new(on_event: impl Fn(PreviewEvent) + Send + Sync + 'static) -> Arc<Preview> {
        Arc::new(Preview { state: AtomicU64::new(0), on_event: Box::new(on_event) })
    }

    /// Asks for pictures as `request` says, in place of what was asked before. `fps` 0 stops.
    pub fn request(&self, request: PreviewRequest) -> Result<(), Error> {
        request.check()?;
        let bits = if request.fps == 0 { 0 } else { request.pack() };
        self.update(|state| Some(next_generation(state) | bits));
        Ok(())
    }

    /// Sets the state to what `change` makes of it, unless it says `None`. True if it changed.
    // A loop of its own: `fetch_update` is deprecated in newer toolchains, `try_update` missing in
    // older ones.
    fn update(&self, change: impl Fn(u64) -> Option<u64>) -> bool {
        let mut state = self.state.load(Ordering::Acquire);
        loop {
            let Some(new) = change(state) else {
                return false;
            };
            match self.state.compare_exchange_weak(state, new, Ordering::AcqRel, Ordering::Acquire) {
                Ok(_) => return true,
                Err(now) => state = now,
            }
        }
    }

    /// The generation and what is asked now, `None` when nothing is.
    pub(crate) fn current(&self) -> (u32, Option<PreviewRequest>) {
        let state = self.state.load(Ordering::Acquire);
        ((state >> 32) as u32, PreviewRequest::unpack(state & 0xffff_ffff))
    }

    pub(crate) fn picture(&self, picture: PreviewPicture) {
        (self.on_event)(PreviewEvent::Picture(picture));
    }

    /// Making a picture for `generation` failed: the preview stops, unless the host asked again
    /// meanwhile, and the host is told (R4).
    pub(crate) fn fail(&self, generation: u32, message: impl Into<String>) {
        let message = message.into();
        let stopped = self.update(|state| ((state >> 32) as u32 == generation).then(|| next_generation(state)));
        tracing::warn!(%message, stopped, "preview failed");
        (self.on_event)(PreviewEvent::Failed(message));
    }
}

/// `state`'s generation plus one, in the high bits, with no request.
fn next_generation(state: u64) -> u64 {
    u64::from(((state >> 32) as u32).wrapping_add(1)) << 32
}

/// When the pipeline offers the preview a frame (R2, R3): the first picture after a request from
/// the kept frame, then a new frame at most `fps` times a second.
#[derive(Debug, Default)]
pub(crate) struct PreviewRate {
    generation: u32,
    request: Option<PreviewRequest>,
    /// No picture offered since the request.
    first: bool,
    /// When the next offer is due, `None` for at once.
    next: Option<Instant>,
}

impl PreviewRate {
    /// Takes up what the preview asks for now. Every request, also one that changes a running
    /// preview, starts with a picture of the kept frame (R3), and the rate counts from there.
    pub(crate) fn follow(&mut self, generation: u32, request: Option<PreviewRequest>) {
        if generation == self.generation {
            return;
        }
        self.generation = generation;
        self.request = request;
        self.first = request.is_some();
        self.next = None;
    }

    pub(crate) fn active(&self) -> bool {
        self.request.is_some()
    }

    /// The first picture after a request is wanted from the kept frame (R3).
    pub(crate) fn wants_kept(&self) -> bool {
        self.request.is_some() && self.first
    }

    /// A new frame may be offered at `now`.
    pub(crate) fn due(&self, now: Instant) -> bool {
        self.request.is_some() && self.next.is_none_or(|next| now >= next)
    }

    /// A frame was offered at `now`. The next is due an interval after this one was due, so the
    /// pictures keep their rate on a source whose frames do not fall on it.
    pub(crate) fn offered(&mut self, now: Instant) {
        self.first = false;
        let Some(interval) = self.request.and_then(|r| r.interval()) else {
            return;
        };
        let after = self.next.map_or(now, |due| due.min(now)) + interval;
        self.next = Some(if after <= now { now + interval } else { after });
    }
}

/// Holds the one frame waiting for the worker. Offering never blocks: if the worker holds the
/// lock that moment, the frame is not previewed; a frame still waiting is replaced (R2).
pub(crate) struct PreviewSlot<F> {
    state: Mutex<SlotState<F>>,
    ready: Condvar,
}

struct SlotState<F> {
    frame: Option<F>,
    closed: bool,
    /// Frames replaced before the worker took them.
    replaced: u64,
}

impl<F> PreviewSlot<F> {
    pub(crate) fn new() -> Self {
        PreviewSlot { state: Mutex::new(SlotState { frame: None, closed: false, replaced: 0 }), ready: Condvar::new() }
    }

    /// Puts `frame` in the slot, in place of one that waits. False when it could not be put there
    /// without waiting, or the slot is closed.
    pub(crate) fn offer(&self, frame: F) -> bool {
        let replaced = {
            let Ok(mut state) = self.state.try_lock() else {
                return false;
            };
            if state.closed {
                return false;
            }
            let replaced = state.frame.replace(frame);
            state.replaced += u64::from(replaced.is_some());
            replaced
        };
        self.ready.notify_one();
        // Let go of a replaced frame outside the lock.
        drop(replaced);
        true
    }

    /// Waits for a frame. `None` once the slot is closed.
    pub(crate) fn take(&self) -> Option<F> {
        let mut state = self.state.lock().ok()?;
        loop {
            if state.closed {
                return None;
            }
            if let Some(frame) = state.frame.take() {
                return Some(frame);
            }
            state = self.ready.wait(state).ok()?;
        }
    }

    pub(crate) fn close(&self) {
        let frame = match self.state.lock() {
            Ok(mut state) => {
                state.closed = true;
                state.frame.take()
            }
            Err(_) => None,
        };
        self.ready.notify_all();
        drop(frame);
    }

    #[cfg(test)]
    fn replaced(&self) -> u64 {
        self.state.lock().map(|s| s.replaced).unwrap_or(0)
    }
}

/// Makes a picture from a converted frame: the part that is per system.
pub(crate) trait PreviewMaker {
    type Frame;
    /// A picture of `frame` fitted into `max` (width, height). `None` when this frame is skipped,
    /// which is not a failure: the next frame offered is tried (on Windows, a GPU too busy to
    /// hand the frame back in time, M6 preview step 3, W3). The maker times its stages into
    /// `times`, which does nothing unless the timing is on.
    fn make(&mut self, frame: &Self::Frame, max: (u32, u32), times: &mut StageTimes) -> Result<Option<PreviewPicture>, Error>;
}

// The preview's timing (.plans/native-media-engine-preview-cost.md, A1): a measurement aid, off
// unless PYLON_PREVIEW_TIMING=1 is in the sidecar's environment. When on, the worker logs one line
// a second with each stage's mean and maximum time per picture, the count and the JPEG's size.
// Nothing is sent to the host.

/// The stages of making a picture that are timed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Stage {
    /// The frame made readable by the CPU. Windows: the copy to the staging texture and the wait
    /// for its map. Linux: the GPU's scale and the read back.
    Readable,
    /// The area average on the CPU (Windows only).
    Shrink,
    /// The colour conversion on the CPU (Windows). On Linux the GPU's scale converts the colour,
    /// and what is timed here is the split of the read back NV12 into the JPEG's planes.
    Colour,
    /// libavcodec's JPEG encode.
    Jpeg,
}

const STAGES: [(Stage, &str); 4] = [(Stage::Readable, "readable"), (Stage::Shrink, "shrink"), (Stage::Colour, "colour"), (Stage::Jpeg, "jpeg")];

/// One picture's stage times, filled in by the maker. Takes no time when the timing is off.
#[derive(Debug, Default)]
pub(crate) struct StageTimes {
    on: bool,
    times: [Option<Duration>; 4],
}

impl StageTimes {
    pub(crate) fn new(on: bool) -> StageTimes {
        StageTimes { on, times: [None; 4] }
    }

    /// The start of a stage, `None` when the timing is off.
    pub(crate) fn start(&self) -> Option<Instant> {
        self.on.then(Instant::now)
    }

    /// `stage` ran from `started` until now (added up if it runs more than once).
    pub(crate) fn done(&mut self, stage: Stage, started: Option<Instant>) {
        if let Some(started) = started {
            let time = &mut self.times[stage as usize];
            *time = Some(time.unwrap_or_default() + started.elapsed());
        }
    }
}

/// PYLON_PREVIEW_TIMING=1 turns the timing on; anything else leaves it off.
fn timing_from(value: Option<&str>) -> bool {
    value.map(str::trim) == Some("1")
}

/// Whether the timing is on, read from the environment once.
fn timing_on() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| {
        let on = timing_from(std::env::var("PYLON_PREVIEW_TIMING").ok().as_deref());
        if on {
            tracing::info!("preview timing on (PYLON_PREVIEW_TIMING=1)");
        }
        on
    })
}

/// A mean and a maximum.
#[derive(Clone, Copy, Debug, Default)]
struct MeanMax {
    sum: f64,
    max: f64,
    count: u32,
}

impl MeanMax {
    fn add(&mut self, value: f64) {
        self.sum += value;
        self.max = self.max.max(value);
        self.count += 1;
    }

    /// "mean/max" with `decimals`, or "-" when nothing was added.
    fn show(&self, decimals: usize) -> String {
        if self.count == 0 {
            return "-".into();
        }
        format!("{:.decimals$}/{:.decimals$}", self.sum / f64::from(self.count), self.max)
    }
}

/// The worker's timings since its last log line.
#[derive(Debug)]
struct TimingLog {
    since: Instant,
    pictures: u32,
    skipped: u32,
    total: MeanMax,
    stages: [MeanMax; 4],
    bytes: MeanMax,
    size: Option<(u32, u32)>,
}

impl TimingLog {
    fn new(now: Instant) -> TimingLog {
        TimingLog { since: now, pictures: 0, skipped: 0, total: MeanMax::default(), stages: [MeanMax::default(); 4], bytes: MeanMax::default(), size: None }
    }

    /// One call of the maker: its whole time, its stages, and the picture it made (`None` when
    /// it skipped the frame or failed).
    fn add(&mut self, total: Duration, times: &StageTimes, picture: Option<&PreviewPicture>) {
        let ms = |d: Duration| d.as_secs_f64() * 1000.0;
        match picture {
            Some(picture) => {
                self.pictures += 1;
                self.bytes.add(picture.jpeg.len() as f64);
                self.size = Some((picture.width, picture.height));
            }
            None => self.skipped += 1,
        }
        self.total.add(ms(total));
        for (stage, time) in self.stages.iter_mut().zip(&times.times) {
            if let Some(time) = time {
                stage.add(ms(*time));
            }
        }
    }

    /// The log line once a second has passed since the last one and anything was timed, after
    /// which the counts start again.
    fn line(&mut self, now: Instant) -> Option<String> {
        if now.duration_since(self.since) < Duration::from_secs(1) || self.total.count == 0 {
            return None;
        }
        let size = self.size.map_or_else(|| "-".into(), |(w, h)| format!("{w}x{h}"));
        let mut line = format!("preview timing: pictures {} skipped {} size {size} ms mean/max: total {}", self.pictures, self.skipped, self.total.show(2));
        for ((_, name), stage) in STAGES.iter().zip(&self.stages) {
            line.push_str(&format!(" {name} {}", stage.show(2)));
        }
        line.push_str(&format!(" bytes {}", self.bytes.show(0)));
        *self = TimingLog::new(now);
        Some(line)
    }
}

/// The worker thread and the slot it takes frames from. Dropping it stops the thread and waits
/// for it.
pub(crate) struct PreviewWorker<F> {
    slot: Arc<PreviewSlot<F>>,
    thread: Option<JoinHandle<()>>,
}

impl<F: Send + 'static> PreviewWorker<F> {
    /// Starts the worker for `preview`. Its maker is made on the worker's thread with `make`,
    /// on the first frame and again after a failure.
    pub(crate) fn start<M>(preview: Arc<Preview>, make: impl Fn() -> Result<M, Error> + Send + 'static) -> Result<Self, Error>
    where
        M: PreviewMaker<Frame = F>,
    {
        let slot = Arc::new(PreviewSlot::new());
        let worker_slot = slot.clone();
        let thread = std::thread::Builder::new()
            .name("pylon-media preview".into())
            .spawn(move || work(&worker_slot, &preview, make))
            .map_err(|e| Error::io("preview thread", e))?;
        tracing::info!("preview worker started");
        Ok(PreviewWorker { slot, thread: Some(thread) })
    }

    /// Offers `frame`, never waiting (R2).
    pub(crate) fn offer(&self, frame: F) -> bool {
        self.slot.offer(frame)
    }
}

impl<F> Drop for PreviewWorker<F> {
    fn drop(&mut self) {
        self.slot.close();
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// The worker's loop: a frame from the slot, a picture of it for what is asked now.
fn work<F, M: PreviewMaker<Frame = F>>(slot: &PreviewSlot<F>, preview: &Preview, make: impl Fn() -> Result<M, Error>) {
    let mut maker: Option<M> = None;
    let timing = timing_on();
    let mut timing_log = TimingLog::new(Instant::now());
    while let Some(frame) = slot.take() {
        // Stopped or changed while the frame waited: what is asked now counts.
        let (generation, Some(request)) = preview.current() else {
            continue;
        };
        let mut times = StageTimes::new(timing);
        let began = times.start();
        let made = match &mut maker {
            Some(maker) => Ok(maker),
            None => make().map(|made| maker.insert(made)),
        }
        .and_then(|maker| maker.make(&frame, (request.max_width, request.max_height), &mut times));
        drop(frame);
        if let Some(began) = began {
            let now = Instant::now();
            timing_log.add(now - began, &times, made.as_ref().ok().and_then(Option::as_ref));
            if let Some(line) = timing_log.line(now) {
                tracing::info!("{line}");
            }
        }
        match made {
            Ok(Some(picture)) => preview.picture(picture),
            Ok(None) => {}
            Err(error) => {
                // Made afresh for the next request.
                maker = None;
                preview.fail(generation, format!("preview: {error}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn request(fps: u32, max_width: u32, max_height: u32) -> PreviewRequest {
        PreviewRequest { fps, max_width, max_height }
    }

    #[test]
    fn requests_are_checked_against_the_limits() {
        for good in [request(0, 16, 16), request(5, 480, 270), request(10, 1280, 720), request(1, 16, 720)] {
            assert_eq!(good.check(), Ok(()), "{good:?}");
        }
        for bad in [request(11, 480, 270), request(5, 15, 270), request(5, 1281, 270), request(5, 480, 15), request(5, 480, 721), request(0, 0, 0)] {
            assert!(matches!(bad.check(), Err(Error::InvalidParameters(_))), "{bad:?}");
        }
    }

    #[test]
    fn a_request_is_followed_and_fps_0_stops() {
        let preview = Preview::new(|_| {});
        assert_eq!(preview.current(), (0, None));
        preview.request(request(5, 480, 270)).unwrap();
        assert_eq!(preview.current(), (1, Some(request(5, 480, 270))));
        preview.request(request(10, 1280, 720)).unwrap();
        assert_eq!(preview.current(), (2, Some(request(10, 1280, 720))));
        // A bad request changes nothing.
        assert!(preview.request(request(11, 480, 270)).is_err());
        assert_eq!(preview.current(), (2, Some(request(10, 1280, 720))));
        preview.request(request(0, 480, 270)).unwrap();
        assert_eq!(preview.current(), (3, None));
    }

    #[test]
    fn a_failure_stops_the_preview_unless_asked_again() {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let preview = Preview::new(move |event| {
            let _ = tx.lock().unwrap().send(event);
        });
        preview.request(request(5, 480, 270)).unwrap();
        preview.fail(1, "scale failed");
        assert_eq!(preview.current(), (2, None));
        assert!(matches!(rx.try_recv(), Ok(PreviewEvent::Failed(message)) if message == "scale failed"));
        // A failure of an older request leaves a newer one running, and is still reported.
        preview.request(request(2, 320, 180)).unwrap();
        preview.fail(2, "late");
        assert_eq!(preview.current(), (3, Some(request(2, 320, 180))));
        assert!(matches!(rx.try_recv(), Ok(PreviewEvent::Failed(_))));
    }

    #[test]
    fn sizes_fit_keep_their_shape_and_never_grow() {
        assert_eq!(fit(1920, 1080, 480, 270), (480, 270));
        assert_eq!(fit(1920, 1080, 1280, 720), (1280, 720));
        // Fitted by the tighter side.
        assert_eq!(fit(1920, 1080, 480, 480), (480, 270));
        assert_eq!(fit(1920, 1080, 1280, 270), (480, 270));
        assert_eq!(fit(1080, 1920, 480, 270), (152, 270));
        assert_eq!(fit(3440, 1440, 480, 270), (480, 200));
        // Even sides.
        assert_eq!(fit(1920, 1080, 333, 333), (332, 186));
        // A frame smaller than asked keeps its size.
        assert_eq!(fit(320, 180, 480, 270), (320, 180));
        assert_eq!(fit(1920, 1082, 480, 270), (478, 270));
    }

    #[test]
    fn the_first_picture_after_a_request_comes_from_the_kept_frame() {
        let t = Instant::now();
        let mut rate = PreviewRate::default();
        rate.follow(0, None);
        assert!(!rate.active() && !rate.wants_kept() && !rate.due(t));
        rate.follow(1, Some(request(5, 480, 270)));
        assert!(rate.wants_kept() && rate.due(t));
        rate.offered(t);
        assert!(!rate.wants_kept());
        assert!(!rate.due(t + Duration::from_millis(199)));
        assert!(rate.due(t + Duration::from_millis(200)));
        // Stopped, then asked again: the kept frame again.
        rate.follow(2, None);
        assert!(!rate.active() && !rate.due(t + Duration::from_secs(1)));
        rate.follow(3, Some(request(5, 480, 270)));
        assert!(rate.wants_kept() && rate.due(t + Duration::from_secs(1)));
        // The same generation again changes nothing.
        rate.offered(t + Duration::from_secs(1));
        rate.follow(3, Some(request(5, 480, 270)));
        assert!(!rate.wants_kept());
    }

    #[test]
    fn offers_keep_the_rate_on_frames_that_do_not_fall_on_it() {
        // Frames at 60 a second, pictures asked at 5: 50 in 10 s, one every 200 ms.
        let t = Instant::now();
        let mut rate = PreviewRate::default();
        rate.follow(1, Some(request(5, 480, 270)));
        let mut offers = Vec::new();
        for n in 0..600u64 {
            let now = t + Duration::from_nanos(n * 1_000_000_000 / 60);
            if rate.due(now) {
                rate.offered(now);
                offers.push(now);
            }
        }
        assert_eq!(offers.len(), 50);
        for pair in offers.windows(2) {
            let gap = pair[1] - pair[0];
            assert!(gap >= Duration::from_millis(183) && gap <= Duration::from_millis(217), "{gap:?}");
        }
        // Frames at 4 a second, pictures asked at 5: every frame, never two at once.
        let mut rate = PreviewRate::default();
        rate.follow(1, Some(request(5, 480, 270)));
        let mut count = 0;
        for n in 0..40u64 {
            let now = t + Duration::from_millis(n * 250);
            if rate.due(now) {
                rate.offered(now);
                count += 1;
            }
            assert!(!rate.due(now));
        }
        assert_eq!(count, 40);
    }

    #[test]
    fn a_new_rate_while_running_is_taken_up() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut rate = PreviewRate::default();
        rate.follow(1, Some(request(5, 480, 270)));
        rate.offered(ms(0));
        assert!(rate.due(ms(200)));
        // To 2 a second at 100 ms: a picture of the kept frame, then one every 500 ms from it.
        rate.follow(2, Some(request(2, 480, 270)));
        assert!(rate.wants_kept() && rate.due(ms(100)));
        rate.offered(ms(100));
        assert!(!rate.due(ms(599)));
        assert!(rate.due(ms(600)));
        // Another size: the same.
        rate.follow(3, Some(request(2, 320, 180)));
        assert!(rate.wants_kept());
    }

    #[test]
    fn the_slot_holds_the_newest_and_never_blocks() {
        let slot = PreviewSlot::new();
        assert!(slot.offer(1));
        assert!(slot.offer(2));
        assert!(slot.offer(3));
        assert_eq!(slot.replaced(), 2);
        assert_eq!(slot.take(), Some(3));
        // Held by someone else: the offer gives up at once.
        {
            let _held = slot.state.lock().unwrap();
            let began = Instant::now();
            assert!(!slot.offer(4));
            assert!(began.elapsed() < Duration::from_millis(50));
        }
        assert!(slot.offer(5));
        slot.close();
        assert_eq!(slot.take(), None);
        assert!(!slot.offer(6));
    }

    /// The frame the test maker skips.
    const SKIPPED: u32 = 9;

    /// A maker that records the sizes asked for, failing when told and skipping `SKIPPED`.
    struct Sizes {
        made: mpsc::Sender<(u32, (u32, u32))>,
        fail_on: u32,
    }
    impl PreviewMaker for Sizes {
        type Frame = u32;
        fn make(&mut self, frame: &u32, max: (u32, u32), _times: &mut StageTimes) -> Result<Option<PreviewPicture>, Error> {
            if *frame == self.fail_on {
                return Err(Error::Media("no surface".into()));
            }
            if *frame == SKIPPED {
                return Ok(None);
            }
            let _ = self.made.send((*frame, max));
            let (width, height) = fit(1920, 1080, max.0, max.1);
            Ok(Some(PreviewPicture { width, height, jpeg: vec![0xff, 0xd8] }))
        }
    }

    #[test]
    fn the_worker_makes_pictures_for_what_is_asked_and_stops_on_a_failure() {
        let (events_tx, events) = mpsc::channel();
        let events_tx = Mutex::new(events_tx);
        let preview = Preview::new(move |event| {
            let _ = events_tx.lock().unwrap().send(event);
        });
        let (made_tx, made) = mpsc::channel();
        let made_tx = Mutex::new(made_tx);
        let worker = PreviewWorker::start(preview.clone(), move || Ok(Sizes { made: made_tx.lock().unwrap().clone(), fail_on: 7 })).unwrap();
        let wait = || events.recv_timeout(Duration::from_secs(2)).unwrap();

        preview.request(request(5, 480, 270)).unwrap();
        assert!(worker.offer(1));
        assert!(matches!(wait(), PreviewEvent::Picture(PreviewPicture { width: 480, height: 270, .. })));
        assert_eq!(made.recv().unwrap(), (1, (480, 270)));
        // A new size is used for the next frame.
        preview.request(request(5, 320, 320)).unwrap();
        assert!(worker.offer(2));
        assert!(matches!(wait(), PreviewEvent::Picture(PreviewPicture { width: 320, height: 180, .. })));
        // A skipped frame makes no picture and no failure, the preview goes on.
        assert!(worker.offer(SKIPPED));
        assert!(events.recv_timeout(Duration::from_millis(100)).is_err());
        assert_eq!(preview.current().1, Some(request(5, 320, 320)));
        // A failure stops it and says so.
        assert!(worker.offer(7));
        assert!(matches!(wait(), PreviewEvent::Failed(message) if message == "preview: no surface"));
        assert_eq!(preview.current().1, None);
        // Stopped: a frame offered is not made.
        assert!(worker.offer(3));
        assert!(events.recv_timeout(Duration::from_millis(100)).is_err());
        // Asked again: made again, by a new maker.
        preview.request(request(2, 480, 270)).unwrap();
        assert!(worker.offer(4));
        assert!(matches!(wait(), PreviewEvent::Picture(_)));
        assert_eq!(made.try_iter().last(), Some((4, (480, 270))));
        // Dropping the worker ends its thread.
        drop(worker);
        assert_eq!(Arc::strong_count(&preview), 1);
    }

    #[test]
    fn the_timing_is_on_only_for_1() {
        assert!(timing_from(Some("1")));
        assert!(timing_from(Some(" 1\n")));
        for off in [None, Some(""), Some("0"), Some("yes"), Some("true"), Some("2")] {
            assert!(!timing_from(off), "{off:?}");
        }
    }

    #[test]
    fn stage_times_take_nothing_when_off_and_add_up_when_on() {
        let mut off = StageTimes::new(false);
        let started = off.start();
        assert!(started.is_none());
        off.done(Stage::Jpeg, started);
        assert_eq!(off.times, [None; 4]);

        let mut on = StageTimes::new(true);
        let started = on.start();
        std::thread::sleep(Duration::from_millis(2));
        on.done(Stage::Shrink, started);
        let first = on.times[Stage::Shrink as usize].unwrap();
        assert!(first >= Duration::from_millis(2));
        // A stage that runs twice is added up.
        on.done(Stage::Shrink, Some(Instant::now() - Duration::from_millis(5)));
        assert!(on.times[Stage::Shrink as usize].unwrap() >= first + Duration::from_millis(5));
        assert_eq!(on.times[Stage::Readable as usize], None);
    }

    #[test]
    fn the_timing_line_comes_once_a_second_with_means_and_maxima() {
        let t = Instant::now();
        let mut log = TimingLog::new(t);
        let ms = Duration::from_millis;
        let mut times = StageTimes::new(true);
        times.times = [Some(ms(2)), None, Some(ms(4)), Some(ms(6))];
        log.add(ms(14), &times, Some(&PreviewPicture { width: 1280, height: 720, jpeg: vec![0; 1000] }));
        times.times = [Some(ms(4)), None, Some(ms(2)), Some(ms(10))];
        log.add(ms(18), &times, Some(&PreviewPicture { width: 1280, height: 720, jpeg: vec![0; 3000] }));
        // A skipped frame counts in the total and the skips, not in the pictures or bytes.
        times.times = [Some(ms(200)), None, None, None];
        log.add(ms(201), &times, None);
        assert_eq!(log.line(t + ms(999)), None);
        assert_eq!(
            log.line(t + ms(1000)).as_deref(),
            Some(
                "preview timing: pictures 2 skipped 1 size 1280x720 ms mean/max: total 77.67/201.00 readable 68.67/200.00 shrink - colour 3.00/4.00 jpeg 8.00/10.00 bytes 2000/3000"
            )
        );
        // Counted afresh, and nothing to say until something is timed.
        assert_eq!(log.line(t + ms(2500)), None);
        log.add(ms(1), &StageTimes::new(true), None);
        assert_eq!(log.line(t + ms(1999)), None);
        assert!(log.line(t + ms(2000)).unwrap().starts_with("preview timing: pictures 0 skipped 1 size - ms mean/max: total 1.00/1.00 readable -"));
    }

    #[test]
    fn pictures_print_without_their_bytes() {
        let picture = PreviewPicture { width: 2, height: 2, jpeg: vec![0xab; 3] };
        assert_eq!(format!("{picture:?}"), "PreviewPicture { width: 2, height: 2, bytes: 3 }");
    }
}
