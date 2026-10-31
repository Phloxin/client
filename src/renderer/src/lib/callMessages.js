// Labels for the messages the server writes into a DM when a call starts and ends.

export const CALL_MESSAGE_KINDS = new Set(['call_started', 'call_ended'])

export function isCallMessage(entry) {
  return CALL_MESSAGE_KINDS.has(entry?.kind)
}

// m:ss, or h:mm:ss from an hour up.
export function formatCallDuration(ms) {
  const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
  return `${minutes}:${seconds}`
}

export function callMessageLabel(entry, authorName) {
  if (entry.kind === 'call_ended') {
    const ms = entry.call?.duration_ms
    return ms == null ? 'Call ended' : `Call ended · ${formatCallDuration(ms)}`
  }
  if (entry.missed) return `Missed call from ${authorName}`
  return `${authorName} started a call`
}
