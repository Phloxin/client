import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SHARE_RATE_INTERVAL_MS,
  chromiumRateSample,
  createShareRateLog,
  frameGapSummary,
  nativeRateSample,
  shareRateLine
} from './shareRate.js'

const NATIVE = { path: 'native', codec: 'H264' }
const CHROMIUM = { path: 'Chromium', codec: 'AV1' }
const at = (ms, frames, more = {}) => ({ id: null, ms, frames, width: 1280, height: 720, ...more })

test('the interval is 5 seconds', () => {
  assert.equal(SHARE_RATE_INTERVAL_MS, 5000)
})

test('a first sample gives no line', () => {
  assert.equal(shareRateLine(null, at(5000, 150), NATIVE), null)
  const lines = []
  const rate = createShareRateLog({ ...NATIVE, log: (line) => lines.push(line) })
  assert.equal(rate.started, false)
  assert.equal(rate.offer(at(1000, 30)), null)
  assert.equal(rate.started, true)
  assert.deepEqual(lines, [])
})

test('the rate is the frames sent over the real length of the interval, one decimal', () => {
  assert.equal(
    shareRateLine(at(1000, 30), at(6000, 180), NATIVE),
    '[Soup] Screen share: 30.0 fps sent, 1280x720, native H264'
  )
  // 149 frames over 5.2 s.
  assert.equal(
    shareRateLine(at(1000, 0), at(6200, 149), NATIVE),
    '[Soup] Screen share: 28.7 fps sent, 1280x720, native H264'
  )
  assert.equal(
    shareRateLine(at(0, 0), at(5000, 0), NATIVE),
    '[Soup] Screen share: 0.0 fps sent, 1280x720, native H264'
  )
})

test('a counter that goes backwards gives no negative rate', () => {
  assert.equal(shareRateLine(at(1000, 500), at(6000, 20), NATIVE), null)
  const lines = []
  const rate = createShareRateLog({ ...CHROMIUM, minIntervalMs: 5000, log: (l) => lines.push(l) })
  rate.offer(at(0, 500))
  // A replacement's counter starts again: the interval starts anew there, no line.
  assert.equal(rate.offer(at(6000, 10)), null)
  assert.equal(rate.offer(at(9000, 100)), null)
  assert.equal(
    rate.offer(at(12000, 190)),
    '[Soup] Screen share: 30.0 fps sent, 1280x720, Chromium AV1'
  )
  assert.equal(lines.length, 1)
  assert.ok(lines.every((line) => !line.includes('-')))
})

test('no time passed, or time going backwards, gives no line', () => {
  assert.equal(shareRateLine(at(5000, 100), at(5000, 130), NATIVE), null)
  assert.equal(shareRateLine(at(5000, 100), at(4000, 130), NATIVE), null)
})

test('samples of different counters are not compared', () => {
  assert.equal(shareRateLine(at(0, 0, { id: 'a' }), at(5000, 150, { id: 'b' }), CHROMIUM), null)
  const rate = createShareRateLog({ ...CHROMIUM, log: () => {} })
  rate.offer(at(0, 0, { id: 'a' }))
  assert.equal(rate.offer(at(5000, 150, { id: 'b' })), null)
  assert.match(rate.offer(at(10000, 300, { id: 'b' })), /30\.0 fps sent/)
})

test('a missing size prints ?x?', () => {
  for (const size of [
    {},
    { width: 1280 },
    { width: null, height: null },
    { width: 0, height: 0 }
  ]) {
    const current = { ...at(5000, 150), width: undefined, height: undefined, ...size }
    assert.equal(
      shareRateLine(at(0, 0), current, NATIVE),
      '[Soup] Screen share: 30.0 fps sent, ?x?, native H264'
    )
  }
})

test('a missing codec prints ?', () => {
  assert.equal(
    shareRateLine(at(0, 0), at(5000, 150), { path: 'Chromium' }),
    '[Soup] Screen share: 30.0 fps sent, 1280x720, Chromium ?'
  )
})

