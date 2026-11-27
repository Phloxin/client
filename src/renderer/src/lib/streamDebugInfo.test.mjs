import assert from 'node:assert/strict'
import test from 'node:test'

import { debugInfoRows, decoderIsHardware, formatBitrate } from './streamDebugInfo.js'
import { extractNativeSendMetrics } from './streamStats.js'

const byLabel = (lines) => Object.fromEntries(lines.map((line) => [line.label, line]))

test('decoderIsHardware tells Chromium software decoders from hardware ones', () => {
  assert.equal(decoderIsHardware('libdav1d'), false)
  assert.equal(decoderIsHardware('libvpx'), false)
  assert.equal(decoderIsHardware('FFmpeg'), false)
  assert.equal(decoderIsHardware('ExternalDecoder (VaapiVideoDecoder)'), true)
  assert.equal(decoderIsHardware('D3D11VideoDecoder'), true)
  assert.equal(decoderIsHardware('unknown'), null)
  assert.equal(decoderIsHardware(null), null)
})

test('formatBitrate switches to Mbps at 1000 kbps', () => {
  assert.equal(formatBitrate(850.4), '850 kbps')
  assert.equal(formatBitrate(4210), '4.21 Mbps')
  assert.equal(formatBitrate(12345), '12.3 Mbps')
  assert.equal(formatBitrate(null), null)
  assert.equal(formatBitrate(Number.NaN), null)
})

test('before the first row only the codec and a collecting line show', () => {
  const lines = debugInfoRows({ isSelf: true, codec: 'AV1', hardware: false }, null)
  assert.deepEqual(
    lines.map((line) => line.label),
    ['Codec', 'Stats']
  )
  assert.equal(lines[0].value, 'AV1')
  assert.deepEqual(lines[0].chip, { label: 'SW', tone: 'warn' })
})

test('a received stream shows its decoder, size, rate and health', () => {
  const lines = byLabel(
    debugInfoRows(
      { isSelf: false },
      {
        direction: 'recv',
        codec: 'VP9',
        metrics: {
          decoderImplementation: 'ExternalDecoder (VaapiVideoDecoder)',
          width: 1920,
          height: 1080,
          fps: 59.7,
          recvKbps: 4210,
          frameJitterMs: 2.14,
          jitterBufferMs: 18.4,
          framesDropped: 3,
          freezeCount: 0,
          packetsLost: 0
        }
      }
    )
  )
  assert.equal(lines.Codec.value, 'VP9')
  assert.deepEqual(lines.Codec.chip, { label: 'HW', tone: 'good' })
  assert.equal(lines.Decoder.value, 'ExternalDecoder (VaapiVideoDecoder)')
  assert.equal(lines.Resolution.value, '1920×1080')
  assert.equal(lines.FPS.value, '60')
  assert.equal(lines.Bitrate.value, '4.21 Mbps')
  assert.equal(lines['Frame jitter'].value, '2.1 ms')
  assert.equal(lines['Jitter buffer'].value, '18 ms')
  assert.equal(lines.Dropped.tone, 'warn')
  assert.equal(lines.Freezes.tone, undefined)
  assert.equal(lines.Encoder, undefined)
})

test('our own browser share shows its encoder and send-side numbers', () => {
  const lines = byLabel(
    debugInfoRows(
      { isSelf: true, codec: 'AV1' },
      {
        direction: 'send',
        codec: 'AV1',
        metrics: {
          implementation: 'ExternalEncoder',
          hardware: true,
          width: 2560,
          height: 1440,
          fps: 60,
          sendKbps: 8000,
          encodeMsPerFrame: 3.25,
          availableOutgoingBitrate: 12_000_000,
          qualityLimitationReason: 'bandwidth',
          activeEncodings: 1,
          rttMs: 21.6,
          fractionLost: 0.004
        }
      }
    )
  )
  assert.deepEqual(lines.Codec.chip, { label: 'HW', tone: 'good' })
  assert.equal(lines.Encoder.value, 'ExternalEncoder')
  assert.equal(lines.Encode.value, '3.3 ms/frame')
  assert.equal(lines.Available.value, '12.0 Mbps')
  assert.equal(lines['Limited by'].value, 'bandwidth')
  assert.equal(lines['Limited by'].tone, 'warn')
  assert.equal(lines.Layers, undefined)
  assert.equal(lines.RTT.value, '22 ms')
  assert.equal(lines.Loss.value, '0.4%')
  assert.equal(lines.Dropped, undefined)
})

test('an unlimited encoder has no Limited by line', () => {
  const lines = byLabel(
    debugInfoRows(
      { isSelf: true },
      { direction: 'send', codec: 'H264', metrics: { qualityLimitationReason: 'none' } }
    )
  )
  assert.equal(lines['Limited by'], undefined)
  assert.equal(lines.Codec.chip, null)
})

test('extractNativeSendMetrics takes the frame rate from the engine clock', () => {
  const stats = (frames, ms) => ({
    frames_sent: frames,
    ms_since_open: ms,
    encoded_width: 1920,
    encoded_height: 1080,
    encoder_output_bps: 6_500_000,
    encode_ms_median: 2.5,
    bandwidth_estimate_bps: 20_000_000,
    rtt_ms: 12,
    loss_fraction: 0,
    frames_skipped_backlog: 1,
    frames_skipped_rate: 2,
    frame_interval_ms_p95: 17.9,
    capture_buffer_path: 'dmabuf',
    nacks: 0,
    plis: 1
  })
  const first = extractNativeSendMetrics(stats(100, 2000), null)
  assert.equal(first.metrics.fps, null)
  const next = extractNativeSendMetrics(stats(160, 3000), first.snapshot)
  assert.equal(next.metrics.fps, 60)
  assert.equal(next.metrics.native, true)
  assert.equal(next.metrics.sendKbps, 6500)
  assert.equal(next.metrics.framesSkipped, 3)
  assert.equal(next.metrics.width, 1920)

  const lines = byLabel(
    debugInfoRows({ isSelf: true }, { direction: 'send', codec: 'AV1', metrics: next.metrics })
  )
  assert.equal(lines.Encoder.value, 'Pylon native engine')
  assert.equal(lines.Capture.value, 'dmabuf')
  assert.equal(lines.FPS.value, '60')
  assert.equal(lines.Bitrate.value, '6.50 Mbps')
  assert.equal(lines['Frame gap p95'].value, '17.9 ms')
  assert.equal(lines.Skipped.tone, 'warn')
})

test('extractNativeSendMetrics with no stats yet keeps the previous snapshot', () => {
  const previous = { frames: 5, ms: 100 }
  assert.deepEqual(extractNativeSendMetrics(null, previous), { metrics: {}, snapshot: previous })
})
