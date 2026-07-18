// ─── Imports ────────────────────────────────────────────────────
import { Device } from 'mediasoup-client'
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import { apiBase, wsBase } from './serverConfig'
import { authFetch } from './auth'
import { startScreenAudio, onScreenAudioError } from './screenAudio'

// ─── State ──────────────────────────────────────────────────────
let device
let ws
let producerTransport
let consumerTransport
let producers = []
let localProducerIds = new Set()
let screenShareCtx = null
let shareClaimQueue = Promise.resolve()
let shareProduceQueue = Promise.resolve()
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
const VOICE_REQUEST_TIMEOUT_MS = 15000
let pendingRequestTimer = null

function armPendingRequestTimeout() {
  if (pendingRequestTimer !== null) clearTimeout(pendingRequestTimer)
  pendingRequestTimer = null
  const pending = pendingHandlers[0]
  if (!pending) return

  // Only the queue head is awaiting a response. Later FIFO entries get their
  // full timeout after earlier requests complete instead of expiring while they
  // are merely waiting their turn.
  pendingRequestTimer = setTimeout(() => {
    if (pendingHandlers[0] !== pending) return
    const error = new Error(`Voice request timed out (${pending.type})`)
    rejectPendingRequests(error)
    forceVoiceReconnect(error.message)
  }, VOICE_REQUEST_TIMEOUT_MS)
}

function rejectPendingRequests(error) {
  if (pendingRequestTimer !== null) clearTimeout(pendingRequestTimer)
  pendingRequestTimer = null
  for (const pending of pendingHandlers.splice(0)) {
    pending.reject(error)
  }
}

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
    const pending = {
      type,
      reject,
      handle: (message) => {
        const userError =
          message?.UserError ?? (message?.type === 'UserError' ? message.data : null)
        if (userError != null)
          reject(new Error(typeof userError === 'string' ? userError : 'Request failed'))
        else resolve(message)
      }
    }
    pendingHandlers.push(pending)
    if (pendingHandlers.length === 1) armPendingRequestTimeout()
    const message = data ? { type, data } : { type }
    try {
      ws.send(JSON.stringify(message))
    } catch (err) {
      const index = pendingHandlers.indexOf(pending)
      if (index !== -1) pendingHandlers.splice(index, 1)
      if (index === 0) armPendingRequestTimeout()
      reject(err)
      return
    }
    console.log(`[Soup] Sent: ${type}`, message)
  })
}

