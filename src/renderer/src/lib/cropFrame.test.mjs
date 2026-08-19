import assert from 'node:assert/strict'
import test from 'node:test'

import { clampOffset, coverScale, minZoom, scaledSize } from './cropFrame.js'

test('cover fit scales the shorter side up to the frame', () => {
  assert.equal(coverScale(512, 1024, 256), 0.5)
  assert.deepEqual(scaledSize(512, 1024, 256, 1), { w: 256, h: 512 })
})

test('a cover-fit image can only pan along its overflowing axis', () => {
  // 256x512 drawn in a 256 frame: 128px of slack top and bottom, none sideways.
  assert.deepEqual(clampOffset(50, 50, 512, 1024, 256, 1), { x: 0, y: 50 })
  assert.deepEqual(clampOffset(0, 999, 512, 1024, 256, 1), { x: 0, y: 128 })
  assert.deepEqual(clampOffset(0, -999, 512, 1024, 256, 1), { x: 0, y: -128 })
})

test('the zoom floor fits the whole image inside the frame, with margin', () => {
  // 512x1024 at the contain fit (0.5 of cover) is exactly 128x256; the 0.8
  // margin shrinks it further, so nothing overhangs.
  assert.equal(minZoom(512, 1024), 0.4)
  const { w, h } = scaledSize(512, 1024, 256, minZoom(512, 1024))
  assert.ok(w <= 256 && h <= 256)
  // Nothing to pan once the image sits inside the frame.
  assert.deepEqual(clampOffset(99, 99, 512, 1024, 256, minZoom(512, 1024)), { x: 0, y: 0 })
})

test('zooming in opens up slack on both axes', () => {
  // Square image at 2x: 512x512 drawn in a 256 frame, 128px of slack each way.
  assert.deepEqual(clampOffset(999, -999, 400, 400, 256, 2), { x: 128, y: -128 })
})
