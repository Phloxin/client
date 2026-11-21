// The messages the server writes into a channel when an activity room opens and closes
// (docs/API.md "Activities", ActivityCard). Drawn as system lines like the call cards. Pure.

import { formatCallDuration } from '../callMessages.js'

export const ACTIVITY_MESSAGE_KINDS = new Set(['activity_started', 'activity_ended'])

export function isActivityMessage(entry) {
  return ACTIVITY_MESSAGE_KINDS.has(entry?.kind)
}

const activityName = (entry) => entry?.activity?.name ?? entry?.activity?.activity_id ?? ''

// The card's sentence. `authorName` is the room creator's, the card's author.
export function activityMessageLabel(entry, authorName, { isOwn = false } = {}) {
  const name = activityName(entry)
  if (entry.kind === 'activity_ended') {
    const ms = entry.activity?.duration_ms
    return ms == null ? `${name} ended` : `${name} ended · ${formatCallDuration(ms)}`
  }
  return isOwn ? `You started ${name}` : `${authorName} started ${name}`
}

// "Alice 3 · Bob 1", highest first, ties in the server's order; null when the card counts nothing.
export function winsTally(entry, nameOf) {
  const wins = entry?.activity?.wins
  if (!Array.isArray(wins) || !wins.length) return null
  return [...wins]
    .sort((a, b) => (b.wins ?? 0) - (a.wins ?? 0))
    .map((w) => `${nameOf(w.client_id) || 'Unknown'} ${w.wins ?? 0}`)
    .join(' · ')
}

// The DM inbox alert for a started card.
export const activityAlertText = (entry, authorName) =>
  `${authorName} started ${activityName(entry)}`
