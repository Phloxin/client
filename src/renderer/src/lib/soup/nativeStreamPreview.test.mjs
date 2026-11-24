import test from 'node:test'
import assert from 'node:assert/strict'
import {
  KEY_FRAME_ASK_MS,
  STREAM_BEHIND,
  STREAM_BEHIND_MS,
  STREAM_QUEUE_LIMIT,
  av1CodecString,
  base64Bytes,
  chooseStreamPreview,
  createStreamPreviewDecoder,
  h264CodecString,
  setStreamPreviewBehind,
  streamPreviewBehind
} from './nativeStreamPreview.js'

// An H264 access unit in Annex B: an SPS (Constrained Baseline, level 4.2), a PPS, an IDR slice.
const IDR = [
  0, 0, 0, 1, 0x67, 0x42, 0xe0, 0x2a, 0x95, 0xa0, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65,
  0x88, 0x84
]
const DELTA = [0, 0, 0, 1, 0x41, 0x9a, 0x02]
const b64 = (bytes) => Buffer.from(bytes).toString('base64')

// Writes bits most significant first.
function bits() {
  const out = []
  let n = 0
  const put = (value, count) => {
    for (let i = count - 1; i >= 0; i--) {
      if (n % 8 === 0) out.push(0)
      out[out.length - 1] |= (Math.floor(value / 2 ** i) & 1) << (7 - (n % 8))
      n++
    }
  }
  return { put, bytes: () => out }
}

// A temporal unit: a temporal delimiter, the sequence header, a frame OBU.
function temporalUnit(header) {
  return [0x12, 0, 0x0a, header.length, ...header, 0x32, 2, 0xaa, 0xbb]
}

test('base64Bytes reads base64 and refuses what is not', () => {
  assert.deepEqual([...base64Bytes(b64([0, 1, 254, 255]))], [0, 1, 254, 255])
  for (const bad of ['', null, 42, '***']) assert.equal(base64Bytes(bad), null, String(bad))
})

test('h264CodecString takes the SPS profile, constraint flags and level', () => {
  assert.equal(h264CodecString(new Uint8Array(IDR)), 'avc1.42E02A')
  // A three-byte start code works too, and a frame without an SPS has none.
  assert.equal(
    h264CodecString(new Uint8Array([0, 0, 1, 0x67, 0x64, 0x00, 0x28, 0xac])),
    'avc1.640028'
  )
  assert.equal(h264CodecString(new Uint8Array(DELTA)), null)
})

