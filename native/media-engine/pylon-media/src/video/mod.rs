// The video pipeline: a producer hands
// raw frames over (DMA-BUFs on Linux, D3D11 textures on Windows), the encoder turns them into
// H264, and the loops in between follow the target bitrate, key frame requests and the depth of
// the send queue.
//
// The portable parts are here and compile on any system with no features.
// What is Linux's is in `linux/`, what is Windows'
// in `windows/`.

// Used by the Linux and Windows encoders, pattern producers and captures, elsewhere
// only by their tests.
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "capture")), allow(dead_code))]
mod bucket;
// On Windows some of them (filter graphs, devices opened by name, frames contexts) have no user.
#[cfg(feature = "encode")]
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
mod ffi;
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod font;
// The preview's JPEG encoder, shared by the Linux and Windows makers.
#[cfg(all(any(target_os = "linux", target_os = "windows"), feature = "encode"))]
mod jpeg;
#[cfg(all(target_os = "linux", feature = "encode"))]
mod linux;
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod pattern;
// The worker and its slot are used by the Linux and Windows encoders, elsewhere by their tests.
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod preview;
// The Windows preview's CPU half: portable, tested everywhere,
// used by the Windows encoder only.
#[cfg_attr(not(all(target_os = "windows", feature = "encode")), allow(dead_code))]
mod preview_cpu;
// Used by the Linux and Windows encoders (on Windows with fixed limits).
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod sizing;
// The compositor's time for a frame: used by the Linux and Windows captures,
// elsewhere only by its tests.
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "capture")), allow(dead_code))]
mod timing;
#[cfg(all(target_os = "windows", feature = "encode"))]
mod windows;

use std::{
    collections::VecDeque,
    sync::Arc,
    time::{Duration, Instant},
};

use crate::{
    Error,
    source::{EncodedFrame, FrameSink, PushError, Source, SourceControl},
};

pub use pattern::PatternKind;
pub use preview::{Preview, PreviewEvent, PreviewPicture, PreviewRequest};
use preview::PreviewRate;

#[cfg(all(target_os = "linux", feature = "capture"))]
pub use linux::capture;
#[cfg(all(target_os = "linux", feature = "encode"))]
pub use linux::{DmaBufFrame, DmaBufObject, DmaBufPlane, PatternProducer, VaapiEncoder, av1_encode_available, pattern_source};

/// Whether this build on this machine encodes AV1: only Linux with `encode`.
#[cfg(not(all(target_os = "linux", feature = "encode")))]
pub fn av1_encode_available() -> bool {
    false
}
#[cfg(all(target_os = "windows", feature = "encode"))]
pub use self::windows::{D3d11Encoder, D3d11Frame, PatternProducer, pattern_source};
#[cfg(all(target_os = "windows", feature = "capture"))]
pub use self::windows::capture;

/// What the pipeline needs from a raw frame.
pub trait RawFrame: Send {
    /// When the frame was captured (or drawn).
    fn capture_time(&self) -> Instant;
}

/// What a producer has for the pipeline.
#[derive(Debug)]
pub enum Produced<F> {
    Frame(F),
    /// Nothing new by the time asked for.
    Idle,
    /// The source is stopped or its frames have ended.
    End,
}

/// Where raw frames come from: the test pattern or a screen capture.
pub trait FrameProducer: Send {
    /// The frames it hands over.
    type Frame: RawFrame;
    /// Waits for the next frame, at most until `until` (a producer on a fixed clock may wait
    /// for its next frame instead).
    fn next_frame(&mut self, control: &SourceControl, until: Instant) -> Result<Produced<Self::Frame>, Error>;
    /// The time between frames at the rate asked for.
    fn interval(&self) -> Duration;
    /// Whether the frames are captured, so their delay to the encoder is measured.
    fn captures(&self) -> bool {
        false
    }
    /// Whether the frame last handed over shows the same picture as the one before it (the still
    /// pattern), so the preview does not take it as new.
    fn repeats_last(&self) -> bool {
        false
    }
}

/// One encoded access unit.
#[derive(Debug)]
pub struct Packet {
    pub data: Vec<u8>,
    pub key: bool,
}

/// What the encoder makes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EncoderConfig {
    /// The largest picture sent. Larger frames are scaled down to fit, smaller ones are not
    /// scaled up.
    pub width: u32,
    pub height: u32,
    pub fps: u32,
    /// The bitrate the encoder is opened at, before the first frame sets its own.
    pub start_bitrate: u64,
    /// Pads constant-bitrate output with filler data. Off in the pipeline, on only to
    /// measure what it would cost.
    pub filler: bool,
}

/// What turns raw frames into H264.
pub trait FrameEncoder: Send {
    /// The frames it takes.
    type Frame;
    /// Encodes `frame` at `bitrate`, as a key frame when `key`, knowing that one frame in
    /// `divisor` of the producer's rate is encoded. One packet per frame.
    fn encode(&mut self, frame: &Self::Frame, bitrate: u64, divisor: u32, key: bool) -> Result<Packet, Error>;
    /// Encodes the last converted frame again, as a key frame when `key`. `None` when there
    /// is none.
    fn encode_kept(&mut self, _bitrate: u64, _divisor: u32, _key: bool) -> Result<Option<Packet>, Error> {
        Ok(None)
    }
    /// When a new size the encoder was asked for will be taken up if nothing newer comes,
    /// `None` when there is none.
    fn resize_due(&self) -> Option<Instant> {
        None
    }
    /// Offers `preview` the last converted frame (a reference to it, never waiting), starting
    /// the preview's worker on first use. False when there is none, or when this encoder makes no
    /// preview.
    fn offer_preview(&mut self, _preview: &Arc<Preview>) -> bool {
        false
    }
    /// Caps the encoded picture at `cap` (`None`: the share's own maximum), fitted keeping its
    /// shape and taken up as a new size is. A no-op for an encoder without the size ladder.
    fn set_size_cap(&mut self, _cap: Option<(u32, u32)>) {}
    /// The size the newest frame is, or would be, encoded at under `cap`. `None` before a frame
    /// came, and always for an encoder without the size ladder.
    fn size_under(&self, _cap: Option<(u32, u32)>) -> Option<(u32, u32)> {
        None
    }
    /// The codec's bits per pixel a size needs, `None` for an encoder without the
    /// size ladder.
    fn size_floor(&self) -> Option<f64> {
        None
    }
    /// The size the open encoder runs at, `None` when it is not open or does not say.
    fn running_size(&self) -> Option<(u32, u32)> {
        None
    }
}

/// Above this much of the target bitrate waiting in the send queue, frames are skipped.
const BACKLOG_LIMIT: Duration = Duration::from_millis(200);
/// Key frames are at least this far apart.
const KEY_FRAME_SPACING: Duration = Duration::from_millis(500);
/// The output is measured over this long.
const OUTPUT_WINDOW: Duration = Duration::from_secs(1);
/// The lowest share of the target the encoder is asked for.
const LOWEST_SHARE: f64 = 0.7;

/// True when more than `BACKLOG_LIMIT` of `target` bits per second are queued.
fn backlogged(queued_bytes: u64, target: u64) -> bool {
    if target == 0 {
        return queued_bytes > 0;
    }
    (queued_bytes as u128) * 8 * 1000 > (target as u128) * BACKLOG_LIMIT.as_millis()
}

/// When to make a key frame: the first frame, and the next frame after a request, but not
/// more often than `KEY_FRAME_SPACING`. A request inside that time waits for its end.
#[derive(Debug, Default)]
struct KeyFrames {
    last: Option<Instant>,
    pending: bool,
}

impl KeyFrames {
    fn request(&mut self) {
        self.pending = true;
    }

    fn pending(&self) -> bool {
        self.pending
    }

    /// The earliest time the next key frame may be made.
    fn next_allowed(&self) -> Option<Instant> {
        self.last.map(|last| last + KEY_FRAME_SPACING)
    }

    /// Whether the frame encoded at `now` is a key frame, and whether it was asked for.
    fn decide(&mut self, now: Instant) -> (bool, bool) {
        let Some(last) = self.last else {
            self.last = Some(now);
            self.pending = false;
            return (true, false);
        };
        if self.pending && now.saturating_duration_since(last) >= KEY_FRAME_SPACING {
            self.last = Some(now);
            self.pending = false;
            return (true, true);
        }
        (false, false)
    }

    /// The encoder made a key frame at `at`, asked for or not (an encoder opened again makes
    /// one): the spacing starts from it and a pending request is met by it.
    fn made(&mut self, at: Instant) {
        self.last = Some(at);
        self.pending = false;
    }
}

/// The encoder's output over the last second, and what it was asked for meanwhile.
#[derive(Debug, Default)]
struct OutputMeter {
    /// (encoded at, bytes, bitrate asked for)
    frames: VecDeque<(Instant, u64, u64)>,
    since: Option<Instant>,
}

impl OutputMeter {
    fn record(&mut self, at: Instant, bytes: u64, asked: u64) {
        self.since.get_or_insert(at);
        self.frames.push_back((at, bytes, asked));
        while let Some(&(first, _, _)) = self.frames.front() {
            if at.saturating_duration_since(first) < OUTPUT_WINDOW {
                break;
            }
            self.frames.pop_front();
        }
    }

    /// Bits per second over the last second, once a second has been seen.
    fn output_bps(&self, now: Instant) -> Option<u64> {
        let since = self.since?;
        if now.saturating_duration_since(since) < OUTPUT_WINDOW {
            return None;
        }
        let bytes: u64 = self
            .frames
            .iter()
            .filter(|(at, _, _)| now.saturating_duration_since(*at) < OUTPUT_WINDOW)
            .map(|(_, bytes, _)| bytes)
            .sum();
        Some(bytes * 8 * 1000 / OUTPUT_WINDOW.as_millis() as u64)
    }

    fn asked_bps(&self) -> Option<u64> {
        if self.frames.is_empty() {
            return None;
        }
        Some(self.frames.iter().map(|(_, _, asked)| asked).sum::<u64>() / self.frames.len() as u64)
    }

    /// What to ask the encoder for so that its output meets `target`: scaled down by how much
    /// it produced over what it was asked for, never above `target` nor below 0.7 of it.
    fn bitrate_for(&self, now: Instant, target: u64) -> u64 {
        let lowest = (target as f64 * LOWEST_SHARE).round() as u64;
        match (self.output_bps(now), self.asked_bps()) {
            (Some(output), Some(asked)) if output > 0 => {
                let scaled = target as f64 * asked as f64 / output as f64;
                (scaled.round() as u64).clamp(lowest, target)
            }
            _ => target,
        }
    }
}

/// The frame rate divisors the pipeline steps through: one frame in N is encoded.
const DIVISORS: [u32; 6] = [1, 2, 3, 4, 6, 10];
/// N steps up after the output has been this far over the target for `STEP_UP_AFTER`, with the
/// scale at its floor.
const OVER_SHARE: f64 = 1.15;
const STEP_UP_AFTER: Duration = Duration::from_secs(1);
/// N steps down after the output has met the target for `STEP_DOWN_AFTER` with the scale above
/// `ROOM_SHARE`.
const ROOM_SHARE: f64 = 0.85;
const STEP_DOWN_AFTER: Duration = Duration::from_secs(3);

/// Gives way on frame rate, evenly, when the encoder cannot get down to the target.
#[derive(Debug, Default)]
struct Cadence {
    index: usize,
    over_since: Option<Instant>,
    met_since: Option<Instant>,
    /// Frames from the producer, counted to keep one in N.
    seen: u64,
}

