// ─── Imports ────────────────────────────────────────────────────
import { Device } from 'mediasoup-client'
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import { apiBase, wsBase, getIceServers } from './serverConfig'

// ─── State ──────────────────────────────────────────────────────
let device
let ws
let producerTransport
let consumerTransport
let producers = []
let localProducerIds = new Set()
let screenProducer = null
let screenAudioProducer = null
let currentChannel = null
// Stop function for the active local audio processing chain (RNNoise / volume
// gate). Tears down its AudioContext and analysis loop; null when no chain is active.
let audioProcessorStop = null
// The RNNoise WASM binary, fetched once and reused across AudioContexts.
let rnnoiseBinaryPromise = null
let subscribePromise = null
let activeCallbacks = {}
let remoteCleanups = []
let remoteAudioElements = []
let micMuted = false
let soundMuted = false
// Playback output device (sinkId) and master output volume (0..1) applied to
// every remote audio element. Persisted in settings and pushed in via
// setOutputDevice()/setMasterVolume(); new audio elements pick them up on creation.
let outputDeviceId = 'default'
let masterVolume = 1
// Tracks remote consumers by the producer id they're consuming, so they
// can be closed and removed when that producer goes away (either because
// a new one replaces it, or the server tells us it closed).
let remoteConsumers = new Map()

// Only the focused stream's screen-share audio should be audible - the
// client whose ScreenShareAudio should currently be unmuted, plus the
// volume/mute settings to apply to it.
let focusedClientId = null
let focusedVolume = 1
let focusedMuted = false

// Per-client local volume/mute overrides for mic audio (right-click controls
// in the sidebar) - keyed by clientId.
let clientAudioOverrides = new Map()

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
export async function connect(token, { onConnect, onDisconnect, onNewProducer, onVideoStream, onTransportsDisconnected, onClientSpeaking, onConsumerClosed } = {}) {
  activeCallbacks = { onConnect, onDisconnect, onNewProducer, onVideoStream, onTransportsDisconnected, onClientSpeaking, onConsumerClosed }

  // Step 1 — get ticket
  const res = await fetch(`${apiBase()}/server/voice`, {
    headers: { Authorization: `Bearer ${token}` }
  })
  const { ticket } = await res.json()
  console.log('[Soup] Got ticket:', ticket)

  // Step 2 — connect to voice WebSocket
  ws = new WebSocket(`${wsBase()}/voice`)
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
      const { id, kind, client_id, produced_type } = message.data
        if (localProducerIds.has(id)) {
          console.log('[Soup] Skipping own producer:', id)
          return
        }
      console.log(`[Soup] New producer: ${id} (${kind}, ${produced_type})`)
      activeCallbacks.onNewProducer?.({ producerId: id, kind })
      consumeProducer(id, kind, activeCallbacks.onVideoStream, client_id, produced_type)
      return
    }

    // A remote producer we were consuming has closed (e.g. the other
    // client stopped screen sharing) — close our consumer and remove its tile.
    if (message.type === 'ProducerClosed') {
      const { id } = message.data
      const entry = remoteConsumers.get(id)
      if (entry) {
        entry.consumer.close()
        remoteConsumers.delete(id)
        if (entry.cleanup) {
          entry.cleanup()
          remoteCleanups = remoteCleanups.filter((fn) => fn !== entry.cleanup)
        }
        if (entry.kind === 'video') {
          activeCallbacks.onConsumerClosed?.(entry.consumerId)
        }
        console.log(`[Soup] Remote producer closed [id:${id}], consumer removed`)
      }
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

// Fetch (once) the RNNoise WASM binary. The SIMD build is used automatically
// where the platform supports it. The binary is reused across AudioContexts.
function getRnnoiseBinary() {
  if (!rnnoiseBinaryPromise) {
    rnnoiseBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
    }).catch((err) => {
      // Don't cache a failed load - allow a later retry.
      rnnoiseBinaryPromise = null
      throw err
    })
  }
  return rnnoiseBinaryPromise
}