test('av1CodecString reads the sequence header', () => {
  // Main profile, level 8 (4.0), Main tier, 8 bit; order hints and screen content tools on.
  const plain = bits()
  plain.put(0, 3) // seq_profile
  plain.put(0, 1) // still_picture
  plain.put(0, 1) // reduced_still_picture_header
  plain.put(0, 1) // timing_info_present_flag
  plain.put(0, 1) // initial_display_delay_present_flag
  plain.put(0, 5) // operating_points_cnt_minus_1
  plain.put(0, 12) // operating_point_idc
  plain.put(8, 5) // seq_level_idx
  plain.put(0, 1) // seq_tier
  plain.put(10, 4)
  plain.put(10, 4)
  plain.put(1919, 11)
  plain.put(1079, 11)
  plain.put(0, 1) // frame_id_numbers_present_flag
  plain.put(7, 3)
  plain.put(0, 4)
  plain.put(1, 1) // enable_order_hint
  plain.put(0, 2)
  plain.put(1, 1) // seq_choose_screen_content_tools
  plain.put(1, 1) // seq_choose_integer_mv
  plain.put(6, 3) // order_hint_bits_minus_1
  plain.put(3, 3) // superres, cdef, restoration
  plain.put(0, 1) // high_bitdepth
  plain.put(0, 7)
  assert.equal(av1CodecString(new Uint8Array(temporalUnit(plain.bytes()))), 'av01.0.08M.08')

  // Timing and decoder model info, two operating points, the first at level 12 High tier, 10 bit.
  const full = bits()
  full.put(0, 3)
  full.put(0, 1)
  full.put(0, 1)
  full.put(1, 1) // timing_info_present_flag
  full.put(1, 32)
  full.put(60, 32)
  full.put(1, 1) // equal_picture_interval
  full.put(1, 1) // num_ticks_per_picture_minus_1 = 0 as uvlc
  full.put(1, 1) // decoder_model_info_present_flag
  full.put(4, 5) // buffer_delay_length_minus_1
  full.put(1, 32)
  full.put(0, 5)
  full.put(0, 5)
  full.put(1, 1) // initial_display_delay_present_flag
  full.put(1, 5) // two operating points
  full.put(0x103, 12)
  full.put(12, 5)
  full.put(1, 1) // High tier
  full.put(1, 1) // decoder_model_present_for_this_op
  full.put(3, 5)
  full.put(3, 5)
  full.put(0, 1)
  full.put(1, 1) // initial_display_delay_present_for_this_op
  full.put(9, 4)
  full.put(0x001, 12)
  full.put(5, 5) // no tier bit at level 5
  full.put(0, 1)
  full.put(0, 1)
  full.put(11, 4)
  full.put(11, 4)
  full.put(2559, 12)
  full.put(1439, 12)
  full.put(1, 1) // frame_id_numbers_present_flag
  full.put(0, 4)
  full.put(0, 3)
  full.put(0, 3)
  full.put(0, 4)
  full.put(0, 1) // no order hints
  full.put(0, 1) // seq_choose_screen_content_tools
  full.put(0, 1) // seq_force_screen_content_tools
  full.put(0, 3)
  full.put(1, 1) // high_bitdepth
  full.put(0, 7)
  assert.equal(av1CodecString(new Uint8Array(temporalUnit(full.bytes()))), 'av01.0.12H.10')

  // A reduced still picture header names its level at once.
  const still = bits()
  still.put(0, 3)
  still.put(1, 1)
  still.put(1, 1)
  still.put(5, 5)
  still.put(9, 4)
  still.put(9, 4)
  still.put(639, 10)
  still.put(479, 10)
  still.put(0, 3)
  still.put(0, 3)
  still.put(0, 1)
  still.put(0, 6)
  assert.equal(av1CodecString(new Uint8Array(temporalUnit(still.bytes()))), 'av01.0.05M.08')

  // No sequence header, or one cut short: none.
  assert.equal(av1CodecString(new Uint8Array([0x12, 0, 0x32, 2, 0xaa, 0xbb])), null)
  assert.equal(av1CodecString(new Uint8Array([0x0a, 2, 0x00, 0x00])), null)
})

test('chooseStreamPreview asks for the hardware first, then any decoder, else JPEG (P6)', async () => {
  const asked = []
  const decoderSaying = (yes) => ({
    isConfigSupported: async (config) => {
      asked.push(config)
      return { supported: yes.includes(config.hardwareAcceleration), config }
    }
  })
  assert.deepEqual(await chooseStreamPreview(decoderSaying(['prefer-hardware']), 'H264'), {
    mode: 'stream',
    hardwareAcceleration: 'prefer-hardware'
  })
  assert.deepEqual(asked.at(-1), {
    codec: 'avc1.42E02A',
    optimizeForLatency: true,
    hardwareAcceleration: 'prefer-hardware'
  })
  assert.deepEqual(await chooseStreamPreview(decoderSaying(['no-preference']), 'AV1'), {
    mode: 'stream',
    hardwareAcceleration: 'no-preference'
  })
  assert.equal(asked.at(-1).codec, 'av01.0.08M.08')
  assert.equal((await chooseStreamPreview(decoderSaying([]), 'H264')).mode, 'jpeg')
  assert.equal((await chooseStreamPreview(undefined, 'H264')).mode, 'jpeg')
  assert.equal((await chooseStreamPreview(decoderSaying(['no-preference']), 'VP9')).mode, 'jpeg')
  const throwing = { isConfigSupported: async () => Promise.reject(new TypeError('bad')) }
  assert.equal((await chooseStreamPreview(throwing, 'H264')).mode, 'jpeg')
})

