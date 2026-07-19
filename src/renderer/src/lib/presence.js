// Presence is user-level (not per-connection): one status per client_id, shared
// across that user's devices, last-write-wins. The server is authoritative — we
// seed from Ready, patch on PresenceUpdate, and can resync via GET /server/presences.

export const STATUSES = ['online', 'away', 'do_not_disturb', 'offline']

export const STATUS_LABELS = {
  online: 'Online',
  away: 'Away',
  do_not_disturb: 'Do Not Disturb',
  // What we send to appear offline while still connected; also what we show for
  // users who simply aren't here. The two are deliberately indistinguishable.
  offline: 'Invisible'
}

// Max length the server accepts, in Unicode code points (not UTF-16 units), so
// astral characters — emoji — count as one the way the server counts them.
export const STATUS_MESSAGE_MAX = 128

export const messageLength = (s) => [...s].length

// A client with no presence entry has never announced one: treat as offline.
// Anything we don't recognise degrades to offline rather than rendering blank.
export function statusOf(presence) {
  const s = presence?.status
  return STATUSES.includes(s) ? s : 'offline'
}

// Trim and validate a status message the way the server does, so an invalid one
// is caught before it costs a round trip. Returns { message } or { error }.
// null is the explicit "clear it" value and is always allowed.
export function validateMessage(raw) {
  if (raw == null) return { message: null }
  const message = raw.trim()
  if (!message) return { error: 'Status message cannot be blank' }
  if (messageLength(message) > STATUS_MESSAGE_MAX) {
    return { error: `Status message is limited to ${STATUS_MESSAGE_MAX} characters` }
  }
  return { message }
}
