import assert from 'node:assert/strict'
import test from 'node:test'

import {
  codecLabel,
  computeOutboundVideoSample,
  extractRecvAudioMetrics,
  extractRecvVideoMetrics,
  extractSendAudioMetrics,
  jitterBufferAvgMs
} from './streamStats.js'

const report = (...stats) => new Map(stats.map((stat) => [stat.id, stat]))

test('codecLabel skips RTX and tolerates incomplete parameters', () => {
  assert.equal(
    codecLabel({ codecs: [{}, { mimeType: 'video/rtx' }, { mimeType: 'video/VP9' }] }),
    'VP9'
  )
  assert.equal(codecLabel(), undefined)
})

test('outbound video samples aggregate simulcast deltas without mixing layers', () => {
  const previous = new Map()
  const first = report(
    {
      id: 'low',
      type: 'outbound-rtp',
      kind: 'video',
      framesEncoded: 100,
      totalEncodeTime: 1,
      bytesSent: 1_000,
      timestamp: 1_000,
      packetsSent: 10,
      frameWidth: 640,
      frameHeight: 360,
      framesPerSecond: 30,
      encoderImplementation: 'libvpx',
      qualityLimitationReason: 'bandwidth'
    },
    {
      id: 'high',
      type: 'outbound-rtp',
      kind: 'video',
      framesEncoded: 200,
      totalEncodeTime: 2,
      bytesSent: 3_000,
      timestamp: 1_000,
      packetsSent: 20,
      frameWidth: 1920,
      frameHeight: 1080,
      framesPerSecond: 60,
      encoderImplementation: 'ExternalEncoder',
      qualityLimitationReason: 'none'
    },
    {
      id: 'rtx',
      type: 'outbound-rtp',
      kind: 'video',
      bytesSent: 50_000,
      timestamp: 1_000
    },
    { id: 'remote-low', type: 'remote-inbound-rtp', localId: 'low', packetsLost: 2 },
    {
      id: 'remote-high',
      type: 'remote-inbound-rtp',
      localId: 'high',
      packetsLost: 3,
      roundTripTime: 0.05,
      fractionLost: 0.02
    }
  )

  const initial = computeOutboundVideoSample(first, previous)
  assert.equal(initial.activeEncodings, 2)
  assert.equal(initial.sendKbps, null)
  assert.equal(initial.hardware, false)
  assert.equal(initial.width, 1920)
  assert.equal(initial.packetsLost, 5)
  assert.equal(previous.size, 2)

  const second = report(
    {
      ...first.get('low'),
      framesEncoded: 130,
      totalEncodeTime: 1.3,
      bytesSent: 2_000,
      timestamp: 2_000,
      qualityLimitationReason: 'bandwidth'
    },
    {
      ...first.get('high'),
      framesEncoded: 260,
      totalEncodeTime: 2.6,
      bytesSent: 5_000,
      timestamp: 2_000,
      qualityLimitationReason: 'cpu'
    },
    first.get('remote-low'),
    first.get('remote-high')
  )
  const sample = computeOutboundVideoSample(second, previous)

  assert.equal(sample.sendKbps, 24)
  assert.ok(Math.abs(sample.encodeMsPerFrame - 10) < 1e-9)
  assert.equal(sample.qualityLimitationReason, 'cpu')
  assert.equal(sample.rttMs, 50)
  assert.equal(sample.activeEncodings, 2)
})

test('inactive and departed encodings drop their stale delta baselines', () => {
  const previous = new Map([
    ['inactive', { bytes: 1, timestamp: 1 }],
    ['departed', { bytes: 1, timestamp: 1 }]
  ])
  const sample = computeOutboundVideoSample(
    report({
      id: 'inactive',
      type: 'outbound-rtp',
      kind: 'video',
      framesEncoded: 10,
      active: false
    }),
    previous
  )
  assert.equal(sample, null)
  assert.equal(previous.size, 0)
})

