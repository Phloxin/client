// The sizes an encoder puts out and when it takes up a new one (D14), on any system.

use std::time::{Duration, Instant};

/// The smallest and largest picture the driver encodes in H264, as FFmpeg checks them when it
/// opens `h264_vaapi`: the surface limits of an encode config, and the config's own maximum.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EncodeLimits {
    pub min: (u32, u32),
    pub max: (u32, u32),
}

/// The encoded size for an input of `width` by `height` under a limit: scaled down to fit,
/// keeping the shape, never up, even sides.
pub(crate) fn output_size(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    let even = |v: u32| (v & !1).max(2);
    if width <= max_width && height <= max_height {
        return (even(width), even(height));
    }
    let scale = (max_width as f64 / width as f64).min(max_height as f64 / height as f64);
    (even((width as f64 * scale).round() as u32), even((height as f64 * scale).round() as u32))
}

/// The size an input of `width` by `height` is encoded at: `output_size` under the smaller of
/// `max` and the driver's maximum, and never below the driver's minimum (a tiny window is
/// scaled up to it).
pub(crate) fn encoded_size(width: u32, height: u32, max: (u32, u32), limits: EncodeLimits) -> (u32, u32) {
    let max = (max.0.min(limits.max.0), max.1.min(limits.max.1));
    let (w, h) = output_size(width, height, max.0, max.1);
    let even_up = |v: u32| v + (v & 1);
    (w.max(even_up(limits.min.0)), h.max(even_up(limits.min.1)))
}

/// A new size must have been asked for this long before the encoder takes it up (D14).
const RESIZE_SETTLE: Duration = Duration::from_millis(300);
/// The encoder is opened again at most this often (D14).
const RESIZE_SPACING: Duration = Duration::from_secs(1);

/// When the encoder takes up a new output size (D14, in place of reopening on every change):
/// once the size asked for has stayed the same for `RESIZE_SETTLE`, and not sooner than
/// `RESIZE_SPACING` after the last opening.
#[derive(Debug, Default)]
pub(crate) struct Resizes {
    /// A size other than the running one, and since when it has been asked for unchanged.
    pub(super) wanted: Option<((u32, u32), Instant)>,
    pub(super) opened: Option<Instant>,
}

impl Resizes {
    /// The size to encode a frame at that asks for `size` at `now`, the encoder running at
    /// `running` (`None` when it is not open), and whether to open the encoder for it.
    pub(crate) fn decide(&mut self, now: Instant, size: (u32, u32), running: Option<(u32, u32)>) -> ((u32, u32), bool) {
        let Some(running) = running else {
            self.wanted = None;
            self.opened = Some(now);
            return (size, true);
        };
        if size == running {
            self.wanted = None;
            return (running, false);
        }
        let since = match self.wanted {
            Some((wanted, since)) if wanted == size => since,
            _ => {
                self.wanted = Some((size, now));
                now
            }
        };
        let settled = now.saturating_duration_since(since) >= RESIZE_SETTLE;
        let spaced = self.opened.is_none_or(|at| now.saturating_duration_since(at) >= RESIZE_SPACING);
        if settled && spaced {
            self.wanted = None;
            self.opened = Some(now);
            return (size, true);
        }
        (running, false)
    }

    /// When a size asked for and not yet taken up will be, if it stays the same.
    pub(crate) fn due(&self) -> Option<Instant> {
        let (_, since) = self.wanted?;
        let settled = since + RESIZE_SETTLE;
        Some(self.opened.map_or(settled, |at| settled.max(at + RESIZE_SPACING)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sizes_fit_and_never_grow() {
        assert_eq!(output_size(1920, 1080, 1920, 1080), (1920, 1080));
        assert_eq!(output_size(1280, 720, 1920, 1080), (1280, 720));
        assert_eq!(output_size(2560, 1440, 1920, 1080), (1920, 1080));
        assert_eq!(output_size(3440, 1440, 1920, 1080), (1920, 804));
        assert_eq!(output_size(1081, 607, 1920, 1080), (1080, 606));
    }

    #[test]
    fn resizes_wait_to_settle_and_are_spaced() {
        let t = Instant::now();
        let ms = |v: u64| t + Duration::from_millis(v);
        let mut r = Resizes::default();
        let (a, b, c) = ((1000, 900), (1100, 950), (1200, 1000));
        // The first frame opens at once.
        assert_eq!(r.decide(ms(0), a, None), (a, true));
        assert_eq!(r.decide(ms(16), a, Some(a)), (a, false));
        // A window being dragged: the size changes every 16 ms, frames stay at the running size.
        for (i, size) in [b, c, b, c].into_iter().enumerate() {
            assert_eq!(r.decide(ms(1100 + 16 * i as u64), size, Some(a)), (a, false));
        }
        // c from 1148 ms: not settled at 1447, settled at 1448, more than 1 s after the open.
        assert_eq!(r.decide(ms(1300), c, Some(a)), (a, false));
        assert_eq!(r.decide(ms(1447), c, Some(a)), (a, false));
        assert_eq!(r.decide(ms(1448), c, Some(a)), (c, true));
        // Settled again 300 ms later, but within the second after the last open: it waits.
        assert_eq!(r.decide(ms(1500), b, Some(c)), (c, false));
        assert_eq!(r.decide(ms(1800), b, Some(c)), (c, false));
        assert_eq!(r.decide(ms(2447), b, Some(c)), (c, false));
        assert_eq!(r.decide(ms(2448), b, Some(c)), (b, true));
        // Back to the running size before settling: nothing pending is left over.
        assert_eq!(r.decide(ms(4000), a, Some(b)), (b, false));
        assert_eq!(r.decide(ms(4100), b, Some(b)), (b, false));
        assert_eq!(r.decide(ms(4500), a, Some(b)), (b, false));
        assert_eq!(r.decide(ms(4799), a, Some(b)), (b, false));
        assert_eq!(r.decide(ms(4800), a, Some(b)), (a, true));
        // Not open again (an encoder dropped for an error): opens at once.
        assert_eq!(r.decide(ms(4810), c, None), (c, true));
    }

    #[test]
    fn encoded_sizes_stay_in_the_driver_limits() {
        let limits = EncodeLimits { min: (128, 128), max: (4096, 2304) };
        assert_eq!(encoded_size(1920, 1080, (1920, 1080), limits), (1920, 1080));
        // A tiny window is scaled up to the minimum.
        assert_eq!(encoded_size(16, 16, (1920, 1080), limits), (128, 128));
        assert_eq!(encoded_size(1, 1, (1920, 1080), limits), (128, 128));
        // A long thin one keeps its width, its height goes up to the minimum.
        assert_eq!(encoded_size(8192, 100, (1920, 1080), limits), (1920, 128));
        // An odd minimum is rounded up to even.
        assert_eq!(encoded_size(2, 2, (1920, 1080), EncodeLimits { min: (33, 17), max: (4096, 4096) }), (34, 18));
        // The driver's maximum caps what the host asked for.
        assert_eq!(encoded_size(4096, 4096, (4096, 4096), limits), (2304, 2304));
    }
}
