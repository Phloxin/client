// Browser-independent WebRTC stats calculations shared by the adaptive encoder
// policy and the diagnostics panel. Keeping the delta state in caller-owned
// maps lets independent pollers inspect the same sender without interfering.

// Short codec name (for example AV1, VP9, or H264), skipping RTX.
export function codecLabel(rtpParameters) {
  const mime = rtpParameters?.codecs?.find(
    (codec) => typeof codec.mimeType === 'string' && !codec.mimeType.toLowerCase().endsWith('/rtx')
  )?.mimeType
  return mime?.split('/')[1]
}

// Windowed rate in kbps from a cumulative byte counter.
function streamKbps(currentBytes, currentTimestamp, previous) {
  if (!previous) return null
  if (
    ![currentBytes, currentTimestamp, previous.bytes, previous.timestamp].every(Number.isFinite)
  ) {
    return null
  }
  const elapsedMs = currentTimestamp - previous.timestamp
  if (elapsedMs <= 0 || currentBytes < previous.bytes) return null
  return (8 * (currentBytes - previous.bytes)) / elapsedMs
}

// Windowed jitter-buffer delay in milliseconds: delta accumulated delay divided
// by the number of samples emitted during the same window.
export function jitterBufferAvgMs(currentDelay, currentEmitted, previous) {
  if (!previous) return null
  if (
    ![
      currentDelay,
      currentEmitted,
      previous.jitterBufferDelay,
      previous.jitterBufferEmittedCount
    ].every(Number.isFinite)
  ) {
    return null
  }
  const emittedDelta = currentEmitted - previous.jitterBufferEmittedCount
  if (emittedDelta <= 0) return null
  return ((currentDelay - previous.jitterBufferDelay) / emittedDelta) * 1000
}

// Chromium software encoders reported by getStats(). Unknown or empty values do
// not count as either hardware or software until the browser supplies a verdict.
const SOFTWARE_ENCODER_RE = /libaom|libvpx|openh264/i

function encoderIsHardware(implementation) {
  if (!implementation || implementation === 'unknown') return null
  return !SOFTWARE_ENCODER_RE.test(implementation)
}

function outboundLayerIsHigher(left, right) {
  const leftPixels = (Number(left?.frameWidth) || 0) * (Number(left?.frameHeight) || 0)
  const rightPixels = (Number(right?.frameWidth) || 0) * (Number(right?.frameHeight) || 0)
  if (leftPixels !== rightPixels) return leftPixels > rightPixels

  const leftFps = Number(left?.framesPerSecond) || 0
  const rightFps = Number(right?.framesPerSecond) || 0
  if (leftFps !== rightFps) return leftFps > rightFps

  // Dimensions can be missing briefly at startup. RIDs retain the usual
  // low -> medium -> full simulcast ordering.
  const ridRank = (rid) => ({ q: 0, h: 1, f: 2 })[String(rid ?? '').toLowerCase()] ?? 0
  return ridRank(left?.rid) > ridRank(right?.rid)
}

