// Which desktop notification (lib/osNotifications.js) a new message raises, with its
// words, key and click target. Pure: Main hands in what it knows about the message's
// channel and people, then passes the result to notifyOs, which applies the gate.
import { activityAlertText } from './activities/cards.js'
import { isCallMessage } from './callMessages.js'
import { dmDisplayName, dmOthers } from './dm.js'
import { dmTitle, mentionTitle, messagePreview, pokeTitle } from './notificationText.js'

// Older than this, a message is a replay (a resume or a history reload), not news.
export const MESSAGE_FRESH_MS = 60_000
// A poke further than this from now stays quiet, as its chime does (Main.jsx).
export const POKE_FRESH_MS = 5000
// How many message ids Main keeps as already notified (rememberNotified).
export const NOTIFIED_MAX = 200

// Snowflakes may come as numbers or strings.
const sameId = (a, b) => a != null && b != null && String(a) === String(b)

// A group DM (a DM with more than one other participant) is named as the ring card
// names it: the other participants' names. Null for a 1:1 DM and for anything else.
// DM channels have no name of their own: the server makes them with an empty one
// and refuses to modify a DM.
export function groupDmName(channel, selfId, nameOf) {
  if (channel?.type !== 'dm' || dmOthers(channel, selfId).length < 2) return null
  return dmDisplayName(channel, selfId, nameOf)
}

// The popup a MessageCreated's `data` raises, or null:
//   { row, key, title, body, target }
// `row` is the Settings row whose gate applies (lib/sounds.js). Context:
//   selfId    our client id (null before Ready: nothing pops up)
//   channel   the message's channel as Main knows it, or undefined
//   nameOf    id -> display name, for the author and <@id> mentions
//   now       Date.now()
//   notified  the ids (as strings) of messages already handled (rememberNotified)
// Rules:
//   • nothing of ours, no call_started / call_ended (the ring pops up for a call),
//     nothing older than MESSAGE_FRESH_MS, nothing already handled;
//   • a poke: "author poked you", within POKE_FRESH_MS of now;
//   • a DM message (default or activity kind): the DM popup only, even when it
//     mentions us;
//   • a server channel's message that mentions us or @everyone: the mention popup;
//   • a channel Main doesn't know yet: nothing (but a poke, which is always a DM).
export function messagePopup(data, { selfId, channel, nameOf, now, notified } = {}) {
  if (!data || selfId == null || sameId(data.author, selfId)) return null
  if (isCallMessage(data)) return null
  if (!(now - data.timestamp <= MESSAGE_FRESH_MS)) return null
  if (data.id != null && notified?.has(String(data.id))) return null

  const kind = data.kind ?? 'default'
  const author = nameOf?.(data.author)
  const channelId = data.channel_id
  const preview = () => messagePreview(data.content, { nameOf, attachments: data.attachments })
  const dmTarget = { kind: 'dm', channelId, authorId: data.author }

  if (kind === 'poke') {
    if (!(Math.abs(now - data.timestamp) <= POKE_FRESH_MS)) return null
    return {
      row: 'you_were_poked',
      key: `poke:${channelId}`,
      title: pokeTitle(author),
      body: preview(),
      target: dmTarget
    }
  }
  if (kind !== 'default' && kind !== 'activity') return null
  if (channel == null) return null

  if (channel.type === 'dm') {
    return {
      row: 'dm_received',
      key: `dm:${channelId}`,
      title: dmTitle(author, groupDmName(channel, selfId, nameOf)),
      body: kind === 'activity' ? activityAlertText(data, author || 'Someone') : preview(),
      target: dmTarget
    }
  }

  const direct = (data.mentions || []).some((id) => sameId(id, selfId))
  if (!direct && !data.mention_everyone) return null
  return {
    row: 'mentioned',
    key: `mention:${channelId}`,
    title: mentionTitle(author, channel.name, { everyone: !direct }),
    body: preview(),
    target: { kind: 'channel', channelId }
  }
}

// Adds message `id` to `notified` (a Set Main keeps), as the newest; past `max`,
// the oldest ids go.
export function rememberNotified(notified, id, max = NOTIFIED_MAX) {
  if (id == null) return
  const key = String(id)
  notified.delete(key)
  notified.add(key)
  while (notified.size > max) notified.delete(notified.values().next().value)
}

// The keys of the popups a channel being read takes away (D9).
export const channelPopupKeys = (channelId) => [
  `dm:${channelId}`,
  `mention:${channelId}`,
  `poke:${channelId}`
]