// The SFU responds to CloseProducer like every other request, so it must use the
// same FIFO response queue. Sending it fire-and-forget leaves that response to
// satisfy an unrelated later request and corrupts signaling state.
async function closeServerProducer(id) {
  try {
    await send('CloseProducer', { id })
  } catch (err) {
    console.warn(`[Soup] Failed to close server producer ${id}:`, err)
  }
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
      consumeProducer(id, kind, activeCallbacks.onVideoStream, client_id, produced_type).catch(
        (err) => console.error(`[Soup] Failed to consume producer ${id}:`, err)
      )
      return
    }

    // A remote producer we were consuming has closed (e.g. the other
    // client stopped screen sharing) — close our consumer and remove its tile.
    if (message.type === 'ProducerClosed') {
      const { id, replaced = false } = message.data
      const entry = remoteConsumers.get(id)
      if (entry) {
        entry.consumer.close()
        remoteConsumers.delete(id)
        if (entry.cleanup) {
          entry.cleanup()
          remoteCleanups = remoteCleanups.filter((fn) => fn !== entry.cleanup)
        }
        if (entry.kind === 'video') {
          activeCallbacks.onConsumerClosed?.(entry.consumerId, {
            replaced,
            clientId: entry.clientId,
            producedType: entry.producedType
          })
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
      const pending = pendingHandlers.shift()
      armPendingRequestTimeout()
      pending.handle(message)
      return
    }

    console.log('[Soup] Unhandled message:', message)
  }

  socket.onclose = (event) => {
    if (ws !== socket) return // a newer socket has already taken over
    console.log('[Soup] WebSocket disconnected — code:', event.code, 'reason:', event.reason)
    // Reject every waiter before reconnecting. Silently dropping these handlers
    // left callers (including screen-share teardown) pending forever.
    rejectPendingRequests(new Error(`Voice socket closed (${event.code || 'no code'})`))
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
    // Same speech-band metric the speaking detector uses, so the gate opens on the
    // same quiet speech the indicator lights up on. These used to diverge: the gate
    // averaged the full spectrum and cut quiet voices before they were ever sent.
    const { analyser, read } = createSpeechLevelReader(audioContext)
    const gate = audioContext.createGain()
    chainNodes.push(analyser, gate)
    node.connect(analyser)
    analyser.connect(gate)
    node = gate

    const checkLevel = () => {
      // If audio is below threshold, mute; otherwise pass through
      gate.gain.setValueAtTime(
        read() >= micSettings.volumeGateThreshold ? 1 : 0,
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
    } catch {
      // The worklet may already have torn itself down.
    }
    for (const chainNode of chainNodes) {
      try {
        chainNode.disconnect()
      } catch {
        // A partially built or already-stopped chain is safe to ignore.
      }
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

// ─── Shared speech-band level measurement ─────────────────────────
// One place that decides "how loud is the voice right now", shared by the volume
// gate, the self/remote speaking detectors, and the settings meter so all three
// judge voice loudness identically. Returns the analyser to wire into the graph
// plus read() -> current level 0-100.
//
// It measures only the human-speech band (~94 Hz–4 kHz) instead of the full
// 0–24 kHz spectrum: averaging every bin diluted quiet speech across the many
// near-silent high-frequency bins so it never crossed threshold — and the RNNoise
// suppressor made that worse by zeroing those bins. The byte mapping is tuned to
// speech levels too (energy below ~-75 dB, a typical ambient floor, maps to 0), so
// silence reads as silence even with suppression off. fftSize 512 gives ~94 Hz
// bins; bin 0 is skipped (DC/rumble), so the lowest kept bin sits near the low end
// of the voiced range. Bin indices come from the real sample rate.
export function createSpeechLevelReader(audioContext) {
  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 512
  analyser.minDecibels = -75
  analyser.maxDecibels = -25
  analyser.smoothingTimeConstant = 0.5

  const data = new Uint8Array(analyser.frequencyBinCount)
  const binHz = audioContext.sampleRate / analyser.fftSize
  const loBin = Math.max(1, Math.floor(85 / binHz))
  const hiBin = Math.min(data.length - 1, Math.ceil(4000 / binHz))
  const bandBins = hiBin - loBin + 1

  const read = () => {
    analyser.getByteFrequencyData(data)
    let sum = 0
    for (let i = loBin; i <= hiBin; i++) sum += data[i]
    return (sum / bandBins / 255) * 100
  }

  return { analyser, read }
}

// ─── Detect speaking activity on an audio stream ──────────────────
// Returns a stop function. Calls onChange(isSpeaking) whenever the
// speaking state changes, and once more with false on stop.
export function createSpeakingDetector(stream, onChange, { threshold = 12, holdMs = 200 } = {}) {
  if (!stream.getAudioTracks().length) return () => {}

  const audioContext = new (window.AudioContext || window.webkitAudioContext)()
  const source = audioContext.createMediaStreamSource(stream)
  const { analyser, read } = createSpeechLevelReader(audioContext)
  source.connect(analyser)

  let speaking = false
  let lastAbove = 0
  let intervalId

  const tick = () => {
    const level = read()
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
    } catch {
      // Cleanup may run after the context has already disconnected the node.
    }
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
  const ctx = screenShareCtx
  if (!ctx || ctx.type !== 'screen') return

  const audioProducer = ctx.audioProducer
  ctx.audioProducer = null
  if (audioProducer) {
    const audioProducerId = audioProducer.id
    audioProducer.close()
    localProducerIds.delete(audioProducerId)
    void closeServerProducer(audioProducerId)
  }

  const nativeAudio = ctx.nativeAudio
  const audioTrack = ctx.audioTrack
  ctx.nativeAudio = null
  ctx.audioTrack = null
  audioTrack?.stop()
  nativeAudio?.stop().catch(() => {})
  if (isActiveShare(ctx) && ctx.producer) {
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

// Screen share uses a single plain encoding — no scalabilityMode at all.
// Spatial SVC (L2/L3) was dropped first: splitting the budget across layers
// left the full-res image soft (Discord looks sharp at ~4 Mbps with one clean
// stream). Temporal layers (L1T3) went next: hardware encoders reject or
// refuse to register for SVC modes (observed: the D3D12 encoder does plain
// H.264 fine but AV1 'L1T3' fell back to libaom; MediaFoundation H.264 threw
// on 'L1T3' in setParameters) — and since a software-AV1 sender gets
// downgraded to H.264 (no layers) anyway, the layers only ever served
// machines that were about to lose them. Trade-off: no per-viewer fps/res
// tiering for screen shares — setVideoStreamRoles() still pauses hidden
// streams; layer preferences are skipped for consumers that report no layers.

// Ceiling for the single full-resolution screen encoding. Sixty FPS needs more
// bits than 30 FPS, and the H.264 hardware fallback needs more than AV1/VP9 for
// comparable screen-text quality. These remain congestion-control ceilings, not
// forced targets; Transport-CC can send below them on a constrained link.
function screenEncodingFor({ width, height, fps, codec, optimizeFor }) {
  const pixels = Math.max(1, width * height)
  // Scale continuously from the 720p-ish floor through the 1440p ceiling.
  // Exact resolution tiers under-budgeted slightly cropped/aligned windows and
  // ultrawides despite nearly identical (or greater) pixel counts.
  const base = Math.min(12_000_000, Math.max(5_000_000, (8_000_000 * pixels) / (1920 * 1080)))
  const frameRateFactor = fps >= 50 ? 1.45 : 1
  const motionFactor = optimizeFor === 'motion' ? 1.05 : 1
  const mime = codec?.mimeType ?? ''
  const codecFactor = /h264/i.test(mime) ? 1.2 : /vp9/i.test(mime) ? 1.08 : 1
  const maxBitrate = Math.min(
    // The SFU currently caps the aggregate producer transport at 25 Mbps.
    // Leave room for screen audio, microphone audio, and RTX bursts.
    20_000_000,
    Math.round((base * frameRateFactor * motionFactor * codecFactor) / 250_000) * 250_000
  )
  return { maxBitrate, maxFramerate: Math.max(1, Math.round(fps)) }
}

// A video codec from the loaded device's sending capabilities, by mime type.
// The codec passed to produce() MUST come from sendRtpCapabilities: the legacy
// rtpCapabilities getter aliases the receiving capabilities, whose H.264 profile
// variants may not match what this device can send. undefined (no match)
// preserves mediasoup's default (first router codec).
function findVideoCodec(mime) {
  return device?.sendRtpCapabilities?.codecs?.find(
    (c) => c.kind === 'video' && c.mimeType?.toLowerCase() === mime
  )
}

// Set once a share's measured encoder came up software for AV1/VP9 (see
// maybeDowngradeScreenCodec): future shares then start on H.264 directly instead
// of re-running ~9s of libaom pain each time. This is the capability check —
// driven by the encoder the machine actually produced, not GPU-model sniffing.
// ponytail: sticky once set; cleared by resetScreenCodecPreference() when the
// encoder landscape changes (e.g. the hardware-acceleration toggle) so AV1 is
// re-probed.
const SCREEN_H264_KEY = 'screenPreferH264'

// Forget a persisted "AV1 is software here → use H.264" verdict so the next
// share re-probes AV1 from scratch. Call when something that changes which
// encoders exist has changed — notably toggling hardware acceleration, after
// which AV1 that was software may now be hardware (or vice-versa).
export function resetScreenCodecPreference() {
  localStorage.removeItem(SCREEN_H264_KEY)
}

// Screen share: AV1 for efficiency (Discord-level sharpness at lower bitrate,
// one plain encoding — see the SVC note above screenEncodingFor), VP9 fallback.
// Whether AV1 encodes in
// hardware or software can't be known up front (mediaCapabilities.encodingInfo
// lies on Windows — reports AV1 powerEfficient even when the WebRTC encoder is
// libaom), so the first share probes it: getStats names the real encoder ~3s in,
// and a software result downgrades the share to H.264 and persists the choice
// (SCREEN_H264_KEY) so later shares skip the probe.
function pickVideoCodec() {
  if (localStorage.getItem(SCREEN_H264_KEY) === '1') {
    return findVideoCodec('video/h264') ?? findVideoCodec('video/vp9')
  }
  return findVideoCodec('video/av1') ?? findVideoCodec('video/vp9')
}

// Webcam prefers H.264: it's almost always hardware-encoded (low CPU/battery for
// a live camera) and fine for low-res motion. Trade-off vs VP9/AV1: H.264 has no
// spatial SVC, so unfocused/thumbnail camera tiles can only drop frames
// (temporal), not resolution — see logNegotiatedVideoCodec's warning. Falls back
// to VP9/AV1 (full spatial tiering) when the router doesn't advertise H.264.
function pickCameraCodec() {
  return findVideoCodec('video/h264') ?? findVideoCodec('video/vp9') ?? findVideoCodec('video/av1')
}

// Short codec name (e.g. 'AV1', 'VP9', 'H264') from a producer/consumer's
// rtpParameters, skipping the rtx retransmission codec. Feeds the UI codec badge.
function codecLabel(rtpParameters) {
  const mime = rtpParameters?.codecs?.find(
    (c) => !c.mimeType?.toLowerCase().endsWith('/rtx')
  )?.mimeType
  return mime?.split('/')[1]
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

// getStats' encoderImplementation names the actual encoder. These substrings are
// Chromium's SOFTWARE encoders (libaom = SW AV1, libvpx = SW VP9/VP8, openh264 =
// SW H264); any other non-empty implementation is hardware/accelerated. This is
// how we tell a real HW AV1 encode from the software-AV1 fallback that pickVideoCodec
// tries to avoid — the codec name alone can't. 'unknown'/empty = not determined yet.
// ponytail: substring match; if a new SW encoder name appears (chrome://webrtc-
// internals → encoderImplementation), add it here.
const SOFTWARE_ENCODER_RE = /libaom|libvpx|openh264/i
function encoderIsHardware(impl) {
  if (!impl || impl === 'unknown') return null
  return !SOFTWARE_ENCODER_RE.test(impl)
}

// Poll the video sender's outbound-rtp stats every 3s and report to onStats:
// codec + whether the encoder is hardware or software (encoderImplementation, e.g.
// 'libaom' = software AV1) for the sharer's HW/SW tile badge, and qualityLimitationReason
// ('cpu' = the encoder can't keep up) which drives maybeDowngradeScreenCodec. The
// live equivalent of chrome://webrtc-internals; also logged in dev. Returns a stop
// function; only the most recent share is polled.
let encoderStatsStop = null
function startEncoderStatsLog(producer, onStats) {
  encoderStatsStop?.()
  const sender = producer.rtpSender
  if (!sender?.getStats) return
  let prev = null
  const id = setInterval(async () => {
    try {
      const stats = await sender.getStats()
      let fallbackRemoteInbound = null
      const remoteInboundByLocalId = new Map()
      let candidatePair = null
      for (const report of stats.values()) {
        if (report.type === 'remote-inbound-rtp') {
          fallbackRemoteInbound ??= report
          if (report.localId) remoteInboundByLocalId.set(report.localId, report)
        } else if (
          report.type === 'candidate-pair' &&
          report.state === 'succeeded' &&
          report.nominated
        ) {
          candidatePair = report
        }
      }

      for (const s of stats.values()) {
        // Chromium may expose a separate outbound RTX report. It has kind=video
        // but no encoded frames; mixing it into the primary report corrupts all
        // byte/frame deltas and can trigger a false codec downgrade.
        if (s.type !== 'outbound-rtp' || s.kind !== 'video' || s.framesEncoded == null) continue
        // ms of encoder time per encoded frame — the clearest HW-vs-SW signal
        // besides the implementation name (software AV1 sits an order of
        // magnitude above hardware).
        const encodeMsPerFrame =
          prev && s.framesEncoded > prev.framesEncoded
            ? ((s.totalEncodeTime - prev.totalEncodeTime) * 1000) /
              (s.framesEncoded - prev.framesEncoded)
            : null
        const elapsedMs = prev ? s.timestamp - prev.timestamp : 0
        const sendKbps =
          prev && elapsedMs > 0 ? (8 * ((s.bytesSent ?? 0) - prev.bytesSent)) / elapsedMs : null
        const remoteInbound = remoteInboundByLocalId.get(s.id) ?? fallbackRemoteInbound
        const rttMs =
          remoteInbound?.roundTripTime != null ? remoteInbound.roundTripTime * 1000 : null
        prev = {
          totalEncodeTime: s.totalEncodeTime ?? 0,
          framesEncoded: s.framesEncoded ?? 0,
          bytesSent: s.bytesSent ?? 0,
          timestamp: s.timestamp
        }
        if (import.meta.env.DEV) {
          console.log(
            `[Soup] encoder: ${s.encoderImplementation ?? '?'} | limited by: ` +
              `${s.qualityLimitationReason ?? '?'} | ${s.frameWidth ?? '?'}x${s.frameHeight ?? '?'}` +
              `@${Math.round(s.framesPerSecond ?? 0)}fps` +
              (encodeMsPerFrame != null ? ` | ${encodeMsPerFrame.toFixed(1)}ms/frame` : '') +
              (sendKbps != null ? ` | ${sendKbps.toFixed(0)}kbps` : '') +
              (rttMs != null ? ` | RTT ${rttMs.toFixed(0)}ms` : '')
          )
        }
        onStats?.({
          codec: codecLabel(producer.rtpParameters),
          implementation: s.encoderImplementation,
          hardware: encoderIsHardware(s.encoderImplementation),
          qualityLimitationReason: s.qualityLimitationReason,
          width: s.frameWidth,
          height: s.frameHeight,
          fps: s.framesPerSecond,
          encodeMsPerFrame,
          sendKbps,
          packetsSent: s.packetsSent,
          retransmittedPacketsSent: s.retransmittedPacketsSent,
          nackCount: s.nackCount,
          pliCount: s.pliCount,
          rttMs,
          packetsLost: remoteInbound?.packetsLost,
          fractionLost: remoteInbound?.fractionLost,
          availableOutgoingBitrate: candidatePair?.availableOutgoingBitrate
        })
      }
    } catch {
      // getStats can reject transiently around teardown — ignore.
    }
  }, 3000)
  const stop = () => {
    clearInterval(id)
    if (encoderStatsStop === stop) encoderStatsStop = null
  }
  encoderStatsStop = stop
  return stop
}

// ─── Adaptive screen-share codec downgrade ───────────────────────
// The share starts on AV1 (best quality-per-bit when hardware-encoded); the first
// stats sample (~3s) names the encoder the machine actually produced. Software
// AV1/VP9 (libaom/libvpx — the heaviest encoders Chromium ships) downgrades to
// H.264 immediately and persists the choice (SCREEN_H264_KEY): H.264 is hardware
// via MediaFoundation where the GPU process supports it, else openh264, the
// cheapest software encoder. A hardware encoder only downgrades under sustained
// cpu limitation. We re-produce ONCE, reusing the live capture track so the user
// doesn't re-pick a source. The SFU already tolerates a brief two-producer overlap
// (see consumeProducer's stale-consumer cleanup), so we produce the replacement
// before closing the original — a failed downgrade leaves the AV1 share running
// rather than killing it.
const CPU_STRIKES_TO_DOWNGRADE = 3 // ~3 polls × 3s ≈ 9s of sustained cpu limiting

function enqueueShareClaim(operation) {
  const result = shareClaimQueue.then(operation, operation)
  shareClaimQueue = result.catch(() => {})
  return result
}

function enqueueShareProduce(operation) {
  const result = shareProduceQueue.then(operation, operation)
  shareProduceQueue = result.catch(() => {})
  return result
}

function shareSupersededError() {
  const error = new Error('Screen share request was superseded')
  error.code = 'SCREEN_SHARE_SUPERSEDED'
  return error
}

function isShareSupersededError(error) {
  return error?.code === 'SCREEN_SHARE_SUPERSEDED'
}

function isActiveShare(ctx) {
  return screenShareCtx === ctx && !ctx.stopped
}

// Serialize mediasoup produce operations for the single local video-share slot.
// If ownership changes during the await, close only the producer just created;
// never call a global teardown that could belong to the successor share.
function produceForShare(ctx, options) {
  return enqueueShareProduce(async () => {
    if (!isActiveShare(ctx)) throw shareSupersededError()
    const producer = await ctx.transport.produce(options)
    if (!isActiveShare(ctx)) {
      producer.close()
      await closeServerProducer(producer.id)
      throw shareSupersededError()
    }
    return producer
  })
}

async function stopShareContext(ctx, { notifyServer = true } = {}) {
  if (!ctx || ctx.stopped) return ctx?.stopPromise
  ctx.stopped = true
  if (screenShareCtx === ctx) screenShareCtx = null

  ctx.statsStop?.()
  ctx.statsStop = null

  const videoProducer = ctx.producer
  const audioProducer = ctx.audioProducer
  ctx.producer = null
  ctx.audioProducer = null

  const producerIds = []
  if (videoProducer) {
    videoProducer.close()
    localProducerIds.delete(videoProducer.id)
    producerIds.push(videoProducer.id)
  }
  if (audioProducer) {
    audioProducer.close()
    localProducerIds.delete(audioProducer.id)
    producerIds.push(audioProducer.id)
  }

  const ownedTracks = new Set(ctx.stream?.getTracks?.() ?? [])
  if (ctx.track) ownedTracks.add(ctx.track)
  if (ctx.audioTrack) ownedTracks.add(ctx.audioTrack)
  const nativeAudio = ctx.nativeAudio
  ctx.stream = null
  ctx.track = null
  ctx.audioTrack = null
  ctx.nativeAudio = null
  for (const track of ownedTracks) track.stop()

  if (notifyServer) void Promise.all(producerIds.map((id) => closeServerProducer(id)))

  ctx.stopPromise = (async () => {
    if (!nativeAudio) return
    await nativeAudio
      .stop()
      .catch((error) =>
        console.warn('[Soup] Failed to stop owned native screen audio cleanly:', error)
      )
  })()
  return ctx.stopPromise
}

function claimShareContext(ctx) {
  return enqueueShareClaim(async () => {
    if (screenShareCtx) await stopShareContext(screenShareCtx)
    screenShareCtx = ctx
  })
}

// Composed stats sink for the screen producer: feeds the UI badge and the downgrade.
function screenStatsHandler(ctx, stats) {
  if (!isActiveShare(ctx)) return
  ctx.onEncoderStats?.(stats)
  maybeDowngradeScreenCodec(ctx, stats)
}

async function maybeDowngradeScreenCodec(ctx, stats) {
  if (!isActiveShare(ctx) || ctx.downgraded || !ctx.producer) return
  const current = ctx.producer.rtpParameters?.codecs?.[0]?.mimeType ?? ''
  if (/h264/i.test(current)) return // already on the lightest codec

  const softwareEncoder = stats.hardware === false
  if (softwareEncoder) {
    // Verified software AV1/VP9 is never worth keeping — downgrade now.
    ctx.cpuStrikes = CPU_STRIKES_TO_DOWNGRADE
  } else {
    // Hardware (or not-yet-known) encoder: only downgrade under sustained cpu
    // limitation. Decay rather than reset — a loaded encoder oscillates between
    // 'cpu' and 'bandwidth', and a hard reset let that oscillation dodge the
    // downgrade forever.
    ctx.cpuStrikes =
      stats.qualityLimitationReason === 'cpu' ? ctx.cpuStrikes + 1 : Math.max(0, ctx.cpuStrikes - 1)
  }
  if (ctx.cpuStrikes < CPU_STRIKES_TO_DOWNGRADE) return
  ctx.downgraded = true // commit — win or lose, don't re-evaluate

  const h264 = findVideoCodec('video/h264')
  if (!h264) return // nothing lighter to switch to

  const previous = ctx.producer
  const oldId = previous.id
  try {
    // No scalabilityMode on H.264: MediaFoundation hardware encoders reject
    // 'L1T3' in setParameters, breaking setDegradationPreference below.
    const next = await produceForShare(ctx, {
      track: ctx.track,
      codec: h264,
      encodings: [
        screenEncodingFor({
          width: ctx.width,
          height: ctx.height,
          fps: ctx.fps,
          codec: h264,
          optimizeFor: ctx.optimizeFor
        })
      ],
      // Same shared-track rule as shareScreen: closing a producer must never
      // stop the capture track (stopScreenShare owns that).
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 2500 },
      appData: { produced: 'ScreenShare' }
    })

    previous.close()
    localProducerIds.delete(oldId)
    // Producing the same ScreenShare media type atomically replaces the old
    // server producer; asking the SFU to close oldId now would return NotFound
    // and used to poison the response FIFO.
    ctx.producer = next
    localProducerIds.add(next.id)
    // Only a measured-software encoder proves the machine can't accelerate
    // AV1/VP9 — remember that so pickVideoCodec() starts future shares on
    // H.264 directly. A hardware encoder that got cpu-limited stays probe-able.
    if (softwareEncoder) localStorage.setItem(SCREEN_H264_KEY, '1')
    await setDegradationPreference(
      next,
      ctx.optimizeFor === 'motion' ? 'maintain-framerate' : 'maintain-resolution'
    )
    if (!isActiveShare(ctx) || ctx.producer !== next) return
    ctx.statsStop = startEncoderStatsLog(next, (nextStats) => screenStatsHandler(ctx, nextStats))
    console.log(
      `[Soup] Screen codec downgraded to H264 (${softwareEncoder ? 'software encoder' : 'cpu limited'}) [id:${next.id}]`
    )
  } catch (err) {
    if (isShareSupersededError(err)) return
    console.warn('[Soup] Screen codec downgrade failed; staying on AV1:', err)
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
  audio = undefined,
  // Fires with { implementation, hardware } from encoder stats, ~3s after the
  // share starts, so the caller can show HW/SW on the self tile.
  onEncoderStats = undefined
} = {}) {
  if (!producerTransport) throw new Error('Not connected to voice')
  if (audio !== undefined && audioMode === 'none' && audio) audioMode = 'system-legacy'

  // Claim ownership before getDisplayMedia. A Stop/new share during the picker
  // invalidates this context; when the old prompt eventually resolves it can
  // release only its own returned tracks without touching the successor.
  const ctx = {
    type: 'screen',
    transport: producerTransport,
    stream: null,
    track: null,
    audioTrack: null,
    nativeAudio: null,
    producer: null,
    audioProducer: null,
    statsStop: null,
    stopPromise: null,
    stopped: false,
    width,
    height,
    fps,
    optimizeFor,
    onEncoderStats,
    cpuStrikes: 0,
    downgraded: false
  }
  await claimShareContext(ctx)

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: { ideal: fps, max: fps },
        width: { ideal: width, max: width },
        height: { ideal: height, max: height }
      },
      audio: audioMode === 'system-legacy'
    })

    if (!isActiveShare(ctx)) {
      stream.getTracks().forEach((ownedTrack) => ownedTrack.stop())
      throw shareSupersededError()
    }
    ctx.stream = stream

    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('The selected source did not provide a video track')
    ctx.track = track
    track.onended = () => {
      void stopShareContext(ctx)
    }
    track.contentHint = optimizeFor === 'motion' ? 'motion' : 'detail'

    const settings = track.getSettings()
    ctx.width = settings.width > 0 ? settings.width : width
    ctx.height = settings.height > 0 ? settings.height : height
    ctx.fps = settings.frameRate > 0 ? Math.min(settings.frameRate, fps) : fps
    const screenCodec = pickVideoCodec()
    const screenEncoding = screenEncodingFor({
      width: ctx.width,
      height: ctx.height,
      fps: ctx.fps,
      codec: screenCodec,
      optimizeFor
    })
    console.log(
      `[Soup] Screen capture selected ${ctx.width}x${ctx.height}@${ctx.fps}fps, ` +
        `ceiling ${Math.round(screenEncoding.maxBitrate / 1000)}kbps`
    )

    const videoProducer = await produceForShare(ctx, {
      track,
      // Request the codec explicitly: AV1, else VP9 — or H.264 once the probe
      // learned AV1 is software here (see pickVideoCodec). One plain encoding,
      // no scalabilityMode (see the SVC note above screenEncodingFor).
      codec: screenCodec,
      encodings: [screenEncoding],
      // The adaptive downgrade re-produces this SAME track, so producers must
      // not stop it on close() (the default stopTracks:true killed the
      // replacement producer — black stream at 0fps).
      stopTracks: false,
      codecOptions: { videoGoogleStartBitrate: 2500 },
      appData: { produced: 'ScreenShare' }
    })
    ctx.producer = videoProducer
    localProducerIds.add(videoProducer.id)
    logNegotiatedVideoCodec(videoProducer)

    await setDegradationPreference(
      videoProducer,
      optimizeFor === 'motion' ? 'maintain-framerate' : 'maintain-resolution'
    )
    if (!isActiveShare(ctx) || ctx.producer !== videoProducer || track.readyState === 'ended') {
      throw shareSupersededError()
    }

    ctx.statsStop = startEncoderStatsLog(videoProducer, (stats) => screenStatsHandler(ctx, stats))
    console.log(`[Soup] Screen sharing [id:${videoProducer.id}]`)

    // Screenshare audio: native capture for per-app/system modes, or the legacy
    // loopback track riding getDisplayMedia. Audio failure keeps video live.
    let audioTrack = null
    let nativeAudio = null
    if (audioMode === 'system-legacy') {
      audioTrack = stream.getAudioTracks()[0] ?? null
      if (!audioTrack) {
        const message = 'The selected capture source did not provide a system-audio track'
        console.error(`[Soup] ${message}; sharing video-only`)
        activeCallbacks.onScreenAudioError?.(message)
      }
    } else if (audioMode !== 'none') {
      try {
        nativeAudio = await startScreenAudio({
          mode: audioMode,
          targets: audioTargets ?? undefined
        })
        if (!isActiveShare(ctx)) {
          await nativeAudio.stop().catch(() => {})
          throw shareSupersededError()
        }
        ctx.nativeAudio = nativeAudio
        audioTrack = nativeAudio.track
        console.log(`[Soup] Native screen audio capture started [backend:${nativeAudio.backend}]`)
      } catch (err) {
        if (isShareSupersededError(err) || !isActiveShare(ctx)) throw shareSupersededError()
        console.error('[Soup] Native screen audio failed, sharing video-only:', err)
        activeCallbacks.onScreenAudioError?.(err.message)
      }
    }

    if (audioTrack) {
      ctx.audioTrack = audioTrack
      try {
        audioTrack.contentHint = 'music'
        const audioProducer = await produceForShare(ctx, {
          track: audioTrack,
          // Stereo + a real bitrate: captured app/system audio is music/media,
          // not speech, and the old mono default audibly degraded it.
          codecOptions: {
            opusStereo: true,
            opusDtx: false,
            opusFec: true,
            opusMaxAverageBitrate: 160000,
            opusPtime: 20
          },
          encodings: [{ maxBitrate: 160000 }],
          appData: { produced: 'ScreenShareAudio' }
        })

        if (audioTrack.readyState === 'ended') {
          const failureAlreadyReported = ctx.audioTrack !== audioTrack
          audioProducer.close()
          await closeServerProducer(audioProducer.id)
          if (ctx.audioTrack === audioTrack) ctx.audioTrack = null
          if (ctx.nativeAudio === nativeAudio) ctx.nativeAudio = null
          audioTrack.stop()
          await nativeAudio?.stop().catch(() => {})
          if (!isActiveShare(ctx)) throw shareSupersededError()
          const message = 'Screen audio capture ended while starting'
          console.error(`[Soup] ${message}; sharing video-only`)
          if (!failureAlreadyReported) activeCallbacks.onScreenAudioError?.(message)
        } else {
          ctx.audioProducer = audioProducer
          localProducerIds.add(audioProducer.id)
          audioTrack.addEventListener(
            'ended',
            () => {
              if (!isActiveShare(ctx) || ctx.audioTrack !== audioTrack) return
              ctx.audioTrack = null
              if (ctx.nativeAudio === nativeAudio) ctx.nativeAudio = null
              if (ctx.audioProducer === audioProducer) ctx.audioProducer = null
              audioProducer.close()
              localProducerIds.delete(audioProducer.id)
              void closeServerProducer(audioProducer.id)
              void nativeAudio?.stop().catch(() => {})
              if (isActiveShare(ctx) && ctx.producer) {
                activeCallbacks.onScreenAudioError?.('Screen audio capture ended')
              }
            },
            { once: true }
          )
          console.log(`[Soup] Screen audio sharing [id:${audioProducer.id}]`)
        }
      } catch (err) {
        if (isShareSupersededError(err) || !isActiveShare(ctx)) throw shareSupersededError()
        const failureAlreadyReported = ctx.audioTrack !== audioTrack
        if (ctx.audioTrack === audioTrack) ctx.audioTrack = null
        if (ctx.nativeAudio === nativeAudio) ctx.nativeAudio = null
        audioTrack.stop()
        await nativeAudio
          ?.stop()
          .catch((stopErr) =>
            console.warn('[Soup] Failed to stop owned screen audio after produce failure:', stopErr)
          )
        if (!isActiveShare(ctx)) throw shareSupersededError()
        console.error('[Soup] Screen audio produce failed, sharing video-only:', err)
        if (!failureAlreadyReported) activeCallbacks.onScreenAudioError?.(err.message)
      }
    }

    if (!isActiveShare(ctx) || !ctx.producer) throw shareSupersededError()

    // Local preview is video-only; playing captured audio locally would echo it.
    const previewStream = new MediaStream([track])
    return {
      id: ctx.producer.id,
      stream: previewStream,
      codec: codecLabel(ctx.producer.rtpParameters),
      stop: () => stopShareContext(ctx)
    }
  } catch (err) {
    await stopShareContext(ctx)
    throw err
  }
}

// ─── Share webcam ────────────────────────────────────────────────
// Streams a camera device into the same producer slot as screen share, so the
// existing stop/preview/remote-render paths all apply. Unlike screen share,
// the webcam carries no audio and uses the device's own native quality - the
// fps/resolution/audio picker settings don't apply here.
export async function shareCamera(deviceId, onEncoderStats) {
  if (!producerTransport) throw new Error('Not connected to voice')
  const ctx = {
    type: 'camera',
    transport: producerTransport,
    stream: null,
    track: null,
    audioTrack: null,
    nativeAudio: null,
    producer: null,
    audioProducer: null,
    statsStop: null,
    stopPromise: null,
    stopped: false
  }
  await claimShareContext(ctx)

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: deviceId ? { deviceId: { exact: deviceId } } : true,
      audio: false
    })
    if (!isActiveShare(ctx)) {
      stream.getTracks().forEach((ownedTrack) => ownedTrack.stop())
      throw shareSupersededError()
    }
    ctx.stream = stream

    const track = stream.getVideoTracks()[0]
    if (!track) throw new Error('The selected camera did not provide a video track')
    ctx.track = track
    track.onended = () => {
      void stopShareContext(ctx)
    }
    track.contentHint = 'motion'

    // H.264 gets NO scalabilityMode (MediaFoundation hardware encoders reject
    // 'L1T3' in setParameters); VP9/AV1 fallbacks keep spatial+temporal layers.
    const cameraCodec = pickCameraCodec()
    const cameraScalabilityMode = /h264/i.test(cameraCodec?.mimeType ?? '')
      ? undefined
      : VIDEO_SCALABILITY_MODE
    const cameraProducer = await produceForShare(ctx, {
      track,
      codec: cameraCodec,
      encodings: [
        {
          maxBitrate: 6_000_000,
          ...(cameraScalabilityMode ? { scalabilityMode: cameraScalabilityMode } : {})
        }
      ],
      codecOptions: { videoGoogleStartBitrate: 2500 },
      appData: { produced: 'Camera' }
    })
    ctx.producer = cameraProducer
    localProducerIds.add(cameraProducer.id)
    logNegotiatedVideoCodec(cameraProducer, cameraScalabilityMode)

    await setDegradationPreference(cameraProducer, 'maintain-framerate')
    if (!isActiveShare(ctx) || ctx.producer !== cameraProducer) throw shareSupersededError()
    ctx.statsStop = startEncoderStatsLog(cameraProducer, onEncoderStats)
    console.log(`[Soup] Camera sharing [id:${cameraProducer.id}]`)

    const previewStream = new MediaStream([track])
    return {
      id: cameraProducer.id,
      stream: previewStream,
      codec: codecLabel(cameraProducer.rtpParameters),
      stop: () => stopShareContext(ctx)
    }
  } catch (err) {
    await stopShareContext(ctx)
    throw err
  }
}

