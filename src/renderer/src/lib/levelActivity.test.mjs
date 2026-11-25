import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createLevelActivity,
  createLevelGateController,
  createNoiseFloorTracker,
  createSpeakingActivity
} from './levelActivity.js'

// The live detector and gate tick every 40 ms.
const TICK_MS = 40

// Deterministic uniform source in (0, 1). xorshift32 never reaches 0 from a
// nonzero seed, so Box–Muller's log() is always finite.
function xorshift32(seed) {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x >>>= 0
    x ^= x >>> 17
    x ^= x << 5
    x >>>= 0
    return x / 4294967296
  }
}

// Raw readings of stationary noise. One reading is the RMS of a 1024-sample
// analyser window, modelled as 167 squared normals; 1.82 level units per dB.
function createNoise(seed) {
  const uniform = xorshift32(seed)
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform())
  return (mean) => {
    let chi = 0
    for (let i = 0; i < 167; i++) chi += normal() ** 2
    return Math.max(0, Math.min(100, mean + 1.82 * 10 * Math.log10(chi / 167)))
  }
}

// The reader's smoothing at a 40 ms tick: first reading as-is, then a 35 ms
// attack and 180 ms release.
function createSmoother() {
  let smoothed = null
  return (raw) => {
    if (smoothed == null) {
      smoothed = raw
    } else {
      smoothed += (raw - smoothed) * (1 - Math.exp(-TICK_MS / (raw > smoothed ? 35 : 180)))
      if (smoothed < 0.05) smoothed = 0
    }
    return smoothed
  }
}

// Drives createSpeakingActivity the way createSpeakingDetector does: each tick
// passes the smoothed and the raw reading, then the clock moves 40 ms.
function createDetectorSim() {
  const activity = createSpeakingActivity()
  const smooth = createSmoother()
  let now = 0
  return {
    tick(raw) {
      const at = now
      const lit = activity.update(smooth(raw), raw, at)
      now += TICK_MS
      return { at, lit }
    },
    now: () => now
  }
}

test('level activity holds through the hysteresis band and drops after the hold', () => {
  const activity = createLevelActivity({ holdMs: 250, hysteresis: 3 })
  let now = 0
  const step = (level) => {
    const active = activity.update(level, 12, now)
    now += TICK_MS
    return active
  }

  assert.equal(step(11.9), false, 'under the threshold stays off')
  assert.equal(step(12), true, 'on at the threshold')

  for (let i = 0; i < 2500; i++) {
    assert.equal(step(10), true, 'a level of 10 is inside the release band and holds it on')
  }

  const lastAboveAt = now - TICK_MS
  for (;;) {
    const at = now
    const active = step(8)
    if (at - lastAboveAt < 250) {
      assert.equal(active, true, `still on ${at - lastAboveAt} ms after the last level at 9+`)
    } else {
      assert.equal(active, false, `off once 250 ms have passed (${at - lastAboveAt} ms)`)
      break
    }
  }
  assert.equal(activity.isActive(), false)
})

test('level activity without hysteresis lets a level under the threshold close it (F2 latch)', () => {
  const activity = createLevelActivity({ holdMs: 200, hysteresis: 0 })
  let now = 0
  const step = (level) => {
    const active = activity.update(level, 15, now)
    now += TICK_MS
    return active
  }

  for (let i = 0; i < 10; i++) assert.equal(step(50), true)
  const lastAboveAt = now - TICK_MS

  let offAt = null
  for (let i = 0; i < 1500; i++) {
    const at = now
    const active = step(13)
    if (offAt == null && !active) offAt = at
    if (offAt != null) assert.equal(active, false, 'a steady 13 never holds or reopens it')
    else assert.ok(at - lastAboveAt < 200, `still on ${at - lastAboveAt} ms after the burst`)
  }
  assert.ok(offAt != null, 'a steady 13 under a threshold of 15 turns it off')
  assert.ok(offAt - lastAboveAt >= 200, 'not before the 200 ms hold')
  assert.ok(offAt - lastAboveAt < 200 + TICK_MS, 'on the first tick after the hold')
})

test('noise floor is the minimum and forgets a step up after one to two buckets', () => {
  const tracker = createNoiseFloorTracker()
  const seen = [30, 20, 25, 10, 40].map((level, i) => tracker.update(level, i * TICK_MS))
  assert.deepEqual(seen, [30, 20, 20, 10, 10])

  // Every phase of the step against the bucket boundary.
  for (let warmupMs = 3000; warmupMs < 3000 + 1600; warmupMs += TICK_MS) {
    const floor = createNoiseFloorTracker()
    let now = 0
    for (; now < warmupMs; now += TICK_MS) floor.update(5, now)

    const stepAt = now
    let risenAt = null
    for (; now < stepAt + 6000; now += TICK_MS) {
      const value = floor.update(20, now)
      if (risenAt == null && value === 20) risenAt = now
      if (risenAt == null) assert.equal(value, 5, 'reads the old floor until it rises')
      else assert.equal(value, 20, 'stays risen')
    }
    assert.ok(risenAt != null, `floor rose (warm-up ${warmupMs} ms)`)
    const delay = risenAt - stepAt
    assert.ok(delay >= 1500, `not before 1500 ms (rose after ${delay} ms)`)
    assert.ok(delay <= 3000, `within 3000 ms (rose after ${delay} ms)`)
  }
})

