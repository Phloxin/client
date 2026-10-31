import assert from 'node:assert/strict'
import test from 'node:test'

import { dmDisplayName, dmOthers, inCallText } from './dm.js'

const names = { a: 'Alice', b: 'Bob', c: 'Cara' }
const nameOf = (id) => names[id]

test('the other participants come from participant_ids, without us', () => {
  assert.deepEqual(dmOthers({ participant_ids: ['a', 'me', 'b'] }, 'me'), [
    { id: 'a', name: undefined },
    { id: 'b', name: undefined }
  ])
})

test('local recipients may carry names', () => {
  assert.deepEqual(dmOthers({ recipients: ['me', { id: 'a', name: 'Al' }] }, 'me'), [
    { id: 'a', name: 'Al' }
  ])
})

test('participant_ids win over recipients', () => {
  assert.deepEqual(dmOthers({ participant_ids: ['b'], recipients: ['a'] }, 'me'), [
    { id: 'b', name: undefined }
  ])
})

test('a channel with no other participants has none', () => {
  assert.deepEqual(dmOthers({ participant_ids: ['me'] }, 'me'), [])
  assert.deepEqual(dmOthers(null, 'me'), [])
})

test('a 1:1 DM is named after the other participant', () => {
  assert.equal(dmDisplayName({ participant_ids: ['me', 'a'] }, 'me', nameOf), 'Alice')
})

test('a group DM joins every other name', () => {
  assert.equal(
    dmDisplayName({ participant_ids: ['a', 'b', 'c', 'me'] }, 'me', nameOf),
    'Alice, Bob, Cara'
  )
})

test('a name on the entry wins, and an unknown id reads as Unknown', () => {
  assert.equal(
    dmDisplayName({ recipients: [{ id: 'a', name: 'Al' }, 'z'] }, 'me', nameOf),
    'Al, Unknown'
  )
})

test('with nobody else, the channel name or a generic one', () => {
  assert.equal(dmDisplayName({ participant_ids: ['me'], name: 'Notes' }, 'me', nameOf), 'Notes')
  assert.equal(dmDisplayName({ participant_ids: ['me'] }, 'me', nameOf), 'Direct Message')
  assert.equal(dmDisplayName({ participant_ids: ['me', 'a'] }, 'me'), 'Unknown')
})

test('who is in the call reads naturally for one, two or more', () => {
  assert.equal(inCallText([]), '')
  assert.equal(inCallText(['Alice']), 'Alice is in the call')
  assert.equal(inCallText(['Alice', 'Bob']), 'Alice and Bob are in the call')
  assert.equal(inCallText(['Alice', 'Bob', 'Cara']), 'Alice, Bob and Cara are in the call')
})