// Aggregate outbound video across simulcast encodings into one sample. The map
// is mutated in place and must belong exclusively to this poller.
export function computeOutboundVideoSample(stats, previousByOutboundId) {
  let fallbackRemoteInbound = null
  const remoteInboundByLocalId = new Map()
  for (const report of stats.values()) {
    if (report.type !== 'remote-inbound-rtp') continue
    fallbackRemoteInbound ??= report
    if (report.localId) remoteInboundByLocalId.set(report.localId, report)
  }

  const activeOutbound = []
  const activeOutboundIds = new Set()
  for (const report of stats.values()) {
    // Ignore separate RTX reports: they carry no encoded frames and would
    // corrupt primary-stream byte and frame deltas.
    if (report.type !== 'outbound-rtp' || report.kind !== 'video' || report.framesEncoded == null) {
      continue
    }
    const id = report.id ?? `ssrc:${report.ssrc ?? 'unknown'}`
    if (report.active === false) {
      previousByOutboundId.delete(id)
      continue
    }
    activeOutboundIds.add(id)
    activeOutbound.push({ id, stat: report })
  }

  for (const previousId of previousByOutboundId.keys()) {
    if (!activeOutboundIds.has(previousId)) previousByOutboundId.delete(previousId)
  }
  if (activeOutbound.length === 0) return null

  let totalEncodeTimeDelta = 0
  let totalFramesDelta = 0
  let hasEncodeDelta = false
  let totalSendKbps = 0
  let hasSendDelta = false
  let totalPacketsSent = 0
  let totalRetransmittedPacketsSent = 0
  let totalNackCount = 0
  let totalPliCount = 0
  let totalPacketsLost = 0
  let hasPacketsLost = false
  let highestActive = null
  let anyCpuLimited = false
  let anyBandwidthLimited = false
  const hardwareVerdicts = []

  for (const { id, stat } of activeOutbound) {
    const previous = previousByOutboundId.get(id)
    const framesDelta =
      previous && stat.framesEncoded >= previous.framesEncoded
        ? stat.framesEncoded - previous.framesEncoded
        : null
    const encodeTimeDelta =
      previous &&
      Number.isFinite(stat.totalEncodeTime) &&
      Number.isFinite(previous.totalEncodeTime) &&
      stat.totalEncodeTime >= previous.totalEncodeTime
        ? stat.totalEncodeTime - previous.totalEncodeTime
        : null
    const encodingKbps = streamKbps(stat.bytesSent, stat.timestamp, previous)

    if (framesDelta != null && encodeTimeDelta != null) {
      totalFramesDelta += framesDelta
      totalEncodeTimeDelta += encodeTimeDelta
      hasEncodeDelta = true
    }
    if (encodingKbps != null) {
      totalSendKbps += encodingKbps
      hasSendDelta = true
    }

    totalPacketsSent += stat.packetsSent ?? 0
    totalRetransmittedPacketsSent += stat.retransmittedPacketsSent ?? 0
    totalNackCount += stat.nackCount ?? 0
    totalPliCount += stat.pliCount ?? 0
    const remoteInbound =
      remoteInboundByLocalId.get(id) ?? (activeOutbound.length === 1 ? fallbackRemoteInbound : null)
    if (remoteInbound?.packetsLost != null) {
      totalPacketsLost += remoteInbound.packetsLost
      hasPacketsLost = true
    }

    const reason = stat.qualityLimitationReason
    anyCpuLimited ||= reason === 'cpu'
    anyBandwidthLimited ||= reason === 'bandwidth'
    hardwareVerdicts.push(encoderIsHardware(stat.encoderImplementation))
    if (highestActive == null || outboundLayerIsHigher(stat, highestActive.stat)) {
      highestActive = { id, stat }
    }

    previousByOutboundId.set(id, {
      totalEncodeTime: stat.totalEncodeTime ?? 0,
      framesEncoded: stat.framesEncoded ?? 0,
      bytes: stat.bytesSent ?? 0,
      timestamp: stat.timestamp
    })
  }

  const hardware = hardwareVerdicts.some((verdict) => verdict === false)
    ? false
    : hardwareVerdicts.length > 0 && hardwareVerdicts.every((verdict) => verdict === true)
      ? true
      : null
  const topRemoteInbound =
    (highestActive && remoteInboundByLocalId.get(highestActive.id)) ??
    (activeOutbound.length === 1 ? fallbackRemoteInbound : null)
  const qualityLimitationReason = anyCpuLimited
    ? 'cpu'
    : anyBandwidthLimited
      ? 'bandwidth'
      : highestActive?.stat.qualityLimitationReason

  return {
    implementation: highestActive?.stat.encoderImplementation,
    hardware,
    qualityLimitationReason,
    width: highestActive?.stat.frameWidth,
    height: highestActive?.stat.frameHeight,
    fps: highestActive?.stat.framesPerSecond,
    encodeMsPerFrame:
      hasEncodeDelta && totalFramesDelta > 0
        ? (totalEncodeTimeDelta * 1000) / totalFramesDelta
        : null,
    sendKbps: hasSendDelta ? totalSendKbps : null,
    packetsSent: totalPacketsSent,
    retransmittedPacketsSent: totalRetransmittedPacketsSent,
    nackCount: totalNackCount,
    pliCount: totalPliCount,
    rttMs: topRemoteInbound?.roundTripTime != null ? topRemoteInbound.roundTripTime * 1000 : null,
    packetsLost: hasPacketsLost ? totalPacketsLost : undefined,
    fractionLost: topRemoteInbound?.fractionLost,
    activeEncodings: activeOutbound.length
  }
}

