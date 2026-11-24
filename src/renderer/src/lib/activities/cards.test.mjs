import assert from 'node:assert/strict'
import test from 'node:test'

import { FALLBACK_ACTIVITY_TYPE, activityType } from './activityTypes.js'
import {
  activityAlertText,
  activityCardMeta,
  activityCardModel,
  activityFooterLabel,
  activityMessageLabel,
  clientLookup,
  hasTrophy,
  isActivityMessage,
  sortResults
} from './cards.js'
test('only the activity kinds are activity messages', () => {
  assert.equal(isActivityMessage({ kind: 'activity' }), true)
  assert.equal(isActivityMessage({ kind: 'call_started' }), false)
  assert.equal(isActivityMessage({ kind: 'default' }), false)
  assert.equal(isActivityMessage(null), false)
})

const card = (activity = {}, extra = {}) => ({
  kind: 'activity',
  authorId: 'u1',
  ts: 1_000_000,
  activity: { room_id: 'r1', activity_id: 'chess', name: 'Chess', ...activity },
  ...extra
})
const openRoom = (extra = {}) => ({
  id: 'r1',
  channel_id: 'c1',
  activity_id: 'chess',
  creator: 'u1',
  clients: ['u1', 'u2'],
  opened_at: 1_000_000,
  ...extra
})
const endedCard = (ended) => card({ ended: { duration_ms: 252_000, participants: [], ...ended } })

test('a card with an open room is live and shows the room', () => {
  const m = activityCardModel(card(), openRoom())
  assert.equal(m.status, 'live')
  assert.equal(m.name, 'Chess')
  assert.equal(m.activityId, 'chess')
  assert.equal(m.roomId, 'r1')
  assert.equal(m.startedAt, 1_000_000)
  assert.equal(m.endedAt, null)
  assert.equal(m.durationMs, null)
  assert.deepEqual(m.participants, ['u1', 'u2'])
  assert.equal(m.results, null)
  assert.equal(m.footer, 'room')
  assert.equal(m.detail, null)
})

test('a live card carries the room detail', () => {
  const m = activityCardModel(card(), openRoom({ detail: 'Now playing: Watches' }))
  assert.equal(m.detail, 'Now playing: Watches')
})

test('an ended card has its times, its duration and the participants', () => {
  const m = activityCardModel(endedCard({ participants: ['u2', 'u1'] }), null)
  assert.equal(m.status, 'ended')
  assert.equal(m.endedAt, 1_252_000)
  assert.equal(m.durationMs, 252_000)
  assert.deepEqual(m.participants, ['u2', 'u1'])
  assert.equal(m.detail, null)
})

test('ended wins over a room still in the list', () => {
  const m = activityCardModel(endedCard({ participants: ['u1'] }), openRoom({ detail: 'x' }))
  assert.equal(m.status, 'ended')
  assert.deepEqual(m.participants, ['u1'])
  assert.equal(m.detail, null)
  assert.equal(m.footer, 'participants')
})

test('no ended and no room is ended with nothing known', () => {
  const m = activityCardModel(card(), null)
  assert.equal(m.status, 'ended')
  assert.equal(m.endedAt, null)
  assert.equal(m.durationMs, null)
  assert.deepEqual(m.participants, [])
  assert.equal(m.results, null)
  assert.equal(m.summary, null)
  assert.equal(m.footer, null)
})

test('one clear top score gets the scoreboard and the trophy', () => {
  const m = activityCardModel(
    endedCard({
      participants: ['a', 'b'],
      results: [
        { client_id: 'b', score: 1 },
        { client_id: 'a', score: 3 }
      ]
    }),
    null
  )
  assert.equal(m.footer, 'scoreboard')
  assert.deepEqual(m.results, [
    { clientId: 'a', score: 3 },
    { clientId: 'b', score: 1 }
  ])
  assert.equal(m.trophy, true)
})

test('a tie for first gets no trophy', () => {
  const m = activityCardModel(
    endedCard({
      results: [
        { client_id: 'a', score: 2 },
        { client_id: 'b', score: 2 },
        { client_id: 'c', score: 1 }
      ]
    }),
    null
  )
  assert.equal(m.trophy, false)
  assert.deepEqual(
    m.results.map((r) => r.clientId),
    ['a', 'b', 'c']
  )
})

test('more than four results are all kept, sorted', () => {
  const results = [1, 5, 0, 3, 4, 2].map((score, i) => ({ client_id: `p${i}`, score }))
  const m = activityCardModel(endedCard({ results }), null)
  assert.deepEqual(
    m.results.map((r) => r.score),
    [5, 4, 3, 2, 1, 0]
  )
})

test('the sort puts zero scores last and keeps ties in server order', () => {
  const sorted = sortResults([
    { client_id: 'z1', score: 0 },
    { client_id: 'a', score: 2 },
    { client_id: 'z2', score: 0 },
    { client_id: 'b', score: 2 },
    { client_id: 7, score: 1 }
  ])
  assert.deepEqual(sorted, [
    { clientId: 'a', score: 2 },
    { clientId: 'b', score: 2 },
    { clientId: '7', score: 1 },
    { clientId: 'z1', score: 0 },
    { clientId: 'z2', score: 0 }
  ])
  assert.equal(sortResults(undefined), null)
  assert.equal(sortResults([]), null)
})

