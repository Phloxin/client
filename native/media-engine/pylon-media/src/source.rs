// The seam that capture and encode plug into: a source runs on a thread of its own and pushes
// encoded frames into a sink the engine gives it.

use std::{
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{Receiver, SyncSender, TrySendError, sync_channel},
    },
    time::{Duration, Instant},
};

use crate::{Error, VideoCodec, av1, h264};

/// One H264 access unit in Annex-B, or one AV1 temporal unit (OBUs with their size fields).
#[derive(Clone, Debug)]
pub struct EncodedFrame {
    pub data: Vec<u8>,
    pub key: bool,
    pub capture_time: Instant,
}

/// Something that produces encoded frames on its own thread.
pub trait Source: Send {
    /// Runs until `control.stopped()` or until the sink is closed.
    fn run(&mut self, sink: FrameSink, control: &SourceControl);
    /// Gives the source the sharer's preview to make pictures for, before it runs. False for a
    /// source that has no picture (the file and synthetic sources, R6).
    fn attach_preview(&mut self, _preview: Arc<crate::video::Preview>) -> bool {
        false
    }
}

/// What a source that encodes reports for the engine's statistics.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SourceReport {
    /// Frames not encoded because the send queue was too deep, in all.
    pub frames_skipped_backlog: u64,
    /// Frames not encoded because the frame rate gave way (one in N kept), in all.
    pub frames_skipped_rate: u64,
    /// N of that, now.
    pub frame_rate_divisor: Option<u32>,
    /// The bitrate the encoder is configured for now.
    pub encoder_bitrate_bps: Option<u64>,
    /// What the encoder produced over the last second.
    pub encoder_output_bps: Option<u64>,
    /// Key frames made because one was asked for, in all.
    pub key_frames_forced: u64,
    /// Encode time of each frame since the statistics last took them.
    pub encode_ms: Vec<f64>,
    /// Key frames made from the kept frame because nothing new came, in all.
    pub key_frames_repeated: u64,
    /// From a capture's frame arriving to the encoder taking it, each frame since the
    /// statistics last took them.
    pub capture_delay_ms: Vec<f64>,
    /// A screen capture's own counters.
    pub capture: Option<CaptureReport>,
}

/// What a screen capture counts, in all.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CaptureReport {
    /// Frames the compositor delivered.
    pub frames_delivered: u64,
    /// Frames handed to the encoder.
    pub frames_taken: u64,
    /// Frames a newer one replaced before they were taken.
    pub frames_dropped_rate: u64,
    /// `dmabuf` or `memory`.
    pub buffer_path: &'static str,
}

/// What the engine tells a running source, and what the source tells it back.
#[derive(Debug, Default)]
pub struct SourceControl {
    target_bps: AtomicU64,
    key_frame_wanted: AtomicBool,
    stop: AtomicBool,
    queued_bytes: AtomicU64,
    report: Mutex<SourceReport>,
    failed: AtomicBool,
    failure: Mutex<Option<String>>,
}

impl SourceControl {
    /// The bitrate to encode at, in bits per second.
    pub fn target_bitrate(&self) -> u64 {
        self.target_bps.load(Ordering::Relaxed)
    }

    /// True once after a key frame was asked for.
    pub fn take_key_frame_wanted(&self) -> bool {
        self.key_frame_wanted.swap(false, Ordering::Relaxed)
    }

