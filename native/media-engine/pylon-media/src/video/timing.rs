// A frame's capture time from the compositor's own clock.

use std::time::{Duration, Instant};

/// A compositor time this long before the arrival is still trusted.
const MAX_BEFORE: Duration = Duration::from_secs(1);
/// A compositor time this long after the arrival is still trusted (Windows gives the time
/// the frame is shown, a few milliseconds ahead).
const MAX_AFTER: Duration = Duration::from_millis(50);
/// Capture times of one capture are at least this far apart.
const STEP: Duration = Duration::from_millis(1);

/// The capture times of one capture.
#[derive(Debug, Default)]
pub(crate) struct CaptureClock {
    last: Option<Instant>,
    /// Frames timed by their arrival, because the compositor gave no usable time.
    pub(crate) untimed: u64,
}

impl CaptureClock {
    /// The capture time of a frame that arrived at `arrived`, with the compositor's time
    /// `composed` for it (`None` when the compositor gave none). A compositor time from 1 s
    /// before the arrival to 50 ms after it is the capture time as such.
    pub(crate) fn stamp(&mut self, arrived: Instant, composed: Option<Instant>) -> Instant {
        let mut at = match composed {
            Some(composed) if composed + MAX_BEFORE >= arrived && composed <= arrived + MAX_AFTER => composed,
            _ => {
                self.untimed += 1;
                arrived
            }
        };
        if let Some(last) = self.last
            && at < last + STEP
        {
            at = last + STEP;
        }
        self.last = Some(at);
        at
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: Duration = Duration::from_millis(1);

    #[test]
    fn a_compositor_time_before_or_just_after_the_arrival_is_the_capture_time() {
        let t = Instant::now() + Duration::from_secs(10);
        let mut clock = CaptureClock::default();
        // Composed before the arrival (Linux), shown after it (Windows).
        assert_eq!(clock.stamp(t, Some(t - 3 * MS)), t - 3 * MS);
        assert_eq!(clock.stamp(t + 17 * MS, Some(t + 25 * MS)), t + 25 * MS);
        // Exactly a second before and exactly 50 ms after are still trusted.
        assert_eq!(clock.stamp(t + 2000 * MS, Some(t + 1000 * MS)), t + 1000 * MS);
        assert_eq!(clock.stamp(t + 2000 * MS, Some(t + 2050 * MS)), t + 2050 * MS);
        assert_eq!(clock.untimed, 0);
    }

    #[test]
    fn a_missing_too_old_or_too_far_ahead_time_is_untimed_and_uses_arrival() {
        let t = Instant::now() + Duration::from_secs(10);
        let mut clock = CaptureClock::default();
        assert_eq!(clock.stamp(t, None), t);
        assert_eq!(clock.untimed, 1);
        assert_eq!(clock.stamp(t + 2000 * MS, Some(t + 999 * MS)), t + 2000 * MS);
        assert_eq!(clock.untimed, 2);
        assert_eq!(clock.stamp(t + 2020 * MS, Some(t + 2071 * MS)), t + 2020 * MS);
        assert_eq!(clock.untimed, 3);
        // A usable time again counts nothing.
        assert_eq!(clock.stamp(t + 2040 * MS, Some(t + 2038 * MS)), t + 2038 * MS);
        assert_eq!(clock.untimed, 3);
    }

    #[test]
    fn times_never_go_back_and_step_by_at_least_a_millisecond() {
        let t = Instant::now() + Duration::from_secs(10);
        let mut clock = CaptureClock::default();
        assert_eq!(clock.stamp(t, Some(t)), t);
        // Composed before the frame before it: one step after that frame.
        assert_eq!(clock.stamp(t + 5 * MS, Some(t - 5 * MS)), t + MS);
        // The same time twice: a step apart.
        assert_eq!(clock.stamp(t + MS, Some(t + MS)), t + 2 * MS);
        // Less than a step later: a step.
        let near = t + 2 * MS + Duration::from_micros(300);
        assert_eq!(clock.stamp(near, Some(near)), t + 3 * MS);
        // More than a step later: as it is.
        assert_eq!(clock.stamp(t + 20 * MS, Some(t + 20 * MS)), t + 20 * MS);
        // An untimed frame follows the same rule.
        assert_eq!(clock.stamp(t + 20 * MS, None), t + 21 * MS);
    }
}
