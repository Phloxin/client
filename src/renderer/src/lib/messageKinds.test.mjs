import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isUnknownMessage } from './messageKinds.js'

test('kinds this client draws are known', () => {
  for (const kind of ['default', 'poke', 'call_started', 'call_ended', 'activity']) {
    assert.equal(isUnknownMessage({ kind }), false, kind)
  }
})

test('a missing kind is a plain message', () => {
  assert.equal(isUnknownMessage({}), false)
  assert.equal(isUnknownMessage(null), false)
})

test('a kind from a newer server is unknown', () => {
  assert.equal(isUnknownMessage({ kind: 'something_new' }), true)
})
