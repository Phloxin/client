import assert from 'node:assert/strict'
import test from 'node:test'

import { callBarEntries, callStartedAt, dmCallState } from './dmCall.js'

const DM = 'dm1'

test('no channel has no call', () => {
  assert.equal(dmCallState(null, DM, [{ id: 'a', channel_id: DM }]), null)
  assert.equal(dmCallState(undefined, null, []), null)
})

test('our own channel is a joined call', () => {
  assert.equal(dmCallState(DM, DM, []), 'joined')
})

test('a call with someone else in it and not us is live', () => {
  assert.equal(dmCallState(DM, 'other', [{ id: 'a', channel_id: DM }]), 'live')
  assert.equal(dmCallState(DM, null, [{ id: 'a', channel_id: DM }]), 'live')
})

test('nobody in the channel is no call', () => {
  assert.equal(dmCallState(DM, 'other', [{ id: 'a', channel_id: 'other' }, { id: 'b' }]), null)
  assert.equal(dmCallState(DM, null, []), null)
})

const msg = (kind, ts, channelId = DM) => ({ type: 'message', channelId, kind, ts })

test('a started call starts at its message', () => {
  assert.equal(callStartedAt([msg('default', 50), msg('call_started', 100)], DM), 100)
})

test('a call that started then ended has no known start', () => {
  assert.equal(callStartedAt([msg('call_started', 100), msg('call_ended', 200)], DM), null)
})

test('a newer start after an end is the start', () => {
  assert.equal(
    callStartedAt([msg('call_started', 100), msg('call_ended', 200), msg('call_started', 300)], DM),
    300
  )
})

test('the newest call message wins whatever the feed order', () => {
  assert.equal(callStartedAt([msg('call_started', 300), msg('call_ended', 200)], DM), 300)
  assert.equal(callStartedAt([msg('call_ended', 400), msg('call_started', 300)], DM), null)
})

test('on a tie the later entry wins', () => {
  assert.equal(callStartedAt([msg('call_ended', 300), msg('call_started', 300)], DM), 300)
  assert.equal(callStartedAt([msg('call_started', 300), msg('call_ended', 300)], DM), null)
})

test("another channel's call messages don't count", () => {
  assert.equal(callStartedAt([msg('call_started', 100), msg('call_ended', 200, 'dm2')], DM), 100)
  assert.equal(callStartedAt([msg('call_started', 100, 'dm2')], DM), null)
})

test('no call messages, no start', () => {
  assert.equal(callStartedAt([msg('default', 100), { type: 'system', ts: 200 }], DM), null)
  assert.equal(callStartedAt([], DM), null)
})

const ME = 'me'

// Entries for us and a, b, c with everything quiet; `over` replaces any input.
function entries(over = {}) {
  return callBarEntries({
    channelId: DM,
    participants: [{ id: ME }, { id: 'a' }, { id: 'b' }, { id: 'c' }],
    selfId: ME,
    joined: true,
    clientsById: new Map(
      [
        { id: ME, name: 'Me', avatar: 'me.png', channel_id: DM },
        { id: 'a', name: 'Alice', channel_id: null },
        { id: 'b', name: 'Bob', avatar: 'b.png', channel_id: DM },
        { id: 'c', name: 'Cara', channel_id: 'elsewhere' }
      ].map((c) => [c.id, c])
    ),
    speaking: {},
    selfMuted: false,
    selfDeafened: false,
    streamers: new Set(),
    tileOwners: new Set(),
    ringing: new Set(),
    isOffline: () => false,
    ...over
  })
}

const byId = (list) => Object.fromEntries(list.map((e) => [e.id, e]))

test('those in the call come first in participant order, then the rest', () => {
  assert.deepEqual(
    entries().map((e) => e.id),
    [ME, 'b', 'a', 'c']
  )
})

test('an entry carries who it is and where they are', () => {
  const [me, bob, alice] = entries()
  assert.deepEqual(me, {
    id: ME,
    name: 'Me',
    avatar: 'me.png',
    isSelf: true,
    inCall: true,
    speaking: false,
    muted: false,
    deafened: false,
    streaming: false,
    watchable: false,
    status: null
  })
  assert.equal(bob.isSelf, false)
  assert.equal(bob.avatar, 'b.png')
  assert.equal(alice.inCall, false)
  assert.equal(alice.avatar, undefined)
})

test('speaking shows only for those in the call', () => {
  const e = byId(entries({ speaking: { [ME]: true, b: true, a: true } }))
  assert.equal(e[ME].speaking, true)
  assert.equal(e.b.speaking, true)
  assert.equal(e.a.speaking, false)
})