test('native: the frames the capture delivered, as a rate, when the stats carry them', () => {
  assert.equal(
    shareRateLine(
      at(1000, 30, { capturedFrames: 100 }),
      at(6000, 180, { capturedFrames: 700 }),
      NATIVE
    ),
    '[Soup] Screen share: 30.0 fps sent, 1280x720, native H264, 120.0 captured'
  )
  // null for sources other than the screen: nothing added.
  assert.equal(
    shareRateLine(
      at(1000, 30, { capturedFrames: null }),
      at(6000, 180, { capturedFrames: null }),
      NATIVE
    ),
    '[Soup] Screen share: 30.0 fps sent, 1280x720, native H264'
  )
  // A capture counter that went backwards is left out, the rate is still there.
  assert.equal(
    shareRateLine(
      at(1000, 30, { capturedFrames: 900 }),
      at(6000, 180, { capturedFrames: 5 }),
      NATIVE
    ),
    '[Soup] Screen share: 30.0 fps sent, 1280x720, native H264'
  )
})

test("Chromium: the encoder in brackets and the media source's own rate", () => {
  assert.equal(
    shareRateLine(
      at(0, 0, { id: 'o' }),
      at(5000, 100, { id: 'o', encoder: 'libaom', capturedFps: 29.97 }),
      CHROMIUM
    ),
    '[Soup] Screen share: 20.0 fps sent, 1280x720, Chromium AV1 (libaom), 30.0 captured'
  )
  assert.equal(
    shareRateLine(at(0, 0), at(5000, 100, { encoder: '', capturedFps: null }), CHROMIUM),
    '[Soup] Screen share: 20.0 fps sent, 1280x720, Chromium AV1'
  )
})

test('createShareRateLog: a line once the interval has passed, then from there', () => {
  const lines = []
  const rate = createShareRateLog({ ...CHROMIUM, minIntervalMs: 5000, log: (l) => lines.push(l) })
  // The existing poll's 3-second ticks.
  assert.equal(rate.offer(at(3000, 90)), null)
  assert.equal(rate.offer(at(6000, 180)), null)
  assert.match(rate.offer(at(9000, 270)), /^\[Soup\] Screen share: 30\.0 fps sent/)
  assert.equal(rate.offer(at(12000, 330)), null)
  assert.match(rate.offer(at(15000, 390)), /20\.0 fps sent/)
  assert.equal(lines.length, 2)
  assert.equal(rate.offer(null), null)
})

test('createShareRateLog without a minimum: a line at each sample after the first', () => {
  const lines = []
  const rate = createShareRateLog({ ...NATIVE, log: (l) => lines.push(l) })
  rate.offer(at(1000, 30))
  rate.offer(at(6000, 180))
  rate.offer(at(11000, 330))
  // The same sample again (the sidecar sent no stats since): no time passed, no line.
  rate.offer(at(11000, 330))
  assert.equal(lines.length, 2)
})

test('nativeRateSample: from the sidecar stats and the size sent', () => {
  const stats = {
    ms_since_open: 2019,
    frames_sent: 60,
    capture_frames_delivered: 240,
    frame_interval_ms_median: 16.667,
    frame_interval_ms_p95: 17.1,
    frame_interval_ms_max: 33.4,
    frame_gaps_long: 3,
    t_ms: 2042.5
  }
  assert.deepEqual(nativeRateSample(stats, { width: 1920, height: 1080 }), {
    id: null,
    frames: 60,
    ms: 2019,
    width: 1920,
    height: 1080,
    capturedFrames: 240,
    frameGap: { median: 16.667, p95: 17.1, max: 33.4, long: 3 }
  })
  // A sidecar that sends no intervals.
  assert.deepEqual(nativeRateSample({ ms_since_open: 1, frames_sent: 2 }, null), {
    id: null,
    frames: 2,
    ms: 1,
    width: null,
    height: null,
    capturedFrames: null,
    frameGap: { median: null, p95: null, max: null, long: null }
  })
  assert.equal(nativeRateSample(null, null), null)
})

