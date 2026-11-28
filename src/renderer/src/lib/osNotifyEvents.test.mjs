// Which desktop notification a new message raises (osNotifyEvents.js).
//   node --test src/renderer/src/lib/osNotifyEvents.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MESSAGE_FRESH_MS,
  NOTIFIED_MAX,
  POKE_FRESH_MS,
  channelPopupKeys,
  groupDmName,
  messagePopup,
  rememberNotified
} from './osNotifyEvents.js'

const SELF = '1'
const NOW = 1_800_000_000_000
const names = { 1: 'Me', 2: 'Alice', 3: 'Bob' }
const nameOf = (id) => names[id]

const dm = { id: '50', type: 'dm', name: '', participant_ids: ['1', '2'] }
const group = { id: '60', type: 'dm', name: '', participant_ids: ['1', '2', '3'] }
const general = { id: '70', type: 'voice', name: 'general' }

const message = (extra = {}) => ({
  id: '900',
  channel_id: dm.id,
  author: '2',
  kind: 'default',
  content: 'hello **there** <@1>',
  mentions: [],
  mention_everyone: false,
  attachments: [],
  timestamp: NOW - 1000,
  ...extra
})

const context = (channel, extra = {}) => ({
  selfId: SELF,
  channel,
  nameOf,
  now: NOW,
  notified: new Set(),
  ...extra
})

test('a DM message: the DM popup, the author as title, the preview as body', () => {
  assert.deepEqual(messagePopup(message(), context(dm)), {
    row: 'dm_received',
    key: 'dm:50',
    title: 'Alice',
    body: 'hello there @Me',
    target: { kind: 'dm', channelId: '50', authorId: '2' }
  })
})

test('a DM with only a file reads "Sent a file"', () => {
  const popup = messagePopup(message({ content: '', attachments: [{ id: 'a' }] }), context(dm))
  assert.equal(popup.body, 'Sent a file')
})

test('an activity card in a DM: the DM popup with the alert text', () => {
  const data = message({ kind: 'activity', content: '', activity: { name: 'Uno' } })
  const popup = messagePopup(data, context(dm))
  assert.equal(popup.row, 'dm_received')
  assert.equal(popup.key, 'dm:50')
  assert.equal(popup.title, 'Alice')
  assert.equal(popup.body, 'Alice started Uno')
  const unknown = messagePopup({ ...data, author: '9' }, context(dm))
  assert.equal(unknown.title, 'Someone')
  assert.equal(unknown.body, 'Someone started Uno')
})

test('a DM that mentions us gives the DM popup only', () => {
  const data = message({ mentions: ['1'], mention_everyone: true })
  const popup = messagePopup(data, context(dm))
  assert.equal(popup.row, 'dm_received')
  assert.equal(popup.key, 'dm:50')
})

test('a group DM is titled "author in <the others>", a 1:1 by the author alone', () => {
  const popup = messagePopup(message({ channel_id: group.id }), context(group))
  assert.equal(popup.title, 'Alice in Alice, Bob')
  assert.equal(popup.key, 'dm:60')
  assert.equal(groupDmName(group, SELF, nameOf), 'Alice, Bob')
  assert.equal(groupDmName(dm, SELF, nameOf), null)
  assert.equal(groupDmName(general, SELF, nameOf), null)
  assert.equal(groupDmName(undefined, SELF, nameOf), null)
  // Recipients as the client stamps them locally, { id, name } entries included.
  const local = { id: '61', type: 'dm', recipients: ['1', { id: '3', name: 'Bobby' }, '2'] }
  assert.equal(groupDmName(local, SELF, nameOf), 'Bobby, Alice')
})

test('a mention in a server channel: "author mentioned you in #channel"', () => {
  const data = message({ channel_id: general.id, mentions: ['1'], content: 'look <@1>' })
  assert.deepEqual(messagePopup(data, context(general)), {
    row: 'mentioned',
    key: 'mention:70',
    title: 'Alice mentioned you in #general',
    body: 'look @Me',
    target: { kind: 'channel', channelId: '70' }
  })
})

test('@everyone in a server channel: "author mentioned @everyone in #channel"', () => {
  const data = message({ channel_id: general.id, mention_everyone: true, content: '@everyone hi' })
  const popup = messagePopup(data, context(general))
  assert.equal(popup.row, 'mentioned')
  assert.equal(popup.title, 'Alice mentioned @everyone in #general')
  // Named directly as well: "you".
  const both = messagePopup({ ...data, mentions: [1] }, context(general))
  assert.equal(both.title, 'Alice mentioned you in #general')
})