// ─── Build the local audio processing chain ──────────────────────
// Wires the captured mic stream through optional RNNoise denoising (an
// AudioWorklet that suppresses keyboard/typing and steady background noise
// while preserving voice) and the optional volume gate, in that order.
// Returns the processed stream plus a stop() that tears the chain down.
async function buildAudioProcessor(stream, micSettings) {
  const needsRnnoise = micSettings.useRnnoise
  const needsGate = micSettings.useVolumeGate
  if (!needsRnnoise && !needsGate) {
    return { stream, stop: () => {} }
  }

  // RNNoise is trained on 48 kHz audio, so pin the context rate to match.
  const audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
  const source = audioContext.createMediaStreamSource(stream)
  const destination = audioContext.createMediaStreamDestination()
  let node = source
  let rnnoiseNode = null
  let rafId = null

  if (needsRnnoise) {
    try {
      const binary = await getRnnoiseBinary()
      await audioContext.audioWorklet.addModule(rnnoiseWorkletPath)
      rnnoiseNode = new RnnoiseWorkletNode(audioContext, { maxChannels: 1, wasmBinary: binary })
      node.connect(rnnoiseNode)
      node = rnnoiseNode
      console.log('[Soup] RNNoise denoiser applied')
    } catch (err) {
      // Fall through to whatever processing remains (or the raw stream).
      console.error('[Soup] RNNoise init failed, skipping:', err)
    }
  }

  if (needsGate) {
    const analyser = audioContext.createAnalyser()
    const gate = audioContext.createGain()
    analyser.fftSize = 256
    node.connect(analyser)
    analyser.connect(gate)
    node = gate

    const dataArray = new Uint8Array(analyser.frequencyBinCount)
    const checkLevel = () => {
      analyser.getByteFrequencyData(dataArray)
      const average = dataArray.reduce((a, b) => a + b) / dataArray.length
      const normalized = (average / 255) * 100
      // If audio is below threshold, mute; otherwise pass through
      gate.gain.setValueAtTime(normalized >= micSettings.volumeGateThreshold ? 1 : 0, audioContext.currentTime)
      rafId = requestAnimationFrame(checkLevel)
    }
    checkLevel()
    console.log('[Soup] Volume gate applied, threshold:', micSettings.volumeGateThreshold)
  }

  node.connect(destination)

  const stop = () => {
    if (rafId) cancelAnimationFrame(rafId)
    try { rnnoiseNode?.destroy() } catch {}
    try { source.disconnect() } catch {}
    try { audioContext.close() } catch {}
  }

  return { stream: destination.stream, stop }
}

// Stop the currently active audio processing chain (if any), releasing its
// AudioContext, worklet, and level-check loop.
function stopAudioProcessor() {
  audioProcessorStop?.()
  audioProcessorStop = null
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
    iceServers: getIceServers()
  })

  producerTransport.on('connectionstatechange', (state) => {
    console.log('[Soup] Producer transport connection state:', state)
  })

  producerTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
    send('ConnectProducerTransport', { dtlsParameters })
      .then(() => callback())
      .catch((err) => errback(err))
  })

  producerTransport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
    send('Produce', {
      produce_params: {
        rtp_params: rtpParameters,
        kind
      },
      produced_type: appData?.produced ?? 'Audio'
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
        // RNNoise replaces the browser suppressor - never run both (they're
        // mutually exclusive in the UI; this guards against any stale state).
        noiseSuppression: micSettings.useRnnoise ? false : micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
        sampleRate: micSettings.sampleRate,
        channelCount: micSettings.channelCount,
      }
    })
  } catch (err) {
    console.error('[Soup] getUserMedia failed:', err.name, err.message)
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  // Apply the local processing chain (RNNoise / volume gate). Stop any
  // previous chain first so its AudioContext and worklet don't leak.
  stopAudioProcessor()
  let processedStream = stream
  try {
    const processed = await buildAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    audioProcessorStop = processed.stop
  } catch (err) {
    console.error('[Soup] Failed to build audio processor:', err)
    // Fall back to unprocessed stream
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
      },
      appData: { produced: 'Audio' }
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
        // RNNoise replaces the browser suppressor - never run both (they're
        // mutually exclusive in the UI; this guards against any stale state).
        noiseSuppression: micSettings.useRnnoise ? false : micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
        sampleRate: micSettings.sampleRate,
        channelCount: micSettings.channelCount,
      }
    })
  } catch (err) {
    console.error('[Soup] republish getUserMedia failed:', err.name, err.message)
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  // Re-apply the local processing chain (RNNoise / volume gate). Stop any
  // previous chain first so its AudioContext and worklet don't leak.
  stopAudioProcessor()
  let processedStream = stream
  try {
    const processed = await buildAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    audioProcessorStop = processed.stop
  } catch (err) {
    console.error('[Soup] republish audio processor failed:', err)
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
        },
        appData: { produced: 'Audio' }
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
export async function shareScreen({ fps = 30, width = 1920, height = 1080, audio = true } = {}) {
  if (!producerTransport) throw new Error('Not connected to voice')

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: fps,
      width: { ideal: width },
      height: { ideal: height }
    },
    audio
  })

  const track = stream.getVideoTracks()[0]
  track.contentHint = 'detail'

  screenProducer = await producerTransport.produce({
    track,
    encodings: [{ maxBitrate: 15000000, scalabilityMode: 'L1T1' }],
    codecOptions: {
      videoGoogleStartBitrate: 8000
    },
    appData: { produced: 'ScreenShare' }
  })

  localProducerIds.add(screenProducer.id)
  console.log(`[Soup] Screen sharing [id:${screenProducer.id}]`)

  // System/tab audio is only available for some sources (e.g. full screens
  // on Windows) - produce it alongside the video when the browser gives us one.
  const audioTrack = stream.getAudioTracks()[0]
  if (audioTrack) {
    screenAudioProducer = await producerTransport.produce({
      track: audioTrack,
      codecOptions: {
        opusDtx: false,
        opusFec: true,
      },
      appData: { produced: 'ScreenShareAudio' }
    })
    localProducerIds.add(screenAudioProducer.id)
    console.log(`[Soup] Screen audio sharing [id:${screenAudioProducer.id}]`)
  }

  track.onended = () => {
    stopScreenShare()
  }

  // Local preview is video-only - the audio track is already produced above,
  // and playing it back locally too would echo/duplicate it for this client.
  const previewStream = new MediaStream([track])

  return {
    id: screenProducer.id,
    stream: previewStream
  }
}