// A VideoDecoder that keeps what it is given; the test makes its pictures and errors.
class FakeDecoder {
  static last = null
  constructor({ output, error }) {
    this.output = output
    this.error = error
    this.state = 'unconfigured'
    this.decodeQueueSize = 0
    this.configs = []
    this.chunks = []
    this.resets = 0
    this.throwOnConfigure = null
    FakeDecoder.last = this
  }
  configure(config) {
    if (this.throwOnConfigure) throw this.throwOnConfigure
    this.configs.push(config)
    this.state = 'configured'
  }
  decode(chunk) {
    if (this.state !== 'configured') throw new Error('InvalidStateError: not configured')
    this.chunks.push(chunk)
    this.decodeQueueSize++
  }
  reset() {
    this.resets++
    this.state = 'unconfigured'
    this.decodeQueueSize = 0
  }
  close() {
    this.state = 'closed'
  }
}

class FakeChunk {
  constructor(init) {
    Object.assign(this, init)
  }
}

// A decoded picture that says when it was closed.
function picture(id, closed) {
  return { id, close: () => closed.push(id) }
}

function setup({ drawable = true, draw = null } = {}) {
  setStreamPreviewBehind(false)
  let clock = 1_000_000
  const timers = []
  // The display's frame clock: callbacks asked for, run by vsync().
  const frames = new Map()
  let nextFrame = 1
  const log = { drawn: [], asks: 0, fallbacks: [], frameRequests: 0 }
  const decoder = createStreamPreviewDecoder({
    VideoDecoder: FakeDecoder,
    EncodedVideoChunk: FakeChunk,
    hardwareAcceleration: 'no-preference',
    draw: draw ?? ((frame) => log.drawn.push(frame.id)),
    canDraw: () => drawable,
    askKeyFrame: () => log.asks++,
    onFallback: (reason) => log.fallbacks.push(reason),
    now: () => clock,
    setTimer: (fn, ms) => {
      timers.push({ fn, at: clock + ms })
      return timers.length
    },
    clearTimer: (id) => {
      if (timers[id - 1]) timers[id - 1].fn = null
    },
    requestFrame: (fn) => {
      log.frameRequests++
      frames.set(nextFrame, fn)
      return nextFrame++
    },
    cancelFrame: (id) => frames.delete(id)
  })
  const advance = (ms) => {
    clock += ms
    for (const timer of timers) {
      if (timer.fn && timer.at <= clock) {
        const fn = timer.fn
        timer.fn = null
        fn()
      }
    }
  }
  const vsync = () => {
    const due = [...frames.values()]
    frames.clear()
    for (const fn of due) fn()
  }
  return { decoder, fake: FakeDecoder.last, log, advance, vsync, pendingFrames: () => frames.size }
}

const key = (t) => ({ codec: 'h264', key: true, t_ms: t, data: b64(IDR) })
const delta = (t) => ({ codec: 'h264', key: false, t_ms: t, data: b64(DELTA) })

// The queue over the limit at a frame and at one STREAM_BEHIND_MS later: behind.
function fallBehind({ decoder, fake, advance }, t) {
  fake.decodeQueueSize = STREAM_QUEUE_LIMIT + 1
  decoder.offer(delta(t))
  advance(STREAM_BEHIND_MS)
  fake.decodeQueueSize = Math.max(fake.decodeQueueSize, STREAM_QUEUE_LIMIT + 1)
  decoder.offer(delta(t + 0.5))
}

test('the decoder starts at a key frame and is configured from it (P5)', () => {
  const { decoder, fake, log, vsync } = setup()
  decoder.offer(delta(1))
  assert.equal(fake.configs.length, 0)
  assert.equal(decoder.counts.skipped, 1)
  decoder.offer(key(16.667))
  decoder.offer(delta(33.333))
  assert.deepEqual(fake.configs, [
    { codec: 'avc1.42E02A', optimizeForLatency: true, hardwareAcceleration: 'no-preference' }
  ])
  assert.deepEqual(
    fake.chunks.map((c) => [c.type, c.timestamp, c.data.length]),
    [
      ['key', 16667, IDR.length],
      ['delta', 33333, DELTA.length]
    ]
  )
  // A key frame with the same codec string is not configured again.
  decoder.offer(key(50))
  assert.equal(fake.configs.length, 1)
  assert.equal(decoder.codec, 'avc1.42E02A')

  // A picture is drawn at the next display frame, then closed.
  const closed = []
  fake.output(picture(1, closed))
  assert.deepEqual(log.drawn, [], 'not drawn in the output callback')
  assert.deepEqual(closed, [])
  vsync()
  assert.deepEqual(log.drawn, [1])
  assert.deepEqual(closed, [1])
  assert.equal(decoder.counts.drawn, 1)
  assert.deepEqual(log.fallbacks, [])
})