impl Cadence {
    fn divisor(&self) -> u32 {
        DIVISORS[self.index]
    }

    /// Whether the next frame from the producer is one to encode.
    fn keep(&mut self) -> bool {
        let keep = self.seen % self.divisor() as u64 == 0;
        self.seen += 1;
        keep
    }

    /// Steps N after an encoded frame, from the output over the last second and the scale the
    /// encoder runs at (configured bitrate over target). The rule: `update_with` free to
    /// slow, which the pipeline calls.
    #[cfg(test)]
    fn update(&mut self, now: Instant, output: Option<u64>, target: u64, scale: f64) {
        self.update_with(now, output, target, scale, true);
    }

    /// As `update`, with N stepping up only when `may_slow` (with the size ladder,
    /// only on its lowest rung). Without it the time over the target is not counted.
    fn update_with(&mut self, now: Instant, output: Option<u64>, target: u64, scale: f64, may_slow: bool) {
        let Some(output) = output else {
            return;
        };
        let target = target as f64;
        let floor = scale <= LOWEST_SHARE + 1e-6;
        if (output as f64) > target * OVER_SHARE && floor {
            self.met_since = None;
            if !may_slow {
                self.over_since = None;
                return;
            }
            let since = *self.over_since.get_or_insert(now);
            if now.saturating_duration_since(since) >= STEP_UP_AFTER && self.index + 1 < DIVISORS.len() {
                self.step(1);
            }
        } else if (output as f64) <= target && scale > ROOM_SHARE {
            self.over_since = None;
            let since = *self.met_since.get_or_insert(now);
            if now.saturating_duration_since(since) >= STEP_DOWN_AFTER && self.index > 0 {
                self.step(-1);
            }
        } else {
            self.over_since = None;
            self.met_since = None;
        }
    }

    fn step(&mut self, by: isize) {
        let from = self.divisor();
        self.index = (self.index as isize + by) as usize;
        self.over_since = None;
        self.met_since = None;
        // Start the new cadence on the next frame.
        self.seen = 0;
        tracing::info!(from, to = self.divisor(), "frame rate divisor");
    }

    /// Its timers start afresh, N stays.
    fn restart(&mut self) {
        self.over_since = None;
        self.met_since = None;
    }
}

/// The caps on the encoded picture a share steps through on a tight link, from none (the
/// share's own maximum) down.
const RUNGS: [Option<(u32, u32)>; 3] = [None, Some((1280, 720)), Some((960, 540))];
/// The bits per pixel a size needs at the producer's rate, H264 and AV1. Chosen, not
/// measured for quality.
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
pub(crate) const FLOOR_H264: f64 = 0.030;
#[cfg_attr(not(all(target_os = "linux", feature = "encode")), allow(dead_code))]
pub(crate) const FLOOR_AV1: f64 = 0.020;
/// One rung down after the target has been under what the size needs for this long.
const UNDER_FOR: Duration = Duration::from_secs(2);
/// One rung up after the target has been at or over `ROOM_OVER` times what the size of the rung
/// above needs for `ROOM_FOR`.
const ROOM_OVER: f64 = 1.25;
const ROOM_FOR: Duration = Duration::from_secs(5);
/// At most one size change this often, up or down.
const SIZE_SPACING: Duration = Duration::from_secs(5);

/// The bits per second `size` needs at `fps` with `floor` bits per pixel.
fn needed(size: (u32, u32), fps: f64, floor: f64) -> f64 {
    f64::from(size.0) * f64::from(size.1) * fps * floor
}

fn area(size: (u32, u32)) -> u64 {
    u64::from(size.0) * u64::from(size.1)
}

/// Gives way on the picture's size before the frame rate, for a share that asked for it.
/// Pure: the pipeline hands it the sizes the content is encoded at under
/// each rung and the loops' figures.
#[derive(Debug, Default)]
struct SizeLadder {
    /// The share asked for the size to give way first.
    on: bool,
    /// The index into `RUNGS` in force.
    rung: usize,
    /// Since when the target has been under what the current size needs.
    under_since: Option<Instant>,
    /// Since when the output has been over the target with the scale at its floor.
    over_since: Option<Instant>,
    /// Since when there has been room for the size of the rung above.
    room_since: Option<Instant>,
    /// When the last change was decided.
    changed: Option<Instant>,
    steps_down: u64,
    steps_up: u64,
    /// The share's maximum bitrate, set by the pipeline before each turn, `None` when not known.
    max: Option<u64>,
}

impl SizeLadder {
    /// The rung to step down to: the first below the one in force that makes the picture
    /// smaller (a rung that would not is skipped).
    fn below(&self, sizes: &[(u32, u32); 3]) -> Option<usize> {
        (self.rung + 1..RUNGS.len()).find(|&i| area(sizes[i]) < area(sizes[self.rung]))
    }

    /// The rung to step up to: the nearest above the one in force that makes the picture larger.
    fn above(&self, sizes: &[(u32, u32); 3]) -> Option<usize> {
        (0..self.rung).rev().find(|&i| area(sizes[i]) > area(sizes[self.rung]))
    }

    /// Whether the rung in force is the lowest there is for this content.
    fn lowest(&self, sizes: &[(u32, u32); 3]) -> bool {
        self.below(sizes).is_none()
    }

    /// What the target must reach for a step up to `size`: `ROOM_OVER` times what it needs,
    /// at most the share's maximum. `None` when it needs more than the maximum: never stepped up
    /// to.
    fn room(&self, size: (u32, u32), fps: f64, floor: f64) -> Option<f64> {
        let need = needed(size, fps, floor);
        match self.max {
            Some(max) if need > max as f64 => None,
            Some(max) => Some((ROOM_OVER * need).min(max as f64)),
            None => Some(ROOM_OVER * need),
        }
    }

    /// The rate the transport is to sustain with padding toward the step up:
    /// what the room check asks of the size of the rung above, 0 with no rung above or none that may be stepped up to.
    fn sustain(&self, sizes: &[(u32, u32); 3], fps: f64, floor: f64) -> u64 {
        self.above(sizes).and_then(|up| self.room(sizes[up], fps, floor)).map_or(0, |room| room.round() as u64)
    }

    /// Its timers start afresh, the rung stays.
    fn restart(&mut self) {
        self.under_since = None;
        self.over_since = None;
        self.room_since = None;
    }

    /// After an encoded frame: the rung to change to, if one is due. `sizes` are the sizes the
    /// newest frame is encoded at under each of `RUNGS`, `fps` the producer's rate, `floor` the
    /// codec's bits per pixel, then the target, the output over the last second, the scale the
    /// encoder runs at and the frame rate divisor.
    #[allow(clippy::too_many_arguments)]
    fn update(
        &mut self,
        now: Instant,
        sizes: &[(u32, u32); 3],
        fps: f64,
        floor: f64,
        target: u64,
        output: Option<u64>,
        scale: f64,
        divisor: u32,
    ) -> Option<usize> {
        let target_f = target as f64;
        let held = |since: Option<Instant>, d: Duration| since.is_some_and(|s| now.saturating_duration_since(s) >= d);
        let below = self.below(sizes);
        let above = self.above(sizes);

        // The target under what the size in force needs.
        if below.is_some() && target_f < needed(sizes[self.rung], fps, floor) {
            self.under_since.get_or_insert(now);
        } else {
            self.under_since = None;
        }
        // What makes the cadence step: the output over the target at the scale's floor.
        if let Some(output) = output {
            if below.is_some() && (output as f64) > target_f * OVER_SHARE && scale <= LOWEST_SHARE + 1e-6 {
                self.over_since.get_or_insert(now);
            } else {
                self.over_since = None;
            }
        }
        // Room for the size above, at the full frame rate, under the share's maximum.
        match above.and_then(|up| self.room(sizes[up], fps, floor)) {
            Some(room) if divisor == 1 && target_f >= room => {
                self.room_since.get_or_insert(now);
            }
            _ => self.room_since = None,
        }

        // A change the spacing holds back waits for its end, if its condition still holds.
        if self.changed.is_some_and(|at| now.saturating_duration_since(at) < SIZE_SPACING) {
            return None;
        }
        let to = match (below, above) {
            (Some(down), _) if held(self.under_since, UNDER_FOR) || held(self.over_since, STEP_UP_AFTER) => {
                self.steps_down += 1;
                down
            }
            (_, Some(up)) if held(self.room_since, ROOM_FOR) => {
                self.steps_up += 1;
                up
            }
            _ => return None,
        };
        tracing::info!(from = ?sizes[self.rung], to = ?sizes[to], cap = ?RUNGS[to], target, "picture size step");
        self.rung = to;
        self.changed = Some(now);
        self.restart();
        Some(to)
    }
}

/// An interval between frames sent over this many times the producer's interval times the
/// divisor in force is a long gap.
const LONG_GAP: f64 = 1.5;

/// The time between frames sent, by their capture times.
#[derive(Debug, Default)]
struct FrameIntervals {
    last: Option<Instant>,
}

impl FrameIntervals {
    /// A frame sent with `capture_time`: the time since the frame sent before it in
    /// milliseconds, and whether that is longer than `LONG_GAP` times `interval` times
    /// `divisor`. `None` for the first frame.
    fn sent(&mut self, capture_time: Instant, interval: Duration, divisor: u32) -> Option<(f64, bool)> {
        let last = self.last.replace(capture_time)?;
        let gap = capture_time.saturating_duration_since(last).as_secs_f64();
        let long = gap > interval.as_secs_f64() * f64::from(divisor) * LONG_GAP;
        Some((gap * 1000.0, long))
    }
}

/// A key frame is made from the kept frame when no new frame came for this many intervals.
const KEPT_AFTER_INTERVALS: u32 = 2;
/// The shortest wait for the producer, so that nothing spins while it waits for a deadline.
const MIN_WAIT: Duration = Duration::from_millis(5);
/// A frame sent is at least this far after the frame sent before it.
const SENT_STEP: Duration = Duration::from_millis(1);
/// With no frame encoded for this long the sustain rate is 0.
const SUSTAIN_IDLE: Duration = Duration::from_secs(1);
/// The sustain rate is handed on when the rung changed or it moved by more than this share.
const SUSTAIN_MOVE: f64 = 0.05;

/// A `Source` made of a frame producer and an encoder.
///
/// The order of the fields is the order they are dropped in, and it matters: the encoder goes
/// before the kept frame `last`. On Windows a capture frame keeps its frame pool open, and the
/// pool closing while the encoder is torn down on the same D3D11 device crashed the process.
/// Keep `encoder` above `last`.
pub struct VideoPipeline<P: FrameProducer, E: FrameEncoder<Frame = P::Frame>> {
    producer: P,
    encoder: E,
    keys: KeyFrames,
    meter: OutputMeter,
    cadence: Cadence,
    /// When the producer last handed over a new frame.
    last_new: Option<Instant>,
    /// The newest frame from the producer, encoded again when nothing newer comes: if it was
    /// skipped, or once the encoder may take up a new size.
    last: Option<P::Frame>,
    /// `last` was skipped and is not encoded yet.
    last_skipped: bool,
    /// When a frame was last encoded.
    last_encoded: Option<Instant>,
    /// The sharer's preview, when the host attached one.
    preview: Option<Arc<Preview>>,
    preview_rate: PreviewRate,
    /// A new picture came from the producer since the preview was last offered a frame.
    preview_new: bool,
    /// The time between frames sent.
    intervals: FrameIntervals,
    /// The picture's size giving way first, when the share asked for it.
    ladder: SizeLadder,
    /// The size the encoder ran at after the frame encoded last.
    running: Option<(u32, u32)>,
    /// The capture time of the frame sent last.
    sent_last: Option<Instant>,
    /// The rung and the sustain rate last handed to the transport.
    sustained: (usize, u64),
}