// ─── Share webcam ────────────────────────────────────────────────
// Streams a camera device into the same producer slot as screen share, so the
// existing stop/preview/remote-render paths all apply. Unlike screen share,
// the webcam carries no audio and uses the device's own native quality - the
// fps/resolution/audio picker settings don't apply here.
export async function shareCamera(deviceId) {
  if (!producerTransport) throw new Error('Not connected to voice')

  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId } } : true,
    audio: false
  })

  const track = stream.getVideoTracks()[0]
  track.contentHint = 'motion'

  screenProducer = await producerTransport.produce({
    track,
    encodings: [{ maxBitrate: 15000000, scalabilityMode: 'L1T1' }],
    codecOptions: {
      videoGoogleStartBitrate: 8000
    },
    appData: { produced: 'ScreenShare' }
  })

  localProducerIds.add(screenProducer.id)
  console.log(`[Soup] Camera sharing [id:${screenProducer.id}]`)

  track.onended = () => {
    stopScreenShare()
  }

  const previewStream = new MediaStream([track])

  return {
    id: screenProducer.id,
    stream: previewStream
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
  screenProducer = null

  if (screenAudioProducer) {
    const audioProducerId = screenAudioProducer.id
    screenAudioProducer.close()
    localProducerIds.delete(audioProducerId)
    notify('CloseProducer', { id: audioProducerId })
    screenAudioProducer = null
  }

  console.log('[Soup] Screen share stopped')
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
      iceServers: getIceServers()
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
export async function consumeProducer(producerId, kind, onStream, clientId, producedType) {
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
  let cleanup = null
  let audioEl = null

  if (kind === 'audio') {
    audioEl = document.createElement('audio')
    audioEl.srcObject = stream
    audioEl.autoplay = true
    // Initial mute state - applyAllAudioState() below sorts out the real
    // value for ScreenShareAudio (focus-driven) and mic audio (per-client overrides).
    audioEl.muted = producedType === 'ScreenShareAudio' ? true : soundMuted
    // Route playback to the user's chosen output device, if the platform supports it.
    if (typeof audioEl.setSinkId === 'function') {
      audioEl
        .setSinkId(outputDeviceId)
        .catch((err) => console.error('[Soup] setSinkId failed:', err))
    }
    document.body.appendChild(audioEl)
    audioEl.play().catch((err) => console.error('[Soup] Audio play failed:', err))
    remoteAudioElements.push(audioEl)

    // Screen/tab audio isn't the client's voice - don't feed it into the
    // speaking indicator.
    let stopDetector = null
    if (clientId != null && producedType !== 'ScreenShareAudio') {
      stopDetector = createSpeakingDetector(stream, (isSpeaking) => {
        activeCallbacks.onClientSpeaking?.(clientId, isSpeaking)
      })
    }

    cleanup = () => {
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
      remoteAudioElements = remoteAudioElements.filter((el) => el !== audioEl)
      stopDetector?.()
    }
    remoteCleanups.push(cleanup)
  } else if (kind === 'video') {
    // If this client already had a video producer (e.g. restarted screen
    // share before a ProducerClosed notice arrived), close out the stale
    // consumer/tile before adding the new one.
    for (const [pid, entry] of remoteConsumers) {
      if (entry.kind === 'video' && entry.clientId === clientId) {
        entry.consumer.close()
        remoteConsumers.delete(pid)
        activeCallbacks.onConsumerClosed?.(entry.consumerId)
        break
      }
    }
    onStream?.({ stream, kind, consumerId: consumer.id, clientId })
  }

  remoteConsumers.set(producerId, { consumer, consumerId: consumer.id, kind, clientId, producedType, cleanup, audioEl })

  if (kind === 'audio') {
    applyAllAudioState()
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
  screenAudioProducer?.close()
  screenAudioProducer = null
  producers = []
  localProducerIds.clear()
  device = null
  currentChannel = null
  stopAudioProcessor()
  subscribePromise = null
  remoteCleanups.forEach((fn) => fn())
  remoteCleanups = []
  remoteAudioElements = []
  remoteConsumers.clear()
  focusedClientId = null
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

// Routes playback to the chosen output device for every current and future
// remote audio element. Pass 'default' (or empty) for the system default.
export function setOutputDevice(deviceId) {
  outputDeviceId = deviceId || 'default'
  for (const el of remoteAudioElements) {
    if (typeof el.setSinkId === 'function') {
      el.setSinkId(outputDeviceId).catch((err) => console.error('[Soup] setSinkId failed:', err))
    }
  }
}

// Sets the master output volume (0..1) applied on top of per-client/focus
// volumes for every remote audio element.
export function setMasterVolume(volume) {
  masterVolume = Math.max(0, Math.min(1, volume))
  applyAllAudioState()
}

// Mutes/unmutes playback of all remote audio elements (deafen).
export function setSoundMuted(muted) {
  soundMuted = muted
  remoteAudioElements.forEach((el) => { el.muted = muted })
  applyAllAudioState()
}

// Applies the focus-driven ScreenShareAudio state and the per-client mic
// volume/mute overrides to every remote audio element.
function applyAllAudioState() {
  for (const entry of remoteConsumers.values()) {
    if (entry.kind !== 'audio' || !entry.audioEl) continue

    if (entry.producedType === 'ScreenShareAudio') {
      // Only the focused stream's screen-share audio should be audible.
      if (entry.clientId === focusedClientId) {
        entry.audioEl.volume = focusedVolume * masterVolume
        entry.audioEl.muted = soundMuted || focusedMuted
      } else {
        entry.audioEl.muted = true
      }
    } else {
      const override = clientAudioOverrides.get(entry.clientId)
      entry.audioEl.volume = (override?.volume ?? 1) * masterVolume
      entry.audioEl.muted = soundMuted || !!override?.muted
    }
  }
}

// Called by the UI when the focused stream or its volume/mute state changes.
export function setFocusedScreenAudio(clientId, { volume, muted } = {}) {
  focusedClientId = clientId
  if (volume != null) focusedVolume = volume
  if (muted != null) focusedMuted = muted
  applyAllAudioState()
}

// Called by the sidebar's per-client right-click controls to locally
// lower the volume of, or fully mute, a specific client's mic audio.
export function setClientAudioState(clientId, { volume, muted } = {}) {
  const current = clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
  clientAudioOverrides.set(clientId, {
    volume: volume != null ? volume : current.volume,
    muted: muted != null ? muted : current.muted,
  })
  applyAllAudioState()
}

export function getClientAudioState(clientId) {
  return clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
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