test('the newest picture wins: the ones it replaces are closed undrawn, one draw a display frame (Q1)', () => {
  const { decoder, fake, log, vsync, pendingFrames } = setup()
  decoder.offer(key(0))
  const closed = []
  fake.output(picture(1, closed))
  fake.output(picture(2, closed))
  fake.output(picture(3, closed))
  assert.equal(log.frameRequests, 1, 'one display frame asked for, however many pictures came')
  assert.deepEqual(closed, [1, 2], 'the replaced pictures are closed at once')
  assert.equal(decoder.counts.superseded, 2)
  vsync()
  assert.deepEqual(log.drawn, [3])
  assert.deepEqual(closed, [1, 2, 3])
  // No new picture: nothing is asked for and a display frame draws nothing.
  assert.equal(pendingFrames(), 0)
  vsync()
  assert.deepEqual(log.drawn, [3])

  // Pictures at twice the display's rate for 60 display frames: 60 drawn, 60 replaced, all closed.
  let id = 10
  for (let n = 0; n < 60; n++) {
    fake.output(picture(id++, closed))
    fake.output(picture(id++, closed))
    vsync()
  }
  assert.equal(decoder.counts.drawn, 61)
  assert.equal(decoder.counts.superseded, 62)
  assert.equal(decoder.counts.decoded, 123)
  assert.equal(closed.length, 123, 'every picture closed exactly once')
  assert.equal(new Set(closed).size, 123)
  assert.deepEqual(log.fallbacks, [])
})

test('a picture is closed but not drawn when the canvas may not be drawn on', () => {
  const { decoder, fake, log, vsync } = setup({ drawable: false })
  decoder.offer(key(0))
  const closed = []
  fake.output(picture(1, closed))
  vsync()
  assert.deepEqual(log.drawn, [])
  assert.deepEqual(closed, [1])
  assert.equal(decoder.counts.late, 1)
})

test('a draw that throws falls back, and the picture is still closed', () => {
  const { decoder, fake, log, vsync } = setup({
    draw: () => {
      throw new Error('canvas gone')
    }
  })
  decoder.offer(key(0))
  const closed = []
  fake.output(picture(1, closed))
  vsync()
  assert.deepEqual(closed, [1])
  assert.deepEqual(log.fallbacks, ['draw: canvas gone'])
  assert.equal(streamPreviewBehind(), false, 'only falling behind marks the run')
})

test('closing closes the kept picture and cancels its display frame', () => {
  const { decoder, fake, log, vsync, pendingFrames } = setup()
  decoder.offer(key(0))
  const closed = []
  fake.output(picture(1, closed))
  decoder.close()
  assert.deepEqual(closed, [1])
  assert.equal(pendingFrames(), 0)
  vsync()
  assert.deepEqual(log.drawn, [])
  // A picture the decoder still hands out after the close is closed at once.
  fake.output(picture(2, closed))
  assert.deepEqual(closed, [1, 2])
  assert.equal(pendingFrames(), 0)
})

test('the queue limit is 30, half a second at 60 (Q2)', () => {
  assert.equal(STREAM_QUEUE_LIMIT, 30)
  assert.equal(KEY_FRAME_ASK_MS, 2000)
})

