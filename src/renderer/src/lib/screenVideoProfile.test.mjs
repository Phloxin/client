import assert from 'node:assert/strict'
import { test } from 'node:test'

import { screenCodecOptionsFor, screenEncodingFor } from './screenVideoProfile.js'

const AV1 = { mimeType: 'video/AV1' }
const H264 = { mimeType: 'video/H264' }

test('1080p60 Motion gives AV1 enough per-frame budget for fast gameplay', () => {
  const encoding = screenEncodingFor({
    width: 1920,
    height: 1080,
    fps: 60,
    codec: AV1,
    optimizeFor: 'motion'
  })

  assert.deepEqual(encoding, { maxBitrate: 16_750_000, maxFramerate: 60 })
  assert.deepEqual(screenCodecOptionsFor(encoding), { videoGoogleStartBitrate: 8_000 })
})

test('1080p60 Motion gives H264 its full safe transport headroom', () => {
  const encoding = screenEncodingFor({
    width: 1920,
    height: 1080,
    fps: 60,
    codec: H264,
    optimizeFor: 'motion'
  })

  assert.deepEqual(encoding, { maxBitrate: 20_000_000, maxFramerate: 60 })
  assert.deepEqual(screenCodecOptionsFor(encoding), { videoGoogleStartBitrate: 8_000 })
})

test('60fps keeps the same per-frame ceiling as 30fps before the safety cap', () => {
  const at30 = screenEncodingFor({
    width: 1920,
    height: 1080,
    fps: 30,
    codec: AV1,
    optimizeFor: 'detail'
  })
  const at60 = screenEncodingFor({
    width: 1920,
    height: 1080,
    fps: 60,
    codec: AV1,
    optimizeFor: 'detail'
  })

  assert.equal(at60.maxBitrate, at30.maxBitrate * 2)
  assert.equal(at60.maxFramerate, 60)
})

test('lower-resolution shares keep a useful floor and a proportional ramp target', () => {
  const encoding = screenEncodingFor({
    width: 1280,
    height: 720,
    fps: 30,
    codec: AV1,
    optimizeFor: 'detail'
  })

  assert.deepEqual(encoding, { maxBitrate: 5_000_000, maxFramerate: 30 })
  assert.deepEqual(screenCodecOptionsFor(encoding), { videoGoogleStartBitrate: 2_500 })
})
