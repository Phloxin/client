import test from 'node:test'
import assert from 'node:assert/strict'
import { openBody } from './openRequest.js'

// What the renderer sends (nativeShare.js), with a made-up key.
const params = (video) => ({
  router_rtp_capabilities: { codecs: [] },
  transport: { id: 't1', ice_parameters: {}, ice_candidates: [], dtls_parameters: {}, extra: 1 },
  e2ee: {
    format: 1,
    epoch: 2,
    key: 'a2V5',
    kid: 3,
    counter: 4,
    source: { tag: 'screen', stream_key: '1:7:abc' }
  },
  video
})
const SOURCE = { pattern: { width: 1920, height: 1080, fps: 60 } }

test('openBody passes degrade on when it is size or rate (fix C1)', () => {
  for (const degrade of ['size', 'rate']) {
    const body = openBody(
      params({ start_bitrate: 8_000_000, max_bitrate: 20_000_000, codec: 'H264', degrade }),
      SOURCE
    )
    assert.deepEqual(body.video, {
      start_bitrate: 8_000_000,
      max_bitrate: 20_000_000,
      codec: 'H264',
      degrade
    })
  }
})

test('openBody leaves any other degrade out, so the sidecar takes its default', () => {
  for (const degrade of [undefined, null, '', 'Size', 'motion', 1, {}]) {
    const body = openBody(params({ start_bitrate: 1, max_bitrate: 2, degrade }), SOURCE)
    assert.deepEqual(
      body.video,
      { start_bitrate: 1, max_bitrate: 2, codec: 'H264' },
      String(degrade)
    )
    assert.equal('degrade' in body.video, false)
  }
})

test("openBody keeps only the protocol's fields", () => {
  const body = openBody(
    params({ start_bitrate: 1, max_bitrate: 2, codec: 'AV1', degrade: 'size', other: 'x' }),
    SOURCE
  )
  assert.deepEqual(Object.keys(body), [
    'router_rtp_capabilities',
    'transport',
    'e2ee',
    'source',
    'video'
  ])
  assert.deepEqual(body.transport, {
    id: 't1',
    ice_parameters: {},
    ice_candidates: [],
    dtls_parameters: {}
  })
  assert.deepEqual(body.e2ee.source, { tag: 'screen', stream_key: '1:7:abc' })
  assert.deepEqual(body.source, SOURCE)
  assert.deepEqual(body.video, { start_bitrate: 1, max_bitrate: 2, codec: 'AV1', degrade: 'size' })
})

test('openBody refuses no e2ee and a codec other than H264 or AV1', () => {
  assert.throws(() => openBody({ video: {} }, SOURCE), /no e2ee/)
  assert.throws(() => openBody(params({ codec: 'VP9' }), SOURCE), /not H264 or AV1/)
})
