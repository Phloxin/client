// The stream view's "Debug Information" overlay: what each stream tile shows,
// from one row of startStreamDebugStats (soup/streamDiagnostics.js). Pure, so
// it can be tested without a browser:
//   node --test src/renderer/src/lib/streamDebugInfo.test.mjs
//
// A row is { direction: 'send' | 'recv', codec, metrics }. Send rows are our own
// shares (browser encoder, or the native engine when metrics.native); recv rows
// are someone else's stream as this client decodes it.

// Chromium's software decoders, by decoderImplementation. Anything else that is
// named (ExternalDecoder (VaapiVideoDecoder), D3D11VideoDecoder, …) is hardware.
const SOFTWARE_DECODER_RE = /libvpx|dav1d|libaom|ffmpeg|openh264/i

export function decoderIsHardware(implementation) {
  if (!implementation || implementation === 'unknown') return null
  return !SOFTWARE_DECODER_RE.test(implementation)
}

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

export function formatBitrate(kbps) {
  if (!finite(kbps)) return null
  if (kbps >= 1000) return `${(kbps / 1000).toFixed(kbps >= 10000 ? 1 : 2)} Mbps`
  return `${Math.round(kbps)} kbps`
}

function formatMs(ms, digits = 0) {
  return finite(ms) ? `${ms.toFixed(digits)} ms` : null
}

function formatPercent(fraction) {
  if (!finite(fraction)) return null
  const pct = fraction * 100
  return `${pct < 10 && pct > 0 ? pct.toFixed(1) : Math.round(pct)}%`
}

function formatCount(value) {
  return finite(value) ? String(value) : null
}

// The codec line's HW/SW chip: { label, tone } or null when unknown.
function accelChip(hardware) {
  if (hardware === true) return { label: 'HW', tone: 'good' }
  if (hardware === false) return { label: 'SW', tone: 'warn' }
  return null
}

// The overlay's lines for a stream: [{ label, value, tone?, chip? }], the
// codec first, then size and rate, then the per-direction health numbers.
// Lines without a value are left out. `stream` is the tile's stream entry,
// whose codec / hardware (our own tile's encoder verdict) stand in until the
// first stats row arrives; with no row there is only the codec line and a
// "collecting" line.
export function debugInfoRows(stream, row) {
  const metrics = row?.metrics ?? {}
  const send = row ? row.direction === 'send' : !!stream?.isSelf
  const codec = row?.codec ?? stream?.codec ?? null
  const implementation = send ? metrics.implementation : metrics.decoderImplementation
  const hardware = send
    ? (metrics.hardware ?? stream?.hardware ?? null)
    : decoderIsHardware(metrics.decoderImplementation)

  const lines = []
  const push = (label, value, extra) => {
    if (value != null && value !== '') lines.push({ label, value, ...extra })
  }

  push('Codec', codec ? String(codec).toUpperCase() : '—', { chip: accelChip(hardware) })
  if (!row) {
    push('Stats', 'collecting…')
    return lines
  }
  push(send ? 'Encoder' : 'Decoder', implementation)
  if (metrics.native) push('Capture', metrics.captureBufferPath)
  if (finite(metrics.width) && finite(metrics.height)) {
    push('Resolution', `${metrics.width}×${metrics.height}`)
  }
  push('FPS', finite(metrics.fps) ? String(Math.round(metrics.fps)) : null)
  push('Bitrate', formatBitrate(send ? metrics.sendKbps : metrics.recvKbps))

  if (send) {
    push(
      'Encode',
      finite(metrics.encodeMsPerFrame) ? `${metrics.encodeMsPerFrame.toFixed(1)} ms/frame` : null
    )
    push(
      'Available',
      formatBitrate(
        finite(metrics.availableOutgoingBitrate) ? metrics.availableOutgoingBitrate / 1000 : null
      )
    )
    const limit = metrics.qualityLimitationReason
    if (limit && limit !== 'none') push('Limited by', limit, { tone: 'warn' })
    if (finite(metrics.activeEncodings) && metrics.activeEncodings > 1) {
      push('Layers', String(metrics.activeEncodings))
    }
    push('RTT', formatMs(metrics.rttMs))
    push('Loss', formatPercent(metrics.fractionLost), {
      tone: metrics.fractionLost > 0.02 ? 'warn' : undefined
    })
    if (metrics.native) {
      push('Frame gap p95', formatMs(metrics.frameIntervalP95Ms, 1))
      push('Skipped', formatCount(metrics.framesSkipped), {
        tone: metrics.framesSkipped > 0 ? 'warn' : undefined
      })
    }
  } else {
    push('Frame jitter', formatMs(metrics.frameJitterMs, 1))
    push('Jitter buffer', formatMs(metrics.jitterBufferMs))
    push('Dropped', formatCount(metrics.framesDropped), {
      tone: metrics.framesDropped > 0 ? 'warn' : undefined
    })
    push('Freezes', formatCount(metrics.freezeCount), {
      tone: metrics.freezeCount > 0 ? 'warn' : undefined
    })
    push('Packets lost', formatCount(metrics.packetsLost), {
      tone: metrics.packetsLost > 0 ? 'warn' : undefined
    })
  }
  return lines
}