test('the trophy needs a single holder of the top score', () => {
  assert.equal(hasTrophy([{ clientId: 'a', score: 1 }]), true)
  assert.equal(
    hasTrophy([
      { clientId: 'a', score: 3 },
      { clientId: 'b', score: 0 }
    ]),
    true
  )
  assert.equal(
    hasTrophy([
      { clientId: 'a', score: 0 },
      { clientId: 'b', score: 0 }
    ]),
    false
  )
  assert.equal(hasTrophy(null), false)
  assert.equal(hasTrophy([]), false)
})

test('empty results means no scoreboard', () => {
  const m = activityCardModel(endedCard({ participants: ['a'], results: [] }), null)
  assert.equal(m.results, null)
  assert.equal(m.footer, 'participants')
})

test('ended without results labels the participants with the verb and the summary', () => {
  const m = activityCardModel(endedCard({ participants: ['a', 'b', 'c', 'd'] }), null)
  assert.equal(activityFooterLabel(m, 'watched'), '4 watched')
  const withSummary = activityCardModel(
    endedCard({ participants: ['a', 'b', 'c', 'd'], summary: '3 videos' }),
    null
  )
  assert.equal(withSummary.summary, '3 videos')
  assert.equal(activityFooterLabel(withSummary, 'watched'), '4 watched · 3 videos')
})

test('participant counts of one, none and many', () => {
  const one = activityCardModel(endedCard({ participants: ['a'] }), null)
  assert.equal(activityFooterLabel(one, 'played'), '1 played')
  const none = activityCardModel(endedCard({ participants: [], summary: '2 videos' }), null)
  assert.equal(activityFooterLabel(none, 'played'), 'No one joined')
  const many = activityCardModel(endedCard({ participants: ['a', 'b', 'c', 'd', 'e'] }), null)
  assert.equal(many.participants.length, 5)
  assert.equal(activityFooterLabel(many, 'played'), '5 played')
})

test('the live footer counts who is in the room', () => {
  assert.equal(activityFooterLabel(activityCardModel(card(), openRoom()), 'played'), '2 in room')
  assert.equal(
    activityFooterLabel(activityCardModel(card(), openRoom({ clients: [] })), 'played'),
    'No one here yet'
  )
  const many = activityCardModel(card(), openRoom({ clients: ['a', 'b', 'c', 'd'] }))
  assert.equal(activityFooterLabel(many, 'played'), '4 in room')
})

test('an unknown activity id keeps the server name and falls back on the look', () => {
  const m = activityCardModel(card({ activity_id: 'darts', name: 'Darts' }), openRoom())
  assert.equal(m.name, 'Darts')
  assert.equal(m.activityId, 'darts')
  assert.equal(activityType('darts'), FALLBACK_ACTIVITY_TYPE)
  assert.equal(activityType('toString'), FALLBACK_ACTIVITY_TYPE)
  assert.equal(activityType('darts').endedVerb, 'took part')
  assert.equal(activityType('watch_together').endedVerb, 'watched')
  assert.equal(activityType('chess').endedVerb, 'played')
  assert.notEqual(activityType('chess').icon, FALLBACK_ACTIVITY_TYPE.icon)
})

test('the meta line reads from the viewer side', () => {
  const formatTime = (ts) => `t${ts}`
  const live = activityCardModel(card(), openRoom())
  assert.equal(
    activityCardMeta(live, { creatorName: 'Alice', formatTime }),
    'Started by Alice at t1000000'
  )
  assert.equal(
    activityCardMeta(live, { creatorName: 'Alice', isOwn: true, formatTime }),
    'Started by you at t1000000'
  )
  const done = activityCardModel(endedCard({}), null)
  assert.equal(
    activityCardMeta(done, { creatorName: 'Alice', formatTime }),
    't1000000 to t1252000 · 4:12'
  )
  const unknown = activityCardModel(card(), null)
  assert.equal(
    activityCardMeta(unknown, { creatorName: 'Alice', formatTime }),
    'Started by Alice at t1000000'
  )
})

test('an activity card reads as a started line in a reply and an alert, ended or not', () => {
  assert.equal(isActivityMessage({ kind: 'activity' }), true)
  assert.equal(activityMessageLabel(card(), 'Alice'), 'Alice started Chess')
  assert.equal(activityMessageLabel(card(), 'Alice', { isOwn: true }), 'You started Chess')
  assert.equal(activityMessageLabel(endedCard({}), 'Alice'), 'Alice started Chess')
  assert.equal(activityAlertText(card(), 'Alice'), 'Alice started Chess')
  assert.equal(activityAlertText(endedCard({}), 'Alice'), 'Alice started Chess')
})

test('the roster lookup matches ids as strings and knows no one else', () => {
  const lookup = clientLookup([
    { id: 5, name: 'alice', avatar: 'a.png' },
    { id: '6', name: 'Bob' }
  ])
  assert.deepEqual(lookup('5'), { name: 'alice', avatar: 'a.png', initial: 'A' })
  assert.deepEqual(lookup(6), { name: 'Bob', avatar: null, initial: 'B' })
  assert.deepEqual(lookup('9'), { name: 'Unknown', avatar: null, initial: '?' })
  assert.deepEqual(clientLookup(undefined)('1'), { name: 'Unknown', avatar: null, initial: '?' })
})
