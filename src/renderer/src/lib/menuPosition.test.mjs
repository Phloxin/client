// Self-check for the menu placement math in menuPosition.js. The `fit` logic is
// duplicated here rather than exported — it's four lines, and exporting it just
// to test it would be more code than the copy.
//   node src/renderer/src/lib/menuPosition.test.mjs
import assert from 'node:assert/strict'

const MARGIN = 8
const fit = (start, size, cursor, limit) => {
  if (start + size <= limit - MARGIN) return start
  const flipped = cursor - size
  return flipped >= MARGIN ? flipped : Math.max(MARGIN, limit - size - MARGIN)
}

// Fits where it is → unchanged.
assert.equal(fit(100, 200, 100, 1000), 100)

// Overflows the far edge but fits flipped → opens back toward the cursor.
assert.equal(fit(900, 200, 900, 1000), 700)

// Too big to fit on either side → clamped inside, never negative.
assert.equal(fit(900, 990, 900, 1000), MARGIN)

// Exactly touching the margin still counts as fitting.
assert.equal(fit(792, 200, 792, 1000), 792)
assert.equal(fit(793, 200, 793, 1000), 593)

console.log('menuPosition: ok')
