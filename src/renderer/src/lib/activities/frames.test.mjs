import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CONTROL_BODY,
  createFrameReader,
  decodeControl,
  decodeDatagram,
  encodeAction,
  encodeControl,
  encodeDatagram,
  isNewerSeq,
  parseStateFrame
} from './frames.js'

const bytes = (...b) => new Uint8Array(b)
const text = (u8) => new TextDecoder().decode(u8)

test('a control frame is a big-endian length, then the JSON body', () => {
  const frame = encodeControl({ t: 'join', ticket: 'abc' })
  const body = '{"t":"join","ticket":"abc"}'
  assert.equal(frame.length, 4 + body.length)
  assert.deepEqual([...frame.subarray(0, 4)], [0, 0, 0, body.length])
  assert.equal(text(frame.subarray(4)), body)
})

test('the length counts UTF-8 bytes, not characters', () => {
  const frame = encodeControl({ s: 'é🎲' })
  const length = new DataView(frame.buffer).getUint32(0)
  assert.equal(length, new TextEncoder().encode('{"s":"é🎲"}').length)
  assert.equal(length, frame.length - 4)
})

test('a control frame that does not serialize is null', () => {
  assert.equal(encodeControl({ n: 1n }), null)
  const cycle = {}
  cycle.self = cycle
  assert.equal(encodeControl(cycle), null)
  assert.equal(encodeControl(undefined), null)
})

test('a control body decodes to its object, anything else to null', () => {
  const enc = (s) => new TextEncoder().encode(s)
  assert.deepEqual(decodeControl(enc('{"t":"ok","id":3,"generation":9}')), {
    t: 'ok',
    id: 3,
    generation: 9
  })
  assert.equal(decodeControl(enc('[1,2]')), null)
  assert.equal(decodeControl(enc('null')), null)
  assert.equal(decodeControl(enc('{nope')), null)
  assert.equal(decodeControl(bytes(0xff, 0xfe)), null)
})

test('an action carries its data as is and reports its body length', () => {
  const action = encodeAction(7, { type: 'drop', column: 3 })
  assert.equal(action.body, action.frame.length - 4)
  assert.deepEqual(decodeControl(action.frame.subarray(4)), {
    t: 'action',
    id: 7,
    data: { type: 'drop', column: 3 }
  })
  assert.deepEqual(decodeControl(encodeAction(1, null).frame.subarray(4)).data, null)
  assert.equal(decodeControl(encodeAction(1, 0).frame.subarray(4)).data, 0)
})

test('an action without data that survives JSON is refused', () => {
  assert.equal(encodeAction(1, undefined), null)
  assert.equal(
    encodeAction(1, () => 1),
    null
  )
  assert.equal(encodeAction(1, 1n), null)
  assert.equal(encodeAction(1, Symbol('x')), null)
})

test('an action body can be measured against the server limit', () => {
  const pad = (n) => 'x'.repeat(n)
  const overhead = encodeAction(1, '').body
  assert.equal(encodeAction(1, pad(MAX_CONTROL_BODY - overhead)).body, MAX_CONTROL_BODY)
  assert.equal(encodeAction(1, pad(MAX_CONTROL_BODY - overhead + 1)).body, MAX_CONTROL_BODY + 1)
})

test('the reader returns frames split across any chunking', () => {
  const a = encodeControl({ t: 'clients', clients: ['1', '2'] })
  const b = encodeControl({ t: 'closed', reason: 'empty' })
  const stream = new Uint8Array([...a, ...b])
  for (let size = 1; size <= stream.length; size++) {
    const reader = createFrameReader()
    const got = []
    for (let i = 0; i < stream.length; i += size)
      got.push(...reader.push(stream.subarray(i, i + size)))
    assert.deepEqual(got.map(decodeControl), [
      { t: 'clients', clients: ['1', '2'] },
      { t: 'closed', reason: 'empty' }
    ])
    assert.equal(reader.pending, 0)
  }
})

test('the reader returns several frames from one chunk, and holds a partial one', () => {
  const reader = createFrameReader()
  const one = encodeControl({ a: 1 })
  const two = encodeControl({ b: 2 })
  const three = encodeControl({ c: 3 })
  const got = reader.push(new Uint8Array([...one, ...two, ...three.subarray(0, 6)]))
  assert.deepEqual(got.map(decodeControl), [{ a: 1 }, { b: 2 }])
  assert.equal(reader.pending, 6)
  assert.deepEqual(reader.push(three.subarray(6)).map(decodeControl), [{ c: 3 }])
})

test('the reader returns an empty frame and owns what it returns', () => {
  const reader = createFrameReader()
  const chunk = bytes(0, 0, 0, 0, 0, 0, 0, 2, 9, 9)
  const [empty, two] = reader.push(chunk)
  assert.equal(empty.length, 0)
  assert.deepEqual([...two], [9, 9])
  chunk.fill(0)
  assert.deepEqual([...two], [9, 9])
  assert.equal(two.byteLength, two.buffer.byteLength)
  assert.deepEqual(reader.push(new Uint8Array(0)), [])
})

test('a state frame is a kind byte, a big-endian generation and the payload', () => {
  const snap = parseStateFrame(bytes(0, 0, 0, 1, 2, 123, 125))
  assert.equal(snap.kind, 'snapshot')
  assert.equal(snap.generation, 258)
  assert.deepEqual([...snap.payload], [123, 125])
  assert.equal(snap.payload.byteLength, snap.payload.buffer.byteLength)
  const delta = parseStateFrame(bytes(1, 0xff, 0xff, 0xff, 0xff))
  assert.equal(delta.kind, 'delta')
  assert.equal(delta.generation, 4294967295)
  assert.equal(delta.payload.length, 0)
})

test('a state frame that is short or of an unknown kind is null', () => {
  assert.equal(parseStateFrame(bytes(0, 0, 0, 1)), null)
  assert.equal(parseStateFrame(bytes(2, 0, 0, 0, 1)), null)
  assert.equal(parseStateFrame(null), null)
})

test('a state frame read from inside a larger buffer keeps its offsets', () => {
  const big = bytes(9, 9, 9, 0, 0, 0, 0, 5, 42)
  const frame = parseStateFrame(big.subarray(3))
  assert.equal(frame.generation, 5)
  assert.deepEqual([...frame.payload], [42])
})

test('a datagram round-trips its seq and payload', () => {
  const d = encodeDatagram(0x01020304, bytes(7, 8))
  assert.deepEqual([...d], [1, 2, 3, 4, 7, 8])
  const back = decodeDatagram(d)
  assert.equal(back.seq, 0x01020304)
  assert.deepEqual([...back.payload], [7, 8])
  assert.deepEqual([...decodeDatagram(bytes(0, 0, 0, 0)).payload], [])
  assert.equal(decodeDatagram(bytes(1, 2, 3)), null)
  assert.equal(decodeDatagram(bytes(9, 0, 0, 0, 1, 5).subarray(1)).seq, 1)
})

test('an incoming datagram is taken only when newer than the last one', () => {
  assert.equal(isNewerSeq(null, 0), true)
  assert.equal(isNewerSeq(0, 1), true)
  assert.equal(isNewerSeq(5, 5), false)
  assert.equal(isNewerSeq(5, 4), false)
})
