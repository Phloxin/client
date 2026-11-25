export const DEFAULT_AUTO_IDLE_SETTINGS = { enabled: true, minutes: 15 }
export const MAX_IDLE_MINUTES = 1440
export const IDLE_POLL_INTERVAL_MS = 5000
const PRESENCE_RETRY_MS = 15000

export function validIdleMinutes(value) {
  return Number.isInteger(value) && value >= 1 && value <= MAX_IDLE_MINUTES
}

export function normalizeAutoIdleSettings(settings) {
  return {
    enabled: settings?.enabled !== false,
    minutes: validIdleMinutes(settings?.minutes)
      ? settings.minutes
      : DEFAULT_AUTO_IDLE_SETTINGS.minutes
  }
}

// Talking unmuted in voice counts as activity: someone in a call can go many
// minutes without touching the mouse or keyboard. The effective idle time is
// the shorter of system input idle and time since we last spoke (0 while
// speaking). Invalid system readings pass through so tick() still ignores them.
export function idleSecondsWithVoice(systemIdleSeconds, { speaking, lastSpokeAt, now }) {
  if (!Number.isFinite(systemIdleSeconds) || systemIdleSeconds < 0) return systemIdleSeconds
  if (speaking) return 0
  if (!Number.isFinite(lastSpokeAt)) return systemIdleSeconds
  return Math.min(systemIdleSeconds, Math.max(0, (now - lastSpokeAt) / 1000))
}

// Own only transitions made by this session. The server remains authoritative;
// wait for its echo before restoring Online, and never restore manual Away/DND/
// Invisible. A missing echo is retried at a bounded rate, not on every poll.
export function createAutoIdleController() {
  let autoAway = false
  let pending = null
  let manualOverride = false

  function reset() {
    autoAway = false
    pending = null
    manualOverride = false
  }

  return {
    reset,
    manualStatusSelected() {
      reset()
      manualOverride = true
    },
    tick({ status, idleSeconds, settings, send, now = Date.now() }) {
      if (!Number.isFinite(idleSeconds) || idleSeconds < 0) return
      const idle = settings.enabled && idleSeconds >= settings.minutes * 60
      if (!idle) manualOverride = false

      if (pending) {
        if (status === pending.to) {
          autoAway = pending.to === 'away'
          pending = null
        } else if (status !== pending.from) {
          // Another device selected a different status while our update flew.
          reset()
        } else if (
          now - pending.sentAt < PRESENCE_RETRY_MS ||
          (pending.to === 'away' ? !idle : idle)
        ) {
          // If activity/settings changed while awaiting the echo, retain
          // ownership of that in-flight update without resending a stale choice.
          return
        } else {
          pending = null
        }
      }
      if (autoAway && status !== 'away') {
        autoAway = false
        // Another device took over presence. Do not fight its Online choice
        // every five seconds while this computer remains unattended.
        manualOverride = idle
      }

      let next = null
      if (autoAway && !idle) next = 'online'
      else if (!manualOverride && idle && status === 'online') next = 'away'

      if (next && send({ status: next })) {
        pending = { from: status, to: next, sentAt: now }
      }
    }
  }
}
