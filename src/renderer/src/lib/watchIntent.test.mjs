import assert from 'node:assert/strict'
import { test } from 'node:test'

import { isProducerWatched, resolveWatchIntent } from './watchIntent.js'

// Miniature of soup.js's watch bookkeeping. Consumes complete asynchronously and
// only then appear in `activeConsumers` — exactly the window the resolver exists
// to cover — so the sequencing here mirrors setWatchedProducers() rather than
// testing the diff in isolation.
function createSession() {
  const videoProducers = new Map()
  const screenAudioProducers = new Map()
  const activeConsumers = new Map()
  const pendingConsumes = new Map()
  const landings = [] // resolvers for consumes that haven't completed yet
  const closeBatches = [] // CloseConsumer batches sent to the server
  let watchedProducerIds = new Set()
  let watchedClientIds = new Set()
  let nextConsumerId = 1
  let consumeCalls = 0

  const producerIsWatched = (producerId) =>
    isProducerWatched({
      producerId,
      watchedProducerIds,
      watchedClientIds,
      videoProducers,
      screenAudioProducers
    })

  const consume = ({ producerId, kind, clientId, producedType }) => {
    consumeCalls++
    let land
    const landed = new Promise((resolve) => {
      land = resolve
    }).then(() => {
      // Close-then-replace, like doConsumeProducer's supersede guard.
      const existing = activeConsumers.get(producerId)
      if (existing) closeBatches.push([existing.consumerId])
      activeConsumers.set(producerId, {
        kind,
        producedType,
        clientId,
        consumerId: nextConsumerId++
      })
    })
    const registered = landed.finally(() => {
      if (pendingConsumes.get(producerId) === registered) {
        pendingConsumes.delete(producerId)
      }
    })
    pendingConsumes.set(producerId, registered)
    landings.push(land)
    return registered
  }

  const closeConsumeWhenItLands = (producerId, { forceClose = false } = {}) => {
    const pending = pendingConsumes.get(producerId)
    if (!pending) return
    pending.then(() => {
      if (!forceClose && producerIsWatched(producerId)) return
      const entry = activeConsumers.get(producerId)
      if (!entry) return
      activeConsumers.delete(producerId)
      closeBatches.push([entry.consumerId])
    })
  }

  const setWatched = (requestedProducerIds) => {
    const intent = resolveWatchIntent({
      requestedProducerIds,
      videoProducers,
      screenAudioProducers,
      activeConsumers,
      pendingConsumeIds: pendingConsumes.keys()
    })
    watchedProducerIds = intent.watchedProducerIds
    watchedClientIds = intent.watchedClientIds

    const closedIds = []
    for (const { producerId, consumerId } of intent.close) {
      closedIds.push(consumerId)
      activeConsumers.delete(producerId)
    }
    if (closedIds.length > 0) closeBatches.push(closedIds)
    for (const producerId of intent.abandon) closeConsumeWhenItLands(producerId)
    for (const item of intent.consume) consume(item)
    return intent
  }

  // Let every queued consume land, including ones queued while draining.
  const flush = async () => {
    while (landings.length > 0) {
      landings.shift()()
      await new Promise((resolve) => setImmediate(resolve))
    }
  }

  const closeProducer = (producerId) => {
    videoProducers.delete(producerId)
    screenAudioProducers.delete(producerId)
    if (!pendingConsumes.has(producerId)) return
    closeConsumeWhenItLands(producerId, { forceClose: true })
  }

  return {
    videoProducers,
    screenAudioProducers,
    activeConsumers,
    closeBatches,
    closeProducer,
    setWatched,
    flush,
    consumeCount: () => consumeCalls
  }
}

