import assert from 'node:assert/strict'
import test from 'node:test'

import { activityAlertText, activityMessageLabel, isActivityMessage, winsTally } from './cards.js'

const started = {
  kind: 'activity_started',
  activity: { room_id: 'r1', activity_id: 'connect4', name: 'Connect 4' }
}
const ended = (extra = {}) => ({
  kind: 'activity_ended',
  activity: { room_id: 'r1', activity_id: 'connect4', name: 'Connect 4', ...extra }
})

test('only the two activity kinds are activity messages', () => {
  assert.equal(isActivityMessage({ kind: 'activity_started' }), true)
  assert.equal(isActivityMessage({ kind: 'activity_ended' }), true)
  assert.equal(isActivityMessage({ kind: 'call_started' }), false)
  assert.equal(isActivityMessage({ kind: 'default' }), false)
  assert.equal(isActivityMessage(null), false)
})

test('a started card names its author, or reads as our own', () => {
  assert.equal(activityMessageLabel(started, 'Alice'), 'Alice started Connect 4')
  assert.equal(activityMessageLabel(started, 'Alice', { isOwn: true }), 'You started Connect 4')
})

test('an ended card shows the name and the duration', () => {
  assert.equal(
    activityMessageLabel(ended({ duration_ms: 754_000 }), 'Alice'),
    'Connect 4 ended · 12:34'
  )
  assert.equal(
    activityMessageLabel(ended({ duration_ms: 3_725_000 }), 'Alice', { isOwn: true }),
    'Connect 4 ended · 1:02:05'
  )
  assert.equal(activityMessageLabel(ended(), 'Alice'), 'Connect 4 ended')
})

test('the name is the server name, untouched', () => {
  const odd = { kind: 'activity_started', activity: { activity_id: 'x', name: 'Tic-tac-toe' } }
  assert.equal(activityMessageLabel(odd, 'Bo'), 'Bo started Tic-tac-toe')
})

test('the wins tally lists the highest first and keeps ties in server order', () => {
  const names = { a: 'Alice', b: 'Bob', c: 'Cy' }
  const card = ended({
    duration_ms: 1,
    wins: [
      { client_id: 'b', wins: 1 },
      { client_id: 'a', wins: 3 },
      { client_id: 'c', wins: 1 }
    ]
  })
  assert.equal(
    winsTally(card, (id) => names[id]),
    'Alice 3 · Bob 1 · Cy 1'
  )
})

test('the wins tally names a client it does not know as Unknown', () => {
  const card = ended({ wins: [{ client_id: 'z', wins: 2 }] })
  assert.equal(
    winsTally(card, () => undefined),
    'Unknown 2'
  )
})

test('no wins, or empty wins, is no tally', () => {
  assert.equal(
    winsTally(ended(), () => 'x'),
    null
  )
  assert.equal(
    winsTally(ended({ wins: [] }), () => 'x'),
    null
  )
  assert.equal(
    winsTally(started, () => 'x'),
    null
  )
})

test('the DM alert names the author and the activity', () => {
  assert.equal(activityAlertText(started, 'Alice'), 'Alice started Connect 4')
})
