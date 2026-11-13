// The viewer page of probe 2: mediasoup-client and the client's own E2EE worker, unmodified,
// receiving the probe's stream. run.mjs drives it through `window.viewer`.
import { Device } from 'mediasoup-client'
import E2eeWorker from '../../../src/renderer/src/lib/e2ee/worker.js?worker'

const INBOUND_FIELDS = [
  'framesDecoded',
  'keyFramesDecoded',
  'framesDropped',
  'framesReceived',
  'framesPerSecond',
  'frameWidth',
  'frameHeight',
  'freezeCount',
  'totalFreezesDuration',
  'pauseCount',
  'pliCount',
  'nackCount',
  'firCount',
  'packetsLost',
  'packetsReceived',
  'bytesReceived',
  'jitterBufferDelay',
  'jitterBufferEmittedCount',
  'totalDecodeTime',
  'decoderImplementation',
  'powerEfficientDecoder'
]
const GRID = 16

const worker = new E2eeWorker({ name: 'pylon-e2ee' })
const pending = new Map()
let nextRequest = 1
worker.onmessage = ({ data }) => {
  if (data.type === 'stats') {
    pending.get(data.request)?.(data)
    pending.delete(data.request)
  } else if (data.type === 'keyframe') {
    console.log(`[viewer] worker asks for a key frame for transform ${data.id}`)
  } else {
    console.log(`[viewer] worker message ${data.type}`)
  }
}
worker.onerror = (event) => console.error('[viewer] worker error:', event.message ?? event)

function askWorker(message) {
  const request = nextRequest++
  return new Promise((resolve) => {
    pending.set(request, resolve)
    worker.postMessage({ ...message, request })
  })
}

const video = document.getElementById('video')
let device = null
let transport = null
let consumer = null
let transformId = null

window.viewer = {
  // `e2ee` is the worker's config message without its type.
  async setup({ routing, e2ee }) {
    worker.postMessage({ type: 'config', ...e2ee })
    device = new Device()
    await device.load({ routerRtpCapabilities: routing.routerRtpCapabilities })
    transport = device.createRecvTransport(routing.transport)
    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      window.probeConnect(dtlsParameters).then(callback, errback)
    })
    transport.on('connectionstatechange', (state) => console.log(`[viewer] transport ${state}`))
    return { rtpCapabilities: device.rtpCapabilities, handler: device.handlerName }
  },

  // `transform` is the receive transform's options without its id.
  async consume(parameters, transform) {
    consumer = await transport.consume({
      ...parameters,
      onRtpReceiver: (rtpReceiver) => {
        transformId = 1
        rtpReceiver.transform = new RTCRtpScriptTransform(worker, { ...transform, id: transformId })
      }
    })
    video.srcObject = new MediaStream([consumer.track])
    video.play().catch((err) => console.warn('[viewer] play:', err?.message ?? err))
    return { id: consumer.id, transformId, codec: consumer.rtpParameters.codecs[0] }
  },

  async sample() {
    let inbound = null
    const report = await consumer.getStats()
    report.forEach((stat) => {
      if (stat.type === 'inbound-rtp' && stat.kind === 'video') inbound = stat
    })
    const picked = inbound
      ? Object.fromEntries(INBOUND_FIELDS.map((field) => [field, inbound[field] ?? null]))
      : null
    const { streams } = await askWorker({ type: 'stats' })
    return {
      inbound: picked,
      transform: streams.find((s) => s.id === transformId) ?? null,
      transforms: streams,
      video: {
        width: video.videoWidth,
        height: video.videoHeight,
        currentTime: video.currentTime,
        readyState: video.readyState,
        paused: video.paused
      }
    }
  },

  // Distinct colours over a GRID by GRID set of points of the current frame.
  colours() {
    const width = video.videoWidth
    const height = video.videoHeight
    if (!width || !height) return { width, height, distinct: 0, points: 0 }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(video, 0, 0, width, height)
    const { data } = context.getImageData(0, 0, width, height)
    const seen = new Set()
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const x = Math.floor(((gx + 0.5) * width) / GRID)
        const y = Math.floor(((gy + 0.5) * height) / GRID)
        const i = (y * width + x) * 4
        seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`)
      }
    }
    return { width, height, distinct: seen.size, points: GRID * GRID }
  }
}