test('watch → unwatch → watch does not start a second consumer for one producer', async () => {
  const session = createSession()
  session.videoProducers.set('p1', { clientId: 'c1', producedType: 'ScreenShare' })

  session.setWatched(['p1'])
  // Nothing landed yet, so there is no consumer to close — the unwatch can only
  // be expressed as an abandon.
  const unwatch = session.setWatched([])
  assert.deepEqual(unwatch.close, [])
  assert.deepEqual(unwatch.abandon, ['p1'])

  // Re-watching while the first consume is still in flight must reuse it.
  const rewatch = session.setWatched(['p1'])
  assert.deepEqual(rewatch.consume, [])
  assert.equal(session.consumeCount(), 1)

  await session.flush()
  assert.equal(session.activeConsumers.size, 1)
  assert.equal(session.consumeCount(), 1)
  assert.deepEqual(session.closeBatches, [])
})

test('a consume abandoned mid-flight is closed as soon as it lands', async () => {
  const session = createSession()
  session.videoProducers.set('p1', { clientId: 'c1', producedType: 'ScreenShare' })

  session.setWatched(['p1'])
  session.setWatched([])
  await session.flush()

  assert.equal(session.activeConsumers.size, 0)
  assert.deepEqual(session.closeBatches, [[1]])
})

test('a producer closing during its consume cannot leave a ghost subscription', async () => {
  const session = createSession()
  session.videoProducers.set('p1', { clientId: 'c1', producedType: 'ScreenShare' })

  session.setWatched(['p1'])
  session.closeProducer('p1')
  await session.flush()

  assert.equal(session.activeConsumers.size, 0)
  assert.deepEqual(session.closeBatches, [[1]])
})

test('a landed consumer is closed in the caller batch, not deferred', async () => {
  const session = createSession()
  session.videoProducers.set('p1', { clientId: 'c1', producedType: 'ScreenShare' })

  session.setWatched(['p1'])
  await session.flush()
  const unwatch = session.setWatched([])

  assert.deepEqual(unwatch.abandon, [])
  assert.deepEqual(unwatch.close, [{ producerId: 'p1', kind: 'video', consumerId: 1 }])
  assert.deepEqual(session.closeBatches, [[1]])
})

test('screen audio follows the watched client and closes with the stream', async () => {
  const session = createSession()
  session.videoProducers.set('p1', { clientId: 'c1', producedType: 'ScreenShare' })
  session.screenAudioProducers.set('a1', { clientId: 'c1' })

  session.setWatched(['p1'])
  await session.flush()
  assert.equal(session.activeConsumers.size, 2)

  const unwatch = session.setWatched([])
  assert.deepEqual(unwatch.close.map((item) => item.kind).sort(), ['screenAudio', 'video'])
  assert.equal(session.activeConsumers.size, 0)
})

test('screen audio arriving during an in-flight video consume is not consumed twice', async () => {
  const session = createSession()
  session.videoProducers.set('p1', { clientId: 'c1', producedType: 'ScreenShare' })
  session.screenAudioProducers.set('a1', { clientId: 'c1' })

  session.setWatched(['p1'])
  // A second watch pass while both consumes are still in flight (the carousel
  // re-asserting its intent) must not duplicate either of them.
  const again = session.setWatched(['p1'])
  assert.deepEqual(again.consume, [])

  await session.flush()
  assert.equal(session.consumeCount(), 2)
  assert.equal(session.activeConsumers.size, 2)
})

test('producer ids the client does not know about are ignored', () => {
  const session = createSession()
  const intent = session.setWatched(['ghost'])

  assert.deepEqual(intent.consume, [])
  assert.equal(intent.watchedProducerIds.size, 0)
  assert.equal(session.consumeCount(), 0)
})

test('mic audio is never watch-gated', () => {
  const videoProducers = new Map()
  const screenAudioProducers = new Map([['a1', { clientId: 'c1' }]])

  assert.equal(
    isProducerWatched({
      producerId: 'mic1',
      watchedProducerIds: new Set(),
      watchedClientIds: new Set(),
      videoProducers,
      screenAudioProducers
    }),
    true
  )
  assert.equal(
    isProducerWatched({
      producerId: 'a1',
      watchedProducerIds: new Set(),
      watchedClientIds: new Set(),
      videoProducers,
      screenAudioProducers
    }),
    false
  )
})