impl<P: FrameProducer, E: FrameEncoder<Frame = P::Frame>> VideoPipeline<P, E> {
    pub fn new(producer: P, encoder: E) -> Self {
        VideoPipeline {
            producer,
            encoder,
            keys: KeyFrames::default(),
            meter: OutputMeter::default(),
            cadence: Cadence::default(),
            last_new: None,
            last: None,
            last_skipped: false,
            last_encoded: None,
            preview: None,
            preview_rate: PreviewRate::default(),
            preview_new: false,
            intervals: FrameIntervals::default(),
            ladder: SizeLadder::default(),
            running: None,
            sent_last: None,
            sustained: (0, 0),
        }
    }

    /// Hands the transport `bps` to sustain on `rung` when the rung changed or the rate moved by
    /// more than `SUSTAIN_MOVE` since it was last handed on.
    fn sustain(&mut self, control: &SourceControl, rung: usize, bps: u64) {
        let (was_rung, was) = self.sustained;
        if rung != was_rung || was.abs_diff(bps) as f64 > was as f64 * SUSTAIN_MOVE {
            self.sustained = (rung, bps);
            control.set_sustain_bitrate(bps);
        }
    }

    /// The sizes the newest frame is encoded at under each rung and the codec's bits per pixel,
    /// `None` when the share did not ask for the size to give way or the encoder has no ladder.
    fn ladder_sizes(&self) -> Option<([(u32, u32); 3], f64)> {
        if !self.ladder.on {
            return None;
        }
        let floor = self.encoder.size_floor()?;
        let mut sizes = [(0, 0); 3];
        for (size, cap) in sizes.iter_mut().zip(RUNGS) {
            *size = self.encoder.size_under(cap)?;
        }
        Some((sizes, floor))
    }

    /// Takes up what the preview asks for, and offers it the kept frame for the first picture
    /// after a request.
    fn preview_turn(&mut self) {
        let Some(preview) = &self.preview else {
            return;
        };
        let (generation, request) = preview.current();
        self.preview_rate.follow(generation, request);
        if self.preview_rate.wants_kept() && self.encoder.offer_preview(preview) {
            self.preview_rate.offered(Instant::now());
            self.preview_new = false;
        }
    }

    /// After a frame was encoded: offers the preview the frame just converted, if it shows a new
    /// picture and one is due.
    fn preview_encoded(&mut self) {
        let Some(preview) = &self.preview else {
            return;
        };
        let now = Instant::now();
        if self.preview_new && self.preview_rate.due(now) && self.encoder.offer_preview(preview) {
            self.preview_rate.offered(now);
            self.preview_new = false;
        }
    }

    /// When a skipped frame may be encoded: one in N of the producer's rate after the last.
    fn skipped_due(&self, now: Instant, interval: Duration) -> Instant {
        self.last_encoded.map_or(now, |at| at + interval * self.cadence.divisor())
    }

    /// How long the producer may wait for a new frame: an interval to look at requests, or less
    /// when something is due sooner, never less than `MIN_WAIT`.
    fn wake_at(&self, now: Instant, interval: Duration) -> Instant {
        let mut until = now + interval;
        if self.keys.pending()
            && let Some(last) = self.last_new
        {
            // The kept frame is due once nothing new came and the spacing is over.
            let quiet = last + interval * KEPT_AFTER_INTERVALS;
            until = quiet.max(self.keys.next_allowed().unwrap_or(quiet));
        }
        if self.last_skipped {
            until = until.min(self.skipped_due(now, interval));
        }
        if self.last.is_some()
            && let Some(at) = self.encoder.resize_due()
        {
            until = until.min(at);
        }
        until.max(now + MIN_WAIT)
    }

    /// One turn of the loops: a new frame, or a key frame from the kept one. `Ok(false)` once
    /// the source should end.
    fn step(&mut self, sink: &FrameSink, control: &SourceControl) -> Result<bool, Error> {
        let interval = self.producer.interval();
        let until = self.wake_at(Instant::now(), interval);
        let produced = self.producer.next_frame(control, until)?;
        if control.take_key_frame_wanted() {
            self.keys.request();
        }
        self.preview_turn();
        let frame = match produced {
            Produced::End => return Ok(false),
            Produced::Idle => return self.idle(sink, control, interval),
            Produced::Frame(frame) => frame,
        };
        self.last_new = Some(Instant::now());
        if self.preview_rate.active() && !self.producer.repeats_last() {
            self.preview_new = true;
        }
        if !self.cadence.keep() {
            control.update_report(|r| r.frames_skipped_rate += 1);
            self.last = Some(frame);
            self.last_skipped = true;
            return Ok(true);
        }
        let target = control.target_bitrate();
        if backlogged(control.queued_bytes(), target) {
            // A skipped frame is not an error. A pending key frame waits for the next one.
            control.update_report(|r| r.frames_skipped_backlog += 1);
            self.last = Some(frame);
            self.last_skipped = true;
            return Ok(true);
        }

        let now = Instant::now();
        if self.producer.captures() {
            let delay = now.saturating_duration_since(frame.capture_time()).as_secs_f64() * 1000.0;
            control.update_report(|r| r.capture_delay_ms.push(delay));
        }
        let capture_time = frame.capture_time();
        self.encode_frame(sink, control, frame, target, capture_time)
    }

    /// Nothing new came: the newest frame if it was skipped or a new size is due, else a key
    /// frame from the kept one.
    fn idle(&mut self, sink: &FrameSink, control: &SourceControl, interval: Duration) -> Result<bool, Error> {
        let now = Instant::now();
        // No padding for a still picture: the next encoded frame's ladder turn brings it back.
        if self.last_encoded.is_none_or(|at| now.saturating_duration_since(at) >= SUSTAIN_IDLE) {
            self.sustain(control, self.ladder.rung, 0);
        }
        let target = control.target_bitrate();
        if self.last.is_some() && !backlogged(control.queued_bytes(), target) {
            let skipped = self.last_skipped && now >= self.skipped_due(now, interval);
            let resize = self.encoder.resize_due().is_some_and(|at| now >= at);
            if skipped || resize {
                tracing::debug!(skipped, resize, "the newest frame encoded again");
                let frame = self.last.take().expect("checked above");
                // Its own capture time may be that of a frame already sent.
                return self.encode_frame(sink, control, frame, target, now);
            }
        }
        self.kept_key_frame(sink, control, interval)
    }

    /// Encodes `frame`, sent with `capture_time`, and keeps it as the newest.
    fn encode_frame(
        &mut self,
        sink: &FrameSink,
        control: &SourceControl,
        frame: P::Frame,
        target: u64,
        capture_time: Instant,
    ) -> Result<bool, Error> {
        let now = Instant::now();
        let (key, forced) = self.keys.decide(now);
        let result = self.encode(sink, control, target, forced, false, capture_time, |encoder, bitrate, divisor| {
            encoder.encode(&frame, bitrate, divisor, key).map(|packet| Some((packet, key)))
        });
        self.last = Some(frame);
        self.last_skipped = false;
        result
    }

    /// The kept frame again as a key frame, when one is wanted and nothing new came for
    /// `KEPT_AFTER_INTERVALS`.
    fn kept_key_frame(&mut self, sink: &FrameSink, control: &SourceControl, interval: Duration) -> Result<bool, Error> {
        let now = Instant::now();
        let quiet = self.last_new.is_some_and(|last| now.saturating_duration_since(last) >= interval * KEPT_AFTER_INTERVALS);
        if !self.keys.pending() || !quiet {
            return Ok(true);
        }
        let target = control.target_bitrate();
        if backlogged(control.queued_bytes(), target) {
            return Ok(true);
        }
        let (key, forced) = self.keys.decide(now);
        if !key {
            // Inside the spacing: the request waits.
            return Ok(true);
        }
        self.encode(sink, control, target, forced, true, now, |encoder, bitrate, divisor| {
            Ok(encoder.encode_kept(bitrate, divisor, true)?.map(|packet| (packet, true)))
        })
    }

    /// Runs `encode` at the bitrate the loops ask for and hands the packet on.
    #[allow(clippy::too_many_arguments)]
    fn encode(
        &mut self,
        sink: &FrameSink,
        control: &SourceControl,
        target: u64,
        forced: bool,
        kept: bool,
        capture_time: Instant,
        encode: impl FnOnce(&mut E, u64, u32) -> Result<Option<(Packet, bool)>, Error>,
    ) -> Result<bool, Error> {
        let now = Instant::now();
        let bitrate = self.meter.bitrate_for(now, target);
        let began = Instant::now();
        let divisor = self.cadence.divisor();
        // What counts as a long gap for this frame: the divisor it was encoded under.
        let (interval, in_force) = (self.producer.interval(), divisor);
        let Some((packet, key)) = encode(&mut self.encoder, bitrate, divisor)? else {
            return Ok(true);
        };
        let encode_ms = began.elapsed().as_secs_f64() * 1000.0;
        let done = Instant::now();
        self.last_encoded = Some(done);
        self.meter.record(done, packet.data.len() as u64, bitrate);
        let previous = self.running;
        let running = self.encoder.running_size();
        if self.ladder.on && self.running.is_some() && running != self.running {
            // A new size starts the loops afresh, its key frame and the old size's frames
            // do not count against it.
            self.meter = OutputMeter::default();
            self.cadence.restart();
            self.ladder.restart();
        }
        self.running = running;
        let output = self.meter.output_bps(done);
        let scale = if target > 0 { bitrate as f64 / target as f64 } else { 1.0 };
        let ladder = self.ladder_sizes();
        // With the size ladder N steps up only on its lowest rung. Without it, whenever it is due.
        let may_slow = ladder.as_ref().is_none_or(|(sizes, _)| self.ladder.lowest(sizes));
        self.cadence.update_with(done, output, target, scale, may_slow);
        if let Some((sizes, floor)) = ladder {
            let fps = 1.0 / interval.as_secs_f64();
            // The share's maximum, 0 when the engine did not set one.
            self.ladder.max = Some(control.max_bitrate()).filter(|&max| max > 0);
            if let Some(rung) = self.ladder.update(done, &sizes, fps, floor, target, output, scale, self.cadence.divisor()) {
                self.encoder.set_size_cap(RUNGS[rung]);
                // The time over the target was the old size's.
                self.cadence.restart();
            }
            // Below the top rung the transport pads toward the step up's rate.
            let sustain = self.ladder.sustain(&sizes, fps, floor);
            self.sustain(control, self.ladder.rung, sustain);
        }
        let divisor = self.cadence.divisor();
        let (steps_down, steps_up) = (self.ladder.steps_down, self.ladder.steps_up);
        control.update_report(|r| {
            r.encoder_bitrate_bps = Some(bitrate);
            r.encoder_output_bps = output;
            r.frame_rate_divisor = Some(divisor);
            r.encoded_size = running;
            r.size_steps_down = steps_down;
            r.size_steps_up = steps_up;
            r.key_frames_forced += u64::from(forced);
            r.key_frames_repeated += u64::from(kept);
            r.encode_ms.push(encode_ms);
        });
        if packet.key && !key {
            if previous.is_some() && running.is_some() && running != previous {
                // The first frame of an encoder opened again at a new size is its own key frame:
                // it is logged at info, not warned of.
                tracing::info!(bytes = packet.data.len(), from = ?previous, to = ?running, "key frame of the encoder opened again at the new size");
            } else {
                tracing::warn!(bytes = packet.data.len(), "key frame that was not asked for");
            }
        }
        if packet.key {
            // Any key frame restarts the spacing and meets a pending request.
            self.keys.made(done);
        }

        // Capture times of frames sent never go back, whatever turn made the frame: an
        // idle turn's `now` can be behind a frame stamped ahead of its arrival (Windows), and a
        // compositor's time behind an idle turn's `now` (Linux).
        let capture_time = self.sent_last.map_or(capture_time, |last| capture_time.max(last + SENT_STEP));
        let frame = EncodedFrame {
            data: packet.data,
            key: packet.key,
            capture_time,
        };
        let pushed = sink.push(frame);
        if pushed.is_ok() {
            self.sent_last = Some(capture_time);
        }
        if pushed.is_ok()
            && let Some((ms, long)) = self.intervals.sent(capture_time, interval, in_force)
        {
            // Only frames that went: one dropped on a full queue is a gap for the viewer.
            control.update_report(|r| {
                r.frame_interval_ms.push(ms);
                r.frame_gaps_long += u64::from(long);
            });
        }
        if !kept {
            // Once the frame is on its way, so the preview never holds it up.
            self.preview_encoded();
        }
        match pushed {
            Ok(()) => Ok(true),
            Err(PushError::Full) => {
                // The encoder refers to the dropped frame from now on, a key frame repairs it.
                self.keys.request();
                Ok(true)
            }
            Err(PushError::Closed) => Ok(false),
        }
    }
}

