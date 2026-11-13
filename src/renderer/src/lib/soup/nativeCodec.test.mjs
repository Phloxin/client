// The codec a native screen share sends (T1 to T3 of .plans/native-media-engine-av1-3-client.md).
//   node --test src/renderer/src/lib/soup/nativeCodec.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { nativeCodecMime, nativeShareCodec } from './nativeCodec.js'

const BOTH = ['H264', 'AV1']
const H264_ONLY = ['H264']
const allowAll = () => true
const allowOnly =
  (...mimes) =>
  (mime) =>
    mimes.includes(mime)
const noAv1 = allowOnly('video/h264', 'video/vp9', 'video/vp8')
const noH264 = allowOnly('video/av1', 'video/vp9', 'video/vp8')
const CHANNEL_NAMES = new Map([
  [allowAll, 'all'],
  [noAv1, 'no AV1'],
  [noH264, 'no H264']
])

// Every row of T1: the choice, with and without AV1 listed by the sidecar, with and without the
// channel allowing the codec. null: the share goes through Chromium.
const ROWS = [
  // auto: H264 natively, whatever the sidecar lists
  ['auto', null, BOTH, allowAll, 'H264'],
  ['auto', null, H264_ONLY, allowAll, 'H264'],
  ['auto', null, null, allowAll, 'H264'],
  ['auto', null, BOTH, noAv1, 'H264'],
  ['auto', null, BOTH, noH264, null],
  ['auto', null, H264_ONLY, noH264, null],
  // h264: the same
  ['h264', null, BOTH, allowAll, 'H264'],
  ['h264', null, H264_ONLY, allowAll, 'H264'],
  ['h264', null, null, allowAll, 'H264'],
  ['h264', null, BOTH, noAv1, 'H264'],
  ['h264', null, BOTH, noH264, null],
  // av1: AV1 natively only when the sidecar lists it and the channel allows it
  ['av1', null, BOTH, allowAll, 'AV1'],
  ['av1', null, H264_ONLY, allowAll, null],
  ['av1', null, BOTH, noAv1, null],
  ['av1', null, H264_ONLY, noAv1, null],
  ['av1', null, BOTH, noH264, 'AV1'],
  // not known yet: asked for, main checks it at open
  ['av1', null, null, allowAll, 'AV1'],
  ['av1', null, null, noAv1, null],
  // PREFER_SCREENSHARE_CODEC counts when the picker says auto
  ['auto', 'AV1', BOTH, allowAll, 'AV1'],
  ['auto', 'AV1', H264_ONLY, allowAll, null],
  ['auto', 'AV1', BOTH, noAv1, null],
  ['auto', 'AV1', null, allowAll, 'AV1'],
  ['auto', 'H264', BOTH, allowAll, 'H264'],
  ['auto', 'H264', BOTH, noH264, null],
  // the picker's choice comes before the variable
  ['h264', 'AV1', BOTH, allowAll, 'H264'],
  ['av1', 'H264', BOTH, allowAll, 'AV1'],
  ['av1', 'H264', H264_ONLY, allowAll, null],
  // VP9 and VP8 are never native
  ['auto', 'VP9', BOTH, allowAll, null],
  ['auto', 'VP8', BOTH, allowAll, null],
  ['vp9', null, BOTH, allowAll, null],
  ['h264', 'VP9', BOTH, allowAll, 'H264'],
  // a value nobody can express counts as auto
  ['something', 'nonsense', BOTH, allowAll, 'H264']
]

for (const [codecPref, envCodec, sidecarCodecs, allowed, want] of ROWS) {
  const lists = sidecarCodecs ? sidecarCodecs.join('+') : 'unknown'
  const channel = CHANNEL_NAMES.get(allowed)
  test(`picker ${codecPref}, env ${envCodec}, sidecar ${lists}, channel ${channel}: ${want}`, () => {
    assert.equal(nativeShareCodec({ codecPref, envCodec, sidecarCodecs, allowed }), want)
  })
}

test('the channel is asked about the chosen codec in lower case', () => {
  const asked = []
  nativeShareCodec({
    codecPref: 'av1',
    sidecarCodecs: BOTH,
    allowed: (mime) => {
      asked.push(mime)
      return true
    }
  })
  assert.deepEqual(asked, ['video/av1'])
})

test('defaults: auto, nothing known, every codec allowed', () => {
  assert.equal(nativeShareCodec(), 'H264')
  assert.equal(nativeShareCodec({ codecPref: undefined, envCodec: undefined }), 'H264')
})

test('nativeCodecMime', () => {
  assert.equal(nativeCodecMime('H264'), 'video/h264')
  assert.equal(nativeCodecMime('AV1'), 'video/av1')
  assert.equal(nativeCodecMime('VP9'), null)
  assert.equal(nativeCodecMime(undefined), null)
})
