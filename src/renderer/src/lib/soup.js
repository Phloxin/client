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
let activeCallbacks = {}
let remoteCleanups = []
let remoteAudioElements = []
let micMuted = false
let soundMuted = false

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

// ─── Send a fire-and-forget notification (no response expected) ──
// Use for telling the server we've closed a producer/consumer we own.
// Does NOT push onto pendingHandlers, so an unanswered message can't
// desync the response queue for subsequent send() calls.
function notify(type, data = null) {
  const message = data ? { type, data } : { type }
  ws.send(JSON.stringify(message))
  console.log(`[Soup] Notify: ${type}`, message)
}

// ─── Connect to signaling server ────────────────────────────────
export async function connect(token, { onConnect, onDisconnect, onNewProducer, onVideoStream, onTransportsDisconnected, onClientSpeaking } = {}) {
  activeCallbacks = { onConnect, onDisconnect, onNewProducer, onVideoStream, onTransportsDisconnected, onClientSpeaking }

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
      activeCallbacks.onConnect?.()
      return
    }

    // Handle server-initiated events BEFORE pending handlers
    if (message.type === 'NewProducer') {
      const { id, kind, client_id } = message.data
        if (localProducerIds.has(id)) {
          console.log('[Soup] Skipping own producer:', id)
          return
        }
      console.log(`[Soup] New producer: ${id} (${kind})`)
      activeCallbacks.onNewProducer?.({ producerId: id, kind })
      consumeProducer(id, kind, activeCallbacks.onVideoStream, client_id)
      return
    }

    // Server is moving us to a different channel — transports must be
    // torn down and re-established, but the websocket stays open.
    if (message.type === 'TransportsDisconnected') {
      console.log('[Soup] Transports disconnected, resetting media state')
      resetMediaState()
      activeCallbacks.onTransportsDisconnected?.()
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
    activeCallbacks.onDisconnect?.()
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
// Returns the gated stream and a stop() function that cancels the
// level-check loop and closes the audio context.
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
  let rafId

  const checkLevel = () => {
    analyser.getByteFrequencyData(dataArray)
    const average = dataArray.reduce((a, b) => a + b) / dataArray.length
    const normalized = (average / 255) * 100

    // If audio is below threshold, mute; otherwise pass through
    gate.gain.setValueAtTime(normalized >= threshold ? 1 : 0, audioContext.currentTime)

    rafId = requestAnimationFrame(checkLevel)
  }

  checkLevel()

  const stop = () => {
    cancelAnimationFrame(rafId)
    try { source.disconnect() } catch {}
    try { audioContext.close() } catch {}
  }

  return { stream: destination.stream, stop }
}

// Stop the currently active volume gate processor (if any), releasing its
// AudioContext and level-check loop.
function stopVolumeGate() {
  volumeGateProcessor?.()
  volumeGateProcessor = null
}

// ─── Detect speaking activity on an audio stream ──────────────────
// Returns a stop function. Calls onChange(isSpeaking) whenever the
// speaking state changes, and once more with false on stop.
export function createSpeakingDetector(stream, onChange, { threshold = 8, holdMs = 150 } = {}) {
  if (!stream.getAudioTracks().length) return () => {}

  const audioContext = new (window.AudioContext || window.webkitAudioContext)()
  const source = audioContext.createMediaStreamSource(stream)
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 256
  source.connect(analyser)

  const data = new Uint8Array(analyser.frequencyBinCount)
  let speaking = false
  let lastAbove = 0
  let rafId

  const tick = () => {
    analyser.getByteFrequencyData(data)
    const avg = data.reduce((a, b) => a + b, 0) / data.length
    const level = (avg / 255) * 100
    const now = performance.now()

    if (level >= threshold) lastAbove = now

    const isSpeaking = now - lastAbove < holdMs
    if (isSpeaking !== speaking) {
      speaking = isSpeaking
      onChange(speaking)
    }

    rafId = requestAnimationFrame(tick)
  }
  tick()

  return () => {
    cancelAnimationFrame(rafId)
    if (speaking) onChange(false)
    try { source.disconnect() } catch {}
    try { audioContext.close() } catch {}
  }
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

  // Apply volume gate if enabled (stop any previous gate first so its
  // AudioContext and level-check loop don't leak)
  stopVolumeGate()
  let processedStream = stream
  if (micSettings.useVolumeGate) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const gated = applyVolumeGate(audioContext, stream, micSettings.volumeGateThreshold)
      processedStream = gated.stream
      volumeGateProcessor = gated.stop
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
    if (micMuted) producer.pause()
    console.log(`[Soup] Producing ${track.kind} [id:${producer.id}]`)
  }

  console.log('[Soup] Publishing audio')
}

