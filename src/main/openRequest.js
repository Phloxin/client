// The body of the sidecar's `open` request (native/media-engine/PROTOCOL.md), from what the
// renderer asked: the protocol's fields and nothing more. Kept apart from mediaEngine.js, which
// imports Electron, so it can be tested (as previewRequest.js is).

// The codecs `open` may ask for (PROTOCOL.md, video.codec).
export const OPEN_CODECS = new Set(['H264', 'AV1'])
// What gives way first on a tight link (video.degrade): anything else is left out, the
// sidecar's default then holds ('rate'), as a value it does not know would be a fatal open.
const DEGRADES = new Set(['size', 'rate'])

// `source` is main's own reading of the configured source (openSource in mediaEngine.js).
export function openBody(params, source) {
  const e2ee = params?.e2ee
  if (!e2ee || typeof e2ee !== 'object') throw new Error('open: no e2ee')
  const transport = params?.transport ?? {}
  const codec = params?.video?.codec ?? 'H264'
  if (!OPEN_CODECS.has(codec)) throw new Error('open: the video codec is not H264 or AV1')
  const degrade = params?.video?.degrade
  return {
    router_rtp_capabilities: params?.router_rtp_capabilities,
    transport: {
      id: transport.id,
      ice_parameters: transport.ice_parameters,
      ice_candidates: transport.ice_candidates,
      dtls_parameters: transport.dtls_parameters
    },
    e2ee: {
      format: e2ee.format,
      epoch: e2ee.epoch,
      key: e2ee.key,
      kid: e2ee.kid,
      counter: e2ee.counter,
      source: { tag: e2ee.source?.tag, stream_key: e2ee.source?.stream_key ?? null }
    },
    source,
    video: {
      start_bitrate: params?.video?.start_bitrate,
      max_bitrate: params?.video?.max_bitrate,
      codec,
      // A share for motion gives way on size first.
      ...(DEGRADES.has(degrade) ? { degrade } : {})
    }
  }
}
