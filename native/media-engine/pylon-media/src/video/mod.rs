// The video pipeline (.plans/native-media-engine-m5a-encoder.md, D3 to D11): a producer hands
// raw frames over (DMA-BUFs on Linux, D3D11 textures on Windows), the encoder turns them into
// H264, and the loops in between follow the target bitrate, key frame requests and the depth of
// the send queue.
//
// The portable parts are here and compile on any system with no features
// (.plans/native-media-engine-m7-2-seams.md). What is Linux's is in `linux/`, what is Windows'
// in `windows/` (.plans/native-media-engine-m7-4-windows-encoder.md).

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
// The preview's JPEG encoder, shared by the Linux and Windows makers (M6 preview step 3, W5).
#[cfg(all(any(target_os = "linux", target_os = "windows"), feature = "encode"))]
mod jpeg;
#[cfg(all(target_os = "linux", feature = "encode"))]
mod linux;
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod pattern;
// The worker and its slot are used by the Linux and Windows encoders, elsewhere by their tests.
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod preview;
// The Windows preview's CPU half (M6 preview step 3, W2, W4, W5): portable, tested everywhere,
// used by the Windows encoder only.
#[cfg_attr(not(all(target_os = "windows", feature = "encode")), allow(dead_code))]
mod preview_cpu;
// Used by the Linux and Windows encoders (on Windows with fixed limits, M7.5 C8).
#[cfg_attr(not(all(any(target_os = "linux", target_os = "windows"), feature = "encode")), allow(dead_code))]
mod sizing;
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

/// Whether this build on this machine encodes AV1 (AV1 step 2, Q2): only Linux with `encode`.
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
    /// Whether the frames are captured, so their delay to the encoder is measured (D9).
    fn captures(&self) -> bool {
        false
    }
    /// Whether the frame last handed over shows the same picture as the one before it (the still
    /// pattern), so the preview does not take it as new (R3).
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
    /// Pads constant-bitrate output with filler data. Off in the pipeline (D7), on only to
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
    /// is none (M5b D6).
    fn encode_kept(&mut self, _bitrate: u64, _divisor: u32, _key: bool) -> Result<Option<Packet>, Error> {
        Ok(None)
    }
    /// When a new size the encoder was asked for will be taken up if nothing newer comes (D14),
    /// `None` when there is none.
    fn resize_due(&self) -> Option<Instant> {
        None
    }
    /// Offers `preview` the last converted frame (R2: a reference to it, never waiting), starting
    /// the preview's worker on first use. False when there is none, or when this encoder makes no
    /// preview.
    fn offer_preview(&mut self, _preview: &Arc<Preview>) -> bool {
        false
    }
}

/// Above this much of the target bitrate waiting in the send queue, frames are skipped (D10).
const BACKLOG_LIMIT: Duration = Duration::from_millis(200);
/// Key frames are at least this far apart (D9).
const KEY_FRAME_SPACING: Duration = Duration::from_millis(500);
/// The output is measured over this long (D8).
const OUTPUT_WINDOW: Duration = Duration::from_secs(1);
/// The lowest share of the target the encoder is asked for (D8).
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
}

/// The encoder's output over the last second, and what it was asked for meanwhile (D8).
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

/// The frame rate divisors the pipeline steps through (D23): one frame in N is encoded.
const DIVISORS: [u32; 6] = [1, 2, 3, 4, 6, 10];
/// N steps up after the output has been this far over the target for `STEP_UP_AFTER`, with the
/// scale of D8 at its floor.
const OVER_SHARE: f64 = 1.15;
const STEP_UP_AFTER: Duration = Duration::from_secs(1);
/// N steps down after the output has met the target for `STEP_DOWN_AFTER` with the scale above
/// `ROOM_SHARE`.
const ROOM_SHARE: f64 = 0.85;
const STEP_DOWN_AFTER: Duration = Duration::from_secs(3);

/// Gives way on frame rate, evenly, when the encoder cannot get down to the target (D23).
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
    /// encoder runs at (configured bitrate over target).
    fn update(&mut self, now: Instant, output: Option<u64>, target: u64, scale: f64) {
        let Some(output) = output else {
            return;
        };
        let target = target as f64;
        let floor = scale <= LOWEST_SHARE + 1e-6;
        if (output as f64) > target * OVER_SHARE && floor {
            self.met_since = None;
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
}

/// A key frame is made from the kept frame when no new frame came for this many intervals
/// (M5b D6).
const KEPT_AFTER_INTERVALS: u32 = 2;
/// The shortest wait for the producer, so that nothing spins while it waits for a deadline.
const MIN_WAIT: Duration = Duration::from_millis(5);

/// A `Source` made of a frame producer and an encoder.
///
/// The order of the fields is the order they are dropped in, and it matters: the encoder goes
/// before the kept frame `last`. On Windows a capture frame keeps its frame pool open, and the
/// pool closing while the encoder is torn down on the same D3D11 device crashed the process
/// (.plans/native-media-engine-m7-5-windows-capture.md, section 5). Keep `encoder` above `last`.
pub struct VideoPipeline<P: FrameProducer, E: FrameEncoder<Frame = P::Frame>> {
    producer: P,
    encoder: E,
    keys: KeyFrames,
    meter: OutputMeter,
    cadence: Cadence,
    /// When the producer last handed over a new frame.
    last_new: Option<Instant>,
    /// The newest frame from the producer, encoded again when nothing newer comes: if it was
    /// skipped, or once the encoder may take up a new size (D14).
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
        }
    }

    /// Takes up what the preview asks for, and offers it the kept frame for the first picture
    /// after a request (R3).
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
    /// picture and one is due (R2).
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
            // The kept frame is due once nothing new came and the spacing of D9 is over.
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
    /// `KEPT_AFTER_INTERVALS` (M5b D6).
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
            // Inside the spacing of D9: the request waits.
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
        let Some((packet, key)) = encode(&mut self.encoder, bitrate, divisor)? else {
            return Ok(true);
        };
        let encode_ms = began.elapsed().as_secs_f64() * 1000.0;
        let done = Instant::now();
        self.last_encoded = Some(done);
        self.meter.record(done, packet.data.len() as u64, bitrate);
        let output = self.meter.output_bps(done);
        let scale = if target > 0 { bitrate as f64 / target as f64 } else { 1.0 };
        self.cadence.update(done, output, target, scale);
        let divisor = self.cadence.divisor();
        control.update_report(|r| {
            r.encoder_bitrate_bps = Some(bitrate);
            r.encoder_output_bps = output;
            r.frame_rate_divisor = Some(divisor);
            r.key_frames_forced += u64::from(forced);
            r.key_frames_repeated += u64::from(kept);
            r.encode_ms.push(encode_ms);
        });
        if packet.key && !key {
            tracing::warn!(bytes = packet.data.len(), "key frame that was not asked for");
        }

        let frame = EncodedFrame {
            data: packet.data,
            key: packet.key,
            capture_time,
        };
        let pushed = sink.push(frame);
        if !kept {
            // Once the frame is on its way, so the preview never holds it up (R4).
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

    /// An encoder that takes up sizes by the rule of D14, recording (input width, width encoded
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
    fn producer_end_ends_the_source() {
        let mut pipeline = VideoPipeline::new(Frames(1), Calls::default());
        let control = SourceControl::default();
        let (sink, _frames, _) = frame_channel(4);
        pipeline.run(sink, &control);
        assert!(control.failure().is_none());
    }
}