export function extractSendAudioMetrics(report, previous) {
  let outbound = null
  let remoteInbound = null
  for (const stat of report.values()) {
    if (stat.type === 'outbound-rtp' && stat.kind === 'audio') outbound = stat
    else if (stat.type === 'remote-inbound-rtp' && stat.kind === 'audio') remoteInbound = stat
  }
  const metrics = {
    sendKbps: outbound ? streamKbps(outbound.bytesSent, outbound.timestamp, previous) : null,
    packetsSent: outbound?.packetsSent ?? null,
    targetBitrate: outbound?.targetBitrate ?? null,
    rttMs: remoteInbound?.roundTripTime != null ? remoteInbound.roundTripTime * 1000 : null,
    jitterMs: remoteInbound?.jitter != null ? remoteInbound.jitter * 1000 : null,
    packetsLost: remoteInbound?.packetsLost ?? null,
    fractionLost: remoteInbound?.fractionLost ?? null
  }
  const snapshot = outbound
    ? { bytes: outbound.bytesSent, timestamp: outbound.timestamp }
    : (previous ?? null)
  return { metrics, snapshot }
}

export function extractRecvVideoMetrics(report, previous) {
  let inbound = null
  for (const stat of report.values()) {
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
      inbound = stat
      break
    }
  }
  if (!inbound) return { metrics: {}, snapshot: previous ?? null }

  return {
    metrics: {
      recvKbps: streamKbps(inbound.bytesReceived, inbound.timestamp, previous),
      fps: inbound.framesPerSecond ?? null,
      width: inbound.frameWidth ?? null,
      height: inbound.frameHeight ?? null,
      framesDecoded: inbound.framesDecoded ?? null,
      framesDropped: inbound.framesDropped ?? null,
      freezeCount: inbound.freezeCount ?? null,
      totalFreezesDuration: inbound.totalFreezesDuration ?? null,
      keyFramesDecoded: inbound.keyFramesDecoded ?? null,
      pliCount: inbound.pliCount ?? null,
      nackCount: inbound.nackCount ?? null,
      packetsLost: inbound.packetsLost ?? null,
      jitterMs: inbound.jitter != null ? inbound.jitter * 1000 : null,
      jitterBufferMs: jitterBufferAvgMs(
        inbound.jitterBufferDelay,
        inbound.jitterBufferEmittedCount,
        previous
      ),
      decoderImplementation: inbound.decoderImplementation ?? null
    },
    snapshot: {
      bytes: inbound.bytesReceived,
      timestamp: inbound.timestamp,
      jitterBufferDelay: inbound.jitterBufferDelay,
      jitterBufferEmittedCount: inbound.jitterBufferEmittedCount
    }
  }
}

export function extractRecvAudioMetrics(report, previous) {
  let inbound = null
  for (const stat of report.values()) {
    if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
      inbound = stat
      break
    }
  }
  if (!inbound) return { metrics: {}, snapshot: previous ?? null }

  const concealedSamplesDelta =
    previous &&
    Number.isFinite(inbound.concealedSamples) &&
    Number.isFinite(previous.concealedSamples) &&
    inbound.concealedSamples >= previous.concealedSamples
      ? inbound.concealedSamples - previous.concealedSamples
      : null

  return {
    metrics: {
      recvKbps: streamKbps(inbound.bytesReceived, inbound.timestamp, previous),
      packetsReceived: inbound.packetsReceived ?? null,
      packetsLost: inbound.packetsLost ?? null,
      jitterMs: inbound.jitter != null ? inbound.jitter * 1000 : null,
      jitterBufferMs: jitterBufferAvgMs(
        inbound.jitterBufferDelay,
        inbound.jitterBufferEmittedCount,
        previous
      ),
      concealedSamplesDelta,
      concealmentEvents: inbound.concealmentEvents ?? null,
      audioLevel: inbound.audioLevel ?? null
    },
    snapshot: {
      bytes: inbound.bytesReceived,
      timestamp: inbound.timestamp,
      jitterBufferDelay: inbound.jitterBufferDelay,
      jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
      concealedSamples: inbound.concealedSamples
    }
  }
}