test('behind once: reset and one key frame ask; behind twice: JPEG, no second ask (Q3, Q4, Q5)', () => {
  const s = setup()
  const { decoder, fake, log, advance, vsync } = s
  decoder.offer(key(0))
  fake.decodeQueueSize = STREAM_QUEUE_LIMIT
  decoder.offer(delta(1))
  assert.equal(fake.resets, 0, 'at the limit it goes on')
  assert.equal(decoder.counts.behind, 0)

  // The first pass: reset, wait for a key frame, ask for one.
  const closed = []
  fake.output(picture(1, closed))
  fallBehind(s, 2)
  assert.equal(fake.resets, 1)
  assert.equal(log.asks, 1)
  assert.equal(decoder.counts.keyAsks, 1)
  assert.equal(decoder.counts.behind, 1)
  assert.deepEqual(log.fallbacks, [])
  assert.equal(streamPreviewBehind(), false)
  // The picture decoded before the reset is still drawn.
  vsync()
  assert.deepEqual(log.drawn, [1])
  // Until the next key frame nothing is decoded; that key frame configures it again.
  const before = fake.chunks.length
  decoder.offer(delta(3))
  assert.equal(fake.chunks.length, before)
  decoder.offer(key(4))
  assert.equal(fake.configs.length, 2)
  assert.equal(fake.chunks.at(-1).type, 'key')

  // The second pass, however much later: the JPEGs, for the rest of the run.
  advance(60_000)
  fake.output(picture(2, closed))
  fallBehind(s, 5)
  assert.deepEqual(log.fallbacks, [STREAM_BEHIND])
  assert.equal(STREAM_BEHIND, 'stream preview could not keep up')
  assert.equal(fake.resets, 1, 'no second reset')
  assert.equal(fake.state, 'closed')
  assert.deepEqual(closed, [1, 2], 'the kept picture is closed')
  assert.equal(decoder.failed, STREAM_BEHIND)
  assert.equal(decoder.counts.behind, 2)
  assert.equal(streamPreviewBehind(), true)
  // Nothing more: no frame decoded, no ask, no second fallback.
  const count = fake.chunks.length
  decoder.offer(key(6))
  fake.decodeQueueSize = STREAM_QUEUE_LIMIT + 1
  decoder.offer(delta(7))
  advance(KEY_FRAME_ASK_MS * 3)
  vsync()
  assert.equal(fake.chunks.length, count)
  assert.equal(log.asks, 1, 'one key frame ask in the share')
  assert.equal(decoder.counts.keyAsks, 1)
  assert.deepEqual(log.fallbacks, [STREAM_BEHIND])
  setStreamPreviewBehind(false)
})

test('after a preview could not keep up, later shares of the run choose the JPEGs (Q5)', async () => {
  setStreamPreviewBehind(false)
  let asked = 0
  const yes = {
    isConfigSupported: async (config) => {
      asked++
      return { supported: true, config }
    }
  }
  assert.equal((await chooseStreamPreview(yes, 'H264')).mode, 'stream')
  assert.equal(asked, 1)

  // A decoder error falls back for that share only.
  const errored = setup()
  errored.decoder.offer(key(0))
  errored.fake.error(new Error('EncodingError'))
  assert.equal(errored.log.fallbacks.length, 1)
  assert.equal(streamPreviewBehind(), false)
  assert.equal((await chooseStreamPreview(yes, 'H264')).mode, 'stream')

  // One that fell behind twice marks the run.
  const behind = setup()
  behind.decoder.offer(key(0))
  fallBehind(behind, 1)
  behind.decoder.offer(key(2))
  fallBehind(behind, 3)
  assert.deepEqual(behind.log.fallbacks, [STREAM_BEHIND])
  assert.equal(streamPreviewBehind(), true)
  asked = 0
  for (const codec of ['H264', 'AV1']) {
    const choice = await chooseStreamPreview(yes, codec)
    assert.equal(choice.mode, 'jpeg')
    assert.match(choice.reason, /could not keep up earlier in this run/)
  }
  assert.equal(asked, 0, 'WebCodecs is not even asked')

  // Cleared (a restart, or the test hooks): the stream again.
  setStreamPreviewBehind(false)
  assert.equal((await chooseStreamPreview(yes, 'H264')).mode, 'stream')
  setStreamPreviewBehind('yes')
  assert.equal(streamPreviewBehind(), false, 'only true sets it')
})

test('a decoder error falls back once, and nothing is decoded after (P6)', () => {
  const { decoder, fake, log } = setup()
  decoder.offer(key(0))
  fake.error(new Error('EncodingError: decoding failed'))
  fake.error(new Error('again'))
  assert.deepEqual(log.fallbacks, ['decoder: EncodingError: decoding failed'])
  assert.equal(fake.state, 'closed')
  const count = fake.chunks.length
  decoder.offer(key(1))
  assert.equal(fake.chunks.length, count)
  assert.equal(decoder.failed, 'decoder: EncodingError: decoding failed')
})

