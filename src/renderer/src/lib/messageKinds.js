// Every message `kind` this client knows how to draw. A server newer than the
// client can write kinds it has never heard of (activity cards reached 0.1.5
// clients this way, as empty lines); those draw as a placeholder instead. Pure.

import { CALL_MESSAGE_KINDS } from './callMessages.js'
import { ACTIVITY_MESSAGE_KINDS } from './activities/cards.js'

export const KNOWN_MESSAGE_KINDS = new Set([
  'default',
  'poke',
  ...CALL_MESSAGE_KINDS,
  ...ACTIVITY_MESSAGE_KINDS
])

// A missing kind is a plain message (messageFromApi defaults it to 'default').
export function isUnknownMessage(entry) {
  return entry?.kind != null && !KNOWN_MESSAGE_KINDS.has(entry.kind)
}

export const UNKNOWN_MESSAGE_TEXT = 'Unable to display this message type'
