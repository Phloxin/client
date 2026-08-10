import {
  codecLabel,
  computeOutboundVideoSample,
  extractRecvAudioMetrics,
  extractRecvVideoMetrics,
  extractSendAudioMetrics
} from '../streamStats'

let getProducerTransport = () => null
let getProducers = () => []
let getScreenShareContext = () => null
let getRemoteConsumers = () => new Map()

export function configureStreamDiagnostics(dependencies = {}) {
  if (dependencies.getProducerTransport) getProducerTransport = dependencies.getProducerTransport
  if (dependencies.getProducers) getProducers = dependencies.getProducers
  if (dependencies.getScreenShareContext) {
    getScreenShareContext = dependencies.getScreenShareContext
  }
  if (dependencies.getRemoteConsumers) getRemoteConsumers = dependencies.getRemoteConsumers
}

// ─── Live per-stream debug stats (send + recv) ───────────────────
// Powers a UI diagnostics panel. Each tick enumerates our live producers (mic,
// screen/camera video, screen audio) and every remote consumer, pulls ONE
// getStats() per stream, and reports a flat per-class metrics object. This is a
// strictly READ-ONLY observer: it never mutates producers / screenShareCtx /
// remoteConsumers and keeps its OWN delta state in the returned closure. That is
// why double-polling a sender the encoder-stats logger also polls is safe — the
// previous-sample maps are separate, so the two pollers never corrupt each
// other's deltas.

// Start a periodic per-stream stats poll for a diagnostics UI. onSample is called
// once per tick with { ts, streams:[...] } (see the stream shape below). Returns a
// stop() that clears the interval and drops this call's delta state. Each call
// owns its closure state, so independent calls never corrupt one another.
// The send transport's aggregate bandwidth estimate. availableOutgoingBitrate is
// exposed ONLY on the ICE candidate-pair report, which RTCRtpSender.getStats()
// never includes (it returns just the sender-relevant subset: outbound-rtp,
// remote-inbound-rtp, codec, media-source). So it must be read from the shared
// send transport's transport-level getStats(). Returns null when the transport is
// gone or hasn't produced an estimate yet.
async function readOutgoingBitrate() {
  const transport = getProducerTransport()
  if (!transport?.getStats) return null
  try {
    const report = await transport.getStats()
    let anyWithBwe = null
    for (const s of report.values()) {
      if (s.type !== 'candidate-pair') continue
      if (typeof s.availableOutgoingBitrate !== 'number') continue
      anyWithBwe = s.availableOutgoingBitrate
      // The selected pair is the authoritative one; prefer it when present.
      if (s.nominated && s.state === 'succeeded') return s.availableOutgoingBitrate
    }
    return anyWithBwe
  } catch {
    return null
  }
}

