// Reuse of RNNoise worklet nodes per AudioContext.
//   node --test src/renderer/src/lib/soup/rnnoiseNodePool.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { createRnnoiseNodePool } from './rnnoiseNodePool.js'

function fakeContext(state = 'running') {
  return { state }
}

function fakeFactory() {
  const created = []
  const createNode = async (context) => {
    const node = {
      context,
      disconnects: 0,
      disconnect() {
        this.disconnects++
      }
    }
    created.push(node)
    return node
  }
  return { createNode, created }
}

test('a released node is handed to the next acquire on that context', async () => {
  const { createNode, created } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const context = fakeContext()

  const first = await pool.acquire(context)
  pool.release(context, first)
  const second = await pool.acquire(context)

  assert.equal(second, first)
  assert.equal(created.length, 1)
})

test('two acquires at the same time give two different nodes', async () => {
  const { createNode, created } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const context = fakeContext()
  pool.release(context, await pool.acquire(context))

  const [a, b] = await Promise.all([pool.acquire(context), pool.acquire(context)])

  assert.notEqual(a, b)
  assert.equal(created.length, 2)
})

test('releasing the same node twice keeps one idle entry', async () => {
  const { createNode, created } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const context = fakeContext()

  const node = await pool.acquire(context)
  pool.release(context, node)
  pool.release(context, node)

  assert.equal(await pool.acquire(context), node)
  const next = await pool.acquire(context)
  assert.notEqual(next, node)
  assert.equal(created.length, 2)
})

test('nodes are kept per context', async () => {
  const { createNode, created } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const contextA = fakeContext()
  const contextB = fakeContext()

  const nodeA = await pool.acquire(contextA)
  pool.release(contextA, nodeA)
  const nodeB = await pool.acquire(contextB)

  assert.notEqual(nodeB, nodeA)
  assert.equal(nodeB.context, contextB)
  assert.equal(await pool.acquire(contextA), nodeA)
  assert.equal(created.length, 2)
})

test('a node of a closed context is not kept', async () => {
  const { createNode, created } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const context = fakeContext()

  const node = await pool.acquire(context)
  context.state = 'closed'
  pool.release(context, node)

  const next = await pool.acquire(context)
  assert.notEqual(next, node)
  assert.equal(created.length, 2)
})

test('release disconnects the node', async () => {
  const { createNode } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const context = fakeContext()

  const node = await pool.acquire(context)
  pool.release(context, node)

  assert.equal(node.disconnects, 1)
})

test('a disconnect that throws does not stop the release', async () => {
  const { createNode } = fakeFactory()
  const pool = createRnnoiseNodePool(createNode)
  const context = fakeContext()

  const node = await pool.acquire(context)
  node.disconnect = () => {
    throw new Error('already disconnected')
  }
  pool.release(context, node)

  assert.equal(await pool.acquire(context), node)
})

test('a failing factory rejects the acquire and a later acquire still works', async () => {
  const { createNode, created } = fakeFactory()
  let fail = true
  const pool = createRnnoiseNodePool(async (context) => {
    if (fail) throw new Error('worklet load failed')
    return createNode(context)
  })
  const context = fakeContext()

  await assert.rejects(pool.acquire(context), /worklet load failed/)
  fail = false
  const node = await pool.acquire(context)

  assert.equal(created.length, 1)
  assert.equal(node, created[0])
  pool.release(context, node)
  assert.equal(await pool.acquire(context), node)
})