impl<P: FrameProducer, E: FrameEncoder<Frame = P::Frame>> Source for VideoPipeline<P, E> {
    fn attach_preview(&mut self, preview: Arc<Preview>) -> bool {
        self.preview = Some(preview);
        true
    }

    fn set_degrade(&mut self, degrade: crate::Degrade) {
        self.ladder.on = degrade == crate::Degrade::Size;
    }

    fn run(&mut self, sink: FrameSink, control: &SourceControl) {
        loop {
            match self.step(&sink, control) {
                Ok(true) => {}
                Ok(false) => return,
                Err(error) => {
                    tracing::error!(%error, "video pipeline stopped");
                    control.fail(error.to_string());
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::frame_channel;
    use std::sync::{Arc, Mutex};

    #[test]
    fn backlog_rule() {
        // 200 ms of 8 Mbps is 200,000 bytes.
        assert!(!backlogged(200_000, 8_000_000));
        assert!(backlogged(200_001, 8_000_000));
        assert!(!backlogged(0, 0));
        assert!(backlogged(1, 0));
    }

    #[test]
    fn key_frames_are_spaced() {
        let t = Instant::now();
        let mut keys = KeyFrames::default();
        assert_eq!(keys.decide(t), (true, false));
        keys.request();
        assert_eq!(keys.decide(t + Duration::from_millis(100)), (false, false));
        assert_eq!(keys.decide(t + Duration::from_millis(499)), (false, false));
        assert_eq!(keys.decide(t + Duration::from_millis(500)), (true, true));
        assert_eq!(keys.decide(t + Duration::from_millis(1500)), (false, false));
        keys.request();
        assert_eq!(keys.decide(t + Duration::from_millis(1501)), (true, true));
    }

    #[test]
    fn meter_scales_down_within_bounds() {
        let t = Instant::now();
        let mut meter = OutputMeter::default();
        assert_eq!(meter.bitrate_for(t, 8_000_000), 8_000_000);
        // 60 frames a second of 20,000 bytes asked at 8 Mbps: 9.6 Mbps out.
        for n in 0..=60u64 {
            meter.record(t + Duration::from_micros(n * 16_667), 20_000, 8_000_000);
        }
        let now = t + Duration::from_millis(1000);
        assert_eq!(meter.output_bps(now), Some(9_600_000));
        assert_eq!(meter.bitrate_for(now, 8_000_000), 6_666_667);
        // Never below 0.7 of the target.
        let mut meter = OutputMeter::default();
        for n in 0..=60u64 {
            meter.record(t + Duration::from_micros(n * 16_667), 50_000, 8_000_000);
        }
        assert_eq!(meter.bitrate_for(now, 8_000_000), 5_600_000);
        // A quiet encoder is asked for the target, never more.
        let mut meter = OutputMeter::default();
        for n in 0..=60u64 {
            meter.record(t + Duration::from_micros(n * 16_667), 100, 8_000_000);
        }
        assert_eq!(meter.bitrate_for(now, 3_000_000), 3_000_000);
    }

    #[test]
    fn cadence_steps_evenly() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut cadence = Cadence::default();
        assert_eq!((0..4).map(|_| cadence.keep()).collect::<Vec<_>>(), vec![true; 4]);
        // Over by more than 15 % at the floor for a second: one step up.
        cadence.update(ms(0), Some(1_200_000), 1_000_000, 0.7);
        cadence.update(ms(999), Some(1_200_000), 1_000_000, 0.7);
        assert_eq!(cadence.divisor(), 1);
        cadence.update(ms(1000), Some(1_200_000), 1_000_000, 0.7);
        assert_eq!(cadence.divisor(), 2);
        assert_eq!((0..4).map(|_| cadence.keep()).collect::<Vec<_>>(), vec![true, false, true, false]);
        // Over, but the scale is not at its floor: no step.
        cadence.update(ms(1100), Some(1_500_000), 1_000_000, 0.8);
        cadence.update(ms(2500), Some(1_500_000), 1_000_000, 0.8);
        assert_eq!(cadence.divisor(), 2);
        // Met with room for 3 s: one step down.
        cadence.update(ms(3000), Some(900_000), 1_000_000, 0.9);
        cadence.update(ms(5999), Some(900_000), 1_000_000, 0.9);
        assert_eq!(cadence.divisor(), 2);
        cadence.update(ms(6000), Some(900_000), 1_000_000, 0.9);
        assert_eq!(cadence.divisor(), 1);
        // Never past the ends.
        cadence.update(ms(7000), Some(900_000), 1_000_000, 0.9);
        cadence.update(ms(11000), Some(900_000), 1_000_000, 0.9);
        assert_eq!(cadence.divisor(), 1);
        for step in 0..20 {
            cadence.update(ms(20_000 + step * 1000), Some(9_000_000), 1_000_000, 0.7);
        }
        assert_eq!(cadence.divisor(), 10);
    }

    #[test]
    fn cadence_does_not_slow_where_it_may_not_and_counts_no_time_there() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut cadence = Cadence::default();
        // Over at the floor for long, not free to slow: N stays 1.
        for step in 0..5 {
            cadence.update_with(ms(step * 1000), Some(1_200_000), 1_000_000, 0.7, false);
        }
        assert_eq!(cadence.divisor(), 1);
        assert_eq!(cadence.over_since, None);
        // Free to slow from 5 s: a full second counted from then.
        cadence.update_with(ms(5000), Some(1_200_000), 1_000_000, 0.7, true);
        cadence.update_with(ms(5999), Some(1_200_000), 1_000_000, 0.7, true);
        assert_eq!(cadence.divisor(), 1);
        cadence.update_with(ms(6000), Some(1_200_000), 1_000_000, 0.7, true);
        assert_eq!(cadence.divisor(), 2);
        // It steps down whether free to slow or not.
        cadence.update_with(ms(7000), Some(900_000), 1_000_000, 0.9, false);
        cadence.update_with(ms(10_000), Some(900_000), 1_000_000, 0.9, false);
        assert_eq!(cadence.divisor(), 1);
        // A restart forgets the time over the target.
        cadence.update_with(ms(11_000), Some(1_200_000), 1_000_000, 0.7, true);
        cadence.restart();
        cadence.update_with(ms(12_500), Some(1_200_000), 1_000_000, 0.7, true);
        assert_eq!(cadence.divisor(), 1);
    }

    /// 1080p content under the three rungs, as `sizing::output_size` fits it.
    const HD: [(u32, u32); 3] = [(1920, 1080), (1280, 720), (960, 540)];

    #[test]
    fn what_a_size_needs() {
        // 1080p at 60 in H264 3.73 Mbps, 720p 1.66, 540p 0.93.
        assert_eq!(needed(HD[0], 60.0, FLOOR_H264).round(), 3_732_480.0);
        assert_eq!(needed(HD[1], 60.0, FLOOR_H264).round(), 1_658_880.0);
        assert_eq!(needed(HD[2], 60.0, FLOOR_H264).round(), 933_120.0);
        assert_eq!(needed(HD[0], 60.0, FLOOR_AV1).round(), 2_488_320.0);
    }

    #[test]
    fn the_size_steps_down_after_2_s_under_what_it_needs_and_spaced_by_5_s() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut l = SizeLadder { on: true, ..SizeLadder::default() };
        let at = |l: &mut SizeLadder, v, target| l.update(ms(v), &HD, 60.0, FLOOR_H264, target, Some(target), 1.0, 1);
        // 3 Mbps is under 1080p's 3.73, for 2 s.
        assert_eq!(at(&mut l, 0, 3_000_000), None);
        assert_eq!(at(&mut l, 1999, 3_000_000), None);
        assert_eq!(at(&mut l, 2000, 3_000_000), Some(1));
        assert_eq!((l.rung, l.steps_down, l.steps_up), (1, 1, 0));
        // 720p needs 1.66: 3 Mbps holds it, however long.
        for v in (3000..20_000).step_by(1000) {
            assert_eq!(at(&mut l, v, 3_000_000), None);
        }
        // Under 720p's need from 21 s, held 2 s at 23 s, taken at once (spacing long over).
        assert_eq!(at(&mut l, 21_000, 1_200_000), None);
        assert_eq!(at(&mut l, 23_000, 1_200_000), Some(2));
        // The lowest rung: nothing further down, whatever the target.
        assert!(l.lowest(&HD));
        assert_eq!(at(&mut l, 30_000, 100_000), None);
        assert_eq!(at(&mut l, 40_000, 100_000), None);
        assert_eq!(l.steps_down, 2);

        // A change the spacing holds back is taken when it ends, if it still holds.
        let mut l = SizeLadder { on: true, ..SizeLadder::default() };
        assert_eq!(at(&mut l, 0, 3_000_000), None);
        assert_eq!(at(&mut l, 2000, 3_000_000), Some(1));
        assert_eq!(at(&mut l, 2500, 1_200_000), None);
        assert_eq!(at(&mut l, 4500, 1_200_000), None);
        assert_eq!(at(&mut l, 6999, 1_200_000), None);
        assert_eq!(at(&mut l, 7000, 1_200_000), Some(2));
        // And not when it no longer does.
        let mut l = SizeLadder { on: true, ..SizeLadder::default() };
        assert_eq!(at(&mut l, 0, 3_000_000), None);
        assert_eq!(at(&mut l, 2000, 3_000_000), Some(1));
        assert_eq!(at(&mut l, 2500, 1_200_000), None);
        assert_eq!(at(&mut l, 6000, 3_000_000), None);
        assert_eq!(at(&mut l, 7000, 1_200_000), None);
        assert_eq!(l.rung, 1);
    }

    #[test]
    fn the_size_steps_down_when_the_encoder_cannot_get_down_to_the_target() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut l = SizeLadder { on: true, ..SizeLadder::default() };
        // 4 Mbps is enough for 1080p's 3.73 (and no room for a step up, 4.67), but the
        // output is over 1.15 times it with the scale at its floor, for 1 s.
        let over = |l: &mut SizeLadder, v, scale| l.update(ms(v), &HD, 60.0, FLOOR_H264, 4_000_000, Some(5_000_000), scale, 1);
        assert_eq!(over(&mut l, 0, 0.7), None);
        assert_eq!(over(&mut l, 999, 0.7), None);
        assert_eq!(over(&mut l, 1000, 0.7), Some(1));
        // Not at the floor: no step (spacing over by 7 s).
        assert_eq!(over(&mut l, 7000, 0.8), None);
        assert_eq!(over(&mut l, 9000, 0.8), None);
        // Within 15 % of the target: no step.
        let near = l.update(ms(9500), &HD, 60.0, FLOOR_H264, 4_000_000, Some(4_500_000), 0.7, 1);
        assert_eq!(near, None);
        assert_eq!(l.update(ms(11_000), &HD, 60.0, FLOOR_H264, 4_000_000, Some(4_500_000), 0.7, 1), None);
        assert_eq!(l.rung, 1);
        // No output figure yet (the meter's first second): the time over is kept, not ended.
        assert_eq!(over(&mut l, 12_000, 0.7), None);
        assert_eq!(l.update(ms(12_500), &HD, 60.0, FLOOR_H264, 4_000_000, None, 0.7, 1), None);
        assert_eq!(over(&mut l, 13_000, 0.7), Some(2));
    }

