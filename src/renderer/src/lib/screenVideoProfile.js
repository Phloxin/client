// Screen-share encoder policy. Keep this module browser-independent so the
// bitrate/ramp profile can be regression-tested without loading mediasoup.

const REFERENCE_WIDTH = 1920
const REFERENCE_HEIGHT = 1080
const REFERENCE_FPS = 30
const BASE_1080P30_BITRATE = 8_000_000
const MIN_BITRATE = 5_000_000
const MAX_BASE_BITRATE = 12_000_000
const MAX_BITRATE = 20_000_000
const BITRATE_STEP = 250_000
const MIN_START_BITRATE_KBPS = 2_500
const MAX_START_BITRATE_KBPS = 8_000

function codecEfficiencyFactor(codec) {
  const mime = codec?.mimeType ?? ''
  if (/h264/i.test(mime)) return 1.2
  if (/vp9/i.test(mime)) return 1.08
  return 1
}

// Ceiling for the single full-resolution screen encoding. The ceiling scales
// with both pixels and frames so 60 fps does not receive fewer bits per frame
// than 30 fps. H.264 gets extra headroom because it needs more bitrate than AV1
// for comparable fast-motion quality. These are congestion-control ceilings,
// not forced targets: WebRTC can and will send below them on a constrained link.
export function screenEncodingFor({ width, height, fps, codec, optimizeFor }) {
  const pixels = Math.max(1, Number(width) * Number(height))
  const safeFps = Math.max(1, Number(fps) || REFERENCE_FPS)
  const pixelFactor = pixels / (REFERENCE_WIDTH * REFERENCE_HEIGHT)
  const frameRateFactor = Math.max(1, safeFps / REFERENCE_FPS)
  const motionFactor = optimizeFor === 'motion' ? 1.05 : 1
  const uncappedBitrate =
    Math.min(MAX_BASE_BITRATE, Math.max(MIN_BITRATE, BASE_1080P30_BITRATE * pixelFactor)) *
    frameRateFactor *
    motionFactor *
    codecEfficiencyFactor(codec)
  const maxBitrate = Math.min(
    // The SFU currently caps the aggregate producer transport at 25 Mbps.
    // This leaves at least 5 Mbps for audio and retransmission bursts.
    MAX_BITRATE,
    Math.round(uncappedBitrate / BITRATE_STEP) * BITRATE_STEP
  )

  return { maxBitrate, maxFramerate: Math.round(safeFps) }
}

// x-google-start-bitrate is expressed in kbps. Starting at half the encoding
// ceiling avoids the old 2.5 Mbps crawl on a 1080p60 share while the 8 Mbps cap
// keeps startup conservative for viewers on constrained paths.
export function screenCodecOptionsFor(encoding) {
  const halfCeilingKbps = Math.round((Number(encoding?.maxBitrate) || 0) / 2_000)
  const videoGoogleStartBitrate = Math.min(
    MAX_START_BITRATE_KBPS,
    Math.max(MIN_START_BITRATE_KBPS, halfCeilingKbps)
  )
  return { videoGoogleStartBitrate }
}
