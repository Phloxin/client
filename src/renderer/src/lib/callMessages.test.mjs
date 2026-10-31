import assert from 'node:assert/strict'
import test from 'node:test'

import { callMessageLabel, formatCallDuration, isCallMessage } from './callMessages.js'

test('call durations under an hour are m:ss', () => {
  assert.equal(formatCallDuration(0), '0:00')
  assert.equal(formatCallDuration(999), '0:00')
  assert.equal(formatCallDuration(65_000), '1:05')
  assert.equal(formatCallDuration(754_000), '12:34')
  assert.equal(formatCallDuration(3_599_999), '59:59')
})

test('call durations from an hour up are h:mm:ss', () => {
  assert.equal(formatCallDuration(3_600_000), '1:00:00')
  assert.equal(formatCallDuration(3_725_000), '1:02:05')
  assert.equal(formatCallDuration(36_000_000), '10:00:00')
})

test('call durations tolerate bad input', () => {
  assert.equal(formatCallDuration(-5000), '0:00')
  assert.equal(formatCallDuration(undefined), '0:00')
})

test('a started call names its author, or reads as missed', () => {
  assert.equal(callMessageLabel({ kind: 'call_started' }, 'Alice'), 'Alice started a call')
  assert.equal(
    callMessageLabel({ kind: 'call_started', missed: true }, 'Alice'),
    'Missed call from Alice'
  )
})

test('an ended call shows its duration when the server sent one', () => {
  assert.equal(
    callMessageLabel({ kind: 'call_ended', call: { duration_ms: 754_000 } }, 'Bob'),
    'Call ended · 12:34'
  )
  assert.equal(callMessageLabel({ kind: 'call_ended', call: null }, 'Bob'), 'Call ended')
  assert.equal(callMessageLabel({ kind: 'call_ended' }, 'Bob'), 'Call ended')
})

test('only the two call kinds are call messages', () => {
  assert.equal(isCallMessage({ kind: 'call_started' }), true)
  assert.equal(isCallMessage({ kind: 'call_ended' }), true)
  assert.equal(isCallMessage({ kind: 'poke' }), false)
  assert.equal(isCallMessage({ kind: 'default' }), false)
  assert.equal(isCallMessage(null), false)
})
