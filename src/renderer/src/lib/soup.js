// ─── Imports ────────────────────────────────────────────────────
import { Device } from 'mediasoup-client'
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import { apiBase, wsBase } from './serverConfig'
import { authFetch } from './auth'
import { startScreenAudio, stopScreenAudio, onScreenAudioError } from './screenAudio'

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
// ICE servers from the server's Authenticated reply; transports are only
// created after auth, so this is always populated before use.
let iceServers = []
// Stop function for the active local audio processing chain (RNNoise / volume
// gate). Tears down its AudioContext and analysis loop; null when no chain is active.
let audioProcessorStop = null
// The raw getUserMedia capture backing the current audio producer. When RNNoise
// or the gate is on, the producer gets a different (processed) track, so this
// handle is the only way to release the OS mic. Held until the producer it feeds
// is torn down or its track replaced — stopping it while live would kill the
// send in the passthrough case (where the produced track IS this raw track).
let rawMicStream = null
// Self speaking detector, owned here rather than by a channel component so it
// survives ownership changes: a moderator move rebinds onClientSpeaking to the new
// channel, and the detector reports our own speaking through that live callback.
let selfSpeakingStop = null
let localClientId = null
// Set while a publish() is mid-flight so a concurrent caller joins the same
// promise instead of allocating a second producer transport (the server rejects a
// duplicate). Both the reset-driven republish and an adopt() can race here.
let publishInFlight = null
// The RNNoise WASM binary, fetched once and reused across AudioContexts.
let rnnoiseBinaryPromise = null
let subscribePromise = null
let activeCallbacks = {}
let remoteCleanups = []
let remoteAudioElements = []
let micMuted = false
let soundMuted = false
// Playback output device (sinkId) and master output volume (0..1). Persisted in
// settings and pushed in via setOutputDevice()/setMasterVolume().
let outputDeviceId = 'default'
let masterVolume = 1
// Shared AudioContext for remote playback. Each remote mic/screen audio stream
// runs through its own GainNode into this context, so a client's volume can be
// boosted above 100% (an HTMLAudioElement's volume is capped at 1.0).
let playbackContext = null
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

// ─── Reconnection state ──────────────────────────────────────────
// The voice socket can't "resume": when it drops, the server tears down our
// transports and removes us from the channel. Recovery is a full re-establish —
// re-assert channel membership, fetch a fresh ticket, reconnect, re-publish —
// driven here with capped exponential backoff + jitter (matches the events
// socket). Remote streams come back on their own: a fresh auth makes the server
// replay NewProducer for everyone in the channel.
const VOICE_RECONNECT_BASE_DELAY_MS = 1000
const VOICE_RECONNECT_MAX_DELAY_MS = 30000
let reconnectAttempts = 0
let reconnectTimer = null
let reconnectInFlight = false // an attempt is mid-flight; don't start a second
let intentionalClose = false // set by disconnect() so onclose won't reconnect
let everAuthenticated = false // only auto-reconnect drops that follow a real auth

// ─── Pending response handlers ───────────────────────────────────
const pendingHandlers = []