test('a server channel message that mentions someone else, or nobody, raises nothing', () => {
  assert.equal(messagePopup(message({ channel_id: general.id }), context(general)), null)
  const other = message({ channel_id: general.id, mentions: ['3'] })
  assert.equal(messagePopup(other, context(general)), null)
})

test('a channel not known yet raises nothing, but a poke still pops up', () => {
  assert.equal(messagePopup(message(), context(undefined)), null)
  assert.equal(messagePopup(message({ mentions: ['1'] }), context(undefined)), null)
  const poke = messagePopup(message({ kind: 'poke', content: null }), context(undefined))
  assert.equal(poke.row, 'you_were_poked')
})

test('a poke: "author poked you", its text as body, a DM target', () => {
  const popup = messagePopup(message({ kind: 'poke', content: 'wake up' }), context(dm))
  assert.deepEqual(popup, {
    row: 'you_were_poked',
    key: 'poke:50',
    title: 'Alice poked you',
    body: 'wake up',
    target: { kind: 'dm', channelId: '50', authorId: '2' }
  })
  const silent = messagePopup(message({ kind: 'poke', content: null }), context(dm))
  assert.equal(silent.body, '')
})

test('a poke more than 5 s from now stays quiet (the chime rule)', () => {
  const at = (ms) => messagePopup(message({ kind: 'poke', timestamp: NOW - ms }), context(dm))
  assert.equal(at(POKE_FRESH_MS).row, 'you_were_poked')
  assert.equal(at(POKE_FRESH_MS + 1), null)
  assert.equal(at(-POKE_FRESH_MS - 1), null, 'from the future too')
})

test('our own messages raise nothing, whatever the id type', () => {
  assert.equal(messagePopup(message({ author: '1' }), context(dm)), null)
  assert.equal(messagePopup(message({ author: 1 }), context(dm)), null)
  assert.equal(messagePopup(message({ author: 1, kind: 'poke' }), context(dm)), null)
  const mention = message({ author: '1', channel_id: general.id, mentions: ['1'] })
  assert.equal(messagePopup(mention, context(general)), null)
  assert.equal(messagePopup(message(), context(dm, { selfId: null })), null, 'self not known')
})

test('call messages never pop up', () => {
  for (const kind of ['call_started', 'call_ended']) {
    assert.equal(messagePopup(message({ kind }), context(dm)), null, kind)
    const mention = message({ kind, channel_id: general.id, mention_everyone: true })
    assert.equal(messagePopup(mention, context(general)), null, kind)
  }
  assert.equal(messagePopup(message({ kind: 'something_new' }), context(dm)), null)
})

test('a message older than 60 s is a replay: nothing', () => {
  const at = (ms) => messagePopup(message({ timestamp: NOW - ms }), context(dm))
  assert.equal(at(MESSAGE_FRESH_MS).row, 'dm_received')
  assert.equal(at(MESSAGE_FRESH_MS + 1), null)
  assert.equal(messagePopup(message({ timestamp: undefined }), context(dm)), null)
})

test('a message id already handled raises nothing again', () => {
  const notified = new Set()
  assert.notEqual(messagePopup(message(), context(dm, { notified })), null)
  rememberNotified(notified, '900')
  assert.equal(messagePopup(message(), context(dm, { notified })), null)
  assert.equal(messagePopup(message({ id: 900 }), context(dm, { notified })), null)
  assert.notEqual(messagePopup(message({ id: '901' }), context(dm, { notified })), null)
})

test('rememberNotified keeps the newest 200 ids', () => {
  const notified = new Set()
  for (let i = 0; i < NOTIFIED_MAX + 5; i++) rememberNotified(notified, i)
  assert.equal(notified.size, NOTIFIED_MAX)
  assert.equal(notified.has('4'), false)
  assert.equal(notified.has('5'), true)
  // Seeing an id again makes it the newest.
  rememberNotified(notified, 5)
  rememberNotified(notified, 'new')
  assert.equal(notified.has('5'), true)
  assert.equal(notified.has('6'), false)
  rememberNotified(notified, null)
  assert.equal(notified.size, NOTIFIED_MAX)
})

test('reading a channel takes away its DM, mention and poke popups', () => {
  assert.deepEqual(channelPopupKeys('50'), ['dm:50', 'mention:50', 'poke:50'])
})