test('a refused configuration, a key frame without an SPS and bad data fall back (P6)', () => {
  const refused = setup()
  refused.fake.throwOnConfigure = new TypeError('unsupported codec')
  refused.decoder.offer(key(0))
  assert.deepEqual(refused.log.fallbacks, ['configure avc1.42E02A: unsupported codec'])

  const noSps = setup()
  noSps.decoder.offer({ codec: 'h264', key: true, t_ms: 0, data: b64(DELTA) })
  assert.deepEqual(noSps.log.fallbacks, ['a h264 key frame without its codec parameters'])

  const bad = setup()
  bad.decoder.offer({ codec: 'h264', key: true, t_ms: 0, data: '***' })
  assert.deepEqual(bad.log.fallbacks, ['a frame that is not base64'])
})

test('a closed decoder takes nothing and never falls back', () => {
  const { decoder, fake, log } = setup()
  decoder.offer(key(0))
  decoder.close()
  assert.equal(fake.state, 'closed')
  fake.error(new Error('late'))
  decoder.offer(key(1))
  assert.deepEqual(log.fallbacks, [])
  assert.equal(fake.chunks.length, 1)
})

// Behind only after the
// queue has been over the limit for STREAM_BEHIND_MS without a break.
test('a burst that drains within 500 ms is not behind (C3)', () => {
  assert.equal(STREAM_BEHIND_MS, 500)
  const { decoder, fake, log, advance } = setup()
  decoder.offer(key(0))
  // A stall of the page: 90 frames come back to back, the queue passes the limit and drains
  // in about 0.1 s (a model of four decodes at a time, 3 ms each).
  for (let n = 1; n <= 90; n++) {
    decoder.offer(delta(n))
    advance(1)
  }
  assert.ok(fake.decodeQueueSize > STREAM_QUEUE_LIMIT)
  for (let ms = 0; ms < 200 && fake.decodeQueueSize > 0; ms += 3) {
    fake.decodeQueueSize = Math.max(0, fake.decodeQueueSize - 4)
    advance(3)
  }
  decoder.offer(delta(91))
  // The same again, twice: a burst never counts.
  for (let burst = 0; burst < 2; burst++) {
    fake.decodeQueueSize = STREAM_QUEUE_LIMIT + 10
    decoder.offer(delta(100))
    advance(STREAM_BEHIND_MS - 1)
    decoder.offer(delta(101))
    fake.decodeQueueSize = STREAM_QUEUE_LIMIT
    decoder.offer(delta(102))
    advance(10_000)
  }
  assert.equal(decoder.counts.behind, 0)
  assert.equal(fake.resets, 0)
  assert.equal(log.asks, 0)
  assert.deepEqual(log.fallbacks, [])
  assert.equal(decoder.counts.skipped, 0, 'every frame decoded')
})

test('over the limit at every frame for 500 ms is behind, counted from the first such frame (C3)', () => {
  const { decoder, fake, log, advance } = setup()
  decoder.offer(key(0))
  fake.decodeQueueSize = STREAM_QUEUE_LIMIT + 1
  // 60 frames a second, the queue over the limit at each.
  decoder.offer(delta(1))
  for (let n = 0; n < 29; n++) {
    advance(17)
    decoder.offer(delta(2 + n))
  }
  assert.equal(decoder.counts.behind, 0, '493 ms over: not yet')
  advance(7)
  decoder.offer(delta(40))
  assert.equal(decoder.counts.behind, 1, '500 ms over: behind')
  assert.equal(fake.resets, 1)
  assert.equal(log.asks, 1)
  // After the reset the time over starts again: a new pass needs 500 ms of its own.
  decoder.offer(key(41))
  fake.decodeQueueSize = STREAM_QUEUE_LIMIT + 1
  decoder.offer(delta(42))
  advance(STREAM_BEHIND_MS - 1)
  decoder.offer(delta(43))
  assert.equal(decoder.counts.behind, 1)
  advance(1)
  decoder.offer(delta(44))
  assert.equal(decoder.counts.behind, 2)
  assert.deepEqual(log.fallbacks, [STREAM_BEHIND])
  setStreamPreviewBehind(false)
})

