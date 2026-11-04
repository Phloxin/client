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