test('nativeRateSample: the size the engine encodes at wins over the size asked for (smooth S10)', () => {
  const stats = { ms_since_open: 5000, frames_sent: 300, encoded_width: 1280, encoded_height: 720 }
  const sample = nativeRateSample(stats, { width: 1920, height: 1080 })
  assert.equal(sample.width, 1280)
  assert.equal(sample.height, 720)
  assert.equal(
    shareRateLine(at(0, 0), sample, NATIVE),
    '[Soup] Screen share: 60.0 fps sent, 1280x720, native H264'
  )
  // Not reported (before the encoder opened, an older sidecar): the size the renderer knows.
  const none = { ms_since_open: 5000, frames_sent: 300, encoded_width: null, encoded_height: null }
  assert.equal(nativeRateSample(none, { width: 1920, height: 1080 }).width, 1920)
  assert.equal(nativeRateSample(none, { width: 1920, height: 1080 }).height, 1080)
})

// One second of a native share's stats as nativeRateSample makes it.
const second = (ms, frames, median, p95, max, long) =>
  at(ms, frames, { frameGap: { median, p95, max, long } })

test('frameGapSummary: median of the medians, highest p95 and max, long gaps since the start', () => {
  const start = second(1000, 60, 16.7, 16.8, 17.0, 1)
  const seconds = [
    second(2000, 120, 16.7, 17.0, 17.2, 1),
    second(3000, 180, 16.6, 17.4, 20.0, 1),
    second(4000, 240, 16.8, 17.1, 33.4, 2),
    second(5000, 300, 16.7, 16.9, 17.0, 3),
    second(6000, 360, 33.4, 33.4, 33.4, 3)
  ].map((s) => s.frameGap)
  assert.deepEqual(frameGapSummary(start, seconds), { median: 16.7, p95: 33.4, max: 33.4, long: 2 })
  // Seconds with fewer than two frames have no interval: left out of the median.
  const sparse = [{ median: null, p95: null, max: null, long: 3 }, ...seconds.slice(0, 2)]
  assert.deepEqual(frameGapSummary(start, sparse), { median: 16.7, p95: 17.4, max: 20.0, long: 0 })
  // No interval in any second: none.
  assert.equal(frameGapSummary(start, [{ median: null, p95: null, max: null, long: 4 }]), null)
  assert.equal(frameGapSummary(start, []), null)
  // A start without a total counts no long gaps rather than guessing.
  assert.equal(frameGapSummary(at(1000, 60), seconds).long, 0)
})

test('native: the frame gap over the line, from every second between start and line', () => {
  const lines = []
  const rate = createShareRateLog({ ...NATIVE, log: (l) => lines.push(l) })
  // Observed before the start: not part of any window.
  rate.observe(second(0, 0, 50, 50, 50, 0))
  rate.offer(second(1000, 60, 16.7, 16.8, 17.0, 0))
  rate.observe(second(2000, 120, 16.7, 17.0, 17.2, 0))
  rate.observe(second(3000, 180, 16.6, 17.4, 20.0, 1))
  rate.observe(second(4000, 240, 16.8, 17.1, 33.4, 2))
  rate.observe(second(5000, 300, 16.7, 16.9, 17.0, 2))
  const last = second(6000, 360, 16.7, 16.9, 17.0, 2)
  rate.observe(last)
  assert.equal(
    rate.offer(last),
    '[Soup] Screen share: 60.0 fps sent, 1280x720, native H264, frame gap 16.7/17.4/33.4 ms, 2 long'
  )
  // The next window starts empty: a sidecar that sends no intervals gives no part.
  rate.observe(second(7000, 420, null, null, null, 2))
  assert.equal(
    rate.offer(second(11000, 660, null, null, null, 2)),
    '[Soup] Screen share: 60.0 fps sent, 1280x720, native H264'
  )
  assert.equal(lines.length, 2)
})

test("Chromium's line has no frame gap part", () => {
  const rate = createShareRateLog({ ...CHROMIUM, log: () => {} })
  rate.offer(at(0, 0, { id: 'o' }))
  assert.equal(
    rate.offer(at(5000, 300, { id: 'o' })),
    '[Soup] Screen share: 60.0 fps sent, 1280x720, Chromium AV1'
  )
})

