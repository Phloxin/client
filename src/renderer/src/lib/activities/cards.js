// The messages the server writes into a channel for an activity room (docs/API.md "Activities",
// ActivityCard). An `activity` message is one card per room that changes in place when the room
// ends. Pure.

import { formatCallDuration } from '../callMessages.js'

export const ACTIVITY_MESSAGE_KINDS = new Set(['activity'])

export function isActivityMessage(entry) {
  return ACTIVITY_MESSAGE_KINDS.has(entry?.kind)
}

const activityName = (entry) => entry?.activity?.name ?? entry?.activity?.activity_id ?? ''

// The line a card reads as in a reply preview. `authorName` is the room creator's.
export function activityMessageLabel(entry, authorName, { isOwn = false } = {}) {
  const name = activityName(entry)
  return isOwn ? `You started ${name}` : `${authorName} started ${name}`
}

// The DM inbox alert for a started card.
export const activityAlertText = (entry, authorName) =>
  `${authorName} started ${activityName(entry)}`

const ids = (list) => (Array.isArray(list) ? list.map(String) : [])
const text = (value) => (typeof value === 'string' && value !== '' ? value : null)

// Highest score first, ties in the server's order. Null when there is nothing to rank.
export function sortResults(results) {
  if (!Array.isArray(results) || !results.length) return null
  return results
    .map((r) => ({ clientId: String(r?.client_id), score: Number(r?.score) || 0 }))
    .sort((a, b) => b.score - a.score)
}

// A score as the scoreboard prints it, with thousands separators (1,005). Scores may be negative
// (poker reports each player's net); those get a real minus sign (U+2212) rather than a hyphen.
// `signed` is set on a card where some score is negative: positive scores then get a `+`.
export function formatScore(score, signed = false) {
  const n = Number(score) || 0
  const digits = Math.abs(n).toLocaleString('en-US')
  if (n < 0) return `−${digits}`
  return signed && n > 0 ? `+${digits}` : digits
}

// A net-ranked card (some score below 0) prints its scores signed.
export const hasSignedScores = (sorted) => !!sorted?.some((r) => r.score < 0)

// The top row earns the trophy only when nobody shares its score.
export const hasTrophy = (sorted) =>
  !!sorted?.length && (sorted.length === 1 || sorted[0].score !== sorted[1].score)

// What an `activity` card draws, from its feed entry and its open room (null when the channel's
// room list has none). An `ended` on the card wins over a room that is still listed.
export function activityCardModel(entry, room) {
  const card = entry?.activity ?? {}
  const ended = card.ended && typeof card.ended === 'object' ? card.ended : null
  const live = !ended && !!room
  const startedAt = entry?.ts ?? null
  const durationMs = ended && Number.isFinite(ended.duration_ms) ? ended.duration_ms : null
  const results = ended ? sortResults(ended.results) : null
  let footer = null
  if (live) footer = 'room'
  else if (results) footer = 'scoreboard'
  else if (ended) footer = 'participants'
  return {
    status: live ? 'live' : 'ended',
    name: activityName(entry),
    activityId: card.activity_id ?? null,
    roomId: card.room_id ?? null,
    startedAt,
    endedAt: durationMs != null && startedAt != null ? startedAt + durationMs : null,
    durationMs,
    detail: live ? text(room.detail) : null,
    participants: live ? ids(room.clients) : ids(ended?.participants),
    results,
    signed: hasSignedScores(results),
    trophy: hasTrophy(results),
    summary: ended ? text(ended.summary) : null,
    footer
  }
}

// The line under the card's name. `formatTime` is the chat's message time format.
export function activityCardMeta(model, { creatorName, isOwn = false, formatTime }) {
  if (model.status === 'ended' && model.endedAt != null) {
    const span = `${formatTime(model.startedAt)} to ${formatTime(model.endedAt)}`
    return `${span} · ${formatCallDuration(model.durationMs)}`
  }
  return `Started by ${isOwn ? 'you' : creatorName} at ${formatTime(model.startedAt)}`
}

// The label beside the footer's avatar stack. `verb` is the activity's ended verb.
export function activityFooterLabel(model, verb) {
  const n = model.participants.length
  if (model.footer === 'room') return n ? `${n} in room` : 'No one here yet'
  if (!n) return 'No one joined'
  return model.summary ? `${n} ${verb} · ${model.summary}` : `${n} ${verb}`
}

// Roster lookup by client id, compared as strings. A client not in the roster is "Unknown".
export function clientLookup(clients) {
  const byId = new Map((clients || []).map((c) => [String(c.id), c]))
  return (id) => {
    const c = byId.get(String(id))
    if (!c) return { name: 'Unknown', avatar: null, initial: '?' }
    const name = c.name || 'Unknown'
    return { name, avatar: c.avatar || null, initial: name.charAt(0).toUpperCase() }
  }
}