test('our own mute and deafen beat the roster echo', () => {
  const clientsById = new Map([
    [ME, { id: ME, channel_id: DM, self_mute: true, self_deaf: true }],
    ['b', { id: 'b', channel_id: DM }]
  ])
  const quiet = byId(entries({ clientsById }))
  assert.equal(quiet[ME].muted, false)
  assert.equal(quiet[ME].deafened, false)
  const loud = byId(
    entries({
      clientsById: new Map([[ME, { id: ME, channel_id: DM }]]),
      selfMuted: true,
      selfDeafened: true
    })
  )
  assert.equal(loud[ME].muted, true)
  assert.equal(loud[ME].deafened, true)
})

test("others' mute and deafen come from the roster, server mute included", () => {
  const clientsById = new Map([
    [ME, { id: ME, channel_id: DM }],
    ['a', { id: 'a', channel_id: DM, self_mute: true }],
    ['b', { id: 'b', channel_id: DM, server_mute: true }],
    ['c', { id: 'c', channel_id: DM, self_deaf: true }]
  ])
  const e = byId(entries({ clientsById, selfMuted: true }))
  assert.equal(e.a.muted, true)
  assert.equal(e.b.muted, true)
  assert.equal(e.c.muted, false)
  assert.equal(e.c.deafened, true)
  assert.equal(e.a.deafened, false)
})

test('mute and deafen show only for those in the call', () => {
  const clientsById = new Map([
    [ME, { id: ME, channel_id: DM }],
    ['a', { id: 'a', self_mute: true, self_deaf: true }]
  ])
  const e = byId(entries({ clientsById }))
  assert.equal(e.a.muted, false)
  assert.equal(e.a.deafened, false)
})

test('a streamer streams; only a tile owner is watchable', () => {
  const e = byId(entries({ streamers: new Set([ME, 'a']), tileOwners: new Set(['b', 'c']) }))
  assert.equal(e[ME].streaming, true)
  assert.equal(e[ME].watchable, false)
  assert.equal(e.b.streaming, true)
  assert.equal(e.b.watchable, true)
  assert.equal(e.a.streaming, false)
  assert.equal(e.c.streaming, false)
  assert.equal(e.c.watchable, false)
})

test('someone not in the call is ringing, offline, or can be rung', () => {
  const e = byId(entries({ ringing: new Set(['a', 'c']), isOffline: (id) => id === 'c' }))
  assert.equal(e.a.status, 'ringing')
  assert.equal(e.c.status, 'ringing')
  const f = byId(entries({ isOffline: (id) => id === 'c' }))
  assert.equal(f.a.status, 'ring')
  assert.equal(f.c.status, 'offline')
  assert.equal(f[ME].status, null)
  assert.equal(f.b.status, null)
})

test('someone in the call has no status, even if still marked ringing', () => {
  const e = byId(entries({ ringing: new Set(['b']), isOffline: () => true }))
  assert.equal(e.b.status, null)
})

test("a call we're not in lists only those in it, none watchable", () => {
  const clientsById = new Map([
    [ME, { id: ME, name: 'Me', channel_id: 'elsewhere' }],
    ['a', { id: 'a', name: 'Alice', channel_id: DM }],
    ['b', { id: 'b', name: 'Bob' }],
    ['c', { id: 'c', name: 'Cara', channel_id: DM }]
  ])
  const list = entries({
    joined: false,
    clientsById,
    streamers: new Set(['a']),
    tileOwners: new Set(['a', 'c'])
  })
  assert.deepEqual(
    list.map((e) => e.id),
    ['a', 'c']
  )
  assert.equal(list[0].streaming, true)
  assert.equal(list[0].watchable, false)
  assert.equal(list[1].watchable, false)
})

test("someone missing from the roster takes the DM's name for them, else Unknown", () => {
  const list = entries({
    participants: [{ id: ME }, { id: 'x', name: 'Xavier' }, { id: 'y' }],
    clientsById: new Map([[ME, { id: ME, name: 'Me', channel_id: DM }]])
  })
  const e = byId(list)
  assert.equal(e.x.name, 'Xavier')
  assert.equal(e.y.name, 'Unknown')
  assert.equal(e.x.inCall, false)
  assert.equal(e.x.avatar, undefined)
  assert.equal(e.y.status, 'ring')
})

test("the roster's name beats the DM's", () => {
  const e = byId(entries({ participants: [{ id: ME }, { id: 'a', name: 'Al' }] }))
  assert.equal(e.a.name, 'Alice')
})