// ─── Send a message and wait for a response ──────────────────────
function send(type, data = null) {
  return new Promise((resolve, reject) => {
    // Don't queue a resolver against a dead socket — the response would never
    // come, and a stale handler left in the queue desyncs response routing once
    // we reconnect.
    if (ws?.readyState !== WebSocket.OPEN) {
      reject(new Error(`Voice socket not open (cannot send ${type})`))
      return
    }
    // Reject on a server UserError (e.g. a Produce refused for a missing STREAM
    // permission) instead of resolving it — otherwise callers proceed on a
    // response with no payload (undefined id) and start a phantom local-only
    // producer. Shape is the externally-tagged { UserError: "..." }.
    pendingHandlers.push((message) => {
      const userError =
        message?.UserError ?? (message?.type === 'UserError' ? message.data : null)
      if (userError != null) reject(new Error(typeof userError === 'string' ? userError : 'Request failed'))
      else resolve(message)
    })
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
  if (ws?.readyState !== WebSocket.OPEN) return
  const message = data ? { type, data } : { type }
  ws.send(JSON.stringify(message))
  console.log(`[Soup] Notify: ${type}`, message)
}

// ─── Connect to signaling server ────────────────────────────────
// Callbacks: onConnect (fired after each successful auth — initial and
// reconnect), onDisconnect (intentional/unrecoverable teardown), onReconnecting
// (an unexpected drop; clear remote tiles but stay "joined"), onReconnectRejoin
// (async; re-assert channel membership before a reconnect's ticket fetch),
// onNewProducer, onVideoStream, onTransportsDisconnected, onClientSpeaking,
// onConsumerClosed.
export async function connect(callbacks = {}) {
  activeCallbacks = { ...callbacks }
  intentionalClose = false
  everAuthenticated = false
  reconnectAttempts = 0
  // Cancel any pending reconnect from a prior session so it can't fire alongside
  // this fresh connection.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  // Watch OS connectivity. A silent network drop leaves the voice socket
  // half-open (onclose never fires on its own — unlike the events socket, this
  // one has no heartbeat to notice), so we use these to detect death and
  // recover. addEventListener dedupes the stable refs, so repeat calls are safe.
  window.addEventListener('offline', handleOffline)
  window.addEventListener('online', handleOnline)
  await openSocket()
}

// Open the voice WebSocket: fetch a fresh (single-use, 30s) ticket with a
// current access token, wire every handler, then authenticate. Used for the
// initial connection and every reconnect attempt — each call replaces the
// shared `ws`. A stale-socket guard on every handler ignores a superseded
// socket once a newer one takes over.
async function openSocket() {
  // Step 1 — get ticket (authFetch refreshes the access token as needed)
  const res = await authFetch(`${apiBase()}/server/voice`)
  if (!res.ok) throw new Error(`Voice ticket request failed: ${res.status}`)
  const { ticket } = await res.json()
  console.log('[Soup] Got ticket:', ticket)

  // Step 2 — connect to voice WebSocket
  const socket = new WebSocket(`${wsBase()}/voice`)
  ws = socket
  console.log('[Soup] WebSocket created, readyState:', socket.readyState)

  // ─── Assign ALL handlers before anything can fire ───────────────
  socket.onmessage = (event) => {
    if (ws !== socket) return // superseded by a newer socket
    const message = JSON.parse(event.data)
    console.log('[Soup] Received:', message)

    // Authenticated confirmation
    if (message.type === 'Authenticated') {
      console.log('[Soup] Authenticated')
      iceServers = message.ice_servers ?? []
      everAuthenticated = true
      reconnectAttempts = 0
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

    // Server is moving us to a different channel — transports must be torn down
    // and re-established, but the websocket stays open. TransportsDisconnected is
    // the self-initiated switch signal; MediaStateReset is the same thing when a
    // moderator moves us (PATCH /client). Both re-establish via the callback.
    if (message.type === 'TransportsDisconnected' || message.type === 'MediaStateReset') {
      console.log(`[Soup] ${message.type}, resetting media state`)
      resetMediaState()
      activeCallbacks.onTransportsDisconnected?.()
      return
    }

    // Route response to pending handler (resolves, or rejects on a UserError)
    if (pendingHandlers.length > 0) {
      const handler = pendingHandlers.shift()
      handler(message)
      return
    }

    console.log('[Soup] Unhandled message:', message)
  }

  socket.onclose = (event) => {
    if (ws !== socket) return // a newer socket has already taken over
    console.log('[Soup] WebSocket disconnected — code:', event.code, 'reason:', event.reason)
    currentChannel = null
    // Drop any in-flight request resolvers so the next connection's responses
    // can't resolve stale handlers and desync the response queue.
    pendingHandlers.length = 0
    resetMediaState()

    if (intentionalClose || !everAuthenticated) {
      // Deliberate teardown, or a connection that never authenticated (treat a
      // failed initial join as a normal disconnect, not something to retry).
      ws = null
      activeCallbacks.onDisconnect?.()
    } else {
      // Unexpected drop after a healthy session — keep the user "joined" and
      // recover in the background. Remote tiles are cleared now and re-arrive
      // via replayed NewProducer once we're back; mic is re-published on auth.
      activeCallbacks.onReconnecting?.()
      scheduleVoiceReconnect()
    }
  }

  socket.onerror = (err) => {
    console.error('[Soup] WebSocket error:', err)
  }

  // ─── onopen last so handlers are guaranteed to be in place ──────
  socket.onopen = () => {
    if (ws !== socket) return
    console.log('[Soup] WebSocket connected, authenticating...')
    socket.send(JSON.stringify({ ticket }))
  }
}

// Schedule a reconnect with capped exponential backoff + jitter.
function scheduleVoiceReconnect() {
  if (intentionalClose || reconnectTimer) return
  const delay = Math.min(
    VOICE_RECONNECT_MAX_DELAY_MS,
    VOICE_RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts
  )
  reconnectAttempts++
  const jittered = Math.round(delay * (0.5 + Math.random() * 0.5))
  console.warn(`[Soup] Reconnecting voice in ${jittered}ms (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    attemptReconnect()
  }, jittered)
}

// One reconnect attempt: re-assert channel membership (the server drops us from
// the channel when the socket dies), then re-open the socket. The fresh auth
// makes the server replay NewProducer for everyone in the channel, so remote
// audio/video re-consume automatically; onConnect re-publishes our mic.
async function attemptReconnect() {
  if (intentionalClose || reconnectInFlight) return
  reconnectInFlight = true
  try {
    await activeCallbacks.onReconnectRejoin?.()
    await openSocket()
  } catch (err) {
    console.error('[Soup] Voice reconnect failed:', err)
    scheduleVoiceReconnect()
  } finally {
    reconnectInFlight = false
  }
}

// Recover from a detected network failure. Because the voice socket has no
// heartbeat, a half-open connection can sit in OPEN forever without firing
// onclose — so the ICE-transport 'failed' state and the OS online/offline
// events call this to kick recovery. No-op unless we have a live, non-
// intentional session.
function forceVoiceReconnect(reason) {
  if (!everAuthenticated || intentionalClose) return
  // A socket that still thinks it's open/connecting is the half-open case:
  // close it so onclose runs the normal teardown + reconnect path.
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    console.warn(`[Soup] ${reason} — closing half-open voice socket to recover`)
    ws.close()
    return
  }
  // Already closed and waiting out a backoff — jump straight to a fresh attempt.
  if (reconnectInFlight) return
  console.warn(`[Soup] ${reason} — retrying voice connection now`)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  attemptReconnect()
}

// OS reports the network interface went down: tear the dead socket down now so
// the UI clears and backoff starts (attempts fail until we're back online).
function handleOffline() {
  forceVoiceReconnect('Network offline')
}

// OS reports connectivity is back: recover promptly rather than waiting out the
// current backoff delay.
function handleOnline() {
  forceVoiceReconnect('Network online')
}

// ─── Disconnect ──────────────────────────────────────────────────
export function disconnect() {
  intentionalClose = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('online', handleOnline)
  // Let the (guarded) onclose handler run resetMediaState + onDisconnect and
  // null out `ws`; closing synchronously here would race that cleanup.
  ws?.close()
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
      simdUrl: rnnoiseSimdWasmPath
    }).catch((err) => {
      // Don't cache a failed load - allow a later retry.
      rnnoiseBinaryPromise = null
      throw err
    })
  }
  return rnnoiseBinaryPromise
}

// Shared AudioContext for the local mic chain. Reused across publishes so the
// RNNoise worklet module is fetched/compiled once, not on every publish or
// settings Apply (which used to rebuild the context and re-addModule each
// time). Suspended on media reset rather than closed, so the compiled module
// survives for the next publish. RNNoise is trained on 48 kHz audio, so the
// rate is pinned.
let micContext = null
let micWorkletLoaded = false

async function getMicContext() {
  if (!micContext || micContext.state === 'closed') {
    micContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
    micWorkletLoaded = false
  }
  if (micContext.state === 'suspended') await micContext.resume()
  return micContext
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

  const audioContext = await getMicContext()
  const source = audioContext.createMediaStreamSource(stream)
  const destination = audioContext.createMediaStreamDestination()
  // Every node this chain creates, so stop() can detach them from the shared
  // context (which lives on for the next publish, unlike the old
  // context-per-publish teardown).
  const chainNodes = [source, destination]
  let node = source
  let rnnoiseNode = null
  let gateTimer = null

  if (needsRnnoise) {
    try {
      const binary = await getRnnoiseBinary()
      if (!micWorkletLoaded) {
        await audioContext.audioWorklet.addModule(rnnoiseWorkletPath)
        micWorkletLoaded = true
      }
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
    chainNodes.push(analyser, gate)
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
      gate.gain.setValueAtTime(
        normalized >= micSettings.volumeGateThreshold ? 1 : 0,
        audioContext.currentTime
      )
    }
    // 25Hz via setInterval, not rAF: level detection needs far less than display
    // rate, and rAF is throttled/paused when the window is hidden — which would
    // stall the gate and stick outgoing audio gated/ungated while minimized.
    checkLevel()
    gateTimer = setInterval(checkLevel, 40)
    console.log('[Soup] Volume gate applied, threshold:', micSettings.volumeGateThreshold)
  }

  node.connect(destination)

  const stop = () => {
    if (gateTimer) clearInterval(gateTimer)
    try {
      rnnoiseNode?.destroy()
    } catch {}
    for (const chainNode of chainNodes) {
      try {
        chainNode.disconnect()
      } catch {}
    }
    // The shared context stays open (suspended on media reset) so the
    // compiled worklet module is reused by the next publish.
  }

  return { stream: destination.stream, stop }
}

// Stop the currently active audio processing chain (if any), releasing its
// AudioContext, worklet, and level-check loop.
function stopAudioProcessor() {
  audioProcessorStop?.()
  audioProcessorStop = null
}

// Release a raw getUserMedia capture, closing the OS mic handle. Safe on null.
// Only call once the capture no longer feeds a live producer — in the
// passthrough case its track IS the produced track, so stopping it mid-use
// would kill the outgoing audio.
function stopRawStream(stream) {
  stream?.getTracks().forEach((track) => track.stop())
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
  let intervalId

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
  }
  // 25Hz via setInterval, not rAF: this runs once per remote participant plus
  // self (N+1 loops in a busy channel), level detection doesn't need display
  // rate, and rAF pauses when the window is hidden — freezing speaking state
  // while minimized.
  tick()
  intervalId = setInterval(tick, 40)

  return () => {
    clearInterval(intervalId)
    if (speaking) onChange(false)
    try {
      source.disconnect()
    } catch {}
    // close() rejects (async) if the context is already closed — e.g. this
    // cleanup runs twice during teardown. Skip when closed and swallow the
    // rejection so it never surfaces as an uncaught promise error.
    if (audioContext.state !== 'closed') audioContext.close().catch(() => {})
  }
}

// Identify the local client so the soup-owned self speaking detector can report
// our own speaking state through onClientSpeaking, the same path remote peers use.
export function setLocalClientId(id) {
  localClientId = id
}

// (Re)start the self speaking detector on the current local audio stream. It
// reports through the live onClientSpeaking callback, so speaking always lands on
// whichever channel currently owns the session (rebound on switch/adopt).
function startSelfSpeakingDetector(stream) {
  selfSpeakingStop?.()
  selfSpeakingStop = createSpeakingDetector(stream, (isSpeaking) => {
    if (localClientId != null) activeCallbacks.onClientSpeaking?.(localClientId, isSpeaking)
  })
}

// ─── Map snake_case transport params to mediasoup camelCase ───────
function mapTransportParams(params) {
  return {
    id: params.id,
    iceParameters: params.ice_parameters,
    iceCandidates: params.ice_candidates,
    dtlsParameters: params.dtls_parameters
  }
}

// ─── Publish: send local audio ───────────────────────────────────
// Single-flight: a forced-move MediaStateReset (re-establish via the previously
// joined channel) and the adopt() of the new channel can both call this at once.
// Allocating two producer transports makes the server error out, so a second
// concurrent caller joins the in-flight promise, and a call while already
// published is a no-op.
export async function publish(micSettings, onStream) {
  if (producerTransport) return
  if (publishInFlight) return publishInFlight
  publishInFlight = doPublish(micSettings, onStream).finally(() => {
    publishInFlight = null
  })
  return publishInFlight
}

async function doPublish(micSettings, onStream) {
  if (!device) await loadDevice()

  const rawParams = await send('CreateProducerTransport')
  producerTransport = device.createSendTransport({
    ...mapTransportParams(rawParams),
    iceServers
  })

  producerTransport.on('connectionstatechange', (state) => {
    console.log('[Soup] Producer transport connection state:', state)
    // ICE gave up (network died without the socket noticing) — recover. Our own
    // teardown closes transports as 'closed', not 'failed', so this won't loop.
    if (state === 'failed') forceVoiceReconnect('Producer transport failed')
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
        deviceId:
          micSettings.deviceId && micSettings.deviceId !== 'default'
            ? { exact: micSettings.deviceId }
            : undefined,
        echoCancellation: micSettings.echoCancellation,
        // RNNoise replaces the browser suppressor - never run both (they're
        // mutually exclusive in the UI; this guards against any stale state).
        noiseSuppression: micSettings.useRnnoise ? false : micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
        sampleRate: micSettings.sampleRate,
        channelCount: micSettings.channelCount
      }
    })
  } catch (err) {
    console.error('[Soup] getUserMedia failed:', err.name, err.message)
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  // Track the raw capture so its OS mic handle can be released on teardown —
  // the processed track handed to the producer is usually a different track, so
  // stopping only that would leave the mic open.
  rawMicStream = stream

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
  startSelfSpeakingDetector(processedStream)

  for (const track of processedStream.getTracks()) {
    const producer = await producerTransport.produce({
      track,
      encodings: [{ maxBitrate: micSettings.bitrate }],
      codecOptions: {
        opusStereo: micSettings.channelCount === 2,
        opusMaxPlaybackRate: micSettings.sampleRate,
        opusDtx: true,
        opusFec: true
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
  // The raw capture backing the current producer(s). Held until the new track
  // has replaced it below, then stopped — waiting avoids killing a live
  // passthrough track (where the raw track IS the produced track).
  const previousRawStream = rawMicStream

  // Get a fresh stream with updated constraints
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId:
          micSettings.deviceId && micSettings.deviceId !== 'default'
            ? { exact: micSettings.deviceId }
            : undefined,
        echoCancellation: micSettings.echoCancellation,
        // RNNoise replaces the browser suppressor - never run both (they're
        // mutually exclusive in the UI; this guards against any stale state).
        noiseSuppression: micSettings.useRnnoise ? false : micSettings.noiseSuppression,
        autoGainControl: micSettings.autoGainControl,
        sampleRate: micSettings.sampleRate,
        channelCount: micSettings.channelCount
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
  startSelfSpeakingDetector(processedStream)

  const newTracks = processedStream.getTracks()

  // The socket can drop while we were awaiting getUserMedia / the audio
  // processor above; onclose then runs resetMediaState(), closing the transport
  // and the producers we captured. Bail rather than produce/replaceTrack on a
  // corpse (InvalidStateError: closed) — the reconnect path re-publishes fresh.
  if (!producerTransport || producerTransport.closed) {
    stopAudioProcessor()
    // The new capture never reached a producer; release it. The previous raw
    // capture was already stopped by resetMediaState() when the socket dropped.
    stopRawStream(stream)
    return
  }

  // Adopt the new capture as the current raw stream; the previous one is
  // released below once its track is no longer attached to a producer.
  rawMicStream = stream

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
          opusDtx: true,
          opusFec: true
        },
        appData: { produced: 'Audio' }
      })
      producers.push(producer)
      localProducerIds.add(producer.id)
      if (micMuted) producer.pause()
      console.log(`[Soup] Republished ${track.kind} [id:${producer.id}]`)
    }

    // No producer was reusing it, so the old capture (if any) is free to stop.
    stopRawStream(previousRawStream)
    console.log('[Soup] Audio republished with new settings')
    return
  }

  // Swap the track on each existing audio producer in place. The
  // server-side producer (and any consumers peers already created for it)
  // stays alive, so peers keep receiving the same producer id.
  for (let i = 0; i < audioProducers.length; i++) {
    const producer = audioProducers[i]
    const track = newTracks[i]
    if (!track || producer.closed) continue

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

  // Every producer now carries the new track — the old raw capture is detached
  // and its OS mic handle can finally be released.
  stopRawStream(previousRawStream)
  console.log('[Soup] Audio republished with new settings')
}

// Native capture dying mid-share (utility process crash, PipeWire/WASAPI
// device loss) degrades the share to video-only instead of tearing it down:
// close the audio producer, surface the reason to the active channel UI.
onScreenAudioError(({ message }) => {
  console.error('[Soup] Screen audio capture failed:', message)
  if (screenAudioProducer) {
    const audioProducerId = screenAudioProducer.id
    screenAudioProducer.close()
    localProducerIds.delete(audioProducerId)
    notify('CloseProducer', { id: audioProducerId })
    screenAudioProducer = null
  }
  stopScreenAudio().catch(() => {})
  if (screenProducer) {
    activeCallbacks.onScreenAudioError?.(message)
  }
})

// ─── Video codec + encoder tuning helpers (screen + camera) ──────
// SVC layering. 'L3' = 3 spatial layers (quarter → full res), 'T3' = 3
// temporal (fps) layers; '_KEY' shares the keyframe across spatial layers for
// cleaner switching. setVideoStreamRoles() forwards a given consumer only the
// layer its view needs. Cameras always use the full mode (native resolution,
// no picker choice).
const VIDEO_SCALABILITY_MODE = 'L3T3_KEY'

// Screen shares adapt the spatial-layer count to the picked resolution: every
// spatial layer is an extra encode pass, and a 720p share's third tier would
// bottom out at 320x180 - smaller than any tile actually renders. The server
// clamps setPreferredLayers() to the producer's top layer, so VIEW_LAYERS
// needs no changes (focused spatial:2 against an L2 producer clamps to 1).
function scalabilityModeFor(height) {
  return height >= 1080 ? 'L3T3_KEY' : 'L2T3_KEY'
}

// Ceiling for the screen-share encoding, scaled to the picked resolution. This is
// a cap, not a target — congestion control sends less on a constrained link — but
// keeping it modest stops the bandwidth estimator from probing so high that it
// overshoots and triggers the loss/keyframe-recovery freezes. Well below what a
// single SVC encoding could demand at full motion.
function maxBitrateFor(height) {
  if (height >= 1440) return 8_000_000
  if (height >= 1080) return 6_000_000
  return 4_000_000
}

// Pick an explicit codec for the video produce(). Both AV1 and VP9 carry real
// spatial SVC (the layering above), unlike VP8/H264, so either keeps the
// focused/grid/thumbnail tiering — the choice is only about encode cost/quality:
//   - 'detail' (static text/UI screen content): AV1. VP9's screen-content SVC
//     path renders a black frame on the receiver here, and low-motion content is
//     cheap enough for software AV1.
//   - everything else (motion shares, cameras): VP9, whose software encoder keeps
//     up with high-motion content where software AV1 (rarely hardware-accelerated)
//     falls behind and stutters.
// The codec MUST come from the loaded device's capabilities: mediasoup matches it
// against the router's codecs and throws 'no matching codec found' on a mismatch,
// so we only ever return one the device already advertised. undefined preserves
// mediasoup's default (first router codec) on a server offering neither.
function pickVideoCodec(optimizeFor) {
  const codecs = device?.rtpCapabilities?.codecs ?? []
  const find = (mime) =>
    codecs.find((c) => c.kind === 'video' && c.mimeType?.toLowerCase() === mime)
  return optimizeFor === 'detail'
    ? (find('video/av1') ?? find('video/vp9') ?? undefined)
    : (find('video/vp9') ?? find('video/av1') ?? undefined)
}

// Webcam prefers H.264: it's almost always hardware-encoded (low CPU/battery for
// a live camera) and fine for low-res motion. Trade-off vs VP9/AV1: H.264 has no
// spatial SVC, so unfocused/thumbnail camera tiles can only drop frames
// (temporal), not resolution — see logNegotiatedVideoCodec's warning. Falls back
// to VP9/AV1 (full spatial tiering) when the router doesn't advertise H.264.
function pickCameraCodec() {
  const codecs = device?.rtpCapabilities?.codecs ?? []
  const find = (mime) =>
    codecs.find((c) => c.kind === 'video' && c.mimeType?.toLowerCase() === mime)
  return find('video/h264') ?? find('video/vp9') ?? find('video/av1') ?? undefined
}

// Log the codec the SFU actually negotiated, and warn when it's one without
// spatial SVC. VP8/H264 have no spatial layers, so 'L3T3_KEY' degrades to
// temporal-only and setVideoStreamRoles() can't tier thumbnail/focus resolution.
function logNegotiatedVideoCodec(producer, scalabilityMode) {
  const mimeType = producer.rtpParameters?.codecs?.find(
    (c) => !c.mimeType?.toLowerCase().endsWith('/rtx')
  )?.mimeType
  console.log('[Soup] Video codec negotiated:', mimeType)

  // Spatial layer count is the 'L' number in the mode (e.g. 'L3T3_KEY' → 3).
  const spatialLayers = Number(/^L(\d+)/.exec(scalabilityMode ?? '')?.[1] ?? 1)
  if (spatialLayers > 1 && /^video\/(vp8|h264)$/i.test(mimeType ?? '')) {
    console.warn(
      `[Soup] ${mimeType} has no spatial SVC — thumbnail/focus resolution tiering ` +
        'will not work (temporal layers only).'
    )
  }
}

// Bias how the encoder sheds quality under CPU/bandwidth pressure, via the RTP
// sender's top-level degradationPreference. Mirrors the audio setParameters path
// (getParameters → mutate → setParameters in a try/catch). 'maintain-resolution'
// keeps frames sharp and lets fps drop; 'maintain-framerate' does the reverse.
async function setDegradationPreference(producer, preference) {
  const sender = producer.rtpSender
  if (!sender) return
  const params = sender.getParameters()
  params.degradationPreference = preference
  try {
    await sender.setParameters(params)
  } catch (err) {
    console.warn('[Soup] Failed to set degradationPreference:', err)
  }
}

// ─── Share screen ────────────────────────────────────────────────
// audioMode selects where screenshare audio comes from:
//   'app'                 native capture of the shared app only (audioTargets)
//   'system-exclude-self' native system capture minus our own audio
//   'system'              native whole-system capture
//   'system-legacy'       Chromium's loopback (rides the getDisplayMedia stream)
//   'none'                video only
// Native modes are produced from the audio-capture pipeline (screenAudio.js);
// only 'system-legacy' asks getDisplayMedia for audio.
export async function shareScreen({
  fps = 30,
  width = 1920,
  height = 1080,
  audioMode = 'none',
  audioTargets = null,
  // 'detail' (default) keeps text sharp, 'motion' favors smoothness — drives
  // the track contentHint and degradationPreference below.
  optimizeFor = 'detail',
  // Legacy boolean from the old picker API - maps to system-legacy loopback.
  audio = undefined
} = {}) {
  if (!producerTransport) throw new Error('Not connected to voice')
  if (audio !== undefined && audioMode === 'none' && audio) audioMode = 'system-legacy'

  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      frameRate: fps,
      width: { ideal: width },
      height: { ideal: height }
    },
    audio: audioMode === 'system-legacy'
  })

  const track = stream.getVideoTracks()[0]
  track.contentHint = optimizeFor === 'motion' ? 'motion' : 'detail'

  const scalabilityMode = scalabilityModeFor(height)
  try {
    screenProducer = await producerTransport.produce({
      track,
      // Request the codec explicitly (per optimizeFor — see pickVideoCodec) so we get
      // real spatial SVC: one efficient upload carrying spatial × temporal layers,
      // so the server can forward a cheap layer to thumbnails / a full layer to
      // the focused viewer (see setVideoStreamRoles). Spatial-layer count adapts
      // to the picked resolution (see scalabilityModeFor).
      codec: pickVideoCodec(optimizeFor),
      encodings: [{ maxBitrate: maxBitrateFor(height), scalabilityMode }],
      codecOptions: {
        // Start conservatively (kbps) and let BWE ramp — a high start bitrate
        // over-probes the link and causes the initial overshoot/freeze.
        videoGoogleStartBitrate: 2500
      },
      appData: { produced: 'ScreenShare' }
    })
  } catch (err) {
    // Produce refused (e.g. no STREAM permission in this channel). Release the
    // capture so we don't leave the OS screen-share running with no producer.
    stream.getTracks().forEach((t) => t.stop())
    throw err
  }

  localProducerIds.add(screenProducer.id)
  logNegotiatedVideoCodec(screenProducer, scalabilityMode)
  // Follow the picker's Optimize-for choice: 'detail' keeps text sharp (fps drops
  // first under pressure), 'motion' favors framerate for video-heavy shares.
  await setDegradationPreference(
    screenProducer,
    optimizeFor === 'motion' ? 'maintain-framerate' : 'maintain-resolution'
  )
  console.log(`[Soup] Screen sharing [id:${screenProducer.id}]`)

  // Screenshare audio: native capture for the per-app/system modes, or the
  // legacy loopback track riding the getDisplayMedia stream. Native capture
  // failure degrades to a video-only share rather than failing the whole thing.
  let audioTrack = null
  if (audioMode === 'system-legacy') {
    audioTrack = stream.getAudioTracks()[0] ?? null
  } else if (audioMode !== 'none') {
    try {
      const nativeAudio = await startScreenAudio({
        mode: audioMode,
        targets: audioTargets ?? undefined
      })
      audioTrack = nativeAudio.track
      console.log(`[Soup] Native screen audio capture started [backend:${nativeAudio.backend}]`)
    } catch (err) {
      console.error('[Soup] Native screen audio failed, sharing video-only:', err)
      activeCallbacks.onScreenAudioError?.(err.message)
    }
  }

  if (audioTrack) {
    screenAudioProducer = await producerTransport.produce({
      track: audioTrack,
      // Stereo + a real bitrate: captured app/system audio is music/media,
      // not speech, and the old mono default audibly degraded it.
      codecOptions: {
        opusStereo: true,
        opusDtx: true,
        opusFec: true
      },
      encodings: [{ maxBitrate: 160000 }],
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

  // H.264 has no spatial SVC, so its scalability tops out at temporal-only (L1T3)
  // — a full spatial mode would just be ignored. VP9/AV1 fallbacks keep the full
  // spatial+temporal mode.
  const cameraCodec = pickCameraCodec()
  const cameraScalabilityMode = /h264/i.test(cameraCodec?.mimeType ?? '')
    ? 'L1T3'
    : VIDEO_SCALABILITY_MODE
  try {
    screenProducer = await producerTransport.produce({
      track,
      // Webcam prefers hardware H.264, falling back to VP9/AV1 — see pickCameraCodec.
      codec: cameraCodec,
      // Webcams capture at native (typically 720p–1080p) resolution; cap at the
      // 1080p tier and let BWE ramp from a conservative start, same as shareScreen.
      encodings: [{ maxBitrate: 6_000_000, scalabilityMode: cameraScalabilityMode }],
      codecOptions: {
        videoGoogleStartBitrate: 2500
      },
      appData: { produced: 'ScreenShare' }
    })
  } catch (err) {
    // Produce refused (e.g. no STREAM permission) — release the camera capture.
    stream.getTracks().forEach((t) => t.stop())
    throw err
  }

  localProducerIds.add(screenProducer.id)
  logNegotiatedVideoCodec(screenProducer, cameraScalabilityMode)
  // Camera content is motion, so keep framerate smooth (resolution drops first).
  await setDegradationPreference(screenProducer, 'maintain-framerate')
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

  // Tear down the native capture session (no-op for legacy/video-only shares).
  stopScreenAudio().catch(() => {})

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
      iceServers
    })

    consumerTransport.on('connectionstatechange', (state) => {
      console.log('[Soup] Consumer transport connection state:', state)
      if (state === 'failed') forceVoiceReconnect('Consumer transport failed')
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
    rtpParameters: consumerParams.rtp_parameters
  })

  const stream = new MediaStream([consumer.track])

  // log track state
  console.log(
    '[Soup] Consumer track state:',
    consumer.track.readyState,
    'muted:',
    consumer.track.muted
  )

  // Audio must play immediately, so resume it on the server right away. Video
  // instead starts *paused*: streams default to stopped, and the grid opts in
  // per stream via setVideoStreamRoles(). Resuming video here would pull full
  // bitrate for every already-live stream the instant we join a channel, before
  // any view role has been applied.
  if (kind === 'audio') {
    await send('ResumeConsumer', { id: consumer.id })
    console.log(`[Soup] Consumer resumed [id:${consumer.id}]`)
  } else {
    await send('PauseConsumer', { id: consumer.id })
    console.log(`[Soup] Video consumer created paused [id:${consumer.id}]`)
  }

  // play audio or stream via DOM element
  let cleanup = null
  let audioEl = null
  let gainNode = null

  if (kind === 'audio') {
    // A muted <audio> element keeps the remote WebRTC track pulled; the audible
    // playback goes through Web Audio so per-client volume can exceed 100%.
    audioEl = document.createElement('audio')
    audioEl.srcObject = stream
    audioEl.autoplay = true
    audioEl.muted = true
    document.body.appendChild(audioEl)
    audioEl.play().catch((err) => console.error('[Soup] Audio pump play failed:', err))
    remoteAudioElements.push(audioEl)

    // source -> gain -> output. applyAllAudioState() below sets the gain value
    // (deafen/focus/per-client overrides); gain may be >1 to boost a client.
    const ctx = getPlaybackContext()
    const srcNode = ctx.createMediaStreamSource(stream)
    gainNode = ctx.createGain()
    gainNode.gain.value = 0 // start silent; applyAllAudioState() sets the real value
    srcNode.connect(gainNode)
    gainNode.connect(ctx.destination)

    // Screen/tab audio isn't the client's voice - don't feed it into the
    // speaking indicator.
    let stopDetector = null
    if (clientId != null && producedType !== 'ScreenShareAudio') {
      stopDetector = createSpeakingDetector(stream, (isSpeaking) => {
        activeCallbacks.onClientSpeaking?.(clientId, isSpeaking)
      })
    }

    cleanup = () => {
      try {
        srcNode.disconnect()
      } catch {}
      try {
        gainNode.disconnect()
      } catch {}
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

  remoteConsumers.set(producerId, {
    consumer,
    consumerId: consumer.id,
    kind,
    clientId,
    producedType,
    cleanup,
    audioEl,
    gain: gainNode,
    // Video is consumed paused above, so seed its bookkeeping as hidden/paused
    // — setVideoStreamRoles() will resume it only when a view role asks for it.
    ...(kind === 'video' ? { serverPaused: true, viewRole: 'hidden' } : {})
  })

  if (kind === 'audio') {
    applyAllAudioState()
  }

  console.log(`[Soup] Consuming ${kind} [id:${consumer.id}]`)
  return { stream, kind, consumerId: consumer.id }
}

// ─── Bandwidth rationing: per-stream view roles ──────────────────
// Drives server-side layer selection + pausing from the UI's current view so
// we don't pull every screen share at full 4K at once. With AV1 L3T3_KEY each
// producer exposes 3 spatial (0 = ~quarter res, 2 = full) and 3 temporal (fps)
// layers; the server forwards only the layer a given consumer asks for.
//
// REQUIRES matching server handlers (same style as Consume / ResumeConsumer):
//   SetConsumerPreferredLayers { id, spatial_layer, temporal_layer }
//       → serverConsumer.setPreferredLayers({ spatialLayer, temporalLayer })
//   PauseConsumer  { id } → serverConsumer.pause()
//   ResumeConsumer { id } → serverConsumer.resume()   (already implemented)
// All three must send a response, since send() awaits one (an unanswered
// message desyncs the response queue — see notify()).
const VIEW_LAYERS = {
  focused: { spatialLayer: 2, temporalLayer: 2 },
  // The unfocused grid fills the whole area with medium tiles, so it gets a
  // mid spatial layer at full fps — better than a carousel thumbnail, cheaper
  // than the focused stream.
  grid: { spatialLayer: 1, temporalLayer: 2 },
  thumbnail: { spatialLayer: 1, temporalLayer: 0 }
}

// Ask the server to forward only the given SVC layers for this consumer.
// No-ops if the preference is unchanged.
function setConsumerPreferredLayers(entry, { spatialLayer, temporalLayer }) {
  if (entry.preferredSpatial === spatialLayer && entry.preferredTemporal === temporalLayer) return
  entry.preferredSpatial = spatialLayer
  entry.preferredTemporal = temporalLayer
  send('SetConsumerPreferredLayers', {
    id: entry.consumerId,
    spatial_layer: spatialLayer,
    temporal_layer: temporalLayer
  }).catch((err) => console.warn('[Soup] SetConsumerPreferredLayers failed:', err))
}

// Pause/resume RTP forwarding on the server side (real bandwidth, unlike a
// client-side consumer.pause() which only stops rendering). Idempotent.
function pauseVideoConsumer(entry) {
  if (entry.serverPaused === true) return
  entry.serverPaused = true
  send('PauseConsumer', { id: entry.consumerId }).catch((err) =>
    console.warn('[Soup] PauseConsumer failed:', err)
  )
}

function resumeVideoConsumer(entry) {
  // Video consumers are created paused (see consumeProducer), so a resume is
  // only ever needed to undo a pause — i.e. when serverPaused is true.
  if (entry.serverPaused !== true) return
  entry.serverPaused = false
  send('ResumeConsumer', { id: entry.consumerId }).catch((err) =>
    console.warn('[Soup] ResumeConsumer failed:', err)
  )
}

// Apply the UI's current view to every remote video consumer:
//   - focusedConsumerId  → full layers
//   - visibleConsumerIds → cheap thumbnail layer
//   - everything else    → paused (0 bytes)
// Only diffs are signaled, so it's safe to call on every focus/visibility
// change. focusedConsumerId always wins even if it's also in visibleConsumerIds.
export function setVideoStreamRoles({ focusedConsumerId = null, visibleConsumerIds = [] } = {}) {
  const visible = new Set(visibleConsumerIds)
  for (const entry of remoteConsumers.values()) {
    if (entry.kind !== 'video') continue

    // Visible streams are 'grid' tiles when nothing is focused (they fill the
    // area), or small carousel 'thumbnail's when a stream is focused.
    const role =
      entry.consumerId === focusedConsumerId
        ? 'focused'
        : visible.has(entry.consumerId)
          ? focusedConsumerId == null
            ? 'grid'
            : 'thumbnail'
          : 'hidden'

    if (entry.viewRole === role) continue
    entry.viewRole = role

    if (role === 'hidden') {
      pauseVideoConsumer(entry)
    } else {
      resumeVideoConsumer(entry) // no-op unless server-paused
      setConsumerPreferredLayers(entry, VIEW_LAYERS[role])
    }
  }
}

// ─── Reset all media state ───────────────────────────────────────
export function resetMediaState() {
  selfSpeakingStop?.()
  selfSpeakingStop = null
  producerTransport?.close()
  producerTransport = null
  consumerTransport?.close()
  consumerTransport = null
  screenProducer?.close()
  screenProducer = null
  screenAudioProducer?.close()
  screenAudioProducer = null
  stopScreenAudio().catch(() => {})
  producers = []
  localProducerIds.clear()
  device = null
  currentChannel = null
  stopAudioProcessor()
  // Release the raw mic capture — the producers above are closed, so no live
  // producer references it anymore (nothing to keep the OS mic open for).
  stopRawStream(rawMicStream)
  rawMicStream = null
  // Idle the shared mic context between sessions; getMicContext() resumes it.
  if (micContext?.state === 'running') micContext.suspend().catch(() => {})
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
  producers.filter((p) => p.kind === 'audio').forEach((p) => (muted ? p.pause() : p.resume()))
}

// Lazily create (and resume) the shared playback AudioContext. Created on the
// first remote audio stream, which happens after the user has clicked to join -
// so the autoplay policy lets it run.
function getPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)()
    applyOutputDeviceToContext()
  }
  if (playbackContext.state === 'suspended') {
    playbackContext.resume().catch(() => {})
  }
  return playbackContext
}

// Route the whole playback context to the chosen output device. AudioContext
// uses '' for the system default (unlike HTMLMediaElement which takes 'default').
function applyOutputDeviceToContext() {
  if (playbackContext && typeof playbackContext.setSinkId === 'function') {
    const sinkId = outputDeviceId === 'default' ? '' : outputDeviceId
    playbackContext
      .setSinkId(sinkId)
      .catch((err) => console.error('[Soup] context setSinkId failed:', err))
  }
}

// Routes playback to the chosen output device. Pass 'default' (or empty) for
// the system default.
export function setOutputDevice(deviceId) {
  outputDeviceId = deviceId || 'default'
  applyOutputDeviceToContext()
}

// Sets the master output volume (0..1) applied on top of per-client/focus
// volumes for every remote stream.
export function setMasterVolume(volume) {
  masterVolume = Math.max(0, Math.min(1, volume))
  applyAllAudioState()
}

// Mutes/unmutes playback of all remote audio (deafen).
export function setSoundMuted(muted) {
  soundMuted = muted
  applyAllAudioState()
}

// Applies the focus-driven ScreenShareAudio state and the per-client mic
// volume/mute overrides to every remote stream's gain node. A per-client
// override volume above 1 boosts that client louder than their natural level.
function applyAllAudioState() {
  for (const entry of remoteConsumers.values()) {
    if (entry.kind !== 'audio' || !entry.gain) continue

    let gain
    if (entry.producedType === 'ScreenShareAudio') {
      // Only the focused stream's screen-share audio should be audible.
      const audible = entry.clientId === focusedClientId && !focusedMuted
      gain = audible ? focusedVolume * masterVolume : 0
    } else {
      const override = clientAudioOverrides.get(entry.clientId)
      const muted = soundMuted || !!override?.muted
      gain = muted ? 0 : (override?.volume ?? 1) * masterVolume
    }
    entry.gain.gain.value = gain
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
    muted: muted != null ? muted : current.muted
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

// ─── TEMP DIAGNOSTIC: live inbound kbps per remote video consumer ─────────
// Verifies that PauseConsumer actually stops RTP (kbps → ~0) vs. the stream
// quietly playing in the background. Dev-only; remove once confirmed.
//   In the renderer console:  __videoStats.start()   …   __videoStats.stop()
let videoStatsTimer = null
const videoStatsLast = new Map() // consumerId -> { bytes, ts }

async function logVideoStatsOnce() {
  for (const entry of remoteConsumers.values()) {
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
