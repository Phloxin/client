// ─── Imports ────────────────────────────────────────────────────
import { Device } from 'mediasoup-client'

// ─── Config ─────────────────────────────────────────────────────
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  {
    urls: 'turn:47.16.222.82:3478',
    username: 'test',
    credential: 'password',
  },
]

// ─── State ──────────────────────────────────────────────────────
let device
let ws
let producerTransport
let consumerTransport
let producers = []
let currentChannel = null
let localProducerIds = new Set()

// ─── Pending response handlers ───────────────────────────────────
const pendingHandlers = []

// ─── Send a message and wait for a response ──────────────────────
function send(type, data = null) {
  return new Promise((resolve) => {
    pendingHandlers.push(resolve)
    const message = data ? { type, data } : { type }
    ws.send(JSON.stringify(message))
    console.log(`[Soup] Sent: ${type}`, message)
  })
}

// ─── Connect to signaling server ────────────────────────────────
export async function connect(token, { onConnect, onDisconnect, onNewProducer } = {}) {
  // Step 1 — get ticket
  const res = await fetch('/api/server/voice', {
    headers: { Authorization: `Bearer ${token}` }
  })
  const { ticket } = await res.json()
  console.log('[Soup] Got ticket:', ticket)

  // Step 2 — connect to voice WebSocket
  ws = new WebSocket('ws://47.16.222.82:3000/voice')
  console.log('[Soup] WebSocket created, readyState:', ws.readyState)

  // ─── Assign ALL handlers before anything can fire ───────────────
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data)
    console.log('[Soup] Received:', message)

    // Authenticated confirmation
    if (message.type === 'Authenticated') {
      console.log('[Soup] Authenticated')
      onConnect?.()
      return
    }

    // Handle server-initiated events BEFORE pending handlers
    if (message.type === 'NewProducer') {
      const { id, kind } = message.data
        if (localProducerIds.has(id)) {
          console.log('[Soup] Skipping own producer:', id)
          return
        }
      console.log(`[Soup] New producer: ${id} (${kind})`)
      onNewProducer?.({ producerId: id, kind })
      consumeProducer(id, kind)
      return
    }

    // Route response to pending handler
    if (pendingHandlers.length > 0) {
      const resolve = pendingHandlers.shift()
      resolve(message)
      return
    }

    console.log('[Soup] Unhandled message:', message)
  }

  ws.onclose = (event) => {
    console.log('[Soup] WebSocket disconnected — code:', event.code, 'reason:', event.reason)
    currentChannel = null
    resetMediaState()
    onDisconnect?.()
  }

  ws.onerror = (err) => {
    console.error('[Soup] WebSocket error:', err)
  }

  // ─── onopen last so handlers are guaranteed to be in place ──────
  ws.onopen = () => {
    console.log('[Soup] WebSocket connected, authenticating...')
    ws.send(JSON.stringify({ ticket }))
  }
}

// ─── Disconnect ──────────────────────────────────────────────────
export function disconnect() {
  ws?.close()
  ws = null
}

// ─── Load mediasoup Device ───────────────────────────────────────
async function loadDevice() {
  const rtpCapabilities = await send('GetRouterRtpCapabilities')
  device = new Device()
  await device.load({ routerRtpCapabilities: rtpCapabilities })
  console.log('[Soup] Device loaded')
}

// ─── Map snake_case transport params to mediasoup camelCase ───────
function mapTransportParams(params) {
  return {
    id: params.id,
    iceParameters: params.ice_parameters,
    iceCandidates: params.ice_candidates,
    dtlsParameters: params.dtls_parameters,
  }
}

// ─── Publish: send local audio ───────────────────────────────────
export async function publish(micSettings, onStream) {
  if (!device) await loadDevice()

  const rawParams = await send('CreateProducerTransport')
  producerTransport = device.createSendTransport({
    ...mapTransportParams(rawParams),
    iceServers: ICE_SERVERS
  })

  producerTransport.on('connectionstatechange', (state) => {
    console.log('[Soup] Producer transport connection state:', state)
  })

  producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    send('ConnectProducerTransport', { dtlsParameters })
      .then(() => callback())
      .catch((err) => errback(err))
  })

  producerTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
    send('Produce', {
      kind,
      rtp_params: rtpParameters
    })
      .then((res) => callback({ id: res.id }))
      .catch((err) => errback(err))
  })

  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: micSettings.echoCancellation,
        noiseSuppression: micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
        sampleRate: micSettings.sampleRate,
        channelCount: micSettings.channelCount,
      }
    })
  } catch (err) {
    console.error('[Soup] getUserMedia failed:', err.name, err.message)
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  onStream?.(stream)

  for (const track of stream.getTracks()) {
    const producer = await producerTransport.produce({
      track,
      encodings: [{ maxBitrate: micSettings.bitrate }],
      codecOptions: {
        opusStereo: micSettings.channelCount === 2,
        opusMaxPlaybackRate: micSettings.sampleRate,
        opusDtx: false,
        opusFec: true,
      }
    })
    producers.push(producer)
    localProducerIds.add(producer.id)
    console.log(`[Soup] Producing ${track.kind} [id:${producer.id}]`)
  }

  console.log('[Soup] Publishing audio')
}

// ─── Subscribe: receive remote audio ────────────────────────────
export async function subscribe() {
  if (!device) await loadDevice()

  if (!consumerTransport) {
    const rawParams = await send('CreateConsumerTransport')
    consumerTransport = device.createRecvTransport({
      ...mapTransportParams(rawParams),
      iceServers: ICE_SERVERS
    })

    consumerTransport.on('connectionstatechange', (state) => {
      console.log('[Soup] Consumer transport connection state:', state)
    })

    consumerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
      send('ConnectConsumerTransport', { dtlsParameters })
        .then(() => callback())
        .catch((err) => errback(err))
    })
  }

  console.log('[Soup] Consumer transport ready')
}

// ─── Consume a remote producer ───────────────────────────────────
export async function consumeProducer(producerId, kind) {
  if (!consumerTransport) await subscribe()

  const consumerParams = await send('Consume', {
    id: producerId,
    rtp_params: device.rtpCapabilities
  })

  if (consumerParams.error) {
    console.error('[Soup] Cannot consume:', consumerParams.error)
    return null
  }

  const consumer = await consumerTransport.consume({
    id: consumerParams.id,
    producerId: consumerParams.producer_id,
    kind: consumerParams.kind,
    rtpParameters: consumerParams.rtp_parameters,
  })

  const stream = new MediaStream([consumer.track])

  // log track state
  console.log('[Soup] Consumer track state:', consumer.track.readyState, 'muted:', consumer.track.muted)

  // Resume the consumer on the server
  await send('ResumeConsumer', { id: consumer.id })
  console.log(`[Soup] Consumer resumed [id:${consumer.id}]`)

  // play audio via DOM element
  const audioEl = document.createElement('audio')
  audioEl.srcObject = stream
  audioEl.autoplay = true
  document.body.appendChild(audioEl)
  audioEl.play().catch((err) => console.error('[Soup] Audio play failed:', err))

  console.log(`[Soup] Consuming ${kind} [id:${consumer.id}]`)
  return { stream, kind, consumerId: consumer.id }
}

// ─── Reset all media state ───────────────────────────────────────
export function resetMediaState() {
  producerTransport?.close()
  producerTransport = null
  consumerTransport?.close()
  consumerTransport = null
  producers = []
  localProducerIds.clear()
  device = null
  currentChannel = null
  console.log('[Soup] Media state reset')
}

// ─── Getters ─────────────────────────────────────────────────────
export function isConnected() {
  return ws?.readyState === WebSocket.OPEN
}