// ─── Stop screen share ───────────────────────────────────────────
export async function stopScreenShare() {
  return enqueueShareClaim(async () => {
    const ctx = screenShareCtx
    if (!ctx) return
    await stopShareContext(ctx)
    console.log('[Soup] Screen share stopped')
  })
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
    rtp_params: device.recvRtpCapabilities
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

  const encodings = consumer.rtpParameters?.encodings ?? []
  const hasSelectableLayers =
    encodings.length > 1 ||
    encodings.some((encoding) => {
      const match = /^L(\d+)T(\d+)/i.exec(encoding.scalabilityMode ?? '')
      return match && (Number(match[1]) > 1 || Number(match[2]) > 1)
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
      } catch {
        // The media source may already be disconnected during transport reset.
      }
      try {
        gainNode.disconnect()
      } catch {
        // The gain node may already be disconnected during transport reset.
      }
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
        activeCallbacks.onConsumerClosed?.(entry.consumerId, {
          replaced: true,
          clientId: entry.clientId,
          producedType: entry.producedType
        })
        break
      }
    }
    onStream?.({
      stream,
      kind,
      consumerId: consumer.id,
      clientId,
      codec: codecLabel(consumer.rtpParameters)
    })
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
    ...(kind === 'video' ? { serverPaused: true, viewRole: 'hidden', hasSelectableLayers } : {})
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
// All three must send a response, since send() awaits one.
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
  if (!entry.hasSelectableLayers) return
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
      // Set the forwarding tier while still paused, then resume. Requests are
      // serialized by the signaling FIFO, so a layered consumer cannot briefly
      // burst at its default highest layer before the preference takes effect.
      setConsumerPreferredLayers(entry, VIEW_LAYERS[role])
      resumeVideoConsumer(entry) // no-op unless server-paused
    }
  }
}

// ─── Reset all media state ───────────────────────────────────────
export function resetMediaState() {
  selfSpeakingStop?.()
  selfSpeakingStop = null
  const activeShare = screenShareCtx
  if (activeShare) void stopShareContext(activeShare, { notifyServer: false })
  producerTransport?.close()
  producerTransport = null
  consumerTransport?.close()
  consumerTransport = null
  encoderStatsStop?.()
  producers = []
  localProducerIds.clear()
  device = null
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
  if (clientId != null && playbackContext?.state === 'suspended') {
    playbackContext.resume().catch(() => {})
  }
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
