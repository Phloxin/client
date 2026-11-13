// Kid bookkeeping for native encoders.
//   node --test src/renderer/src/lib/e2ee/engineKids.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ENGINE_KID_MAX,
  ENGINE_KID_MIN,
  createEngineKids,
  fnv1a64,
  sendingKeyHash
} from './engineKids.js'

const A = 'key-a'
const B = 'key-b'

test('kids start at 1 and never include the worker kid 0', () => {
  const kids = createEngineKids()
  assert.equal(ENGINE_KID_MIN, 1)
  assert.equal(kids.take('a', A), 1)
  assert.equal(kids.take('b', A), 2)
  assert.equal(kids.kidOf('a'), 1)
  assert.equal(kids.kidOf('nobody'), null)
  assert.deepEqual(kids.engines(), ['a', 'b'])
})

test('an engine asking again keeps its kid', () => {
  const kids = createEngineKids()
  assert.equal(kids.take('a', A), 1)
  assert.equal(kids.take('a', A), 1)
  assert.equal(kids.take('b', A), 2)
})

test('no key, no kid', () => {
  const kids = createEngineKids()
  assert.equal(kids.take('a', null), null)
  assert.equal(kids.kidOf('a'), null)
})

test('a released kid is not handed out again under the same key', () => {
  const kids = createEngineKids()
  assert.equal(kids.take('a', A), 1)
  kids.release('a')
  assert.equal(kids.kidOf('a'), null)
  assert.deepEqual(kids.engines(), [])
  // The restarted engine is a new engine, and gets a new kid.
  assert.equal(kids.take('a2', A), 2)
  kids.release('a2')
  assert.equal(kids.take('a3', A), 3)
})

test('a new key frees every kid but those of registered engines', () => {
  const kids = createEngineKids()
  kids.take('a', A)
  kids.take('b', A)
  kids.take('c', A)
  kids.release('a')
  kids.release('c')
  kids.keyChanged(B)
  // b keeps 2 under the new key, 1 and 3 are free under it.
  assert.equal(kids.kidOf('b'), 2)
  assert.equal(kids.take('d', B), 1)
  assert.equal(kids.take('e', B), 3)
  assert.equal(kids.take('f', B), 4)
})

test('a key that comes back keeps the kids used under it', () => {
  const kids = createEngineKids()
  assert.equal(kids.take('a', A), 1)
  kids.release('a')
  kids.keyChanged(B)
  assert.equal(kids.take('b', B), 1)
  kids.release('b')
  // A again (a rejoin under the same static key, say): kid 1 was used under it.
  kids.keyChanged(A)
  assert.equal(kids.take('c', A), 2)
  kids.keyChanged(B)
  assert.equal(kids.take('d', B), 3)
})

test('an engine registered across a key change holds its kid under the new key', () => {
  const kids = createEngineKids()
  assert.equal(kids.take('a', A), 1)
  kids.keyChanged(B)
  assert.equal(kids.take('b', B), 2)
  kids.release('a')
  assert.equal(kids.take('c', B), 3)
})

test('no kid left under a key is a refusal, until another key', () => {
  const kids = createEngineKids()
  for (let i = ENGINE_KID_MIN; i <= ENGINE_KID_MAX; i++) {
    assert.equal(kids.take(`e${i}`, A), i)
    kids.release(`e${i}`)
  }
  assert.equal(kids.take('late', A), null)
  assert.equal(kids.kidOf('late'), null)
  kids.keyChanged(B)
  assert.equal(kids.take('late', B), ENGINE_KID_MIN)
  kids.release('late')
  kids.keyChanged(A)
  assert.equal(kids.take('later', A), null)
})

test('with every kid held by live engines a key change frees nothing', () => {
  const kids = createEngineKids()
  for (let i = ENGINE_KID_MIN; i <= ENGINE_KID_MAX; i++) kids.take(`e${i}`, A)
  kids.keyChanged(B)
  assert.equal(kids.take('late', B), null)
  kids.release('e7')
  assert.equal(kids.take('late', B), null)
  // Kid 7 was held by e7 under B as well.
  kids.keyChanged('key-c')
  assert.equal(kids.take('late', 'key-c'), 7)
})

test('fnv1a64 matches the published test vectors', () => {
  const bytes = (text) => new TextEncoder().encode(text)
  assert.equal(fnv1a64(bytes('')), 'cbf29ce484222325')
  assert.equal(fnv1a64(bytes('a')), 'af63dc4c8601ec8c')
  assert.equal(fnv1a64(bytes('foobar')), '85944171f73967e8')
})

test('a sending key is known by its hash, which keeps none of the key', () => {
  const key = Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i)
  const copy = Uint8Array.from(key)
  const hash = sendingKeyHash({ format: 1, epoch: 7, key })
  assert.match(hash, /^[0-9a-f]{16}$/)
  // Hashing leaves the caller's key as it was.
  assert.deepEqual(key, copy)
  const keyHex = Buffer.from(key).toString('hex')
  const keyBase64 = Buffer.from(key).toString('base64')
  assert.ok(!keyHex.includes(hash) && !hash.includes(keyHex.slice(0, 8)))
  assert.ok(!hash.includes(keyBase64))
  // Format, epoch and key bytes all count.
  const prefix = new Uint8Array([1, 0, 0, 0, 7, 0, 0, 0])
  assert.equal(hash, fnv1a64([...prefix, ...key]))
  assert.equal(sendingKeyHash({ format: 1, epoch: 7, key: copy }), hash)
  assert.notEqual(sendingKeyHash({ format: 1, epoch: 8, key }), hash)
  assert.notEqual(sendingKeyHash({ format: 2, epoch: 7, key }), hash)
  copy[15] ^= 1
  assert.notEqual(sendingKeyHash({ format: 1, epoch: 7, key: copy }), hash)
  assert.equal(sendingKeyHash(null), null)
})

test('the kids remember keys by what they are given, nothing more', () => {
  const kids = createEngineKids()
  const key = Uint8Array.from({ length: 16 }, (_, i) => i * 3)
  const hash = sendingKeyHash({ format: 1, epoch: 0, key })
  kids.take('a', hash)
  kids.release('a')
  kids.keyChanged(sendingKeyHash({ format: 1, epoch: 0, key: Uint8Array.from(key) }))
  assert.equal(kids.take('b', hash), 2)
})
