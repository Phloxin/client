// The screen share's frame rate in the console (.plans/native-media-engine-fps-line.md, F1 to
// F5): while a share is live, one line every 5 seconds,
//   [Soup] Screen share: <sent> fps sent, <width>x<height>, <path> <codec>
// <path> is `native` or `Chromium`. A Chromium share adds the encoder in brackets after the
// codec when the statistics name it, either share adds `, <n> captured` when the statistics
// carry what the capture delivered. The rate is the frames sent between two samples divided by
// the real time between them. Pure: the callers sample (nativeShare.js from the sidecar's
// `stats`, screenShare.js from the sender's outbound-rtp) and log.
//
// A sample: { id, frames, ms, width, height, capturedFrames, capturedFps, encoder }
//   id              what the counters belong to (an outbound-rtp's id); samples of different
//                   ids are not compared
//   frames          frames sent, a total
//   ms              when, in milliseconds (the sidecar's ms_since_open, a report's timestamp)
//   width, height   the size sent; missing prints ?x?
//   capturedFrames  frames the capture delivered, a total (native), or
//   capturedFps     the capture's own rate (Chromium's media-source)
//   encoder         the encoder's name (Chromium)

export const SHARE_RATE_INTERVAL_MS = 5_000

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

function sizeText(width, height) {
  return finite(width) && finite(height) && width > 0 && height > 0 ? `${width}x${height}` : '?x?'
}

// The line for the interval from `previous` to `current`, or null: no previous sample, samples
// of different counters, no time between them, or a counter that went backwards (a
// replacement or a restart): never a negative rate.
export function shareRateLine(previous, current, { path, codec } = {}) {
  if (!previous || !current) return null
  if ((previous.id ?? null) !== (current.id ?? null)) return null
  if (![previous.frames, current.frames, previous.ms, current.ms].every(finite)) return null
  const elapsedMs = current.ms - previous.ms
  const frames = current.frames - previous.frames
  if (elapsedMs <= 0 || frames < 0) return null
  const sent = (frames * 1000) / elapsedMs

  let captured = null
  if (finite(current.capturedFrames) && finite(previous.capturedFrames)) {
    const delivered = current.capturedFrames - previous.capturedFrames
    if (delivered >= 0) captured = (delivered * 1000) / elapsedMs
  } else if (finite(current.capturedFps) && current.capturedFps >= 0) {
    captured = current.capturedFps
  }

  const encoder =
    typeof current.encoder === 'string' && current.encoder !== '' ? ` (${current.encoder})` : ''
  return (
    `[Soup] Screen share: ${sent.toFixed(1)} fps sent, ` +
    `${sizeText(current.width, current.height)}, ${path} ${codec || '?'}${encoder}` +
    (captured != null ? `, ${captured.toFixed(1)} captured` : '')
  )
}

// A sample from the sidecar's `stats` event (native/media-engine/PROTOCOL.md) and the size the
// renderer knows is sent (the stats carry none), or null.
export function nativeRateSample(stats, size) {
  if (!stats) return null
  return {
    id: null,
    frames: stats.frames_sent,
    ms: stats.ms_since_open,
    width: size?.width ?? null,
    height: size?.height ?? null,
    capturedFrames: stats.capture_frames_delivered ?? null
  }
}

// A sample from a sender's getStats() report: the video outbound-rtp with the largest frame
// size (the first, when none has a size yet), its media source's own rate, or null.
export function chromiumRateSample(report) {
  if (!report?.values) return null
  let chosen = null
  let chosenPixels = -1
  for (const stat of report.values()) {
    if (stat?.type !== 'outbound-rtp' || (stat.kind ?? stat.mediaType) !== 'video') continue
    if (stat.active === false || !finite(stat.framesSent)) continue
    const pixels =
      finite(stat.frameWidth) && finite(stat.frameHeight) ? stat.frameWidth * stat.frameHeight : 0
    if (pixels > chosenPixels) {
      chosen = stat
      chosenPixels = pixels
    }
  }
  if (!chosen) return null
  let source = chosen.mediaSourceId ? report.get?.(chosen.mediaSourceId) : null
  if (!source) {
    for (const stat of report.values()) {
      if (stat?.type === 'media-source' && stat.kind === 'video') {
        source = stat
        break
      }
    }
  }
  return {
    id: chosen.id ?? `ssrc:${chosen.ssrc ?? 'unknown'}`,
    frames: chosen.framesSent,
    ms: chosen.timestamp,
    width: chosen.frameWidth ?? null,
    height: chosen.frameHeight ?? null,
    capturedFps: finite(source?.framesPerSecond) ? source.framesPerSecond : null,
    encoder: chosen.encoderImplementation ?? null
  }
}

// One share's lines: `offer(sample)` keeps the first sample as the start of the interval and,
// once at least minIntervalMs have passed since it, logs the line and starts the next interval
// there. A sample that cannot follow the start (another counter, a counter that went
// backwards, no time passed) starts the interval anew without a line.
export function createShareRateLog({ path, codec, minIntervalMs = 0, log = console.log }) {
  let start = null
  return {
    get started() {
      return start != null
    },
    offer(sample) {
      if (!sample) return null
      if (!start) {
        start = sample
        return null
      }
      const follows =
        (start.id ?? null) === (sample.id ?? null) &&
        [start.ms, sample.ms, start.frames, sample.frames].every(finite) &&
        sample.ms > start.ms &&
        sample.frames >= start.frames
      if (!follows) {
        start = sample
        return null
      }
      if (sample.ms - start.ms < minIntervalMs) return null
      const line = shareRateLine(start, sample, { path, codec })
      start = sample
      if (line) log(line)
      return line
    }
  }
}
