import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OUTGOING_RING_TTL_MS,
  applyReady,
  applyRingEnded,
  applyRinging,
  expire,
  isMissedRing,
  settleOutgoing,
  startOutgoing
} from './rings.js'

const NOW = 1_000_000

test('Ready rebuilds the map and drops rings already over', () => {
  const stale = new Map([['old', { callerId: 'x', deadline: NOW + 5000 }]])
  const rings = applyReady(
    stale,
    [
      { channel_id: 'd1', caller_id: 'a', deadline: NOW + 1000 },
      { channel_id: 'd2', caller_id: 'b', deadline: NOW },
      { channel_id: 'd3', caller_id: 'c', deadline: NOW - 1 }
    ],
    NOW
  )
  assert.deepEqual([...rings], [['d1', { callerId: 'a', deadline: NOW + 1000 }]])
  assert.equal(applyReady(stale, undefined, NOW).size, 0)
})

test('CallRinging adds a ring and says whether it is new', () => {
  const first = applyRinging(
    new Map(),
    { channel_id: 'd1', caller_id: 'a', deadline: NOW + 25_000 },
    NOW,
    null
  )
  assert.equal(first.added, true)
  assert.deepEqual(first.rings.get('d1'), { callerId: 'a', deadline: NOW + 25_000 })

  const again = applyRinging(
    first.rings,
    { channel_id: 'd1', caller_id: 'b', deadline: NOW + 30_000 },
    NOW,
    null
  )
  assert.equal(again.added, false)
  assert.deepEqual(again.rings.get('d1'), { callerId: 'b', deadline: NOW + 30_000 })
})

test('CallRinging past its deadline, or for the DM we are in, is ignored', () => {
  const rings = new Map()
  const late = applyRinging(rings, { channel_id: 'd1', caller_id: 'a', deadline: NOW }, NOW, null)
  assert.equal(late.rings, rings)
  assert.equal(late.added, false)
  const inCall = applyRinging(
    rings,
    { channel_id: 'd1', caller_id: 'a', deadline: NOW + 1000 },
    NOW,
    'd1'
  )
  assert.equal(inCall.rings, rings)
  assert.equal(inCall.added, false)
})

test('CallRingEnded removes the ring whatever the reason and returns it', () => {
  const rings = new Map([['d1', { callerId: 'a', deadline: NOW + 1000 }]])
  const { rings: next, ended } = applyRingEnded(rings, { channel_id: 'd1', reason: 'declined' })
  assert.equal(next.size, 0)
  assert.deepEqual(ended, {
    channelId: 'd1',
    callerId: 'a',
    deadline: NOW + 1000,
    reason: 'declined'
  })
  const none = applyRingEnded(next, { channel_id: 'd1', reason: 'ended' })
  assert.equal(none.rings, next)
  assert.equal(none.ended, null)
})

test('expire drops rings at or past their deadline as expired', () => {
  const rings = new Map([
    ['d1', { callerId: 'a', deadline: NOW }],
    ['d2', { callerId: 'b', deadline: NOW + 1 }]
  ])
  const { rings: next, expired } = expire(rings, NOW)
  assert.deepEqual([...next.keys()], ['d2'])
  assert.deepEqual(expired, [{ channelId: 'd1', callerId: 'a', deadline: NOW, reason: 'expired' }])
  const quiet = expire(next, NOW)
  assert.equal(quiet.rings, next)
  assert.deepEqual(quiet.expired, [])
})

test('only expired and ended rings were missed', () => {
  assert.equal(isMissedRing('expired'), true)
  assert.equal(isMissedRing('ended'), true)
  assert.equal(isMissedRing('answered'), false)
  assert.equal(isMissedRing('declined'), false)
})

test('outgoing rings start and refresh with a ttl', () => {
  const started = startOutgoing(new Map(), ['a', 'b'], NOW)
  assert.deepEqual(
    [...started],
    [
      ['a', NOW + OUTGOING_RING_TTL_MS],
      ['b', NOW + OUTGOING_RING_TTL_MS]
    ]
  )
  const refreshed = startOutgoing(started, ['a'], NOW + 10_000, 5000)
  assert.equal(refreshed.get('a'), NOW + 15_000)
  assert.equal(refreshed.get('b'), NOW + OUTGOING_RING_TTL_MS)
  assert.equal(startOutgoing(started, [], NOW), started)
})

test('outgoing rings settle when the recipient joins or the ring runs out', () => {
  const outgoing = new Map([
    ['a', NOW + 1000],
    ['b', NOW + 1000],
    ['c', NOW]
  ])
  assert.deepEqual([...settleOutgoing(outgoing, ['a'], NOW).keys()], ['b'])
  const live = new Map([['b', NOW + 1000]])
  assert.equal(settleOutgoing(live, new Set(['z']), NOW), live)
})
