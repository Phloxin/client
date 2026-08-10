import assert from 'node:assert/strict'
import test from 'node:test'

import { fitMenuAxis } from './menuPosition.js'

test('menu placement keeps a fitting origin unchanged', () => {
  assert.equal(fitMenuAxis(100, 200, 100, 1000), 100)
})

test('menu placement flips away from an overflowing edge', () => {
  assert.equal(fitMenuAxis(900, 200, 900, 1000), 700)
})

test('menu placement clamps content that cannot fit on either side', () => {
  assert.equal(fitMenuAxis(900, 990, 900, 1000), 8)
})

test('menu placement treats the edge margin as inclusive', () => {
  assert.equal(fitMenuAxis(792, 200, 792, 1000), 792)
  assert.equal(fitMenuAxis(793, 200, 793, 1000), 593)
})
