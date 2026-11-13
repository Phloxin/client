// The capture producer's rate limit (.plans/native-media-engine-m5b-capture.md, D5), on any
// system.

use std::time::Instant;

/// Tokens of the rate limit: up to this many frames may go at once after a quiet spell.
const TOKENS: f64 = 1.5;

/// A token bucket that fills at `fps`.
#[derive(Debug)]
pub(crate) struct TokenBucket {
    pub(crate) fps: f64,
    pub(crate) tokens: f64,
    refilled: Option<Instant>,
}

impl TokenBucket {
    pub(crate) fn new(fps: u32) -> TokenBucket {
        TokenBucket {
            fps: fps as f64,
            tokens: TOKENS,
            refilled: None,
        }
    }

    pub(crate) fn refill(&mut self, now: Instant) {
        if let Some(at) = self.refilled {
            self.tokens = (self.tokens + now.saturating_duration_since(at).as_secs_f64() * self.fps).min(TOKENS);
        }
        self.refilled = Some(now);
    }
}