test('speaking activity on a quiet mic keeps the fixed 12 on and 9 release', () => {
  const activity = createSpeakingActivity()
  let now = 0
  // Words carry their own raw level; between them the raw reading is 0.
  const step = (level, raw) => {
    const speaking = activity.update(level, raw, now)
    now += TICK_MS
    return speaking
  }

  for (let i = 0; i < 25; i++) assert.equal(step(0, 0), false, 'silence')
  assert.equal(step(11.9, 11.9), false, 'a word under 12 does not light it')
  assert.equal(step(0, 0), false)
  assert.equal(step(12, 12), true, 'a word at 12 lights it')

  for (let i = 0; i < 100; i++) {
    assert.equal(step(9, 0), true, 'a smoothed 9 between words holds it')
  }

  const lastAboveAt = now - TICK_MS
  for (;;) {
    const at = now
    const speaking = step(8.9, 0)
    if (at - lastAboveAt < 250) {
      assert.equal(speaking, true, `held ${at - lastAboveAt} ms after the last 9`)
    } else {
      assert.equal(speaking, false, `off once 250 ms under 9 (${at - lastAboveAt} ms)`)
      break
    }
  }
  assert.equal(activity.isSpeaking(), false)
})

test('speaking activity does not latch on noise after speech (F1)', () => {
  for (const noiseLevel of [10, 12, 20, 30]) {
    const noise = createNoise(0x9e3779b9 ^ noiseLevel)
    const sim = createDetectorSim()

    while (sim.now() < 5000) sim.tick(noise(noiseLevel))
    let litAtSpeechEnd = false
    while (sim.now() < 6000) litAtSpeechEnd = sim.tick(noise(50)).lit
    assert.equal(litAtSpeechEnd, true, `speech at 50 lights it over noise at ${noiseLevel}`)

    const speechEndedAt = sim.now()
    let offAt = null
    let remaining = 0
    let litRemaining = 0
    while (sim.now() < speechEndedAt + 60000) {
      const { at, lit } = sim.tick(noise(noiseLevel))
      if (offAt == null) {
        if (!lit) offAt = at
        continue
      }
      remaining++
      if (lit) litRemaining++
    }

    assert.ok(offAt != null, `ring drops over noise at ${noiseLevel}`)
    assert.ok(
      offAt - speechEndedAt <= 800,
      `noise at ${noiseLevel}: off ${offAt - speechEndedAt} ms after speech, want <= 800`
    )
    assert.ok(
      litRemaining / remaining < 0.02,
      `noise at ${noiseLevel}: lit ${litRemaining} of ${remaining} remaining ticks, want < 2 %`
    )
  }
})

test('speaking activity never lights on noise alone', () => {
  for (const noiseLevel of [10, 20, 30]) {
    const noise = createNoise(0x85ebca6b ^ noiseLevel)
    const sim = createDetectorSim()

    while (sim.now() < 3000) sim.tick(noise(noiseLevel))
    while (sim.now() < 63000) {
      const { at, lit } = sim.tick(noise(noiseLevel))
      assert.equal(lit, false, `noise at ${noiseLevel} lit it at ${at} ms`)
    }
  }
})

test('speaking activity stays lit through syllable dips over noise', () => {
  const noise = createNoise(0xc2b2ae35)
  const sim = createDetectorSim()
  let ticks = 0
  let lit = 0
  while (sim.now() < 30000) {
    // 180 ms of speech at 45, then 70 ms of the room's noise at 20.
    const speech = sim.now() % 250 < 180
    if (sim.tick(noise(speech ? 45 : 20)).lit) lit++
    ticks++
  }
  assert.ok(lit / ticks >= 0.99, `lit ${lit} of ${ticks} ticks, want >= 99 %`)
})

test('the floor cap keeps sustained sound without dips lit', () => {
  const noise = createNoise(0x27d4eb2f)
  const shapes = [
    ['a constant 45', () => 45],
    ['stationary noise at 45', () => noise(45)]
  ]
  for (const [name, next] of shapes) {
    const sim = createDetectorSim()
    while (sim.now() < 10000) {
      const { at, lit } = sim.tick(next())
      if (at >= 1000) assert.equal(lit, true, `${name} dropped at ${at} ms`)
    }
  }
})

test('gate controller reports each open and close once, and release reports closing', (t) => {
  let clock = 0
  t.mock.method(performance, 'now', () => clock)

  const audioContext = { currentTime: 0 }
  const gate = {
    gain: {
      value: 0,
      setValueAtTime() {},
      cancelScheduledValues() {},
      linearRampToValueAtTime() {}
    }
  }
  let level = 0
  const events = []
  const controller = createLevelGateController(audioContext, gate, () => level, {
    threshold: 15,
    onOpenChange: (open) => events.push(open)
  })
  const tick = () => {
    const result = controller.update()
    clock += TICK_MS
    return result
  }

  controller.release()
  assert.deepEqual(events, [], 'release while closed reports nothing')

  tick()
  assert.deepEqual(events, [])

  level = 50
  for (let i = 0; i < 10; i++) assert.deepEqual(tick(), { level: 50, open: true })
  assert.deepEqual(events, [true], 'opening is reported once')

  // The F2 latch: a level just under the marker must not hold the gate open.
  level = 13
  for (let i = 0; i < 25; i++) tick()
  assert.equal(controller.isOpen(), false, 'a level 2 under the marker closes it')
  assert.deepEqual(events, [true, false], 'closing is reported once')

  level = 50
  tick()
  assert.equal(controller.isOpen(), true)
  assert.deepEqual(events, [true, false, true])

  controller.release()
  assert.equal(controller.isOpen(), false)
  assert.deepEqual(events, [true, false, true, false], 'release while open reports closing once')

  controller.release()
  assert.deepEqual(events, [true, false, true, false], 'a second release reports nothing')
})
