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
let localProducerIds = new Set()
let screenProducer = null
let currentChannel = null
let volumeGateProcessor = null
let subscribePromise = null

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
export async function connect(token, { onConnect, onDisconnect, onNewProducer, onVideoStream } = {}) {
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
      consumeProducer(id, kind, onVideoStream)
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

// ─── Apply Volume Gate to Audio Stream ───────────────────────────
function applyVolumeGate(audioContext, stream, threshold) {
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  const gate = audioContext.createGain()
  const destination = audioContext.createMediaStreamDestination()

  analyser.fftSize = 256
  source.connect(analyser)
  analyser.connect(gate)
  gate.connect(destination)

  const dataArray = new Uint8Array(analyser.frequencyBinCount)

  const checkLevel = () => {
    analyser.getByteFrequencyData(dataArray)
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length
    const normalized = (average / 255) * 100

    // If audio is below threshold, mute; otherwise pass through
    gate.gain.setValueAtTime(normalized >= threshold ? 1 : 0, audioContext.currentTime)

    requestAnimationFrame(checkLevel)
  }

  checkLevel()

  // Return the gated stream
  return destination.stream
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
        deviceId: micSettings.deviceId && micSettings.deviceId !== 'default' ? { exact: micSettings.deviceId } : undefined,
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

  // Apply volume gate if enabled
  let processedStream = stream
  if (micSettings.useVolumeGate) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      processedStream = applyVolumeGate(audioContext, stream, micSettings.volumeGateThreshold)
      console.log('[Soup] Volume gate applied, threshold:', micSettings.volumeGateThreshold)
    } catch (err) {
      console.error('[Soup] Failed to apply volume gate:', err)
      // Fall back to unprocessed stream
    }
  }

  onStream?.(processedStream)

  for (const track of processedStream.getTracks()) {
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

// ─── Republish: replace audio track with new settings ───────────
export async function republish(micSettings) {
  if (!producerTransport) throw new Error('Not connected to voice')

  // Close existing audio producers
  const audioProducers = producers.filter((p) => p.kind === 'audio')
  for (const producer of audioProducers) {
    localProducerIds.delete(producer.id)
    producer.close()
  }
  producers = producers.filter((p) => p.kind !== 'audio')

  // Get a fresh stream with updated constraints
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: micSettings.deviceId && micSettings.deviceId !== 'default' ? { exact: micSettings.deviceId } : undefined,
        echoCancellation: micSettings.echoCancellation,
        noiseSuppression: micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
        sampleRate: micSettings.sampleRate,
        channelCount: micSettings.channelCount,
      }
    })
  } catch (err) {
    console.error('[Soup] republish getUserMedia failed:', err.name, err.message)
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  // Re-apply volume gate if enabled
  let processedStream = stream
  if (micSettings.useVolumeGate) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      processedStream = applyVolumeGate(audioContext, stream, micSettings.volumeGateThreshold)
    } catch (err) {
      console.error('[Soup] republish volume gate failed:', err)
    }
  }

  // Produce the new track on the existing transport
  for (const track of processedStream.getTracks()) {
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
    console.log(`[Soup] Republished ${track.kind} [id:${producer.id}]`)
  }

  console.log('[Soup] Audio republished with new settings')
}

// ─── Share screen ────────────────────────────────────────────────
export async function shareScreen() {
  if (!producerTransport) throw new Error('Not connected to voice')

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: 30,
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  })

  const track = stream.getVideoTracks()[0]
  track.contentHint = 'detail'

  screenProducer = await producerTransport.produce({
    track,
    encodings: [{ maxBitrate: 15000000, scalabilityMode: 'L1T1' }],
    codecOptions: {
      videoGoogleStartBitrate: 8000
    },
    appData: { type: 'screen' }
  })

  localProducerIds.add(screenProducer.id)
  console.log(`[Soup] Screen sharing [id:${screenProducer.id}]`)

  track.onended = () => {
    stopScreenShare()
  }

  return {
    id: screenProducer.id,
    stream
  }
}

// ─── Stop screen share ───────────────────────────────────────────
export async function stopScreenShare() {
  if (!screenProducer) return
  screenProducer.close()
  localProducerIds.delete(screenProducer.id)
  console.log('[Soup] Screen share stopped')
  screenProducer = null
}

// ─── Subscribe: receive remote audio ────────────────────────────
// Promise lock — concurrent NewProducer events share one in-flight
// transport setup instead of each creating their own and stomping.
export async function subscribe() {
  if (consumerTransport) return

  if (subscribePromise) {
    await subscribePromise
    return
  }

  subscribePromise = (async () => {
    if (!device) await loadDevice()

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

    console.log('[Soup] Consumer transport ready')
  })()

  await subscribePromise
  subscribePromise = null
}

// ─── Consume a remote producer ───────────────────────────────────
export async function consumeProducer(producerId, kind, onStream) {
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

  // play audio or stream via DOM element
  if (kind === 'audio') {
    const audioEl = document.createElement('audio')
    audioEl.srcObject = stream
    audioEl.autoplay = true
    document.body.appendChild(audioEl)
    audioEl.play().catch((err) => console.error('[Soup] Audio play failed:', err))
  } else if (kind === 'video') {
    onStream?.({ stream, kind, consumerId: consumer.id })
  }

  console.log(`[Soup] Consuming ${kind} [id:${consumer.id}]`)
  return { stream, kind, consumerId: consumer.id }
}

// ─── Reset all media state ───────────────────────────────────────
export function resetMediaState() {
  producerTransport?.close()
  producerTransport = null
  consumerTransport?.close()
  consumerTransport = null
  screenProducer?.close()
  screenProducer = null
  producers = []
  localProducerIds.clear()
  device = null
  currentChannel = null
  volumeGateProcessor = null
  subscribePromise = null
  console.log('[Soup] Media state reset')
}

// ─── Getters ─────────────────────────────────────────────────────
export function isConnected() {
  return ws?.readyState === WebSocket.OPEN
}