// A decoder that may be software gets the stream only up to 1080p at 60.
import { PAINT_TIMER_MS, SOFTWARE_PIXEL_RATE } from './nativeStreamPreview.js'

test('with only no-preference the stream preview is chosen up to 1080p at 60, else the JPEGs (C7)', async () => {
  setStreamPreviewBehind(false)
  assert.equal(SOFTWARE_PIXEL_RATE, 1920 * 1080 * 60)
  const saying = (yes) => ({
    isConfigSupported: async (config) => ({
      supported: yes.includes(config.hardwareAcceleration),
      config
    })
  })
  const software = saying(['no-preference'])
  const hardware = saying(['prefer-hardware', 'no-preference'])
  for (const shape of [
    { width: 1920, height: 1080, fps: 60 },
    { width: 1280, height: 720, fps: 120 },
    { width: 2560, height: 1440, fps: 30 },
    null
  ]) {
    assert.deepEqual(
      await chooseStreamPreview(software, 'H264', shape),
      { mode: 'stream', hardwareAcceleration: 'no-preference' },
      JSON.stringify(shape)
    )
  }
  for (const shape of [
    { width: 3840, height: 2160, fps: 60 },
    { width: 2560, height: 1440, fps: 60 },
    { width: 1920, height: 1080, fps: 61 }
  ]) {
    const choice = await chooseStreamPreview(software, 'H264', shape)
    assert.equal(choice.mode, 'jpeg', JSON.stringify(shape))
    assert.match(choice.reason, /over 1080p at 60 for software/)
  }
  assert.equal(
    (await chooseStreamPreview(software, 'AV1', { width: 3840, height: 2160, fps: 60 })).reason,
    'no hardware decoder for av01.0.08M.08, and 3840x2160 at 60 is over 1080p at 60 for software'
  )
  // The hardware takes any size.
  assert.deepEqual(
    await chooseStreamPreview(hardware, 'H264', { width: 3840, height: 2160, fps: 120 }),
    {
      mode: 'stream',
      hardwareAcceleration: 'prefer-hardware'
    }
  )
})

// The kept picture is drawn from a timer when no animation frame comes first.
test('a kept picture is drawn after 50 ms when no animation frame comes (C9)', () => {
  assert.equal(PAINT_TIMER_MS, 50)
  const { decoder, fake, log, advance, vsync, pendingFrames } = setup()
  decoder.offer(key(0))
  const closed = []
  fake.output(picture(1, closed))
  advance(PAINT_TIMER_MS - 1)
  assert.deepEqual(log.drawn, [])
  advance(1)
  assert.deepEqual(log.drawn, [1])
  assert.deepEqual(closed, [1])
  assert.equal(decoder.counts.timed, 1)
  assert.equal(pendingFrames(), 0, 'the animation frame asked for is cancelled')
  vsync()
  assert.deepEqual(log.drawn, [1])
  // No animation frames at all (a hidden window): about 20 pictures a second, the newest each time.
  let id = 10
  for (let n = 0; n < 60; n++) {
    fake.output(picture(id++, closed))
    advance(17)
  }
  assert.equal(decoder.counts.drawn, 21)
  assert.equal(decoder.counts.timed, 21)
  assert.equal(decoder.counts.superseded, 40)
  assert.equal(closed.length, 61, 'every picture closed exactly once')
  assert.equal(new Set(closed).size, 61)
})

test('an animation frame first: drawn once, the timer cancelled; close cancels both (C9)', () => {
  const { decoder, fake, log, advance, vsync, pendingFrames } = setup()
  decoder.offer(key(0))
  const closed = []
  fake.output(picture(1, closed))
  vsync()
  assert.deepEqual(log.drawn, [1])
  advance(PAINT_TIMER_MS * 4)
  assert.deepEqual(log.drawn, [1], 'the timer does not draw again')
  assert.equal(decoder.counts.timed, 0)
  assert.equal(decoder.counts.drawn, 1)
  fake.output(picture(2, closed))
  decoder.close()
  assert.deepEqual(closed, [1, 2])
  assert.equal(pendingFrames(), 0)
  advance(PAINT_TIMER_MS * 4)
  vsync()
  assert.deepEqual(log.drawn, [1])
  assert.deepEqual(log.fallbacks, [])
})
