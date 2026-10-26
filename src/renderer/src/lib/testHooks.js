// window.pylonTest, the e2e harness's handle (client/e2e). Installed only when the preload says
// the app was launched with PYLON_TEST=1. soup hands in its state through configureTestHooks.
let getRemoteConsumers = () => new Map()
let getProducers = () => []
let getScreenShareContext = () => null
let dropVoiceSocket = () => {}

export function configureTestHooks(dependencies = {}) {
  if (dependencies.getRemoteConsumers) getRemoteConsumers = dependencies.getRemoteConsumers
  if (dependencies.getProducers) getProducers = dependencies.getProducers
  if (dependencies.getScreenShareContext) {
    getScreenShareContext = dependencies.getScreenShareContext
  }
  if (dependencies.dropVoiceSocket) dropVoiceSocket = dependencies.dropVoiceSocket
}

function consumers() {
  return [...getRemoteConsumers().values()].map((entry) => ({
    consumerId: entry.consumerId,
    kind: entry.kind,
    owner: entry.clientId == null ? null : String(entry.clientId),
    sourceKind: entry.consumer?.appData?.source?.kind ?? null,
    sinkNode: entry.sinkNode
  }))
}

function localProducers() {
  const list = getProducers().filter((p) => !p.closed)
  const ctx = getScreenShareContext()
  if (ctx && !ctx.stopped) {
    for (const p of [ctx.producer, ctx.audioProducer]) {
      if (p && !p.closed && !list.includes(p)) list.push(p)
    }
  }
  return list
}

async function consumerStats(entry) {
  const base = {
    consumerId: entry.consumerId,
    kind: entry.kind,
    owner: entry.clientId == null ? null : String(entry.clientId)
  }
  try {
    const report = await entry.consumer.getStats()
    for (const s of report.values()) {
      if (s.type !== 'inbound-rtp') continue
      return {
        ...base,
        framesDecoded: s.framesDecoded ?? null,
        keyFramesDecoded: s.keyFramesDecoded ?? null,
        pliCount: s.pliCount ?? null,
        freezeCount: s.freezeCount ?? null,
        frameWidth: s.frameWidth ?? null,
        frameHeight: s.frameHeight ?? null,
        packetsLost: s.packetsLost ?? null,
        packetsReceived: s.packetsReceived ?? null,
        bytesReceived: s.bytesReceived ?? null
      }
    }
    return { ...base, missing: 'inbound-rtp' }
  } catch (err) {
    return { ...base, error: String(err?.message ?? err) }
  }
}

async function producerStats(producer) {
  const base = {
    producerId: producer.id,
    kind: producer.kind,
    produced: producer.appData?.produced ?? null
  }
  try {
    const report = await producer.getStats()
    // Simulcast has one outbound-rtp per layer; the widest one stands for the producer.
    let best = null
    for (const s of report.values()) {
      if (s.type !== 'outbound-rtp') continue
      if (!best || (s.frameWidth ?? 0) > (best.frameWidth ?? 0)) best = s
    }
    if (!best) return { ...base, missing: 'outbound-rtp' }
    return {
      ...base,
      codec: report.get(best.codecId)?.mimeType ?? null,
      encoderImplementation: best.encoderImplementation ?? null,
      framesEncoded: best.framesEncoded ?? null,
      keyFramesEncoded: best.keyFramesEncoded ?? null,
      frameWidth: best.frameWidth ?? null,
      frameHeight: best.frameHeight ?? null,
      qualityLimitationReason: best.qualityLimitationReason ?? null
    }
  } catch (err) {
    return { ...base, error: String(err?.message ?? err) }
  }
}

async function rtcStats() {
  const entries = [...getRemoteConsumers().values()].filter((e) => e.consumer && !e.consumer.closed)
  const [consumerList, producerList] = await Promise.all([
    Promise.all(entries.map(consumerStats)),
    Promise.all(localProducers().map(producerStats))
  ])
  return { consumers: consumerList, producers: producerList }
}

if (typeof window !== 'undefined' && window.api?.isTestHarness) {
  window.pylonTest = {
    consumers,
    rtcStats,
    dropVoiceSocket: () => dropVoiceSocket()
  }
}
