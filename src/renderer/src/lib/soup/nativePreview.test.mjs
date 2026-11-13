// The sharer's own preview of a native share (.plans/native-media-engine-m6-preview-2-client.md).
//   node --test src/renderer/src/lib/soup/nativePreview.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PREVIEW_FPS,
  PREVIEW_MAX_HEIGHT,
  PREVIEW_MAX_WIDTH,
  createPreviewPainter,
  jpegBytes,
  previewRequest
} from './nativePreview.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

// A decode the test settles by hand.
function manualDecode() {
  const pending = []
  const decode = (picture) =>
    new Promise((resolve, reject) => pending.push({ picture, resolve, reject }))
  return { decode, pending }
}

test('the request asks for 10 a second within 1280x720, and 0 stops', () => {
  assert.equal(PREVIEW_FPS, 10)
  assert.deepEqual(previewRequest(PREVIEW_FPS), { fps: 10, max_width: 1280, max_height: 720 })
  assert.deepEqual(previewRequest(0), {
    fps: 0,
    max_width: PREVIEW_MAX_WIDTH,
    max_height: PREVIEW_MAX_HEIGHT
  })
})

test('jpegBytes decodes base64, and refuses what is not', () => {
  assert.deepEqual([...jpegBytes('/9j/2Q==')], [0xff, 0xd8, 0xff, 0xd9])
  assert.equal(jpegBytes(''), null)
  assert.equal(jpegBytes(null), null)
  assert.equal(jpegBytes(42), null)
  assert.equal(jpegBytes('not base64 !'), null)
})

test('a picture is decoded and drawn, then released', async () => {
  const drawn = []
  const released = []
  const painter = createPreviewPainter({
    decode: async (picture) => ({ image: picture.n }),
    draw: (image) => drawn.push(image.image),
    release: (image) => released.push(image.image),
    canDraw: () => true
  })
  assert.equal(painter.offer({ n: 1 }), true)
  await tick()
  assert.deepEqual(drawn, [1])
  assert.deepEqual(released, [1])
  assert.deepEqual(painter.counts, { received: 1, drawn: 1, dropped: 0, late: 0, failed: 0 })
})

test('a picture that arrives while one decodes is dropped', async () => {
  const { decode, pending } = manualDecode()
  const drawn = []
  const painter = createPreviewPainter({ decode, draw: (n) => drawn.push(n), canDraw: () => true })
  assert.equal(painter.offer(1), true)
  assert.equal(painter.offer(2), false)
  assert.equal(painter.offer(3), false)
  assert.equal(pending.length, 1)
  pending[0].resolve('one')
  await tick()
  assert.deepEqual(drawn, ['one'])
  // Free again: the next picture is taken.
  assert.equal(painter.offer(4), true)
  assert.equal(pending.length, 2)
  assert.equal(pending[1].picture, 4)
  pending[1].resolve('four')
  await tick()
  assert.deepEqual(drawn, ['one', 'four'])
  assert.deepEqual(painter.counts, { received: 4, drawn: 2, dropped: 2, late: 0, failed: 0 })
})

test('a failed decode draws nothing and frees the painter', async () => {
  const { decode, pending } = manualDecode()
  const drawn = []
  const painter = createPreviewPainter({ decode, draw: (n) => drawn.push(n), canDraw: () => true })
  painter.offer(1)
  pending[0].reject(new Error('not a JPEG'))
  await tick()
  assert.deepEqual(drawn, [])
  assert.equal(painter.offer(2), true)
  pending[1].resolve('two')
  await tick()
  assert.deepEqual(drawn, ['two'])
  assert.equal(painter.counts.failed, 1)
})

test('a decode that throws at once draws nothing and frees the painter', async () => {
  let first = true
  const drawn = []
  const painter = createPreviewPainter({
    decode: (n) => {
      if (first) {
        first = false
        throw new Error('bad')
      }
      return n
    },
    draw: (n) => drawn.push(n),
    canDraw: () => true
  })
  assert.equal(painter.offer(1), true)
  await tick()
  assert.equal(painter.offer(2), true)
  await tick()
  assert.deepEqual(drawn, [2])
  assert.equal(painter.counts.failed, 1)
})

