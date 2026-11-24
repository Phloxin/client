// The requests waiting on a sidecar (engineWaiters.js).
//   node --test src/main/engineWaiters.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { engineGone, failWaiters, settleWaiter, waitFor } from './engineWaiters.js'

const newEngine = () => ({ waiting: new Map(), gone: false, exitError: null })

// Whether `promise` settles within a few turns of the event loop, and how.
async function outcome(promise) {
  const pending = Symbol('pending')
  const settled = await Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error: error.message })
    ),
    new Promise((resolve) => setTimeout(() => resolve(pending), 20))
  ])
  return settled === pending ? 'pending' : settled
}

test('an answer settles only its own waiter, once', async () => {
  const engine = newEngine()
  const hello = waitFor(engine, 'hello')
  const opened = waitFor(engine, 'opened')
  settleWaiter(engine, 'hello', null, { protocol: 1 })
  // A second answer of the same name finds no waiter.
  settleWaiter(engine, 'hello', null, { protocol: 2 })
  assert.deepEqual(await outcome(hello), { value: { protocol: 1 } })
  assert.equal(await outcome(opened), 'pending')
  failWaiters(engine, new Error('media engine closed (requested)'))
  assert.deepEqual(await outcome(opened), { error: 'media engine closed (requested)' })
  assert.equal(engine.waiting.size, 0)
})

test("the sidecar's exit fails every waiting request at once", async () => {
  const engine = newEngine()
  const ready = waitFor(engine, 'capture_ready')
  const cancelled = waitFor(engine, 'capture_cancelled')
  engineGone(engine, new Error('media engine exited (3)'))
  assert.deepEqual(await outcome(ready), { error: 'media engine exited (3)' })
  assert.deepEqual(await outcome(cancelled), { error: 'media engine exited (3)' })
})

test('a capture asked for after a sidecar died right after its hello fails, never waits', async () => {
  const engine = newEngine()
  const hello = waitFor(engine, 'hello')
  settleWaiter(engine, 'hello', null, { protocol: 1, codecs: ['H264'] })
  assert.deepEqual(await outcome(hello), { value: { protocol: 1, codecs: ['H264'] } })
  // It exits before the capture's waiters are made: those fail at once with its exit.
  engineGone(engine, new Error('media engine exited (SIGKILL)'))
  const ready = waitFor(engine, 'capture_ready')
  const cancelled = waitFor(engine, 'capture_cancelled')
  const capture = Promise.race([
    ready.then((body) => ({ ready: body })),
    cancelled.then(() => ({ cancelled: true }))
  ])
  assert.deepEqual(await outcome(capture), { error: 'media engine exited (SIGKILL)' })
  assert.equal(engine.waiting.size, 0)
})

test('a gone engine without its exit error still fails a request', async () => {
  const engine = { ...newEngine(), gone: true }
  assert.deepEqual(await outcome(waitFor(engine, 'opened')), { error: 'media engine exited' })
})