export function startStreamDebugStats(onSample, intervalMs = 1000) {
  // send/video only: key -> the per-producer previousByOutboundId map that
  // computeOutboundVideoSample() mutates. Never shared across streams or with the
  // encoder-stats poller — each key gets its own map so simulcast SSRC deltas stay
  // isolated.
  const outboundPrevByKey = new Map()
  // The other three classes: key -> previous cumulative snapshot for delta math.
  const prevByKey = new Map()
  // Guard against stacking ticks: if a slow getStats fan-out is still resolving we
  // drop this wakeup entirely rather than doubling the effective poll rate.
  let inFlight = false

  const tick = async () => {
    if (inFlight) return
    inFlight = true
    try {
      // Keys observed this tick, to prune delta state for streams that departed.
      const seenKeys = new Set()
      const jobs = []
      // Set when a send-video row is enumerated below, so the transport-wide BWE
      // read (only ever stamped onto send-video rows) is skipped otherwise.
      let hasSendVideo = false

      // Module state is read LIVE here: producers is reassigned on reset and
      // screenShareCtx / remoteConsumers churn constantly, so a captured reference
      // would go stale. Referencing the module bindings each tick always sees the
      // current media state (a mid-tick resetMediaState just yields fewer streams).
      const pushSend = (producer, kind, producedType) => {
        const sender = producer.rtpSender
        // Mirror startEncoderStatsLog's guard: no sender/getStats → omit the stream.
        if (!sender?.getStats) return
        if (kind === 'video') hasSendVideo = true
        const key = `send:${producer.id}`
        seenKeys.add(key)
        const base = {
          key,
          direction: 'send',
          kind,
          producedType,
          producerId: producer.id,
          codec: codecLabel(producer.rtpParameters)
        }
        jobs.push(
          (async () => {
            try {
              const report = await sender.getStats()
              if (kind === 'video') {
                // One previousByOutboundId map per stream key (created on first use);
                // computeOutboundVideoSample owns/mutates it.
                let perStreamMap = outboundPrevByKey.get(key)
                if (!perStreamMap) {
                  perStreamMap = new Map()
                  outboundPrevByKey.set(key, perStreamMap)
                }
                // Returns null until an active outbound-rtp video report exists; emit
                // an empty metrics object so the row still renders during the gap.
                const metrics = computeOutboundVideoSample(report, perStreamMap) ?? {}
                return { ...base, metrics }
              }
              const { metrics, snapshot } = extractSendAudioMetrics(report, prevByKey.get(key))
              if (snapshot) prevByKey.set(key, snapshot)
              return { ...base, metrics }
            } catch {
              // A teardown-race getStats reject skips only THIS stream, not the tick.
              return null
            }
          })()
        )
      }

      const pushRecv = (producerId, entry) => {
        const consumer = entry.consumer
        const key = `recv:${entry.consumerId}`
        seenKeys.add(key)
        const base = {
          key,
          direction: 'recv',
          kind: entry.kind,
          producedType: entry.producedType,
          producerId,
          consumerId: entry.consumerId,
          clientId: entry.clientId,
          codec: codecLabel(consumer.rtpParameters)
        }
        // Only video entries carry server-pause / view-role bookkeeping.
        if (entry.kind === 'video') {
          base.paused = entry.serverPaused
          base.viewRole = entry.viewRole
        }
        jobs.push(
          (async () => {
            try {
              const report = await consumer.getStats()
              const { metrics, snapshot } =
                entry.kind === 'video'
                  ? extractRecvVideoMetrics(report, prevByKey.get(key))
                  : extractRecvAudioMetrics(report, prevByKey.get(key))
              if (snapshot) prevByKey.set(key, snapshot)
              return { ...base, metrics }
            } catch {
              return null
            }
          })()
        )
      }

      // Mic: possibly more than one during a republish overlap.
      for (const p of getProducers()) {
        if (p.kind !== 'audio' || p.closed) continue
        pushSend(p, 'audio', p.appData?.produced ?? 'Audio')
      }
      // Screen/camera share: at most one video producer and one screen-audio one.
      const ctx = getScreenShareContext()
      if (ctx && !ctx.stopped) {
        if (ctx.producer && !ctx.producer.closed) {
          pushSend(
            ctx.producer,
            'video',
            ctx.producer.appData?.produced ?? (ctx.type === 'camera' ? 'Camera' : 'ScreenShare')
          )
        }
        if (ctx.audioProducer && !ctx.audioProducer.closed) {
          pushSend(ctx.audioProducer, 'audio', 'ScreenShareAudio')
        }
      }
      // Consumed remote streams.
      for (const [producerId, entry] of getRemoteConsumers()) {
        if (entry.consumer?.closed) continue
        pushRecv(producerId, entry)
      }

      // Enumeration above already kicked off the per-stream getStats jobs, so
      // starting the transport-wide BWE read now still runs it concurrently with
      // them — just skip it entirely when no send-video row will use it.
      const bwePromise = hasSendVideo ? readOutgoingBitrate() : Promise.resolve(null)

      const [streams, availableOutgoingBitrate] = await Promise.all([
        Promise.all(jobs).then((all) => all.filter((s) => s != null)),
        bwePromise
      ])

      // The estimate is transport-wide, so every video send stream (they all share
      // the one send transport) reports the same value.
      if (availableOutgoingBitrate != null) {
        for (const s of streams) {
          if (s.direction === 'send' && s.kind === 'video' && s.metrics) {
            s.metrics.availableOutgoingBitrate = availableOutgoingBitrate
          }
        }
      }

      // Prune delta state for keys not present this tick so a reused id (returning
      // after a gap) can't diff against an ancient sample.
      for (const map of [outboundPrevByKey, prevByKey]) {
        for (const key of map.keys()) {
          if (!seenKeys.has(key)) map.delete(key)
        }
      }

      onSample?.({ ts: Date.now(), streams })
    } catch {
      // Enumeration itself shouldn't throw (per-stream work is already guarded),
      // but never let a stray error wedge inFlight permanently.
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  return function stop() {
    clearInterval(timer)
    outboundPrevByKey.clear()
    prevByKey.clear()
  }
}

// ─── TEMP DIAGNOSTIC: live inbound kbps per remote video consumer ─────────
// Verifies that PauseConsumer actually stops RTP (kbps → ~0) vs. the stream
// quietly playing in the background. Dev-only; remove once confirmed.
//   In the renderer console:  __videoStats.start()   …   __videoStats.stop()
let videoStatsTimer = null
const videoStatsLast = new Map() // consumerId -> { bytes, ts }

async function logVideoStatsOnce() {
  for (const entry of getRemoteConsumers().values()) {
    if (entry.kind !== 'video') continue
    let report
    try {
      report = await entry.consumer.getStats()
    } catch {
      continue
    }
    for (const s of report.values()) {
      if (s.type !== 'inbound-rtp' || s.bytesReceived == null) continue
      const prev = videoStatsLast.get(entry.consumerId) || {
        bytes: s.bytesReceived,
        ts: s.timestamp
      }
      const dt = s.timestamp - prev.ts // ms
      // (bytes * 8) bits over dt ms = kbits/s = kbps
      const kbps = dt > 0 ? (8 * (s.bytesReceived - prev.bytes)) / dt : 0
      videoStatsLast.set(entry.consumerId, { bytes: s.bytesReceived, ts: s.timestamp })
      console.log(
        `[Stats] video ${entry.consumerId} role=${entry.viewRole ?? '?'} paused=${!!entry.serverPaused} → ${kbps.toFixed(0)} kbps`
      )
    }
  }
}

function startVideoStatsLog(intervalMs = 2000) {
  stopVideoStatsLog()
  videoStatsLast.clear()
  videoStatsTimer = setInterval(logVideoStatsOnce, intervalMs)
  console.log('[Stats] video stats logging started')
}

function stopVideoStatsLog() {
  if (videoStatsTimer) clearInterval(videoStatsTimer)
  videoStatsTimer = null
  console.log('[Stats] video stats logging stopped')
}

if (import.meta.env.DEV && typeof window !== 'undefined') {
  window.__videoStats = { start: startVideoStatsLog, stop: stopVideoStatsLog }
}