    #[test]
    fn the_size_steps_up_after_5_s_of_room_at_the_full_frame_rate() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut l = SizeLadder { on: true, rung: 2, ..SizeLadder::default() };
        let at = |l: &mut SizeLadder, v, target, divisor| l.update(ms(v), &HD, 60.0, FLOOR_H264, target, Some(target), 1.0, divisor);
        // 720p needs 1.66, 1.25 times that is 2.07 Mbps. 2 Mbps is not room.
        assert_eq!(at(&mut l, 0, 2_000_000, 1), None);
        assert_eq!(at(&mut l, 10_000, 2_000_000, 1), None);
        // Room, but not at the full frame rate: no step.
        assert_eq!(at(&mut l, 11_000, 2_100_000, 2), None);
        assert_eq!(at(&mut l, 17_000, 2_100_000, 2), None);
        // Room at the full frame rate for 5 s.
        assert_eq!(at(&mut l, 18_000, 2_100_000, 1), None);
        assert_eq!(at(&mut l, 22_999, 2_100_000, 1), None);
        assert_eq!(at(&mut l, 23_000, 2_100_000, 1), Some(1));
        assert_eq!((l.rung, l.steps_up), (1, 1));
        // 1080p needs 3.73, room is 4.67 Mbps: from 25 s, held at 30 s, spacing over at 28 s.
        assert_eq!(at(&mut l, 25_000, 4_700_000, 1), None);
        assert_eq!(at(&mut l, 29_999, 4_700_000, 1), None);
        assert_eq!(at(&mut l, 30_000, 4_700_000, 1), Some(0));
        // At full size there is nothing above.
        assert_eq!(at(&mut l, 50_000, 20_000_000, 1), None);
        assert_eq!((l.rung, l.steps_up, l.steps_down), (0, 2, 0));
    }

    #[test]
    fn the_rate_sustained_is_what_the_step_up_needs_and_none_on_the_top_rung() {
        // 0 on the top rung, below it 1.25 times what the size of the rung above needs.
        let on = |rung| SizeLadder { on: true, rung, ..SizeLadder::default() };
        assert_eq!(on(0).sustain(&HD, 60.0, FLOOR_H264), 0);
        assert_eq!(on(1).sustain(&HD, 60.0, FLOOR_H264), 4_665_600);
        assert_eq!(on(2).sustain(&HD, 60.0, FLOOR_H264), 2_073_600);
        assert_eq!(on(1).sustain(&HD, 60.0, FLOOR_AV1), 3_110_400);
        // A rung that does not make the picture smaller is skipped on the way up too: 1280x720
        // content at 540p pads toward 720p, at 720p it is full size and pads for nothing.
        let small = [(1280, 720), (1280, 720), (960, 540)];
        assert_eq!(on(2).sustain(&small, 60.0, FLOOR_H264), 2_073_600);
        assert_eq!(on(1).sustain(&small, 60.0, FLOOR_H264), 0);
        assert_eq!(on(0).sustain(&[(640, 480); 3], 60.0, FLOOR_H264), 0);
    }

    #[test]
    fn a_rung_that_does_not_make_the_picture_smaller_is_skipped() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        // 1280x720 content: the 720p cap changes nothing, the way down is to 540p.
        let small = [(1280, 720), (1280, 720), (960, 540)];
        assert_eq!(output_size_under(1280, 720), small);
        let mut l = SizeLadder { on: true, ..SizeLadder::default() };
        assert_eq!(l.below(&small), Some(2));
        assert_eq!(l.update(ms(0), &small, 60.0, FLOOR_H264, 1_500_000, None, 1.0, 1), None);
        assert_eq!(l.update(ms(2000), &small, 60.0, FLOOR_H264, 1_500_000, None, 1.0, 1), Some(2));
        // Back up it goes to the first rung that makes it larger.
        assert_eq!(l.above(&small), Some(1));
        // 640x480 content: no rung makes it smaller, it is the lowest at once.
        let tiny = output_size_under(640, 480);
        assert_eq!(tiny, [(640, 480); 3]);
        let mut l = SizeLadder { on: true, ..SizeLadder::default() };
        assert!(l.lowest(&tiny));
        assert_eq!(l.update(ms(0), &tiny, 60.0, FLOOR_H264, 100_000, Some(900_000), 0.7, 1), None);
        assert_eq!(l.update(ms(10_000), &tiny, 60.0, FLOOR_H264, 100_000, Some(900_000), 0.7, 1), None);
        // A tall window: each cap keeps its shape.
        assert_eq!(output_size_under(1080, 1920), [(608, 1080), (404, 720), (304, 540)]);
    }

    /// The sizes content of `width` by `height` is encoded at under each rung, with the share's
    /// maximum at 1920x1080, as the real encoders work them out.
    fn output_size_under(width: u32, height: u32) -> [(u32, u32); 3] {
        RUNGS.map(|cap| {
            let (w, h) = cap.map_or((1920, 1080), |(w, h)| (w.min(1920), h.min(1080)));
            sizing::output_size(width, height, w, h)
        })
    }

    /// A raw frame for these tests, on any system.
    #[derive(Debug)]
    struct TestFrame {
        width: u32,
        height: u32,
        capture_time: Instant,
    }

    impl RawFrame for TestFrame {
        fn capture_time(&self) -> Instant {
            self.capture_time
        }
    }

    fn frame() -> TestFrame {
        TestFrame {
            width: 16,
            height: 16,
            capture_time: Instant::now(),
        }
    }

    struct Frames(u64);
    impl FrameProducer for Frames {
        type Frame = TestFrame;
        fn next_frame(&mut self, control: &SourceControl, _until: Instant) -> Result<Produced<TestFrame>, Error> {
            if self.0 == 0 || control.stopped() {
                return Ok(Produced::End);
            }
            self.0 -= 1;
            Ok(Produced::Frame(frame()))
        }

        fn interval(&self) -> Duration {
            Duration::from_millis(16)
        }
    }

    /// Frames as scripted: `true` a new frame, `false` nothing new by the time asked for.
    struct Script(VecDeque<bool>);
    impl FrameProducer for Script {
        type Frame = TestFrame;
        fn next_frame(&mut self, _control: &SourceControl, until: Instant) -> Result<Produced<TestFrame>, Error> {
            match self.0.pop_front() {
                None => Ok(Produced::End),
                Some(true) => Ok(Produced::Frame(frame())),
                Some(false) => {
                    std::thread::sleep(until.saturating_duration_since(Instant::now()));
                    Ok(Produced::Idle)
                }
            }
        }

        fn interval(&self) -> Duration {
            Duration::from_millis(5)
        }

        fn captures(&self) -> bool {
            true
        }
    }

    /// (bitrate, key, kept) of every call.
    #[derive(Clone, Default)]
    struct Calls(Arc<Mutex<Vec<(u64, bool, bool)>>>);
    impl FrameEncoder for Calls {
        type Frame = TestFrame;
        fn encode(&mut self, _frame: &TestFrame, bitrate: u64, _divisor: u32, key: bool) -> Result<Packet, Error> {
            self.0.lock().unwrap().push((bitrate, key, false));
            Ok(Packet { data: vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }, 1], key })
        }

        fn encode_kept(&mut self, bitrate: u64, _divisor: u32, key: bool) -> Result<Option<Packet>, Error> {
            self.0.lock().unwrap().push((bitrate, key, true));
            Ok(Some(Packet { data: vec![0, 0, 0, 1, 0x65, 1], key }))
        }
    }

    #[test]
    fn kept_frame_answers_a_key_request_on_a_still_source() {
        let calls = Calls::default();
        // A frame, then nothing new for long.
        let mut pipeline = VideoPipeline::new(Script(VecDeque::from(vec![true, false, false, false, false])), calls.clone());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(16);
        assert!(pipeline.step(&sink, &control).unwrap());
        // No request: idle turns encode nothing.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(calls.0.lock().unwrap().len(), 1);
        // A request inside the 500 ms after the first key frame waits for its end.
        control.want_key_frame();
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(calls.0.lock().unwrap().len(), 1);
        pipeline.keys.last = Some(Instant::now() - KEY_FRAME_SPACING);
        assert!(pipeline.step(&sink, &control).unwrap());
        let calls = calls.0.lock().unwrap().clone();
        assert_eq!(calls, vec![(1_000_000, true, false), (1_000_000, true, true)]);
        let report = control.take_report();
        assert_eq!(report.key_frames_repeated, 1);
        assert_eq!(report.key_frames_forced, 1);
        assert_eq!(report.capture_delay_ms.len(), 1);
        assert_eq!(frames.try_iter().filter(|f| f.key).count(), 2);
        // Then the source ends.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(!pipeline.step(&sink, &control).unwrap());
    }

    #[test]
    fn pipeline_skips_on_backlog_and_keeps_a_key_request() {
        let calls = Calls::default();
        let mut pipeline = VideoPipeline::new(Frames(10), calls.clone());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(16);

        assert!(pipeline.step(&sink, &control).unwrap());
        control.set_queued_bytes(30_000);
        control.want_key_frame();
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(pipeline.step(&sink, &control).unwrap());
        control.set_queued_bytes(0);
        assert!(pipeline.step(&sink, &control).unwrap());

        let report = control.take_report();
        assert_eq!(report.frames_skipped_backlog, 2);
        assert_eq!(report.encode_ms.len(), 2);
        assert_eq!(report.encoder_bitrate_bps, Some(1_000_000));
        let calls = calls.0.lock().unwrap().clone();
        // The first frame is a key frame. The request made during the backlog is still pending
        // and waits out the 500 ms after the first.
        assert_eq!(calls, vec![(1_000_000, true, false), (1_000_000, false, false)]);
        assert_eq!(frames.try_iter().count(), 2);
    }

    #[test]
    fn a_frame_skipped_by_the_cadence_is_encoded_when_nothing_newer_comes() {
        let calls = Calls::default();
        // Two frames, then the screen goes still.
        let mut pipeline = VideoPipeline::new(Script(VecDeque::from(vec![true, true, false, false, false, false, false, false])), calls.clone());
        pipeline.cadence.index = 1;
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(16);
        assert!(pipeline.step(&sink, &control).unwrap());
        // One in two: the second frame is skipped and kept.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(calls.0.lock().unwrap().len(), 1);
        assert!(pipeline.last_skipped);
        // Nothing new: it goes out once the cadence allows, two intervals after the first.
        let began = Instant::now();
        while calls.0.lock().unwrap().len() < 2 && began.elapsed() < Duration::from_secs(1) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        let encoded = pipeline.last_encoded.unwrap();
        assert_eq!(*calls.0.lock().unwrap(), vec![(1_000_000, true, false), (1_000_000, false, false)]);
        assert!(!pipeline.last_skipped);
        assert_eq!(frames.try_iter().count(), 2);
        assert_eq!(control.take_report().frames_skipped_rate, 1);
        // And only once.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(calls.0.lock().unwrap().len(), 2);
        assert_eq!(pipeline.last_encoded, Some(encoded));
    }

    #[test]
    fn a_frame_skipped_for_backlog_is_encoded_once_the_queue_drains() {
        let calls = Calls::default();
        let mut pipeline = VideoPipeline::new(Script(VecDeque::from(vec![true, true, false, false])), calls.clone());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, _) = frame_channel(16);
        assert!(pipeline.step(&sink, &control).unwrap());
        control.set_queued_bytes(30_000);
        assert!(pipeline.step(&sink, &control).unwrap());
        // Still backlogged: nothing.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(calls.0.lock().unwrap().len(), 1);
        control.set_queued_bytes(0);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(*calls.0.lock().unwrap(), vec![(1_000_000, true, false), (1_000_000, false, false)]);
        assert_eq!(control.take_report().frames_skipped_backlog, 1);
    }

    /// Frames of the given widths, then nothing new until stopped.
    struct Widths(VecDeque<u32>);
    impl FrameProducer for Widths {
        type Frame = TestFrame;
        fn next_frame(&mut self, _control: &SourceControl, until: Instant) -> Result<Produced<TestFrame>, Error> {
            match self.0.pop_front() {
                Some(width) => Ok(Produced::Frame(TestFrame { width, ..frame() })),
                None => {
                    std::thread::sleep(until.saturating_duration_since(Instant::now()));
                    Ok(Produced::Idle)
                }
            }
        }

        fn interval(&self) -> Duration {
            Duration::from_millis(16)
        }
    }

    /// An encoder that takes up sizes by the sizing rule, recording (input width, width encoded
    /// at, opened for it).
    #[derive(Default)]
    struct Resizing {
        resizes: sizing::Resizes,
        running: Option<(u32, u32)>,
        calls: Arc<Mutex<Vec<(u32, u32, bool)>>>,
    }
    impl FrameEncoder for Resizing {
        type Frame = TestFrame;
        fn encode(&mut self, frame: &TestFrame, _bitrate: u64, _divisor: u32, key: bool) -> Result<Packet, Error> {
            let (size, opened) = self.resizes.decide(Instant::now(), (frame.width, frame.height), self.running);
            self.running = Some(size);
            self.calls.lock().unwrap().push((frame.width, size.0, opened));
            Ok(Packet { data: vec![0, 0, 0, 1, if key || opened { 0x65 } else { 0x41 }, 1], key: key || opened })
        }

        fn resize_due(&self) -> Option<Instant> {
            self.running.and(self.resizes.due())
        }
    }

    #[test]
    fn a_resize_then_stillness_takes_up_the_new_size() {
        let encoder = Resizing::default();
        let calls = encoder.calls.clone();
        let mut pipeline = VideoPipeline::new(Widths(VecDeque::from(vec![1000, 1100])), encoder);
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(16);
        let began = Instant::now();
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(pipeline.step(&sink, &control).unwrap());
        // The new size is scaled to the running one until it settles, and no new frame comes.
        assert_eq!(*calls.lock().unwrap(), vec![(1000, 1000, true), (1100, 1000, false)]);
        let mut steps = 0;
        while calls.lock().unwrap().len() < 3 && began.elapsed() < Duration::from_secs(3) {
            assert!(pipeline.step(&sink, &control).unwrap());
            steps += 1;
        }
        // Taken up a second after the first opening, from the frame kept.
        assert_eq!(calls.lock().unwrap()[2], (1100, 1100, true));
        assert!(began.elapsed() >= Duration::from_secs(1), "{:?}", began.elapsed());
        // The wait was not a spin: at most one turn an interval.
        assert!(steps <= 70, "{steps} turns");
        assert_eq!(frames.try_iter().filter(|f| f.key).count(), 2);
        // Then nothing more while it stays still.
        let more = Instant::now();
        while more.elapsed() < Duration::from_millis(100) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        assert_eq!(calls.lock().unwrap().len(), 3);
    }

    #[test]
    fn a_frame_dropped_on_a_full_queue_asks_for_a_key_frame() {
        let calls = Calls::default();
        let mut pipeline = VideoPipeline::new(Frames(3), calls.clone());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, dropped) = frame_channel(1);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(!pipeline.keys.pending());
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(dropped.load(std::sync::atomic::Ordering::Relaxed), 1);
        assert!(pipeline.keys.pending());
    }

    #[test]
    fn a_pending_key_frame_waits_without_spinning() {
        let mut pipeline = VideoPipeline::new(Frames(0), Calls::default());
        let interval = Duration::from_millis(16);
        let now = Instant::now();
        pipeline.last_new = Some(now - Duration::from_secs(1));
        pipeline.keys.last = Some(now - Duration::from_millis(100));
        pipeline.keys.request();
        // Quiet for long, but inside the spacing after the last key frame: wake at its end.
        assert_eq!(pipeline.wake_at(now, interval), now + Duration::from_millis(400));
        // Both deadlines past (the kept frame waits for a backlog): a short wait, not none.
        pipeline.keys.last = Some(now - Duration::from_secs(2));
        assert_eq!(pipeline.wake_at(now, interval), now + MIN_WAIT);
        // Nothing pending: an interval.
        pipeline.keys = KeyFrames::default();
        assert_eq!(pipeline.wake_at(now, interval), now + interval);
    }

    /// A producer of `frames` new frames, of which those after the first repeat it when `still`.
    struct Pictures {
        frames: u64,
        handed: u64,
        still: bool,
    }
    impl FrameProducer for Pictures {
        type Frame = TestFrame;
        fn next_frame(&mut self, _control: &SourceControl, until: Instant) -> Result<Produced<TestFrame>, Error> {
            if self.handed == self.frames {
                std::thread::sleep(until.saturating_duration_since(Instant::now()));
                return Ok(Produced::Idle);
            }
            self.handed += 1;
            Ok(Produced::Frame(frame()))
        }

        fn interval(&self) -> Duration {
            Duration::from_millis(5)
        }

        fn repeats_last(&self) -> bool {
            self.still && self.handed > 1
        }
    }

    /// An encoder that keeps the last frame and counts the preview's offers.
    #[derive(Default)]
    struct Previewing {
        encoded: u32,
        offers: Arc<Mutex<Vec<u32>>>,
    }
    impl FrameEncoder for Previewing {
        type Frame = TestFrame;
        fn encode(&mut self, _frame: &TestFrame, _bitrate: u64, _divisor: u32, key: bool) -> Result<Packet, Error> {
            self.encoded += 1;
            Ok(Packet { data: vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }, 1], key })
        }

        fn offer_preview(&mut self, _preview: &Arc<Preview>) -> bool {
            if self.encoded == 0 {
                return false;
            }
            // The frame offered, by how many were encoded by then.
            self.offers.lock().unwrap().push(self.encoded);
            true
        }
    }

    #[test]
    fn the_preview_gets_the_kept_frame_on_a_request_and_new_pictures_only() {
        let encoder = Previewing::default();
        let offers = encoder.offers.clone();
        let mut pipeline = VideoPipeline::new(Pictures { frames: 4, handed: 0, still: true }, encoder);
        let preview = Preview::new(|_| {});
        assert!(pipeline.attach_preview(preview.clone()));
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, _) = frame_channel(16);
        // Not asked: nothing offered.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(offers.lock().unwrap().is_empty());
        // Asked: the kept frame (the first) at once, and none of the frames repeating it.
        preview.request(PreviewRequest { fps: 10, max_width: 480, max_height: 270 }).unwrap();
        for _ in 0..6 {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        assert_eq!(*offers.lock().unwrap(), vec![1]);
        assert_eq!(pipeline.encoder.encoded, 4);
        // Asked again: the kept frame again, once.
        preview.request(PreviewRequest { fps: 2, max_width: 320, max_height: 180 }).unwrap();
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(*offers.lock().unwrap(), vec![1, 4]);
        // Stopped: nothing.
        preview.request(PreviewRequest { fps: 0, max_width: 320, max_height: 180 }).unwrap();
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(offers.lock().unwrap().len(), 2);
    }

    #[test]
    fn a_preview_asked_before_the_first_frame_gets_it_then_follows_new_frames_at_its_rate() {
        let encoder = Previewing::default();
        let offers = encoder.offers.clone();
        let mut pipeline = VideoPipeline::new(Pictures { frames: 40, handed: 0, still: false }, encoder);
        let preview = Preview::new(|_| {});
        pipeline.attach_preview(preview.clone());
        // 10 a second, frames every 5 ms: one in about 20 frames.
        preview.request(PreviewRequest { fps: 10, max_width: 480, max_height: 270 }).unwrap();
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, _) = frame_channel(64);
        let began = Instant::now();
        while pipeline.encoder.encoded < 40 {
            assert!(pipeline.step(&sink, &control).unwrap());
            // Paced like the producer's clock would.
            std::thread::sleep(Duration::from_millis(5));
        }
        let elapsed = began.elapsed();
        let offers = offers.lock().unwrap().clone();
        // The first frame, then every 100 ms.
        assert_eq!(offers[0], 1);
        let most = (elapsed.as_millis() / 100 + 1) as usize;
        assert!(offers.len() >= 2 && offers.len() <= most, "{offers:?} in {elapsed:?}");
        assert!(offers.windows(2).all(|w| w[1] > w[0]), "{offers:?}");
    }

    #[test]
    fn frame_intervals_skip_the_first_frame_and_scale_with_the_divisor() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let interval = Duration::from_millis(16);
        let mut intervals = FrameIntervals::default();
        let mut sent = |at, divisor| intervals.sent(at, interval, divisor).map(|(ms, long)| ((ms * 1000.0).round() / 1000.0, long));
        // The first frame has no interval.
        assert_eq!(sent(ms(0), 1), None);
        assert_eq!(sent(ms(16), 1), Some((16.0, false)));
        // Over 1.5 intervals at one in one: long.
        assert_eq!(sent(ms(46), 1), Some((30.0, true)));
        // The same at one in two is the cadence, not a gap; past 1.5 times two intervals it is.
        assert_eq!(sent(ms(76), 2), Some((30.0, false)));
        assert_eq!(sent(ms(126), 2), Some((50.0, true)));
        assert_eq!(sent(ms(149), 1), Some((23.0, false)));
    }

    #[test]
    fn a_still_spell_gives_one_long_interval_and_one_long_gap() {
        // Two frames, a still spell of about 30 ms (6 waits of the 5 ms interval), a frame.
        let script = [true, true, false, false, false, false, false, false, true];
        let mut pipeline = VideoPipeline::new(Script(VecDeque::from(script.to_vec())), Calls::default());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(16);
        for _ in script {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        assert_eq!(frames.try_iter().count(), 3);
        let report = control.take_report();
        // Three frames sent, two intervals: the first frame has none.
        assert_eq!(report.frame_interval_ms.len(), 2, "{:?}", report.frame_interval_ms);
        assert!(report.frame_interval_ms[0] < 7.5, "{:?}", report.frame_interval_ms);
        assert!(report.frame_interval_ms[1] >= 25.0, "{:?}", report.frame_interval_ms);
        assert_eq!(report.frame_gaps_long, 1);
        // Taken by the statistics: the intervals go, the count of long gaps is a total.
        let again = control.take_report();
        assert!(again.frame_interval_ms.is_empty());
        assert_eq!(again.frame_gaps_long, 1);
    }

    /// An encoder with the size ladder, for 1920x1080 content at a maximum of 1920x1080, whose
    /// packets are `bytes` long. A new cap is taken up on the next frame (the real encoders wait
    /// for the sizing rule), with a key frame. It records the caps it was given.
    struct Laddered {
        cap: Option<(u32, u32)>,
        running: Option<(u32, u32)>,
        bytes: usize,
        caps: Arc<Mutex<Vec<Option<(u32, u32)>>>>,
        /// The next frame is a key frame nobody asked for, at the running size.
        key_next: bool,
    }
    impl Laddered {
        fn new(bytes: usize) -> Self {
            Laddered { cap: None, running: None, bytes, caps: Arc::default(), key_next: false }
        }
    }
    impl FrameEncoder for Laddered {
        type Frame = TestFrame;
        fn encode(&mut self, _frame: &TestFrame, _bitrate: u64, _divisor: u32, key: bool) -> Result<Packet, Error> {
            let size = self.size_under(self.cap).unwrap();
            let opened = self.running != Some(size);
            self.running = Some(size);
            let key = key || opened || std::mem::take(&mut self.key_next);
            let mut data = vec![0, 0, 0, 1, if key { 0x65 } else { 0x41 }];
            data.resize(self.bytes.max(data.len()), 1);
            Ok(Packet { data, key })
        }

        fn set_size_cap(&mut self, cap: Option<(u32, u32)>) {
            self.cap = cap;
            self.caps.lock().unwrap().push(cap);
        }

        fn size_under(&self, cap: Option<(u32, u32)>) -> Option<(u32, u32)> {
            let (w, h) = cap.map_or((1920, 1080), |(w, h)| (w.min(1920), h.min(1080)));
            Some(sizing::output_size(1920, 1080, w, h))
        }

        fn size_floor(&self) -> Option<f64> {
            Some(FLOOR_H264)
        }

        fn running_size(&self) -> Option<(u32, u32)> {
            self.running
        }
    }

    /// Fills the meter with a second of output far over a 1 Mbps target, asked at it, so the next
    /// frame is encoded with the scale at its floor and its output is still over: what makes
    /// the cadence step (and, with the ladder, the size).
    fn over_the_target<P: FrameProducer<Frame = TestFrame>, E: FrameEncoder<Frame = TestFrame>>(pipeline: &mut VideoPipeline<P, E>) {
        let now = Instant::now();
        pipeline.meter = OutputMeter::default();
        pipeline.meter.record(now - Duration::from_millis(1500), 0, 1_000_000);
        for n in 0..60u64 {
            pipeline.meter.record(now - Duration::from_millis(980) + Duration::from_millis(n * 16), 100_000, 1_000_000);
        }
        // The cadence has seen that for 2 s.
        pipeline.cadence.over_since = Some(now - Duration::from_secs(2));
    }

    #[test]
    fn rate_slows_the_frame_rate_and_never_caps_the_size() {
        let encoder = Laddered::new(100_000);
        let caps = encoder.caps.clone();
        let mut pipeline = VideoPipeline::new(Frames(20), encoder);
        pipeline.set_degrade(crate::Degrade::Rate);
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, _) = frame_channel(64);
        over_the_target(&mut pipeline);
        assert!(pipeline.step(&sink, &control).unwrap());
        // The cadence: one in two.
        assert_eq!(pipeline.cadence.divisor(), 2);
        // However long it stays over, the size is never touched, nor the meter reset.
        for _ in 0..10 {
            over_the_target(&mut pipeline);
            pipeline.ladder.under_since = Some(Instant::now() - Duration::from_secs(10));
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        assert!(caps.lock().unwrap().is_empty());
        let report = control.take_report();
        assert_eq!((report.size_steps_down, report.size_steps_up), (0, 0));
        // A `rate` share never asks for padding.
        assert_eq!(control.sustain_bitrate(), 0);
        assert_eq!(report.encoded_size, Some((1920, 1080)));
        assert!(pipeline.cadence.divisor() > 2);
    }

    #[test]
    fn with_size_the_frame_rate_gives_way_only_on_the_lowest_rung() {
        let encoder = Laddered::new(100_000);
        let caps = encoder.caps.clone();
        let mut pipeline = VideoPipeline::new(Frames(20), encoder);
        pipeline.set_degrade(crate::Degrade::Size);
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, _) = frame_channel(64);
        // 1080p, with two rungs below: the cadence does not step, the ladder starts its timers.
        over_the_target(&mut pipeline);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(pipeline.cadence.divisor(), 1);
        assert!(caps.lock().unwrap().is_empty());
        // On the top rung nothing is sustained.
        assert_eq!(control.sustain_bitrate(), 0);
        let fps = 1.0 / Duration::from_millis(16).as_secs_f64();
        let toward = |size| (ROOM_OVER * needed(size, fps, FLOOR_H264)).round() as u64;
        // Over at the floor for a second: down to 720p, the cadence's time forgotten.
        over_the_target(&mut pipeline);
        pipeline.ladder.over_since = Some(Instant::now() - Duration::from_secs(2));
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(*caps.lock().unwrap(), vec![Some((1280, 720))]);
        // At 720p the rate the step up to 1080p needs.
        assert_eq!(control.sustain_bitrate(), toward(HD[0]));
        assert_eq!(pipeline.cadence.divisor(), 1);
        assert_eq!(pipeline.cadence.over_since, None);
        assert_eq!(control.take_report().size_steps_down, 1);
        // On the lowest rung (540p) the cadence steps as usual.
        pipeline.ladder.rung = 2;
        pipeline.encoder.cap = RUNGS[2];
        assert!(pipeline.step(&sink, &control).unwrap());
        over_the_target(&mut pipeline);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(pipeline.cadence.divisor(), 2);
        assert_eq!(control.take_report().encoded_size, Some((960, 540)));
        // At 540p (and slowed) the rate the step up to 720p needs.
        assert_eq!(control.sustain_bitrate(), toward(HD[1]));
    }

    #[test]
    fn after_a_size_change_the_meter_and_the_cadence_start_afresh() {
        let encoder = Laddered::new(20_000);
        let mut pipeline = VideoPipeline::new(Frames(20), encoder);
        pipeline.set_degrade(crate::Degrade::Size);
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(64);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(pipeline.running, Some((1920, 1080)));
        // The old size's output and time over the target.
        over_the_target(&mut pipeline);
        let before = Instant::now();
        pipeline.cadence.met_since = Some(before - Duration::from_secs(10));
        pipeline.ladder.under_since = Some(before - Duration::from_secs(10));
        pipeline.encoder.set_size_cap(RUNGS[1]);
        // The next frame is the new size's key frame: none of it counts against the new size.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(pipeline.running, Some((1280, 720)));
        assert!(pipeline.meter.frames.is_empty() && pipeline.meter.since.is_none());
        assert_eq!((pipeline.cadence.over_since, pipeline.cadence.met_since), (None, None));
        // The ladder's time under the need counts from the change at the earliest.
        assert!(pipeline.ladder.under_since.is_none_or(|since| since >= before), "{:?}", pipeline.ladder.under_since);
        let report = control.take_report();
        assert_eq!(report.encoder_output_bps, None);
        assert_eq!(report.encoded_size, Some((1280, 720)));
        // The frame after it is asked for the target, as at a share's start.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(control.take_report().encoder_bitrate_bps, Some(1_000_000));
        assert_eq!(frames.try_iter().filter(|f| f.key).count(), 2);

        // With `rate` a new size (a window resized) leaves the loops as they are.
        let mut pipeline = VideoPipeline::new(Frames(20), Laddered::new(20_000));
        let (sink, _frames, _) = frame_channel(64);
        assert!(pipeline.step(&sink, &control).unwrap());
        over_the_target(&mut pipeline);
        pipeline.encoder.set_size_cap(RUNGS[1]);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert!(!pipeline.meter.frames.is_empty());
        assert!(pipeline.cadence.over_since.is_none(), "it stepped, as today");
        assert_eq!(pipeline.cadence.divisor(), 2);
    }

    /// Every line logged on this thread while `run` runs, at `info` and above.
    fn logged(run: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Lines(Arc<Mutex<Vec<u8>>>);
        impl std::io::Write for Lines {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(bytes);
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let lines = Lines::default();
        let writer = lines.clone();
        let subscriber = tracing_subscriber::fmt().with_writer(move || writer.clone()).with_max_level(tracing::Level::INFO).finish();
        tracing::subscriber::with_default(subscriber, run);
        String::from_utf8(lines.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn the_key_frame_of_an_encoder_opened_again_is_not_warned_of_and_any_other_unasked_one_is() {
        // The reopening's own key frame is logged at info, not warned of.
        let mut pipeline = VideoPipeline::new(Frames(20), Laddered::new(20_000));
        pipeline.set_degrade(crate::Degrade::Size);
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(64);
        let warned = |log: &str| log.lines().filter(|line| line.contains("WARN") && line.contains("key frame that was not asked for")).count();
        let log = logged(|| {
            // The share's first frame, asked as a key frame.
            assert!(pipeline.step(&sink, &control).unwrap());
            // A size step: the encoder opened again starts with its own key frame.
            pipeline.encoder.set_size_cap(RUNGS[1]);
            assert!(pipeline.step(&sink, &control).unwrap());
            assert_eq!(pipeline.running, Some((1280, 720)));
        });
        assert_eq!(warned(&log), 0, "{log}");
        assert_eq!(log.lines().filter(|line| line.contains("INFO") && line.contains("key frame of the encoder opened again at the new size")).count(), 1, "{log}");
        // Any other key frame nobody asked for, at the running size, is still warned of.
        let log = logged(|| {
            pipeline.encoder.key_next = true;
            assert!(pipeline.step(&sink, &control).unwrap());
        });
        assert_eq!(warned(&log), 1, "{log}");
        assert_eq!(frames.try_iter().filter(|f| f.key).count(), 3);
    }

    #[test]
    fn producer_end_ends_the_source() {
        let mut pipeline = VideoPipeline::new(Frames(1), Calls::default());
        let control = SourceControl::default();
        let (sink, _frames, _) = frame_channel(4);
        pipeline.run(sink, &control);
        assert!(control.failure().is_none());
    }

    /// Frames at scripted times (ms after `start`, with their widths), each stamped `stamp_ms`
    /// after (+) or before (-) its arrival, as a capture's compositor clock does.
    struct Timed {
        start: Instant,
        at_ms: VecDeque<(u64, u32)>,
        stamp_ms: i64,
    }
    impl FrameProducer for Timed {
        type Frame = TestFrame;
        fn next_frame(&mut self, _control: &SourceControl, until: Instant) -> Result<Produced<TestFrame>, Error> {
            if let Some(&(at, width)) = self.at_ms.front() {
                let due = self.start + Duration::from_millis(at);
                if due <= until {
                    std::thread::sleep(due.saturating_duration_since(Instant::now()));
                    self.at_ms.pop_front();
                    let now = Instant::now();
                    let stamp = Duration::from_millis(self.stamp_ms.unsigned_abs());
                    let capture_time = if self.stamp_ms >= 0 { now + stamp } else { now - stamp };
                    return Ok(Produced::Frame(TestFrame { width, height: 16, capture_time }));
                }
            }
            std::thread::sleep(until.saturating_duration_since(Instant::now()));
            Ok(Produced::Idle)
        }

        fn interval(&self) -> Duration {
            Duration::from_millis(16)
        }

        fn captures(&self) -> bool {
            true
        }
    }

    /// (capture time in ms after `start`, rounded to 0.01, key) of each frame sent.
    fn sent_times(start: Instant, frames: &std::sync::mpsc::Receiver<EncodedFrame>) -> Vec<(f64, bool)> {
        frames
            .try_iter()
            .map(|f| {
                let ms = if f.capture_time >= start {
                    f.capture_time.duration_since(start).as_secs_f64() * 1000.0
                } else {
                    -(start.duration_since(f.capture_time).as_secs_f64() * 1000.0)
                };
                ((ms * 100.0).round() / 100.0, f.key)
            })
            .collect()
    }

    /// Each capture time at least `SENT_STEP` after the one before (to the rounding).
    fn assert_forward(times: &[(f64, bool)]) {
        assert!(times.windows(2).all(|w| w[1].0 - w[0].0 >= 0.98), "a capture time went back: {times:?}");
    }

    #[test]
    fn future_stamps_and_a_resize_on_idle_never_send_a_capture_time_that_goes_back() {
        // The Windows case: stamps 12 ms ahead of the arrival. A window resized at
        // 990 ms, its last frame at 1284 ms, then still: the new size is due at 1290 ms and is
        // taken up from the kept frame on an idle turn stamped `now`, before 1284 + 12 ms.
        let start = Instant::now();
        let producer = Timed { start, at_ms: VecDeque::from(vec![(0, 1000), (990, 1100), (1284, 1100)]), stamp_ms: 12 };
        let mut pipeline = VideoPipeline::new(producer, Resizing::default());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(64);
        while start.elapsed() < Duration::from_millis(1400) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        let times = sent_times(start, &frames);
        // The three frames and the new size's key frame from the kept one.
        assert_eq!(times.len(), 4, "{times:?}");
        assert!(times[3].1, "{times:?}");
        assert_forward(&times);
        // No interval of 0 in the statistics either.
        let report = control.take_report();
        assert_eq!(report.frame_interval_ms.len(), 3);
        assert!(report.frame_interval_ms.iter().all(|&ms| ms >= 0.999), "{:?}", report.frame_interval_ms);
    }

    #[test]
    fn past_stamps_and_a_skipped_frame_on_idle_never_send_a_capture_time_that_goes_back() {
        // The Linux case: stamps 4 ms before the arrival, one frame in two kept.
        // The third frame is 4 ms late, so the skipped second one is encoded on idle at `now`
        // just before it comes, after the third's compositor time.
        let start = Instant::now();
        let producer = Timed { start, at_ms: VecDeque::from(vec![(0, 16), (16, 16), (34, 16)]), stamp_ms: -4 };
        let mut pipeline = VideoPipeline::new(producer, Calls::default());
        pipeline.cadence.index = 1;
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(64);
        while start.elapsed() < Duration::from_millis(80) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        let times = sent_times(start, &frames);
        assert_eq!(times.len(), 3, "{times:?}");
        assert_forward(&times);
    }

    #[test]
    fn a_key_frame_nobody_asked_for_restarts_the_spacing() {
        // The encoder opens again for a new size on idle at about 1000 ms
        // and makes a key frame nobody asked the pipeline for. A viewer's PLI comes 90 ms later:
        // it waits for the 500 ms after that key frame, so no key frame follows at once.
        let start = Instant::now();
        let at_ms = VecDeque::from(vec![(0, 1000), (100, 1100), (1100, 1100), (1116, 1100), (1132, 1100)]);
        let producer = Timed { start, at_ms, stamp_ms: 0 };
        let mut pipeline = VideoPipeline::new(producer, Resizing::default());
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, frames, _) = frame_channel(64);
        while start.elapsed() < Duration::from_millis(1090) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        control.want_key_frame();
        while start.elapsed() < Duration::from_millis(1200) {
            assert!(pipeline.step(&sink, &control).unwrap());
        }
        let times = sent_times(start, &frames);
        let keys: Vec<f64> = times.iter().filter(|(_, key)| *key).map(|(ms, _)| *ms).collect();
        assert_eq!(keys.len(), 2, "key frames at {keys:?} of {times:?}");
        assert!(keys[1] >= 990.0 && keys[1] < 1090.0, "the reopening's key frame at {keys:?}");
        // The last turn waited for the spacing's end, where the request was decided: 500 ms
        // after the reopening's key frame (this encoder has no kept frame, so nothing was sent).
        assert!(!pipeline.keys.pending());
        let decided = pipeline.keys.last.unwrap().duration_since(start).as_secs_f64() * 1000.0;
        assert!(decided >= keys[1] + 499.0, "decided at {decided} ms, a key frame at {} ms", keys[1]);
    }

    #[test]
    fn a_key_frame_the_encoder_made_meets_a_pending_request() {
        // A request pending inside the spacing is met by a key frame made meanwhile.
        let t = Instant::now();
        let mut keys = KeyFrames::default();
        assert_eq!(keys.decide(t), (true, false));
        keys.request();
        assert_eq!(keys.decide(t + Duration::from_millis(200)), (false, false));
        keys.made(t + Duration::from_millis(300));
        assert!(!keys.pending());
        assert_eq!(keys.next_allowed(), Some(t + Duration::from_millis(800)));
        assert_eq!(keys.decide(t + Duration::from_millis(900)), (false, false));
    }

    #[test]
    fn the_ladder_steps_up_to_a_size_under_the_maximum_and_never_to_one_over_it() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        // A maximum of 4 Mbps, between what 1080p60 needs (3.73)
        // and 1.25 times that (4.67). The target is never above the maximum.
        let max = 4_000_000u64;
        let mut l = SizeLadder { on: true, max: Some(max), ..SizeLadder::default() };
        let mut now = 0u64;
        let mut run = |l: &mut SizeLadder, frames: u64, target: u64| {
            let mut changed = None;
            for _ in 0..frames {
                if let Some(rung) = l.update(ms(now), &HD, 60.0, FLOOR_H264, target, Some(target.min(1_700_000)), 1.0, 1) {
                    changed = Some(rung);
                }
                now += 16;
            }
            changed
        };
        assert_eq!(run(&mut l, 300, max), None);
        // One dip to 3.5 Mbps for 2.2 s: down to 720p, which pads toward the maximum.
        assert_eq!(run(&mut l, 140, 3_500_000), Some(1));
        assert_eq!(l.sustain(&HD, 60.0, FLOOR_H264), max);
        // Back at the maximum: 5 s of room after the spacing, and back at 1080p.
        assert_eq!(run(&mut l, 600, max), Some(0));
        assert_eq!((l.rung, l.steps_up), (0, 1));
        assert_eq!(l.sustain(&HD, 60.0, FLOOR_H264), 0);

        // A maximum under what 1080p needs: 720p is never left, and nothing is padded for.
        let max = 3_500_000u64;
        let mut l = SizeLadder { on: true, rung: 1, max: Some(max), ..SizeLadder::default() };
        assert_eq!(l.sustain(&HD, 60.0, FLOOR_H264), 0);
        assert_eq!(run(&mut l, 600_000 / 16, max), None);
        assert_eq!(l.rung, 1);
        // From 540p it still steps up to 720p: 1.25 times 720p's 1.66 Mbps is under it.
        let mut l = SizeLadder { on: true, rung: 2, max: Some(max), ..SizeLadder::default() };
        assert_eq!(l.sustain(&HD, 60.0, FLOOR_H264), 2_073_600);
        assert_eq!(run(&mut l, 400, max), Some(1));
    }

    #[test]
    fn a_still_picture_sustains_nothing_until_the_next_frame() {
        // Script's frames are 5 ms apart, so the ladder works at 200 frames a second.
        let script = [true, true, false, false, true];
        let mut pipeline = VideoPipeline::new(Script(VecDeque::from(script.to_vec())), Laddered::new(100_000));
        pipeline.set_degrade(crate::Degrade::Size);
        let control = SourceControl::default();
        control.set_target_bitrate(1_000_000);
        let (sink, _frames, _) = frame_channel(64);
        let fps = 1.0 / Duration::from_millis(5).as_secs_f64();
        let toward = (ROOM_OVER * needed(HD[0], fps, FLOOR_H264)).round() as u64;
        assert!(pipeline.step(&sink, &control).unwrap());
        // Down to 720p: the step up's rate is sustained.
        over_the_target(&mut pipeline);
        pipeline.ladder.over_since = Some(Instant::now() - Duration::from_secs(2));
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(pipeline.ladder.rung, 1);
        assert_eq!(control.sustain_bitrate(), toward);
        // An idle turn within a second of the last frame leaves it.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(control.sustain_bitrate(), toward);
        // A second without an encoded frame: nothing sustained.
        pipeline.last_encoded = Some(Instant::now() - SUSTAIN_IDLE);
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(control.sustain_bitrate(), 0);
        // The next encoded frame's ladder turn brings it back.
        assert!(pipeline.step(&sink, &control).unwrap());
        assert_eq!(control.sustain_bitrate(), toward);
    }

    #[test]
    fn the_sustain_rate_is_handed_on_when_the_rung_changes_or_it_moves_over_5_percent() {
        let mut pipeline = VideoPipeline::new(Frames(0), Calls::default());
        let control = SourceControl::default();
        // Nothing on the top rung: nothing handed on.
        pipeline.sustain(&control, 0, 0);
        assert_eq!(pipeline.sustained, (0, 0));
        pipeline.sustain(&control, 1, 1_000_000);
        assert_eq!(control.sustain_bitrate(), 1_000_000);
        // A window dragged: 4 % is not handed on, 6 % is, measured from what was.
        pipeline.sustain(&control, 1, 1_040_000);
        assert_eq!(control.sustain_bitrate(), 1_000_000);
        pipeline.sustain(&control, 1, 960_000);
        assert_eq!(control.sustain_bitrate(), 1_000_000);
        pipeline.sustain(&control, 1, 1_060_000);
        assert_eq!(control.sustain_bitrate(), 1_060_000);
        pipeline.sustain(&control, 1, 1_100_000);
        assert_eq!(control.sustain_bitrate(), 1_060_000);
        // A new rung is handed on whatever the rate.
        pipeline.sustain(&control, 2, 1_070_000);
        assert_eq!(control.sustain_bitrate(), 1_070_000);
        // To 0 and back.
        pipeline.sustain(&control, 2, 0);
        assert_eq!(control.sustain_bitrate(), 0);
        pipeline.sustain(&control, 2, 1_070_000);
        assert_eq!(control.sustain_bitrate(), 1_070_000);
    }
}