// ─── Republish: apply new mic settings to the existing producer ──
// Reuses the existing audio producer(s) via replaceTrack() instead of
// closing and re-negotiating a brand-new producer with the server on
// every settings change.
export async function republish(micSettings, onStream) {
  if (!producerTransport) throw new Error('Not connected to voice')

  const audioProducers = producers.filter((p) => p.kind === 'audio')

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

  // Re-apply volume gate if enabled (stop any previous gate first so its
  // AudioContext and level-check loop don't leak)
  stopVolumeGate()
  let processedStream = stream
  if (micSettings.useVolumeGate) {
    try {
      const audioContext = new (window.AudioContext || window.webkitAudioContext)()
      const gated = applyVolumeGate(audioContext, stream, micSettings.volumeGateThreshold)
      processedStream = gated.stream
      volumeGateProcessor = gated.stop
    } catch (err) {
      console.error('[Soup] republish volume gate failed:', err)
    }
  }

  onStream?.(processedStream)

  const newTracks = processedStream.getTracks()

  if (audioProducers.length === 0) {
    // No existing producer to reuse (first publish hasn't happened yet) -
    // produce fresh, mirroring publish().
    for (const track of newTracks) {
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
      if (micMuted) producer.pause()
      console.log(`[Soup] Republished ${track.kind} [id:${producer.id}]`)
    }

    console.log('[Soup] Audio republished with new settings')
    return
  }

  // Swap the track on each existing audio producer in place. The
  // server-side producer (and any consumers peers already created for it)
  // stays alive, so peers keep receiving the same producer id.
  for (let i = 0; i < audioProducers.length; i++) {
    const producer = audioProducers[i]
    const track = newTracks[i]
    if (!track) continue

    await producer.replaceTrack({ track })

    // Update bitrate on the existing RTP sender without renegotiating.
    // Note: opusStereo/opusMaxPlaybackRate are negotiated at produce()
    // time and can't be changed without a brand-new producer - changing
    // sampleRate/channelCount won't retroactively update those params.
    const sender = producer.rtpSender
    if (sender) {
      const params = sender.getParameters()
      if (params.encodings?.length) {
        params.encodings[0].maxBitrate = micSettings.bitrate
        try {
          await sender.setParameters(params)
        } catch (err) {
          console.warn('[Soup] Failed to update bitrate:', err)
        }
      }
    }

    if (micMuted) producer.pause()
    else producer.resume()
    console.log(`[Soup] Replaced track on producer [id:${producer.id}]`)
  }

  console.log('[Soup] Audio republished with new settings')
}

// ─── Share screen ────────────────────────────────────────────────
export async function shareScreen() {
  if (!producerTransport) throw new Error('Not connected to voice')

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: 60,
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
  const producerId = screenProducer.id
  screenProducer.close()
  localProducerIds.delete(producerId)
  // Tell the server we're done with this producer so it can close the
  // server-side mediasoup Producer and any consumers peers have for it.
  notify('CloseProducer', { id: producerId })
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
export async function consumeProducer(producerId, kind, onStream, clientId) {
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
    audioEl.muted = soundMuted
    document.body.appendChild(audioEl)
    audioEl.play().catch((err) => console.error('[Soup] Audio play failed:', err))
    remoteAudioElements.push(audioEl)
    remoteCleanups.push(() => {
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
      remoteAudioElements = remoteAudioElements.filter((el) => el !== audioEl)
    })

    if (clientId != null) {
      const stopDetector = createSpeakingDetector(stream, (isSpeaking) => {
        activeCallbacks.onClientSpeaking?.(clientId, isSpeaking)
      })
      remoteCleanups.push(stopDetector)
    }
  } else if (kind === 'video') {
    onStream?.({ stream, kind, consumerId: consumer.id, clientId })
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
  stopVolumeGate()
  subscribePromise = null
  remoteCleanups.forEach((fn) => fn())
  remoteCleanups = []
  remoteAudioElements = []
  console.log('[Soup] Media state reset')
}

// ─── Rebind callbacks (e.g. when switching channels) ──────────────
export function rebindCallbacks(newCallbacks) {
  activeCallbacks = { ...activeCallbacks, ...newCallbacks }
}

// ─── Mute controls ────────────────────────────────────────────────
// Pauses/resumes local audio producers so other clients stop receiving them.
export function setMicMuted(muted) {
  micMuted = muted
  producers
    .filter((p) => p.kind === 'audio')
    .forEach((p) => (muted ? p.pause() : p.resume()))
}

// Mutes/unmutes playback of all remote audio elements (deafen).
export function setSoundMuted(muted) {
  soundMuted = muted
  remoteAudioElements.forEach((el) => { el.muted = muted })
}

// ─── Getters ─────────────────────────────────────────────────────
export function isConnected() {
  return ws?.readyState === WebSocket.OPEN
}

export function isMicMuted() {
  return micMuted
}

export function isSoundMuted() {
  return soundMuted
}