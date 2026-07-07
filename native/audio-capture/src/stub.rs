//! Test-tone backend: emits a 440Hz sine in the pipeline's wire format.
//! Exists to exercise the exact same threading + delivery path as the real
//! backends (dedicated capture thread → threadsafe function → JS).

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};

use crate::{CHANNELS, FRAME_MS, FRAME_SAMPLES_PER_CH, SAMPLE_RATE};

pub fn spawn(
  stop_flag: Arc<AtomicBool>,
  emit_frame: impl Fn(Vec<u8>) + Send + 'static,
) -> thread::JoinHandle<()> {
  thread::spawn(move || {
    const FREQ: f32 = 440.0;
    const GAIN: f32 = 0.2;
    let mut phase: f32 = 0.0;
    let phase_step = std::f32::consts::TAU * FREQ / SAMPLE_RATE as f32;

    // Pace against wall clock, not cumulative sleeps, so drift doesn't build up.
    let start = Instant::now();
    let mut frames_sent: u64 = 0;

    while !stop_flag.load(Ordering::SeqCst) {
      let mut bytes = Vec::with_capacity(FRAME_SAMPLES_PER_CH * CHANNELS * 4);
      for _ in 0..FRAME_SAMPLES_PER_CH {
        let sample = phase.sin() * GAIN;
        phase = (phase + phase_step) % std::f32::consts::TAU;
        for _ in 0..CHANNELS {
          bytes.extend_from_slice(&sample.to_le_bytes());
        }
      }
      emit_frame(bytes);
      frames_sent += 1;

      let next_due = start + Duration::from_millis(frames_sent * FRAME_MS as u64);
      if let Some(wait) = next_due.checked_duration_since(Instant::now()) {
        thread::sleep(wait);
      }
    }
  })
}