test('audio metrics calculate rates and preserve cumulative snapshots', () => {
  const previous = {
    bytes: 1_000,
    timestamp: 1_000,
    jitterBufferDelay: 1,
    jitterBufferEmittedCount: 100,
    concealedSamples: 20
  }
  const inbound = {
    id: 'audio',
    type: 'inbound-rtp',
    kind: 'audio',
    bytesReceived: 3_000,
    timestamp: 2_000,
    packetsReceived: 80,
    jitter: 0.004,
    jitterBufferDelay: 1.5,
    jitterBufferEmittedCount: 200,
    concealedSamples: 25,
    concealmentEvents: 2,
    audioLevel: 0.4
  }
  const { metrics, snapshot } = extractRecvAudioMetrics(report(inbound), previous)

  assert.equal(metrics.recvKbps, 16)
  assert.equal(metrics.jitterMs, 4)
  assert.equal(metrics.jitterBufferMs, 5)
  assert.equal(metrics.concealedSamplesDelta, 5)
  assert.equal(snapshot.concealedSamples, 25)
})

test('audio metrics separate NetEq time-stretch from playout-path delay', () => {
  const previous = {
    bytes: 1_000,
    timestamp: 1_000,
    jitterBufferDelay: 1,
    jitterBufferEmittedCount: 100,
    removedSamplesForAcceleration: 480,
    insertedSamplesForDeceleration: 960,
    totalPlayoutDelay: 2,
    totalSamplesCount: 100
  }
  const inbound = {
    id: 'audio',
    type: 'inbound-rtp',
    kind: 'audio',
    bytesReceived: 3_000,
    timestamp: 2_000,
    jitterBufferDelay: 1.5,
    jitterBufferEmittedCount: 200,
    removedSamplesForAcceleration: 3_360,
    insertedSamplesForDeceleration: 960
  }
  const playout = {
    id: 'playout',
    type: 'media-playout',
    totalPlayoutDelay: 8,
    totalSamplesCount: 200
  }
  const { metrics, snapshot } = extractRecvAudioMetrics(report(inbound, playout), previous)

  // Buffer draining faster than realtime while the render path holds 60ms.
  assert.equal(metrics.acceleratedSamplesDelta, 2_880)
  assert.equal(metrics.deceleratedSamplesDelta, 0)
  assert.equal(metrics.playoutMs, 60)
  assert.equal(snapshot.totalPlayoutDelay, 8)

  // A counter that went backwards (receiver reset) reads as unknown, not zero.
  const reset = extractRecvAudioMetrics(
    report({ ...inbound, removedSamplesForAcceleration: 0 }, playout),
    previous
  )
  assert.equal(reset.metrics.acceleratedSamplesDelta, null)

  // No media-playout stat (or no previous sample) leaves playout unknown.
  assert.equal(extractRecvAudioMetrics(report(inbound), previous).metrics.playoutMs, null)
  assert.equal(extractRecvAudioMetrics(report(inbound, playout), null).metrics.playoutMs, null)
})

test('send-audio and receive-video metrics keep rows stable across missing reports', () => {
  const send = extractSendAudioMetrics(
    report(
      {
        id: 'out',
        type: 'outbound-rtp',
        kind: 'audio',
        bytesSent: 2_000,
        timestamp: 2_000,
        packetsSent: 10
      },
      {
        id: 'remote',
        type: 'remote-inbound-rtp',
        kind: 'audio',
        roundTripTime: 0.02
      }
    ),
    { bytes: 1_000, timestamp: 1_000 }
  )
  assert.equal(send.metrics.sendKbps, 8)
  assert.equal(send.metrics.rttMs, 20)

  const previous = { bytes: 4, timestamp: 5 }
  assert.deepEqual(extractRecvVideoMetrics(new Map(), previous), {
    metrics: {},
    snapshot: previous
  })
})

test('jitterBufferAvgMs rejects windows with no newly emitted samples', () => {
  const previous = { jitterBufferDelay: 1, jitterBufferEmittedCount: 10 }
  assert.equal(jitterBufferAvgMs(2, 10, previous), null)
  assert.equal(jitterBufferAvgMs(2, 20, previous), 100)
})
