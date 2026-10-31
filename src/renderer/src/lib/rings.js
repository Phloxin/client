// Bookkeeping for DM call rings. Incoming rings are a Map of channel id ->
// { callerId, deadline }; outgoing ones (the caller's local "Ringing…") a Map of
// recipient id -> deadline. Deadlines are Unix milliseconds. Every function
// returns the map it was given when nothing changed.

export const OUTGOING_RING_TTL_MS = 30_000

// A ring that left for one of these reasons was missed. A client-side expiry
// counts as 'expired'.
const MISSED_REASONS = new Set(['expired', 'ended'])

export function isMissedRing(reason) {
  return MISSED_REASONS.has(reason)
}

// Ready is the truth: the map is rebuilt from it, minus rings already over.
export function applyReady(rings, readyRings, now) {
  const next = new Map()
  for (const r of readyRings || []) {
    if (r?.channel_id == null || !(r.deadline > now)) continue
    next.set(r.channel_id, { callerId: r.caller_id, deadline: r.deadline })
  }
  return next
}

// `added` is true only for a channel that wasn't ringing before.
export function applyRinging(rings, ev, now, selfChannelId) {
  if (ev?.channel_id == null || !(ev.deadline > now) || ev.channel_id === selfChannelId) {
    return { rings, added: false }
  }
  const next = new Map(rings)
  next.set(ev.channel_id, { callerId: ev.caller_id, deadline: ev.deadline })
  return { rings: next, added: !rings.has(ev.channel_id) }
}

// `ended` is the removed ring with its reason, or null if none was pending.
export function applyRingEnded(rings, ev) {
  const ring = rings.get(ev?.channel_id)
  if (!ring) return { rings, ended: null }
  const next = new Map(rings)
  next.delete(ev.channel_id)
  return { rings: next, ended: { channelId: ev.channel_id, ...ring, reason: ev.reason } }
}

export function expire(rings, now) {
  const expired = []
  for (const [channelId, ring] of rings) {
    if (ring.deadline <= now) expired.push({ channelId, ...ring, reason: 'expired' })
  }
  if (!expired.length) return { rings, expired }
  const next = new Map(rings)
  for (const ring of expired) next.delete(ring.channelId)
  return { rings: next, expired }
}

export function startOutgoing(outgoing, ids, now, ttlMs = OUTGOING_RING_TTL_MS) {
  if (!ids?.length) return outgoing
  const next = new Map(outgoing)
  for (const id of ids) next.set(id, now + ttlMs)
  return next
}

// Drops the recipients who joined the call or whose ring ran out.
export function settleOutgoing(outgoing, inCallIds, now) {
  const inCall = new Set(inCallIds)
  let next = outgoing
  for (const [id, deadline] of outgoing) {
    if (!inCall.has(id) && deadline > now) continue
    if (next === outgoing) next = new Map(outgoing)
    next.delete(id)
  }
  return next
}