    pub fn stopped(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    /// Bytes waiting in the transport's send queue (media, resends, padding), as last sampled.
    pub fn queued_bytes(&self) -> u64 {
        self.queued_bytes.load(Ordering::Relaxed)
    }

    /// Changes what the source reports.
    pub fn update_report(&self, change: impl FnOnce(&mut SourceReport)) {
        if let Ok(mut report) = self.report.lock() {
            change(&mut report);
        }
    }

    /// The source cannot go on. The engine reports `message` as fatal and stops.
    pub fn fail(&self, message: impl Into<String>) {
        if let Ok(mut failure) = self.failure.lock() {
            failure.get_or_insert(message.into());
        }
        self.failed.store(true, Ordering::Relaxed);
    }

    pub(crate) fn failure(&self) -> Option<String> {
        if !self.failed.load(Ordering::Relaxed) {
            return None;
        }
        self.failure.lock().ok().and_then(|f| f.clone())
    }

    /// The report, with the encode times taken out.
    pub(crate) fn take_report(&self) -> SourceReport {
        match self.report.lock() {
            Ok(mut report) => {
                let taken = report.clone();
                report.encode_ms.clear();
                report.capture_delay_ms.clear();
                taken
            }
            Err(_) => SourceReport::default(),
        }
    }

    pub(crate) fn set_queued_bytes(&self, bytes: u64) {
        self.queued_bytes.store(bytes, Ordering::Relaxed);
    }

    pub(crate) fn set_target_bitrate(&self, bps: u64) {
        self.target_bps.store(bps, Ordering::Relaxed);
    }

    pub(crate) fn want_key_frame(&self) {
        self.key_frame_wanted.store(true, Ordering::Relaxed);
    }

    pub(crate) fn stop(&self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Why a push failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PushError {
    /// The engine is behind. The frame was dropped and counted.
    Full,
    /// The engine has stopped.
    Closed,
}

/// Where a source puts its frames.
pub struct FrameSink {
    frames: SyncSender<EncodedFrame>,
    dropped: Arc<AtomicU64>,
}

impl FrameSink {
    /// Hands a frame to the engine without blocking.
    pub fn push(&self, frame: EncodedFrame) -> Result<(), PushError> {
        match self.frames.try_send(frame) {
            Ok(()) => Ok(()),
            Err(TrySendError::Full(_)) => {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                Err(PushError::Full)
            }
            Err(TrySendError::Disconnected(_)) => Err(PushError::Closed),
        }
    }
}

/// A sink and the engine's end of it. `capacity` frames fit before pushes fail.
pub(crate) fn frame_channel(capacity: usize) -> (FrameSink, Receiver<EncodedFrame>, Arc<AtomicU64>) {
    let (frames, receiver) = sync_channel(capacity);
    let dropped = Arc::new(AtomicU64::new(0));
    (
        FrameSink {
            frames,
            dropped: dropped.clone(),
        },
        receiver,
        dropped,
    )
}

/// The capture time of frame `n` at `fps`, counted from `start` without drift.
pub(crate) fn frame_time(start: Instant, n: u64, fps: u32) -> Instant {
    start + Duration::from_nanos((n as u128 * 1_000_000_000 / fps as u128) as u64)
}

/// Sleeps until `at` in short steps. False if the source was stopped meanwhile.
pub(crate) fn wait_until(at: Instant, control: &SourceControl) -> bool {
    loop {
        if control.stopped() {
            return false;
        }
        let now = Instant::now();
        if now >= at {
            return true;
        }
        std::thread::sleep((at - now).min(Duration::from_millis(10)));
    }
}

pub(crate) fn check_fps(fps: u32) -> Result<(), Error> {
    if !(1..=240).contains(&fps) {
        return Err(Error::invalid(format!("fps {fps} is not in 1 to 240")));
    }
    Ok(())
}

/// An Annex-B H264 file, one access unit per frame interval, looping. Or with AV1 an IVF file,
/// one temporal unit per frame interval (Q9).
pub struct FileSource {
    units: Vec<Vec<u8>>,
    keys: Vec<bool>,
    fps: u32,
}

impl FileSource {
    pub fn open(path: impl AsRef<Path>, fps: u32) -> Result<Self, Error> {
        let path = path.as_ref();
        let stream = std::fs::read(path).map_err(|e| Error::io(&path.display().to_string(), e))?;
        Self::from_annex_b(&stream, fps)
    }

    /// A file of the session's codec: Annex-B for H264, IVF for AV1.
    pub fn open_for(path: impl AsRef<Path>, fps: u32, codec: VideoCodec) -> Result<Self, Error> {
        match codec {
            VideoCodec::H264 => Self::open(path, fps),
            VideoCodec::Av1 => {
                let path = path.as_ref();
                let file = std::fs::read(path).map_err(|e| Error::io(&path.display().to_string(), e))?;
                Self::from_ivf(&file, fps)
            }
        }
    }

    /// An IVF file of AV1. A key frame is a temporal unit with a sequence header.
    pub fn from_ivf(file: &[u8], fps: u32) -> Result<Self, Error> {
        check_fps(fps)?;
        let units: Vec<Vec<u8>> = av1::ivf_frames(file)?.into_iter().map(<[u8]>::to_vec).collect();
        if units.is_empty() {
            return Err(Error::invalid("no AV1 temporal units in the file"));
        }
        if let Some(index) = units.iter().position(|unit| av1::obus(unit).is_err()) {
            return Err(Error::invalid(format!("frame {index} of the file is not AV1 OBUs")));
        }
        let keys: Vec<bool> = units.iter().map(|u| av1::has_sequence_header(u)).collect();
        tracing::info!(
            temporal_units = units.len(),
            key_frames = keys.iter().filter(|k| **k).count(),
            bytes = units.iter().map(Vec::len).sum::<usize>(),
            fps,
            "file source (AV1)"
        );
        Ok(FileSource { units, keys, fps })
    }

    pub fn from_annex_b(stream: &[u8], fps: u32) -> Result<Self, Error> {
        check_fps(fps)?;
        let units: Vec<Vec<u8>> = h264::access_units(stream).into_iter().map(<[u8]>::to_vec).collect();
        if units.is_empty() {
            return Err(Error::invalid("no H264 access units in the file"));
        }
        let keys: Vec<bool> = units
            .iter()
            .map(|u| h264::nal_units(u).iter().any(|n| h264::nal_type(n) == 5))
            .collect();
        tracing::info!(
            access_units = units.len(),
            key_frames = keys.iter().filter(|k| **k).count(),
            bytes = units.iter().map(Vec::len).sum::<usize>(),
            fps,
            "file source"
        );
        Ok(FileSource { units, keys, fps })
    }
}

impl Source for FileSource {
    // The target bitrate and key frame requests are ignored, the file is what it is.
    fn run(&mut self, sink: FrameSink, control: &SourceControl) {
        let start = Instant::now();
        for n in 0u64.. {
            let at = frame_time(start, n, self.fps);
            if !wait_until(at, control) {
                return;
            }
            let index = (n % self.units.len() as u64) as usize;
            let frame = EncodedFrame {
                data: self.units[index].clone(),
                key: self.keys[index],
                capture_time: at,
            };
            if sink.push(frame) == Err(PushError::Closed) {
                return;
            }
        }
    }
}

/// Made-up H264 for transport tests, sized to follow the target bitrate. Never encrypted.
pub struct SyntheticSource {
    fps: u32,
    fill: u32,
}

impl SyntheticSource {
    pub fn new(fps: u32) -> Result<Self, Error> {
        check_fps(fps)?;
        Ok(SyntheticSource { fps, fill: 0x9e37_79b9 })
    }

    /// One access unit: SPS, PPS and an IDR slice for a key frame, a single slice otherwise.
    fn frame(&mut self, key: bool, bytes: usize) -> Vec<u8> {
        const START: [u8; 4] = [0, 0, 0, 1];
        const SPS: [u8; 10] = [0x67, 0x42, 0x00, 0x34, 0x95, 0xa8, 0x14, 0x01, 0x6e, 0x40];
        const PPS: [u8; 4] = [0x68, 0xce, 0x3c, 0x80];
        // At least two full packets a frame, as probe 1's source sent.
        let slice = bytes.max(2 * h264::PAYLOAD_LIMIT);

        let mut data = Vec::with_capacity(slice + 32);
        if key {
            for nal in [&SPS[..], &PPS[..]] {
                data.extend_from_slice(&START);
                data.extend_from_slice(nal);
            }
        }
        data.extend_from_slice(&START);
        data.push(if key { 0x65 } else { 0x41 });
        for _ in 1..slice {
            self.fill ^= self.fill << 13;
            self.fill ^= self.fill >> 17;
            self.fill ^= self.fill << 5;
            // No zero bytes, so no start code can appear inside the slice.
            data.push((self.fill as u8).max(1));
        }
        data
    }
}

impl Source for SyntheticSource {
    fn run(&mut self, sink: FrameSink, control: &SourceControl) {
        let start = Instant::now();
        let mut first = true;
        for n in 0u64.. {
            let at = frame_time(start, n, self.fps);
            if !wait_until(at, control) {
                return;
            }
            let key = std::mem::take(&mut first) | control.take_key_frame_wanted();
            let bytes = (control.target_bitrate() / 8 / self.fps as u64) as usize * if key { 4 } else { 1 };
            let frame = EncodedFrame {
                data: self.frame(key, bytes),
                key,
                capture_time: at,
            };
            if sink.push(frame) == Err(PushError::Closed) {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn synthetic_frames_packetize() {
        let mut source = SyntheticSource::new(30).unwrap();
        let key = source.frame(true, 20_000);
        let nals = h264::nal_units(&key);
        assert_eq!(nals.iter().map(|n| h264::nal_type(n)).collect::<Vec<_>>(), vec![7, 8, 5]);
        assert_eq!(nals[2].len(), 20_000);
        let packets = h264::packetize(&key, h264::PAYLOAD_LIMIT);
        assert_eq!(h264::packet_kind(&packets[0]), "STAP-A");
        assert!(packets[1..].iter().all(|p| h264::packet_kind(p) == "FU-A"));

        let delta = source.frame(false, 10);
        let nals = h264::nal_units(&delta);
        assert_eq!(nals.len(), 1);
        assert_eq!(h264::nal_type(nals[0]), 1);
        assert_eq!(nals[0].len(), 2 * h264::PAYLOAD_LIMIT);
    }

    #[test]
    fn full_sink_counts_drops() {
        let (sink, receiver, dropped) = frame_channel(1);
        let frame = EncodedFrame { data: vec![], key: false, capture_time: Instant::now() };
        assert_eq!(sink.push(frame.clone()), Ok(()));
        assert_eq!(sink.push(frame.clone()), Err(PushError::Full));
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        drop(receiver);
        assert_eq!(sink.push(frame), Err(PushError::Closed));
    }

    #[test]
    fn frame_times_do_not_drift() {
        let start = Instant::now();
        assert_eq!(frame_time(start, 30, 30) - start, Duration::from_secs(1));
        assert_eq!(frame_time(start, 3, 30) - start, Duration::from_nanos(100_000_000));
    }

    #[test]
    fn file_source_needs_access_units() {
        assert!(FileSource::from_annex_b(&[1, 2, 3], 30).is_err());
        assert!(FileSource::from_annex_b(&[0, 0, 1, 0x65, 1], 0).is_err());
        let source = FileSource::from_annex_b(&[0, 0, 1, 0x67, 1, 0, 0, 1, 0x65, 1, 0, 0, 1, 0x41, 2], 30).unwrap();
        assert_eq!(source.keys, vec![true, false]);
        assert!(FileSource::open("/nonexistent/file.h264", 30).is_err());
    }

    #[test]
    fn file_source_reads_ivf_for_av1() {
        // DKIF, version 0, header 32, AV01, 16x16, 30/1, 2 frames, then the frames.
        let mut file = b"DKIF\0\0\x20\0AV01\x10\0\x10\0\x1e\0\0\0\x01\0\0\0\x02\0\0\0\0\0\0\0".to_vec();
        // TD SEQ(2 bytes) FRAME(3 bytes), then TD FRAME(1 byte).
        let key = [0x12, 0x00, 0x0a, 0x02, 1, 2, 0x32, 0x03, 7, 8, 9];
        let delta = [0x12, 0x00, 0x32, 0x01, 5];
        for (pts, frame) in [&key[..], &delta[..]].into_iter().enumerate() {
            file.extend((frame.len() as u32).to_le_bytes());
            file.extend((pts as u64).to_le_bytes());
            file.extend_from_slice(frame);
        }
        let source = FileSource::from_ivf(&file, 30).unwrap();
        assert_eq!(source.keys, vec![true, false]);
        assert_eq!(source.units, vec![key.to_vec(), delta.to_vec()]);
        assert!(FileSource::from_ivf(&file, 0).is_err());
        // An Annex-B file is no IVF, an IVF no Annex-B.
        assert!(FileSource::from_ivf(&[0, 0, 1, 0x65, 1], 30).is_err());
        assert!(FileSource::from_annex_b(&file, 30).is_err());
        // A frame that is not OBUs.
        let mut bad = file.clone();
        let at = bad.len() - delta.len();
        bad[at] = 0x80;
        assert!(FileSource::from_ivf(&bad, 30).is_err());
        assert!(FileSource::open_for("/nonexistent/file.ivf", 30, VideoCodec::Av1).is_err());
    }
}
