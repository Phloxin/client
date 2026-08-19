// Decides when and how to recover a lost screen capture track. Kept free of
// WebRTC and Electron globals so it can be unit tested on its own.
//
// On Windows, a shared window can get rebuilt, which ends the capture track
// even though the producer, audio pipeline, and viewers are all still fine.
// In that case the right move is to re-acquire the source and swap the track
// in, rather than ending the share. These helpers decide whether and when
// that's allowed.

// Up to three tries per incident. A window that's truly gone shouldn't retry
// forever, and a window that keeps toggling fullscreen gets its budget back
// through the stability reset below.
export const SCREEN_RECOVERY_MAX_ATTEMPTS = 3
export const SCREEN_RECOVERY_BACKOFF_MS = [0, 1000, 2000]
// A recovered capture that stays stable this long counts as a new incident,
// so the next toggle starts with a full attempt budget again.
export const SCREEN_RECOVERY_STABILITY_MS = 10_000
// How long a muted (frame-starved) track is tolerated before it's treated as
// stalled. Set generously, since static content doesn't mute the track, but
// a slow compositor briefly can.
export const SCREEN_MUTE_STALL_MS = 8000

// 'recover'    re-resolve the source and swap the track in
// 'final-stop' the share can't continue, so tear it down and tell the UI
// 'ignore'     this context no longer owns the share, or a recovery is
//              already running, so do nothing
export function screenRecoveryDecision({
  active,
  type,
  sourceId,
  recovering = false,
  attempts = 0
} = {}) {
  if (!active || recovering) return 'ignore'
  // Cameras always stop on track end. Wayland shares have no id to
  // re-resolve, and retrying would pop the OS picker dialog unprompted.
  if (type !== 'screen') return 'final-stop'
  if (!sourceId) return 'final-stop'
  if (attempts >= SCREEN_RECOVERY_MAX_ATTEMPTS) return 'final-stop'
  return 'recover'
}

// Delay before the given (zero-based) attempt, or null once attempts are spent.
export function nextRecoveryDelay(attempt) {
  return SCREEN_RECOVERY_BACKOFF_MS[attempt] ?? null
}

// By the time this timer fires, the track may have unmuted, the share may
// have stopped, or a recovery may already be running. Only recover a track
// that's still muted on a share that's still active and eligible.
export function shouldRecoverOnMuteStall({ muted, ...state } = {}) {
  return muted === true && screenRecoveryDecision(state) === 'recover'
}
