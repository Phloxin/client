import assert from 'node:assert/strict'
import test from 'node:test'

import { elapsedText } from './useElapsed.js'

test('elapsed time from the start', () => {
  assert.equal(elapsedText(1000, 1000), '0:00')
  assert.equal(elapsedText(1000, 1000 + 252_000), '4:12')
  assert.equal(elapsedText(0, 3_725_000), '1:02:05')
})

test('a start ahead of our clock reads as zero', () => {
  assert.equal(elapsedText(5000, 1000), '0:00')
})
