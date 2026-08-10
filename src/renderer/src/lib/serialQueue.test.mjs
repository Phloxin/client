import assert from 'node:assert/strict'
import test from 'node:test'

import { createSerialQueue } from './serialQueue.js'

test('operations run in submission order without overlapping', async () => {
  const enqueue = createSerialQueue()
  const events = []
  let releaseFirst

  const first = enqueue(async () => {
    events.push('first:start')
    await new Promise((resolve) => {
      releaseFirst = resolve
    })
    events.push('first:end')
    return 'first result'
  })
  const second = enqueue(async () => {
    events.push('second:start')
    return 'second result'
  })

  await Promise.resolve()
  assert.deepEqual(events, ['first:start'])

  releaseFirst()
  assert.equal(await first, 'first result')
  assert.equal(await second, 'second result')
  assert.deepEqual(events, ['first:start', 'first:end', 'second:start'])
})

test('a rejected operation does not poison the queue', async () => {
  const enqueue = createSerialQueue()
  const expected = new Error('expected failure')

  await assert.rejects(
    enqueue(() => Promise.reject(expected)),
    expected
  )
  await assert.doesNotReject(enqueue(() => 'recovered'))
  assert.equal(await enqueue(() => 42), 42)
})
