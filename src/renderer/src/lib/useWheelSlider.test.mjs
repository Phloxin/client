// Self-check for the wheel step math in useWheelSlider.js. The hook itself
// needs a DOM, but the value math is pure and is where the bugs live.
//   node src/renderer/src/lib/useWheelSlider.test.mjs
import assert from 'node:assert/strict'
import { nextWheelValue } from './useWheelSlider.js'

const step = (current, deltaY) => nextWheelValue(current, deltaY, 5, 0, 200)

// Wheel up raises, wheel down lowers.
assert.equal(step(100, -1), 105)
assert.equal(step(100, 1), 95)

// Off-grid values snap onto the grid rather than staying off it.
assert.equal(step(103, -1), 105)
assert.equal(step(103, 1), 100)

// Clamped at both ends, never past them.
assert.equal(step(200, -1), 200)
assert.equal(step(0, 1), 0)
assert.equal(step(198, -1), 200)
assert.equal(step(2, 1), 0)

// A wheel event with no vertical delta (horizontal trackpad swipe) changes nothing.
assert.equal(step(100, 0), 100)

console.log('useWheelSlider: ok')
