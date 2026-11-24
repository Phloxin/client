import test from 'node:test'
import assert from 'node:assert/strict'
import { previewRequestBody } from './previewRequest.js'

test('previewRequestBody passes a request inside the limits', () => {
  assert.deepEqual(previewRequestBody({ fps: 5, max_width: 480, max_height: 270 }), {
    fps: 5,
    max_width: 480,
    max_height: 270
  })
})

test('previewRequestBody accepts the ends of each range', () => {
  assert.deepEqual(previewRequestBody({ fps: 0, max_width: 16, max_height: 16 }), {
    fps: 0,
    max_width: 16,
    max_height: 16
  })
  assert.deepEqual(previewRequestBody({ fps: 10, max_width: 1280, max_height: 720 }), {
    fps: 10,
    max_width: 1280,
    max_height: 720
  })
})

test('previewRequestBody refuses a field outside its range', () => {
  const ok = { fps: 5, max_width: 480, max_height: 270 }
  for (const bad of [
    { fps: -1 },
    { fps: 11 },
    { max_width: 15 },
    { max_width: 1281 },
    { max_height: 15 },
    { max_height: 721 }
  ]) {
    assert.equal(previewRequestBody({ ...ok, ...bad }), null, JSON.stringify(bad))
  }
})

test('previewRequestBody refuses a stop with sizes out of range', () => {
  assert.equal(previewRequestBody({ fps: 0, max_width: 0, max_height: 0 }), null)
})

test('previewRequestBody refuses missing fields, non-integers and non-objects', () => {
  assert.equal(previewRequestBody({ fps: 5, max_width: 480 }), null)
  assert.equal(previewRequestBody({ fps: 2.5, max_width: 480, max_height: 270 }), null)
  assert.equal(previewRequestBody({ fps: '5', max_width: 480, max_height: 270 }), null)
  assert.equal(previewRequestBody(null), null)
  assert.equal(previewRequestBody(undefined), null)
  assert.equal(previewRequestBody(5), null)
})

test('previewRequestBody passes on only the protocol fields', () => {
  assert.deepEqual(
    previewRequestBody({ fps: 5, max_width: 480, max_height: 270, jpeg: 'x', close: {} }),
    { fps: 5, max_width: 480, max_height: 270 }
  )
})

import { previewOverride } from './previewRequest.js'

test('previewOverride reads <width>x<height>@<fps> within the limits', () => {
  assert.deepEqual(previewOverride('960x540@5'), { fps: 5, max_width: 960, max_height: 540 })
  assert.deepEqual(previewOverride(' 1280x720@10 '), { fps: 10, max_width: 1280, max_height: 720 })
  assert.deepEqual(previewOverride('16x16@1'), { fps: 1, max_width: 16, max_height: 16 })
})

test('previewOverride ignores anything else', () => {
  for (const raw of [
    undefined,
    null,
    '',
    'off',
    '960x540',
    '960x540@0',
    '960x540@11',
    '1281x720@5',
    '1280x721@5',
    '15x16@5',
    '960x540@5.5',
    '-960x540@5',
    '0960x540@5',
    '960X540@5',
    'large',
    42
  ]) {
    assert.equal(previewOverride(raw), null, String(raw))
  }
})

test('previewRequestBody passes a mode of jpeg or stream, and refuses any other (smooth P1)', () => {
  const ok = { fps: 10, max_width: 1280, max_height: 720 }
  assert.deepEqual(previewRequestBody({ ...ok, mode: 'stream' }), { ...ok, mode: 'stream' })
  assert.deepEqual(previewRequestBody({ ...ok, mode: 'jpeg' }), { ...ok, mode: 'jpeg' })
  // No mode: the body has no mode in it.
  assert.deepEqual(previewRequestBody(ok), ok)
  for (const bad of ['png', '', null, 1]) {
    assert.equal(previewRequestBody({ ...ok, mode: bad }), null, JSON.stringify(bad))
  }
})
