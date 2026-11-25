// A DM's call as its tab and its call bar show it.

import { CALL_MESSAGE_KINDS } from './callMessages.js'

// 'joined' while we're in the DM's call, 'live' while it runs without us, else null.
export function dmCallState(channelId, selfChannelId, clients) {
  if (channelId == null) return null
  if (selfChannelId === channelId) return 'joined'
  return clients?.some((c) => c.channel_id === channelId) ? 'live' : null
}

// When the DM's running call started (ms), from its newest call message. An end
// there means the current call's start isn't loaded: null, as with none at all.
export function callStartedAt(feed, channelId) {
  let latest = null
  for (const e of feed || []) {
    if (e?.type !== 'message' || e.channelId !== channelId || !CALL_MESSAGE_KINDS.has(e.kind)) {
      continue
    }
    if (!latest || e.ts >= latest.ts) latest = e
  }
  return latest?.kind === 'call_started' ? latest.ts : null
}

// The call bar's entries for `participants` (us first, then the DM's others):
// those in the call first, then the rest with a status. Without us in the call,
// only those in it.
export function callBarEntries({
  channelId,
  participants,
  selfId,
  joined,
  clientsById,
  speaking,
  selfMuted,
  selfDeafened,
  streamers,
  tileOwners,
  ringing,
  isOffline
}) {
  const entries = participants.map((p) => {
    const c = clientsById.get(p.id) ?? {}
    const isSelf = p.id === selfId
    const inCall = c.channel_id === channelId
    let status = null
    if (!inCall) status = ringing.has(p.id) ? 'ringing' : isOffline(p.id) ? 'offline' : 'ring'
    return {
      id: p.id,
      name: c.name || p.name || 'Unknown',
      avatar: c.avatar,
      isSelf,
      inCall,
      speaking: inCall && !!speaking[p.id],
      // Our own toggles beat the roster echo.
      muted: inCall && (isSelf ? !!selfMuted : !!c.self_mute || !!c.server_mute),
      deafened: inCall && (isSelf ? !!selfDeafened : !!c.self_deaf),
      streaming: inCall && (streamers.has(p.id) || tileOwners.has(p.id)),
      watchable: !!joined && inCall && tileOwners.has(p.id),
      status
    }
  })
  const present = entries.filter((e) => e.inCall)
  return joined ? [...present, ...entries.filter((e) => !e.inCall)] : present
}
