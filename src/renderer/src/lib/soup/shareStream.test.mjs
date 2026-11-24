// A share's stream is handed back once (shareStream.js).
//   node --test src/renderer/src/lib/soup/shareStream.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { releaseShareStream } from './shareStream.js'

const recorder = () => {
  const released = []
  return { released, release: (key) => released.push(key) }
}

test('a native share stopped right after its stream was created hands it back once', () => {
  const { released, release } = recorder()
  const ctx = { streamKey: '1:7:abc' }
  // stopShareContext, then the start's catch: the second is a no-op.
  assert.equal(releaseShareStream(ctx, release), true)
  assert.equal(releaseShareStream(ctx, release), false)
  assert.deepEqual(released, ['1:7:abc'])
})

test("a new stream on the same share, Chromium's after a native start failed, goes once too", () => {
  const { released, release } = recorder()
  const ctx = { streamKey: '1:7:abc' }
  releaseShareStream(ctx, release)
  ctx.streamKey = null
  ctx.streamKey = '1:7:def'
  releaseShareStream(ctx, release)
  releaseShareStream(ctx, release)
  assert.deepEqual(released, ['1:7:abc', '1:7:def'])
})

test('no stream, nothing handed back', () => {
  const { released, release } = recorder()
  assert.equal(releaseShareStream({ streamKey: null }, release), false)
  assert.equal(releaseShareStream({}, release), false)
  assert.equal(releaseShareStream(null, release), false)
  assert.deepEqual(released, [])
})

import { setShareStreamKey } from './shareStream.js'

test('a key issued again after it was handed back is handed back again (fix C6)', () => {
  const { released, release } = recorder()
  const ctx = {}
  setShareStreamKey(ctx, '1:7:abc')
  assert.equal(releaseShareStream(ctx, release), true)
  // The native start failed; Chromium's path asks again and the backend gives the same key.
  ctx.streamKey = null
  setShareStreamKey(ctx, '1:7:abc')
  assert.equal(releaseShareStream(ctx, release), true)
  // Still once per issue: the stop and the start's catch of the same issue.
  assert.equal(releaseShareStream(ctx, release), false)
  assert.deepEqual(released, ['1:7:abc', '1:7:abc'])
})