const report = (stats) => new Map(stats.map((s) => [s.id, s]))

test('chromiumRateSample: the outbound-rtp with the largest frame size', () => {
  const sample = chromiumRateSample(
    report([
      {
        id: 'q',
        type: 'outbound-rtp',
        kind: 'video',
        framesSent: 90,
        frameWidth: 320,
        frameHeight: 180,
        timestamp: 9000,
        encoderImplementation: 'libvpx',
        mediaSourceId: 'ms'
      },
      {
        id: 'f',
        type: 'outbound-rtp',
        kind: 'video',
        framesSent: 80,
        frameWidth: 1920,
        frameHeight: 1080,
        timestamp: 9000,
        encoderImplementation: 'VaapiVideoEncodeAccelerator',
        mediaSourceId: 'ms'
      },
      {
        id: 'h',
        type: 'outbound-rtp',
        kind: 'video',
        framesSent: 85,
        frameWidth: 960,
        frameHeight: 540,
        timestamp: 9000,
        mediaSourceId: 'ms'
      },
      { id: 'a', type: 'outbound-rtp', kind: 'audio', packetsSent: 400, timestamp: 9000 },
      { id: 'ms', type: 'media-source', kind: 'video', framesPerSecond: 30 }
    ])
  )
  assert.deepEqual(sample, {
    id: 'f',
    frames: 80,
    ms: 9000,
    width: 1920,
    height: 1080,
    capturedFps: 30,
    encoder: 'VaapiVideoEncodeAccelerator'
  })
})

test('chromiumRateSample: inactive layers, RTX and audio are left out, sizes may be missing', () => {
  const sample = chromiumRateSample(
    report([
      {
        id: 'off',
        type: 'outbound-rtp',
        kind: 'video',
        framesSent: 9,
        frameWidth: 3840,
        frameHeight: 2160,
        timestamp: 1,
        active: false
      },
      { id: 'rtx', type: 'outbound-rtp', kind: 'video', packetsSent: 3, timestamp: 1 },
      { id: 'v', type: 'outbound-rtp', kind: 'video', framesSent: 0, timestamp: 1 }
    ])
  )
  assert.deepEqual(sample, {
    id: 'v',
    frames: 0,
    ms: 1,
    width: null,
    height: null,
    capturedFps: null,
    encoder: null
  })
  assert.equal(chromiumRateSample(report([{ id: 'a', type: 'outbound-rtp', kind: 'audio' }])), null)
  assert.equal(chromiumRateSample(new Map()), null)
  assert.equal(chromiumRateSample(null), null)
})

test('chromiumRateSample: a media source found without mediaSourceId', () => {
  const sample = chromiumRateSample(
    report([
      {
        id: 'v',
        type: 'outbound-rtp',
        kind: 'video',
        framesSent: 5,
        frameWidth: 2,
        frameHeight: 2,
        timestamp: 1
      },
      { id: 'mic', type: 'media-source', kind: 'audio' },
      { id: 'cam', type: 'media-source', kind: 'video', framesPerSecond: 24 }
    ])
  )
  assert.equal(sample.capturedFps, 24)
})

test('a Chromium share end to end: three polls, one line', () => {
  const lines = []
  const rate = createShareRateLog({
    path: 'Chromium',
    codec: 'H264',
    minIntervalMs: 5000,
    log: (l) => lines.push(l)
  })
  const poll = (timestamp, framesSent) =>
    rate.offer(
      chromiumRateSample(
        report([
          {
            id: 'v',
            type: 'outbound-rtp',
            kind: 'video',
            framesSent,
            frameWidth: 1600,
            frameHeight: 1000,
            timestamp,
            encoderImplementation: 'OpenH264',
            mediaSourceId: 'm'
          },
          { id: 'm', type: 'media-source', kind: 'video', framesPerSecond: 30 }
        ])
      )
    )
  poll(3000, 60)
  poll(6000, 120)
  poll(9000, 180)
  assert.deepEqual(lines, [
    '[Soup] Screen share: 20.0 fps sent, 1600x1000, Chromium H264 (OpenH264), 30.0 captured'
  ])
})