test('nothing is drawn once canDraw() turns false, also mid-decode', async () => {
  const { decode, pending } = manualDecode()
  let live = true
  const drawn = []
  const released = []
  const painter = createPreviewPainter({
    decode,
    draw: (n) => drawn.push(n),
    release: (n) => released.push(n),
    canDraw: () => live
  })
  painter.offer(1)
  live = false
  pending[0].resolve('one')
  await tick()
  assert.deepEqual(drawn, [])
  // A decoded image is released even when it is not drawn.
  assert.deepEqual(released, ['one'])
  assert.equal(painter.offer(2), false)
  assert.equal(pending.length, 1)
  assert.deepEqual(painter.counts, { received: 2, drawn: 0, dropped: 0, late: 2, failed: 0 })
})

test('a draw that throws still releases the image and frees the painter', async () => {
  const released = []
  let calls = 0
  const painter = createPreviewPainter({
    decode: async (n) => n,
    draw: () => {
      calls++
      if (calls === 1) throw new Error('canvas gone')
    },
    release: (n) => released.push(n),
    canDraw: () => true
  })
  painter.offer(1)
  await tick()
  assert.equal(painter.offer(2), true)
  await tick()
  assert.deepEqual(released, [1, 2])
  assert.equal(painter.counts.drawn, 1)
  assert.equal(painter.counts.failed, 1)
})

// B2 and B5 of .plans/native-media-engine-preview-cost.md.
import {
  PREVIEW_GATE_MS,
  createPreviewGate,
  previewFps,
  previewRequest as requestFor
} from './nativePreview.js'

test('previewRequest and previewFps take the override when there is one', () => {
  const override = { fps: 5, max_width: 960, max_height: 540 }
  assert.deepEqual(requestFor(5, override), { fps: 5, max_width: 960, max_height: 540 })
  assert.deepEqual(requestFor(0, override), { fps: 0, max_width: 960, max_height: 540 })
  assert.equal(previewFps(override), 5)
  assert.equal(previewFps(null), 10)
  assert.deepEqual(requestFor(10, null), { fps: 10, max_width: 1280, max_height: 720 })
})

// A gate on a clock the test moves by hand.
function gateOnClock() {
  let t = 1_000
  const timers = []
  const sent = []
  const gate = createPreviewGate({
    send: (seen) => sent.push({ seen, t }),
    now: () => t,
    setTimer: (fn, ms) => {
      const timer = { fn, at: t + ms, done: false }
      timers.push(timer)
      return timer
    },
    clearTimer: (timer) => {
      timer.done = true
    }
  })
  const advance = (ms) => {
    const end = t + ms
    for (;;) {
      const next = timers.filter((x) => !x.done && x.at <= end).sort((a, b) => a.at - b.at)[0]
      if (!next) break
      t = next.at
      next.done = true
      next.fn()
    }
    t = end
  }
  return { gate, sent, advance, timers }
}

test('the gate sends nothing until the tile is seen, then sends at once', () => {
  const { gate, sent } = gateOnClock()
  gate.set(false)
  assert.deepEqual(sent, [])
  gate.set(true)
  assert.deepEqual(sent, [{ seen: true, t: 1_000 }])
  gate.set(true)
  assert.equal(sent.length, 1)
})

test('the gate sends at most one change in 250 ms, the last state winning', () => {
  const { gate, sent, advance } = gateOnClock()
  assert.equal(PREVIEW_GATE_MS, 250)
  gate.set(true)
  advance(50)
  gate.set(false)
  gate.set(true)
  gate.set(false)
  assert.equal(sent.length, 1)
  advance(199)
  assert.equal(sent.length, 1)
  advance(1)
  assert.deepEqual(sent.at(-1), { seen: false, t: 1_250 })
  // A flicker that ends where it began sends nothing.
  advance(100)
  gate.set(true)
  gate.set(false)
  advance(1_000)
  assert.equal(sent.length, 2)
  // After a quiet spell a change goes at once.
  gate.set(true)
  assert.deepEqual(sent.at(-1), { seen: true, t: 2_350 })
})

test('a closed gate sends nothing, not even a change that was waiting', () => {
  const { gate, sent, advance } = gateOnClock()
  gate.set(true)
  advance(10)
  gate.set(false)
  gate.close()
  advance(1_000)
  gate.set(true)
  assert.deepEqual(sent, [{ seen: true, t: 1_000 }])
})
