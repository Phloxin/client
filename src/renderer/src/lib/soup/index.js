// ─── Imports ────────────────────────────────────────────────────
import { Device, parseScalabilityMode } from 'mediasoup-client'
import { apiBase, voiceSocketUrl } from '../serverConfig'
import { authFetch } from '../auth'
import { recoverMicRepublish, runBeforeServerProduce } from '../mediaRecovery'
import {
  buildMicOpusOptions,
  micAudioProfileKey,
  micSettingsForPublishedStream
} from '../micAudioProfile'
import { isProducerWatched, resolveWatchIntent } from '../watchIntent'
import { micCaptureKey } from '../micRepublishScope'
import {
  allKnownAudioConsumersReady,
  isConsumerClosedEvent,
  isPermanentMicError,
  nextAudioConsumeRetryDelay,
  voiceRequestError,
  voiceSocketRecoveryAction
} from '../voiceRecoveryState'
import { createSerialQueue } from '../serialQueue'
import { codecLabel, jitterBufferAvgMs } from '../streamStats'
import {
  acquireMicCapture,
  buildAudioProcessor,
  createSpeakingDetector,
  stopRawStream,
  suspendMicContext
} from './localAudio'
import {
  applyAllAudioState,
  buildAudioGraph,
  configurePlayback,
  getPlaybackContext,
  resetFocusedScreenAudio,
  teardownAudioGraph
} from './playback'
import {
  configureScreenShare,
  getScreenShareContext,
  resetActiveScreenShare,
  stopScreenEncoderStats
} from './screenShare'
import { configureStreamDiagnostics } from './streamDiagnostics'

export {
  acquireMicCapture,
  createLevelGateController,
  createMicLevelMonitor,
  createSpeakingDetector,
  setVolumeGateThreshold
} from './localAudio'
export {
  getClientAudioState,
  setClientAudioState,
  setFocusedScreenAudio,
  setMasterVolume,
  setOutputDevice,
  setSoundMuted
} from './playback'
export {
  resetCameraCodecPreference,
  resetScreenCodecPreference,
  shareCamera,
  shareScreen,
  stopScreenShare
} from './screenShare'
export { startStreamDebugStats } from './streamDiagnostics'

// ─── State ──────────────────────────────────────────────────────
let device
// Device loading is shared by the send and receive paths.  Keep it single-flight
// per media generation so replayed NewProducer messages cannot race the mic
// publish and install two different Device instances.
let deviceLoadInFlight = null // { generation, promise }
let ws
let producerTransport
let consumerTransport
let producers = []
let localProducerIds = new Set()
// ICE servers from the server's Authenticated reply; transports are only
// created after auth, so this is always populated before use.
let iceServers = []
// Stop function for the active local audio processing chain (mono fold plus
// optional RNNoise / volume gate). Tears down its nodes and analysis loop; null
// when no chain is active.
let audioProcessorStop = null
// The raw getUserMedia capture backing the current audio producer. Voice is
// always published through a separate mono processing track, so this handle is
// the only way to release the OS mic. Held until the producer it feeds is torn
// down or its track is replaced.
let rawMicStream = null
// The last capture configuration that was successfully committed to the live
// audio producer(s). Republish must be able to reopen this profile after it has
// released the old capture and a candidate gUM/processing/produce operation
// fails; otherwise the old producer can be left holding an ended track.
let lastCommittedMicSettings = null
// The Opus profile key committed to the live audio producer(s). Every commit
// path stamps the same key onto all audio producers in one transaction, so a
// single module value is enough to detect a profile change on republish.
let lastCommittedAudioProfile = null
// Self speaking detector, owned here rather than by a channel component so it
// survives ownership changes: a moderator move rebinds onClientSpeaking to the new
// channel, and the detector reports our own speaking through that live callback.
let selfSpeakingStop = null
// Separate detector on the processing chain's output node (stays live while
// muted, unlike the published track), used to warn when we talk while muted.
// Its handler is set from the UI layer.
let mutedTalkStop = null
let onTalkingWhileMuted = null
let lastTalkingWhileMutedAt = 0
// The warning is a toast plus a chime, so it nags rather than informs if it
// repeats every couple of seconds. Long enough that continuous talking gets
// re-warned occasionally; the count resets on each fresh mute (setMicMuted).
const TALKING_WHILE_MUTED_COOLDOWN_MS = 10_000
let localClientId = null
// Set while a publish() is mid-flight so a concurrent caller joins the same
// promise instead of allocating a second producer transport (the server rejects a
// duplicate). Both the reset-driven republish and an adopt() can race here.
// { generation, promise }.  A publish started before a reset is never allowed
// to satisfy callers in the new media session.
let publishInFlight = null
// Republish serializes the entire capture -> processing -> producer update
// transaction. The mic-acquisition queue alone only protects getUserMedia; without this
// queue, rapid settings changes can replace tracks out of order.
const enqueueRepublish = createSerialQueue()
// Invalidates republish work that was queued or awaiting media after a reset.
// A stale operation must not attach its capture to a newly-created transport.
let mediaStateGeneration = 0
let subscribePromise = null
let activeCallbacks = {}
let micMuted = false
// Tracks remote consumers by the producer id they're consuming, so they
// can be closed and removed when that producer goes away (either because
// a new one replaces it, or the server tells us it closed).
let remoteConsumers = new Map()

configurePlayback({
  getRemoteConsumers: () => remoteConsumers,
  onClientSpeaking: (clientId, isSpeaking) =>
    activeCallbacks.onClientSpeaking?.(clientId, isSpeaking)
})
configureScreenShare({
  getDevice: () => device,
  getProducerTransport: () => producerTransport,
  getCallbacks: () => activeCallbacks,
  closeServerProducer,
  localProducerIds
})
configureStreamDiagnostics({
  getProducerTransport: () => producerTransport,
  getProducers: () => producers,
  getScreenShareContext,
  getRemoteConsumers: () => remoteConsumers
})

// ─── Inbound audio health monitoring / self-heal ─────────────────
// A remote voice's receive path can degrade over time (jitter buffer bloat or a
// stalled playout FIFO), leaving audio delayed/crackling until the remote peer
// leaves and rejoins. We poll each audio consumer's WebRTC stats and repair it
// automatically: a local Web Audio graph rebuild when the bloat is in the
// playout path, or a full re-consume when it's in the receiver's jitter buffer.
const AUDIO_HEALTH_INTERVAL_MS = 5000
const AUDIO_HEALTH_BAD_DELAY_SEC = 0.4 // windowed avg delay considered pathological
const AUDIO_HEALTH_STRIKES = 2 // consecutive bad windows before acting
const AUDIO_HEAL_BASE_COOLDOWN_MS = 30_000
const AUDIO_HEAL_MAX_COOLDOWN_MS = 300_000
let audioHealthTimer = null
// producerId -> { lastHealAt, cooldownMs }. Lives OUTSIDE the consumer entry so
// a full re-consume (which replaces the entry) cannot reset the backoff.
const audioHealHistory = new Map()
// producerIds whose full re-consume is in flight, so a later tick doesn't fire a
// second overlapping heal for the same producer.
const audioHealsInFlight = new Set()

// ─── Reconnection state ──────────────────────────────────────────
// The voice socket can't "resume": when it drops, the server tears down our
// transports and removes us from the channel. Recovery is a full re-establish —
// re-assert channel membership (which mints a fresh ticket), reconnect, re-publish —
// driven here with capped exponential backoff + jitter (matches the events
// socket). Remote streams come back on their own: a fresh auth makes the server
// replay NewProducer for everyone in the channel.
const VOICE_RECONNECT_BASE_DELAY_MS = 1000
const VOICE_RECONNECT_MAX_DELAY_MS = 30000
const VOICE_AUTH_TIMEOUT_MS = 15000
let reconnectAttempts = 0
let reconnectTimer = null
let reconnectInFlight = false // an attempt is mid-flight; don't start a second
let intentionalClose = false // set by disconnect() so onclose won't reconnect
let everAuthenticated = false // only auto-reconnect drops that follow a real auth
// Invalidates a ticket fetch/socket open that outlives disconnect followed by a
// new join. Without this, the old single-use ticket can install a stale socket
// after the new session has already cleared intentionalClose.
let voiceConnectionGeneration = 0
let currentSocketCloseHandler = null
let socketCloseDeadlineTimer = null
let mediaWatchdogTimer = null
let mediaReadyTimer = null
let mediaWatchdogRecoveryUsed = false
const MEDIA_WATCHDOG_DELAY_MS = 15000
const MEDIA_READY_SETTLE_MS = 300
const TRANSPORT_DISCONNECTED_GRACE_MS = 8000

function clearMediaWatchdog() {
  if (mediaWatchdogTimer != null) clearTimeout(mediaWatchdogTimer)
  mediaWatchdogTimer = null
}

function clearMediaReadyTimer() {
  if (mediaReadyTimer != null) clearTimeout(mediaReadyTimer)
  mediaReadyTimer = null
}

function emitMediaState(state, details = {}) {
  activeCallbacks.onMediaState?.({ state, generation: mediaStateGeneration, ...details })
}

function remoteAudioIsReady() {
  return (
    (knownAudioProducers.size === 0 ||
      (!consumerTransport?.closed && consumerTransport?.connectionState === 'connected')) &&
    allKnownAudioConsumersReady(knownAudioProducers.keys(), remoteConsumers.keys())
  )
}

function localAudioIsReady() {
  return (
    hasLiveAudioProducer() &&
    !producerTransport?.closed &&
    producerTransport?.connectionState === 'connected'
  )
}

// Existing-producer replay has no explicit "snapshot complete" message.  A
// short quiet period lets its NewProducer frames arrive before an empty room is
// declared ready; every announcement/consume completion re-evaluates the gate.
function scheduleMediaReadyCheck(generation = mediaStateGeneration) {
  clearMediaReadyTimer()
  if (
    intentionalClose ||
    generation !== mediaStateGeneration ||
    !localAudioIsReady() ||
    !remoteAudioIsReady()
  )
    return

  mediaReadyTimer = setTimeout(() => {
    mediaReadyTimer = null
    if (
      intentionalClose ||
      generation !== mediaStateGeneration ||
      !localAudioIsReady() ||
      !remoteAudioIsReady()
    )
      return
    clearMediaWatchdog()
    mediaWatchdogRecoveryUsed = false
    audioConsumeRecoveryUsed = false
    emitMediaState('ready')
  }, MEDIA_READY_SETTLE_MS)
}

// A transient local-media failure gets one full voice reconnect.  If the same
// recovery budget is already spent, report a bounded failure instead of looping
// forever or leaving the UI on an endless reconnect overlay.
export function requestVoiceMediaRecovery(reason = 'Voice media recovery failed') {
  if (intentionalClose || !everAuthenticated) return false
  if (mediaWatchdogRecoveryUsed) {
    emitMediaState('failed', { reason })
    return false
  }
  mediaWatchdogRecoveryUsed = true
  emitMediaState('reconnecting', { reason })
  forceVoiceReconnect(reason)
  return true
}

function armMediaWatchdog(generation) {
  clearMediaWatchdog()
  mediaWatchdogTimer = setTimeout(() => {
    mediaWatchdogTimer = null
    if (intentionalClose || generation !== mediaStateGeneration) return
    const expectedRemote = knownAudioProducers.size
    const activeRemote = [...remoteConsumers.keys()].filter((id) =>
      knownAudioProducers.has(id)
    ).length
    const localReady = localAudioIsReady()
    console.warn(
      `[Soup] media watchdog generation=${generation} local=${localReady} remote=${activeRemote}/${expectedRemote}`
    )
    if (!localReady) {
      requestVoiceMediaRecovery('Local microphone was not ready after reconnect')
      return
    }
    // A missing remote is retried by ensureAudioConsumer; invoke it again here
    // in case an earlier timer was canceled while the transport was resetting.
    for (const producerId of knownAudioProducers.keys()) ensureAudioConsumer(producerId)
    scheduleMediaReadyCheck(generation)
  }, MEDIA_WATCHDOG_DELAY_MS)
}

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
    // Both externally-tagged SFU error variants are failures. Resolving a
    // ServerError lets callers commit a transport/consumer that the server did
    // not create, which looks locally healthy but carries no media.
    const pending = {
      type,
      reject,
      handle: (message) => {
        const error = voiceRequestError(message)
        if (error) reject(error)
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

// CloseConsumer is a normal request and the SFU always replies with the unit
// ConsumerClosed acknowledgement. Account for it in the FIFO response queue;
// sending it fire-and-forget would shift every later response onto the wrong
// request and eventually strand signaling.
async function closeServerConsumers(ids) {
  if (ids.length === 0) return
  try {
    await send('CloseConsumer', { ids })
  } catch (err) {
    console.warn(`[Soup] Failed to close server consumers ${ids.join(', ')}:`, err)
  }
}

// ─── Stream viewers ─────────────────────────────────────────────
// Who is watching which screen share. The server tells us via NewConsumer (also
// replayed on join, so a late arrival learns the existing audience) and
// ConsumerClosed. ConsumerClosed identifies the consumer only by id, so we keep
// the id→(producer, client) mapping needed to undo it.
// Remote video producers we know about but may not be consuming. Tiles are
// driven by this — a stream is listed as soon as it exists, whether or not we
// have chosen to watch it.
const knownVideoProducers = new Map() // producerId -> { clientId, producedType }
// Remote screen-share audio producers we know about but only consume while the
// user is actually watching that client's stream. Screen audio is bound to the
// stream exactly like the video is (see setWatchedProducers) — pulling it for
// unwatched streams wastes bandwidth on audio nobody can hear (only the focused
// stream is ever audible, and focus implies watching).
const knownScreenAudioProducers = new Map() // producerId -> { clientId }
// Mic producer announcements are replayed only once by the server after a
// reconnect. Keep them until ProducerClosed so a transient consumer setup
// failure can be retried locally instead of leaving already-present peers mute.
const knownAudioProducers = new Map() // producerId -> { kind, clientId, producedType, generation }
const audioConsumeRetryTimers = new Map()
const audioConsumeRetryAttempts = new Map()
let audioConsumeRecoveryUsed = false
// Client ids whose streams are currently watched. Persisted so a ScreenShareAudio
// producer that arrives *after* the watch starts is consumed on arrival, mirroring
// how setWatchedProducers consumes ones that are already known.
let watchedClientIds = new Set()
// The video producers those clients are watched *through*. Held alongside the
// client set so a consume that lands after the watch moved on can re-check the
// current intent before deciding to tear itself down.
let watchedProducerIds = new Set()
// producerId -> in-flight consumeProducer() promise. A consume is invisible to
// remoteConsumers for several round-trips, so every "already consuming?" test
// has to consult this too; otherwise a watch→unwatch→watch race starts a second
// consumer and orphans the first server-side (see watchIntent.js).
const pendingConsumes = new Map()

const consumerOwners = new Map() // consumerId -> { producerId, clientId }
const producerViewers = new Map() // producerId -> Set<clientId>
const viewerSubscribers = new Set()

const snapshotViewers = () =>
  new Map([...producerViewers].map(([producerId, clients]) => [producerId, [...clients]]))

const notifyViewers = () => {
  // Hand out a plain snapshot: subscribers are React components that must not
  // hold a reference to a Map we keep mutating underneath them.
  const snapshot = snapshotViewers()
  for (const cb of viewerSubscribers) cb(snapshot)
}

const addViewer = ({ id, producer_id, client_id }) => {
  if (consumerOwners.has(id)) return
  consumerOwners.set(id, { producerId: producer_id, clientId: client_id })
  if (!producerViewers.has(producer_id)) producerViewers.set(producer_id, new Set())
  producerViewers.get(producer_id).add(client_id)
  notifyViewers()
}

const removeViewer = (consumerId) => {
  const owner = consumerOwners.get(consumerId)
  if (!owner) return
  consumerOwners.delete(consumerId)
  const set = producerViewers.get(owner.producerId)
  if (!set) return
  // A client can hold several consumers of one producer (e.g. a re-consume
  // racing the old one's close), so only drop the name once the last is gone.
  const stillWatching = [...consumerOwners.values()].some(
    (o) => o.producerId === owner.producerId && o.clientId === owner.clientId
  )
  if (!stillWatching) set.delete(owner.clientId)
  if (set.size === 0) producerViewers.delete(owner.producerId)
  notifyViewers()
}

const clearViewers = () => {
  consumerOwners.clear()
  producerViewers.clear()
  notifyViewers()
}

// Subscribe to the viewer map (producerId -> clientId[]). Returns an unsubscribe.
// Fires immediately with the current snapshot so a late subscriber isn't blank
// until the next event — NewConsumer replays happen at join, before mount.
export function subscribeStreamViewers(cb) {
  viewerSubscribers.add(cb)
  cb(snapshotViewers())
  return () => viewerSubscribers.delete(cb)
}

// Bind consumer lifetime to the set of streams the user has explicitly chosen to
// watch (the play/stop buttons), NOT to whether a tile happens to be on screen.
// A consumer is our public "I am watching this" signal, so it must mean exactly
// that; binding it to visibility instead would also churn full renegotiations
// every time the carousel collapsed or the chat tab was selected.
export function setWatchedProducers(producerIds = []) {
  const intent = resolveWatchIntent({
    requestedProducerIds: producerIds,
    videoProducers: knownVideoProducers,
    screenAudioProducers: knownScreenAudioProducers,
    activeConsumers: remoteConsumers,
    pendingConsumeIds: pendingConsumes.keys()
  })
  // Persisted so a ScreenShareAudio producer arriving after the watch starts
  // (NewProducer) gets consumed on arrival, and so a consume that lands late can
  // re-check whether it is still wanted.
  watchedProducerIds = intent.watchedProducerIds
  watchedClientIds = intent.watchedClientIds

  // The server takes a batch, so send the whole diff in one message — switching
  // away from a multi-stream view closes several at once. A stream's video
  // consumer and its screen-audio consumer go out in the same batch.
  const closedIds = []
  for (const { producerId, kind, consumerId } of intent.close) {
    closedIds.push(consumerId)
    if (kind === 'video') closeVideoConsumer(producerId)
    else closeScreenAudioConsumer(producerId)
  }
  void closeServerConsumers(closedIds)

  // Consumes still in flight for a producer nobody wants any more. They own no
  // consumer to close yet, so their teardown rides the consume itself.
  for (const producerId of intent.abandon) closeConsumeWhenItLands(producerId)

  for (const { producerId, kind, clientId, producedType } of intent.consume) {
    consumeProducer(
      producerId,
      kind,
      kind === 'video' ? activeCallbacks.onVideoStream : null,
      clientId,
      producedType
    ).catch((err) => console.error(`[Soup] Failed to consume producer ${producerId}:`, err))
  }
}

// Are we consuming this producer, or about to be? Both halves matter: the map
// only fills in after the consume completes.
function isConsumingProducer(producerId) {
  return remoteConsumers.has(producerId) || pendingConsumes.has(producerId)
}

// Does the current watch intent still cover this producer?
function producerIsWatched(producerId) {
  return isProducerWatched({
    producerId,
    watchedProducerIds,
    watchedClientIds,
    videoProducers: knownVideoProducers,
    screenAudioProducers: knownScreenAudioProducers
  })
}

function clearAudioConsumeRetry(producerId) {
  const timer = audioConsumeRetryTimers.get(producerId)
  if (timer != null) clearTimeout(timer)
  audioConsumeRetryTimers.delete(producerId)
  audioConsumeRetryAttempts.delete(producerId)
}

// Consume replayed microphone producers with a small, idempotent local retry
// budget. NewProducer is edge-triggered on the server, so merely clearing the
// failed subscribe promise does not bring peers that were already in the room
// back. A failed budget escalates once per media generation to the normal full
// reconnect, which causes the server to replay the complete producer list.
function ensureAudioConsumer(producerId) {
  const known = knownAudioProducers.get(producerId)
  if (
    !known ||
    known.generation !== mediaStateGeneration ||
    isConsumingProducer(producerId) ||
    audioConsumeRetryTimers.has(producerId)
  )
    return

  const generation = mediaStateGeneration
  consumeProducer(
    producerId,
    known.kind,
    activeCallbacks.onVideoStream,
    known.clientId,
    known.producedType
  )
    .then(() => {
      clearAudioConsumeRetry(producerId)
      scheduleMediaReadyCheck(generation)
    })
    .catch((err) => {
      if (
        knownAudioProducers.get(producerId) !== known ||
        generation !== mediaStateGeneration ||
        intentionalClose
      )
        return
      const attempt = audioConsumeRetryAttempts.get(producerId) ?? 0
      const delay = nextAudioConsumeRetryDelay(attempt)
      if (delay == null) {
        clearAudioConsumeRetry(producerId)
        console.error(`[Soup] Audio consume retries exhausted for ${producerId}:`, err)
        if (!audioConsumeRecoveryUsed) {
          audioConsumeRecoveryUsed = true
          emitMediaState('reconnecting', { reason: 'Remote audio recovery failed' })
          forceVoiceReconnect('Remote audio recovery failed')
        } else {
          emitMediaState('failed', { reason: 'Remote audio recovery failed' })
        }
        return
      }
      audioConsumeRetryAttempts.set(producerId, attempt + 1)
      console.warn(`[Soup] Retrying audio consumer ${producerId} in ${delay}ms:`, err)
      const timer = setTimeout(() => {
        audioConsumeRetryTimers.delete(producerId)
        ensureAudioConsumer(producerId)
      }, delay)
      audioConsumeRetryTimers.set(producerId, timer)
    })
}

// Stop watching something whose consume hasn't landed yet: chain the close onto
// the in-flight consume so the consumer is torn down (and the server told) the
// moment it exists. The intent is re-checked when it lands — the user may have
// started watching again meanwhile — and this CloseConsumer can't ride the
// caller's batch because it necessarily happens later.
function closeConsumeWhenItLands(producerId, { forceClose = false } = {}) {
  const pending = pendingConsumes.get(producerId)
  if (!pending) return
  pending
    .then(() => {
      if (!forceClose && producerIsWatched(producerId)) return
      const entry = remoteConsumers.get(producerId)
      if (!entry) return
      const { consumerId } = entry
      if (entry.kind === 'video') closeVideoConsumer(producerId)
      else closeScreenAudioConsumer(producerId)
      void closeServerConsumers([consumerId])
    })
    // A consume that failed left nothing behind to close.
    .catch(() => {})
}

// Remove the registry entry before tearing down its consumer and optional audio
// graph, so racing close/heal paths see an already-clean state. Returns the
// removed entry for callers that still need its metadata.
function removeRemoteConsumer(producerId) {
  const entry = remoteConsumers.get(producerId)
  if (!entry) return null
  remoteConsumers.delete(producerId)
  entry.consumer.close()
  entry.cleanup?.()
  return entry
}

// Local half of "stop watching". The server is told separately, in one batched
// CloseConsumer by the caller — a local consumer.close() alone is invisible to
// it, and we'd never drop out of anyone else's viewer list.
function closeVideoConsumer(producerId) {
  const entry = removeRemoteConsumer(producerId)
  if (!entry) return
  // The producer still exists — only our subscription ended. Keep the tile and
  // blank its stream so it returns to the stopped state rather than vanishing.
  activeCallbacks.onVideoStream?.({
    stream: null,
    kind: 'video',
    producerId,
    clientId: entry.clientId
  })
}

// Local half of "stop watching" for a stream's audio. Mirrors closeVideoConsumer:
// tear down the consumer and its Web Audio graph. The server is told via the same
// batched CloseConsumer as the video, so the RTP flow actually stops rather than
// just being muted. The producer still exists — we simply stop pulling it.
function closeScreenAudioConsumer(producerId) {
  removeRemoteConsumer(producerId)
}

// ─── Connect to signaling server ────────────────────────────────
// Callbacks: onConnect (fired after each successful auth — initial and
// reconnect), onDisconnect (intentional/unrecoverable teardown), onReconnecting
// (an unexpected drop; clear remote tiles but stay "joined"), onReconnectRejoin
// (async; re-assert channel membership before a reconnect's ticket fetch),
// onNewProducer, onVideoStream, onClientSpeaking, onConsumerClosed.
export async function connect(callbacks = {}) {
  // A rapid leave→join can arrive before the prior browser close event. Finish
  // that session synchronously while its intentional flag and callbacks still
  // belong to it; otherwise the new connect would reclassify the old onclose and
  // inherit stale transports/callbacks.
  if (ws) {
    const previousSocket = ws
    previousSocket.close()
    currentSocketCloseHandler?.({ code: 4001, reason: 'Superseded by new voice connection' })
    if (ws === previousSocket) throw new Error('Previous voice socket could not be closed')
  }
  const connectionGeneration = ++voiceConnectionGeneration
  activeCallbacks = { ...callbacks }
  intentionalClose = false
  everAuthenticated = false
  reconnectAttempts = 0
  audioConsumeRecoveryUsed = false
  mediaWatchdogRecoveryUsed = false
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
  await openSocket(connectionGeneration)
}

// ─── Voice tickets ───────────────────────────────────────────────
// Tickets are single-use and expire 30s after the server mints one. The server
// pushes one over the *events* socket (VoiceTicketUpdate, op 6) whenever a
// VoiceStateUpdate moves us from no channel into a voice channel — which covers
// both an initial join and a reconnect, since the server drops us out of the
// channel when the voice socket dies. Main routes that push here.
//
// The push often lands before openSocket() asks for it (the op-1 goes out first,
// then we get around to connecting), so it's stashed rather than awaited-only.
// The REST endpoint stays as the fallback: a push we never see — events socket
// down, or the server already considered us in the channel — must not strand a
// join.
//
// A ticket also names the host it is good for: `voice_endpoint` is present when
// the server serves /voice from somewhere other than the API host, and absent
// otherwise. It travels with the ticket rather than being remembered, because a
// server that moves its voice plane changes it — so the two are stashed,
// consumed, and used together, and never separately.
const VOICE_TICKET_PUSH_WAIT_MS = 3000
const VOICE_TICKET_MAX_AGE_MS = 20_000
const VOICE_TICKET_REQUEST_TIMEOUT_MS = 15_000
let pushedTicket = null // { ticket, voiceEndpoint, receivedAt } — unconsumed push
let ticketWaiter = null // resolver for an acquireTicket() currently waiting

// Hand a server-pushed ticket to whoever is connecting (or stash it for the
// connect that's about to start).
export function receiveVoiceTicket(ticket, voiceEndpoint) {
  if (typeof ticket !== 'string' || ticket === '') return
  console.log('[Soup] Voice ticket pushed by server')
  pushedTicket = { ticket, voiceEndpoint, receivedAt: Date.now() }
  const waiter = ticketWaiter
  ticketWaiter = null
  waiter?.()
}

// Consume the stash, refusing one old enough that the server may already have
// expired it (presenting a dead ticket costs us a failed socket, not a retry).
function takePushedTicket() {
  if (!pushedTicket) return null
  const { ticket, voiceEndpoint, receivedAt } = pushedTicket
  pushedTicket = null
  return Date.now() - receivedAt > VOICE_TICKET_MAX_AGE_MS ? null : { ticket, voiceEndpoint }
}

function waitForPushedTicket() {
  return new Promise((resolve) => {
    let timer
    let waiter
    const finish = (value) => {
      clearTimeout(timer)
      if (ticketWaiter === waiter) ticketWaiter = null
      resolve(value)
    }
    waiter = () => finish(takePushedTicket())
    ticketWaiter = waiter
    timer = setTimeout(() => finish(null), VOICE_TICKET_PUSH_WAIT_MS)
  })
}

// A ticket for the connection we're about to open, with the endpoint it is good
// for: the server's push if we have (or shortly get) one, else minted over REST.
async function acquireTicket() {
  const pushed = takePushedTicket() ?? (await waitForPushedTicket())
  if (pushed) return pushed
  // The user left while we were waiting — don't spend a request on a join
  // nobody is waiting for any more.
  if (intentionalClose) return null

  // No push — either it was lost or this join didn't cause a channel transition
  // the server would mint for. Ask for one directly (authFetch refreshes the
  // access token as needed).
  console.warn('[Soup] No pushed voice ticket; requesting one over REST')
  const res = await authFetch(`${apiBase()}/server/voice`, {
    signal: AbortSignal.timeout(VOICE_TICKET_REQUEST_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`Voice ticket request failed: ${res.status}`)
  const { ticket, voice_endpoint: voiceEndpoint } = await res.json()
  return ticket ? { ticket, voiceEndpoint } : null
}

// Open the voice WebSocket: take a fresh (single-use, 30s) ticket, wire every
// handler, then authenticate. Used for the initial connection and every
// reconnect attempt — each call replaces the shared `ws`. A stale-socket guard
// on every handler ignores a superseded socket once a newer one takes over.
async function openSocket(connectionGeneration = voiceConnectionGeneration) {
  if (ws) throw new Error('A voice socket is already closing or connected')
  // Step 1 — get ticket, and the endpoint it is good for
  const acquired = await acquireTicket()
  // Acquiring waits on the server's push (and possibly the network), so the
  // user may have left meanwhile — opening now would orphan a socket that
  // nothing is holding.
  if (intentionalClose || connectionGeneration !== voiceConnectionGeneration) {
    throw mediaResetError()
  }
  // No ticket while we still want to be connected is a *failure*, not a
  // no-op: returning cleanly here would let attemptReconnect() treat it as a
  // success and schedule nothing, stranding the user "reconnecting" forever.
  // Throwing puts the attempt back on the backoff ladder, which is what a
  // dual-drop needs — the events socket has to come back before the server
  // will mint a ticket at all.
  if (!acquired) throw new Error('Voice ticket unavailable')
  const { ticket, voiceEndpoint } = acquired

  // Step 2 — connect to voice WebSocket, on the voice host when the server
  // named one and on the API host otherwise.
  const url = voiceSocketUrl(voiceEndpoint)
  console.log('[Soup] Voice endpoint:', url)
  const socket = new WebSocket(url)
  ws = socket
  console.log('[Soup] WebSocket created, readyState:', socket.readyState)

  // Keep the reconnect single-flight lock until the socket actually
  // authenticates. Constructing WebSocket is not a successful attempt: an
  // OPEN black hole or a server that never replies otherwise strands recovery.
  let authenticationSettled = false
  let resolveAuthentication
  let rejectAuthentication
  let authenticationTimer = null
  const authentication = new Promise((resolve, reject) => {
    resolveAuthentication = resolve
    rejectAuthentication = reject
  })
  const settleAuthentication = (error = null) => {
    if (authenticationSettled) return
    authenticationSettled = true
    clearTimeout(authenticationTimer)
    if (error) rejectAuthentication(error)
    else resolveAuthentication()
  }
  authenticationTimer = setTimeout(() => {
    if (ws !== socket || authenticationSettled) return
    console.warn('[Soup] Voice authentication timed out; rebuilding socket')
    settleAuthentication(new Error('Voice authentication timed out'))
    socket.close()
    armSocketCloseDeadline(socket)
    // The close handler normally tears media down. The deadline is its bounded
    // fallback when the platform never emits close.
  }, VOICE_AUTH_TIMEOUT_MS)

  // ─── Assign ALL handlers before anything can fire ───────────────
  socket.onmessage = (event) => {
    if (ws !== socket) return // superseded by a newer socket
    // Never let a malformed frame throw out of the handler: doing so skips the
    // FIFO routing below, so a dropped *response* would desync every later
    // request instead of costing us one frame. A response we genuinely lose
    // still hits the 15s pending timeout, which forces a reconnect — the
    // correct last resort, and much rarer than this path.
    let message
    try {
      message = JSON.parse(event.data)
    } catch (err) {
      console.error('[Soup] Dropping unparseable frame:', err)
      return
    }
    console.log('[Soup] Received:', message)

    // Authenticated confirmation
    if (message.type === 'Authenticated') {
      if (authenticationSettled) return
      console.log('[Soup] Authenticated')
      iceServers = message.ice_servers ?? []
      everAuthenticated = true
      reconnectAttempts = 0
      emitMediaState('authenticated')
      armMediaWatchdog(mediaStateGeneration)
      activeCallbacks.onConnect?.()
      settleAuthentication()
      return
    }

    if (message.type === 'Unauthorized' && !authenticationSettled) {
      const error = new Error('Voice authentication was rejected')
      settleAuthentication(error)
      socket.close()
      armSocketCloseDeadline(socket)
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

      // Screen-share audio is bound to a stream: like video, it waits for an
      // actual watch. Consuming it eagerly makes every client in the channel pull
      // every stream's audio — audio that is inaudible anyway unless the stream is
      // focused. Register it and consume immediately only if this client's stream
      // is already watched; setWatchedProducers() consumes/closes it as the watch
      // set changes.
      if (produced_type === 'ScreenShareAudio') {
        knownScreenAudioProducers.set(id, { clientId: client_id })
        if (watchedClientIds.has(client_id) && !isConsumingProducer(id)) {
          consumeProducer(id, kind, null, client_id, produced_type).catch((err) =>
            console.error(`[Soup] Failed to consume screen audio ${id}:`, err)
          )
        }
        return
      }

      // Mic audio must be audible the moment it exists, so it still consumes eagerly.
      if (kind !== 'video') {
        knownAudioProducers.set(id, {
          kind,
          clientId: client_id,
          producedType: produced_type,
          generation: mediaStateGeneration
        })
        // A producer replay arriving during the settle window makes inbound
        // audio part of the readiness barrier.
        scheduleMediaReadyCheck(mediaStateGeneration)
        ensureAudioConsumer(id)
        return
      }

      // Video does NOT consume here. Consuming is what tells the server (and
      // therefore everyone else) that we're watching, so it has to wait for an
      // actual click — otherwise every client in the channel counts as a viewer
      // of every stream. We just register the producer and announce a tile with
      // no stream yet; setWatchedProducers() consumes on demand.
      knownVideoProducers.set(id, { clientId: client_id, producedType: produced_type })
      activeCallbacks.onVideoStream?.({
        stream: null,
        kind,
        producerId: id,
        clientId: client_id
      })
      return
    }

    // Audience bookkeeping for screen shares. NewConsumer covers both "someone
    // started watching" and the replay a client receives on joining a channel,
    // so it must be idempotent (addViewer dedupes by consumer id).
    if (message.type === 'NewConsumer') {
      addViewer(message.data)
      return
    }

    if (isConsumerClosedEvent(message)) {
      removeViewer(message.data.id)
      return
    }

    // A remote producer we were consuming has closed (e.g. the other
    // client stopped screen sharing) — close our consumer and remove its tile.
    if (message.type === 'ProducerClosed') {
      const { id, replaced = false } = message.data
      const known = knownVideoProducers.get(id)
      knownVideoProducers.delete(id)
      knownScreenAudioProducers.delete(id)
      knownAudioProducers.delete(id)
      clearAudioConsumeRetry(id)
      scheduleMediaReadyCheck(mediaStateGeneration)
      // The Consume may still resolve after this close notification. Chain a
      // CloseConsumer onto it so a late consumer cannot become a ghost
      // subscription; the producer is definitively gone, regardless of whether
      // its metadata still identifies it as watched.
      if (pendingConsumes.has(id)) {
        closeConsumeWhenItLands(id, { forceClose: true })
      }
      // A genuinely new producer with this id deserves a fresh cooldown, so drop
      // any heal backoff we were tracking for the one that just closed.
      audioHealHistory.delete(id)
      const entry = removeRemoteConsumer(id)
      if (entry) {
        console.log(`[Soup] Remote producer closed [id:${id}], consumer removed`)
      }
      // Tiles are producer-driven now, so the tile must go whether or not we
      // were consuming — an unwatched stream has no consumer to close.
      if (entry?.kind === 'video' || known) {
        activeCallbacks.onStreamEnded?.(id, {
          replaced,
          clientId: entry?.clientId ?? known?.clientId,
          producedType: entry?.producedType ?? known?.producedType
        })
      }
      return
    }

    // The server has already torn down both transports and removed this socket's
    // router peer. It cannot create replacement transports on the same socket;
    // close and authenticate a fresh SFU session so producer replay and both
    // directions of media are rebuilt together.
    if (message.type === 'TransportsDisconnected' || message.type === 'MediaStateReset') {
      console.warn(`[Soup] ${message.type}, rebuilding voice session`)
      emitMediaState('reconnecting', { reason: message.type })
      activeCallbacks.onReconnecting?.()
      forceVoiceReconnect(message.type)
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

  const handleSocketClose = (event) => {
    if (ws !== socket) return // a newer socket has already taken over
    clearTimeout(socketCloseDeadlineTimer)
    socketCloseDeadlineTimer = null
    currentSocketCloseHandler = null
    // Release the global socket before callbacks or reconnect scheduling. A
    // recovery attempt may now begin, but only after this handler has torn down
    // all transports belonging to the old SFU peer.
    ws = null
    console.log('[Soup] WebSocket disconnected — code:', event.code, 'reason:', event.reason)
    settleAuthentication(
      new Error(`Voice socket closed before authentication (${event.code || 'no code'})`)
    )
    // Reject every waiter before reconnecting. Silently dropping these handlers
    // left callers (including screen-share teardown) pending forever.
    rejectPendingRequests(new Error(`Voice socket closed (${event.code || 'no code'})`))
    resetMediaState()

    if (intentionalClose || !everAuthenticated) {
      // Deliberate teardown, or a connection that never authenticated (treat a
      // failed initial join as a normal disconnect, not something to retry).
      activeCallbacks.onDisconnect?.()
    } else {
      // Unexpected drop after a healthy session — keep the user "joined" and
      // recover in the background. Remote tiles are cleared now and re-arrive
      // via replayed NewProducer once we're back; mic is re-published on auth.
      activeCallbacks.onReconnecting?.()
      scheduleVoiceReconnect()
    }
  }
  currentSocketCloseHandler = handleSocketClose
  socket.onclose = handleSocketClose

  socket.onerror = (err) => {
    console.error('[Soup] WebSocket error:', err)
  }

  // ─── onopen last so handlers are guaranteed to be in place ──────
  socket.onopen = () => {
    if (ws !== socket) return
    console.log('[Soup] WebSocket connected, authenticating...')
    socket.send(JSON.stringify({ ticket }))
  }

  await authentication
}

// WebSocket.close() can itself stall behind a dead network path. Once close has
// been requested, give the browser a short grace period, then run the exact same
// idempotent teardown as onclose. A late native close sees a stale socket and is
// ignored; no stale transports survive into the replacement session.
function armSocketCloseDeadline(socket) {
  if (socketCloseDeadlineTimer != null) return
  socketCloseDeadlineTimer = setTimeout(() => {
    socketCloseDeadlineTimer = null
    if (ws !== socket) return
    console.warn('[Soup] Voice socket close timed out; forcing local teardown')
    currentSocketCloseHandler?.({ code: 4000, reason: 'Local close timeout' })
  }, 3000)
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
  const connectionGeneration = voiceConnectionGeneration
  reconnectInFlight = true
  try {
    await activeCallbacks.onReconnectRejoin?.()
    if (intentionalClose || connectionGeneration !== voiceConnectionGeneration) return
    await openSocket(connectionGeneration)
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
  const action = voiceSocketRecoveryAction(ws?.readyState)
  // A socket that still thinks it's open/connecting is the half-open case:
  // close it so onclose runs the normal teardown + reconnect path.
  if (action === 'close') {
    console.warn(`[Soup] ${reason} — closing half-open voice socket to recover`)
    ws.close()
    armSocketCloseDeadline(ws)
    return
  }
  // CLOSING/CLOSED still owns the teardown callback. Starting a replacement
  // now would overwrite `ws`, make the old onclose stale, and preserve its dead
  // transports — the two-way-silence race this recovery path must prevent.
  if (action === 'wait-for-close') {
    armSocketCloseDeadline(ws)
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
  voiceConnectionGeneration++
  intentionalClose = true
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  // A ticket minted for a join we're abandoning: drop it so a later connect
  // can't present it instead of waiting for its own.
  pushedTicket = null
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('online', handleOnline)
  // Let the (guarded) onclose handler run resetMediaState + onDisconnect and
  // null out `ws`; closing synchronously here would race that cleanup.
  if (ws) {
    const socket = ws
    socket.close()
    armSocketCloseDeadline(socket)
  }
}

// ─── Load mediasoup Device ───────────────────────────────────────
async function loadDevice(generation = mediaStateGeneration) {
  if (generation !== mediaStateGeneration) throw mediaResetError()
  if (device) return device
  if (deviceLoadInFlight?.generation === generation) return deviceLoadInFlight.promise

  const promise = (async () => {
    const rtpCapabilities = await send('GetRouterRtpCapabilities')
    if (generation !== mediaStateGeneration) throw mediaResetError()

    // Do not publish a half-loaded Device globally.  A reset can occur while
    // mediasoup validates capabilities; only the generation that started this
    // load may install the result.
    const candidate = new Device()
    await candidate.load({ routerRtpCapabilities: rtpCapabilities })
    if (generation !== mediaStateGeneration) throw mediaResetError()
    device = candidate
    console.log('[Soup] Device loaded')
    return candidate
  })().finally(() => {
    if (deviceLoadInFlight?.promise === promise) deviceLoadInFlight = null
  })

  deviceLoadInFlight = { generation, promise }
  return promise
}

// Stop the currently active audio processing chain (if any), releasing its
// nodes, worklet, and level-check loop.
function stopAudioProcessor() {
  audioProcessorStop?.()
  audioProcessorStop = null
}

// Only one capture can define the device's processing, and while joined to a
// channel that capture belongs to the call. Anything else that wants mic audio
// (the settings meter) has to read this one rather than open its own — a second
// capture would inherit stale processing *and* poison the next republish.
const rawMicStreamListeners = new Set()
let rawMicEndedRepairGeneration = null

export function getRawMicStream() {
  return rawMicStream
}

// Fires whenever the live capture is swapped (republish) or released (teardown),
// so readers can rebuild their graph on the new track. Returns an unsubscribe.
export function onRawMicStreamChange(listener) {
  rawMicStreamListeners.add(listener)
  return () => rawMicStreamListeners.delete(listener)
}

function setRawMicStream(stream) {
  if (rawMicStream === stream) return
  rawMicStream = stream
  for (const track of stream?.getAudioTracks?.() ?? []) {
    track.addEventListener('ended', () => {
      // resetMediaState deliberately stops this track. Only repair a capture
      // that is still the live session's source, and only once per generation.
      if (
        rawMicStream !== stream ||
        intentionalClose ||
        rawMicEndedRepairGeneration === mediaStateGeneration
      )
        return
      rawMicEndedRepairGeneration = mediaStateGeneration
      const settings = lastCommittedMicSettings
      console.warn('[Soup] Raw microphone track ended; attempting one repair')
      if (!settings || !producerTransport || producerTransport.closed) {
        requestVoiceMediaRecovery('Microphone capture ended')
        return
      }
      republish(settings).catch((err) => {
        if (isPermanentMicError(err)) {
          console.error('[Soup] Microphone capture needs user action:', err.name, err.message)
          emitMediaState('failed', { reason: err.name })
          return
        }
        requestVoiceMediaRecovery('Microphone republish failed')
      })
    })
  }
  rawMicStreamListeners.forEach((listener) => {
    try {
      listener(stream)
    } catch (err) {
      console.error('[Soup] rawMicStream listener failed:', err)
    }
  })
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
  // Run on the shared playback context (no sourceNode — the mic stream needs its
  // own source node). Safe re the autoplay policy: this only runs after the user
  // has joined a channel, by which point the playback context is allowed to run.
  // getPlaybackContext() is declared later in the file, but function declarations
  // hoist and we call it lazily here, so the reference resolves fine.
  selfSpeakingStop = createSpeakingDetector(
    stream,
    (isSpeaking) => {
      if (localClientId != null) activeCallbacks.onClientSpeaking?.(localClientId, isSpeaking)
    },
    { audioContext: getPlaybackContext() }
  )
}

// Register the "you're talking while muted" handler (UI plays a sound + shows a
// warning toast). Mirrored in from the app layer, like setLocalClientId.
export function setTalkingWhileMutedHandler(fn) {
  onTalkingWhileMuted = fn
}

// Warn (throttled) when we speak while muted. `tap` is the processing chain's
// pre-destination node (see buildAudioProcessor): it stays live while muted, and
// it has already been through RNNoise and the volume gate, so a warning only
// fires on audio loud/clean enough that peers would have received it. Without a
// chain (processor build failed) we fall back to the raw capture, which is then
// what would have been published anyway.
function startMutedTalkDetector(stream, tap) {
  mutedTalkStop?.()
  mutedTalkStop = createSpeakingDetector(
    stream,
    (isSpeaking) => {
      if (!isSpeaking || !micMuted) return
      const now = performance.now()
      if (now - lastTalkingWhileMutedAt < TALKING_WHILE_MUTED_COOLDOWN_MS) return
      lastTalkingWhileMutedAt = now
      onTalkingWhileMuted?.()
    },
    tap
      ? { audioContext: tap.context, sourceNode: tap.node }
      : { audioContext: getPlaybackContext() }
  )
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
// concurrent caller joins the in-flight promise.
//
// The fast-path guard is "we are already transmitting", NOT "a transport
// exists": a publish that died between creating the transport and producing
// (getUserMedia denied, processor or produce failure) must stay retryable, or
// the user sits in the channel sending nothing until something else happens to
// trigger a republish. The transport itself is reused across those retries —
// the server rejects a second producer-transport allocation for one session.
export async function publish(micSettings, onStream) {
  if (hasLiveAudioProducer()) return
  const generation = mediaStateGeneration
  if (publishInFlight?.generation === generation) return publishInFlight.promise
  const promise = doPublish(micSettings, onStream, generation).finally(() => {
    if (publishInFlight?.promise === promise) publishInFlight = null
  })
  publishInFlight = { generation, promise }
  return promise
}

function hasLiveAudioProducer() {
  const rawTrack = rawMicStream?.getAudioTracks?.().find((track) => track.readyState === 'live')
  return (
    !!rawTrack &&
    producers.some(
      (producer) =>
        producer.kind === 'audio' && !producer.closed && producer.track?.readyState === 'live'
    )
  )
}

function watchTransportConnectivity(transport, label, isCurrentTransport) {
  let wasConnected = false
  let degradedTimer = null
  const clearDegradedTimer = () => {
    if (degradedTimer != null) clearTimeout(degradedTimer)
    degradedTimer = null
  }

  transport.on('connectionstatechange', (state) => {
    console.log(`[Soup] ${label} transport connection state:`, state)
    if (!isCurrentTransport()) {
      clearDegradedTimer()
      return
    }
    if (state === 'connected') {
      wasConnected = true
      clearDegradedTimer()
      scheduleMediaReadyCheck()
      return
    }
    if (state === 'closed') {
      clearDegradedTimer()
      return
    }
    if (state === 'failed') {
      clearDegradedTimer()
      forceVoiceReconnect(`${label} transport failed`)
      return
    }
    // ICE can briefly report disconnected/connecting while changing network
    // paths. Once a transport was healthy, bound that state; this SFU has no
    // RestartIce request, so a persistent degradation requires a full session.
    if (wasConnected && (state === 'disconnected' || state === 'connecting')) {
      clearDegradedTimer()
      degradedTimer = setTimeout(() => {
        degradedTimer = null
        if (
          isCurrentTransport() &&
          transport.connectionState !== 'connected' &&
          transport.connectionState !== 'closed'
        ) {
          forceVoiceReconnect(`${label} transport remained ${transport.connectionState}`)
        }
      }, TRANSPORT_DISCONNECTED_GRACE_MS)
    }
  })
}

// Create the send transport, or hand back the one this session already owns.
// Never recreates: a duplicate CreateProducerTransport is a server-side error,
// so a retried publish has to build on the existing transport.
async function ensureProducerTransport(generation) {
  if (generation !== mediaStateGeneration) throw mediaResetError()
  if (producerTransport && !producerTransport.closed) return producerTransport
  const loadedDevice = await loadDevice(generation)
  if (generation !== mediaStateGeneration) throw mediaResetError()
  const rawParams = await send('CreateProducerTransport')
  if (generation !== mediaStateGeneration) throw mediaResetError()
  const transport = loadedDevice.createSendTransport({
    ...mapTransportParams(rawParams),
    iceServers
  })

  const isCurrentTransport = () =>
    generation === mediaStateGeneration && producerTransport === transport && !transport.closed

  watchTransportConnectivity(transport, 'Producer', isCurrentTransport)

  transport.on('connect', ({ dtlsParameters }, callback, errback) => {
    if (!isCurrentTransport()) {
      errback(mediaResetError())
      return
    }
    send('ConnectProducerTransport', { dtlsParameters })
      .then(() => {
        if (!isCurrentTransport()) throw mediaResetError()
        callback()
      })
      .catch((err) => errback(err))
  })

  transport.on('produce', ({ kind, rtpParameters, appData }, callback, errback) => {
    const produceOnServer = async () => {
      if (!isCurrentTransport()) throw mediaResetError()
      // Screen rung validation must finish before the SFU sees Produce. The SFU
      // atomically replaces a same-type producer, so validating afterward could
      // destroy the last live share when the candidate is rejected.
      await runBeforeServerProduce(appData, rtpParameters)
      if (!isCurrentTransport()) throw mediaResetError()
      const response = await send('Produce', {
        produce_params: {
          rtp_params: rtpParameters,
          kind
        },
        produced_type: appData?.produced ?? 'Audio'
      })
      if (!isCurrentTransport()) throw mediaResetError()
      return response
    }

    produceOnServer()
      .then((res) => callback({ id: res.id }))
      .catch((err) => errback(err))
  })

  if (generation !== mediaStateGeneration) {
    transport.close()
    throw mediaResetError()
  }
  producerTransport = transport
  return transport
}

function mediaResetError() {
  const error = new Error('Voice media state reset during operation')
  error.name = 'VoiceMediaResetError'
  return error
}

async function doPublish(micSettings, onStream, generation) {
  const transport = await ensureProducerTransport(generation)
  const isCurrent = () =>
    generation === mediaStateGeneration && producerTransport === transport && !transport.closed
  if (!isCurrent()) throw mediaResetError()

  let stream
  try {
    stream = await acquireMicCapture(micSettings, rawMicStream)
  } catch (err) {
    console.error('[Soup] getUserMedia failed:', err.name, err.message)
    // Preserve the browser error name so callers can distinguish a temporary
    // device handoff from permission/constraint failures that need user action.
    throw err
  }

  if (!isCurrent()) {
    stopRawStream(stream)
    throw mediaResetError()
  }

  // Track the raw capture so its OS mic handle can be released on teardown —
  // the processed track handed to the producer is usually a different track, so
  // stopping only that would leave the mic open.
  setRawMicStream(stream)

  // Apply the local processing chain (RNNoise / volume gate). Stop any
  // previous chain first so its AudioContext and worklet don't leak.
  stopAudioProcessor()
  let processedStream = stream
  let processorTap = null
  let processorStop = null
  try {
    const processed = await buildAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    audioProcessorStop = processed.stop
    processorStop = processed.stop
    processorTap = processed.tap
  } catch (err) {
    console.error('[Soup] Failed to build audio processor:', err)
    // Fall back to unprocessed stream
  }

  // A reset (socket drop, channel switch) can land while we were awaiting the
  // capture and the processing graph — it closes this transport. Drop the
  // candidate rather than produce on a corpse; the reconnect's publish() starts
  // over on a fresh transport.
  if (!isCurrent()) {
    stopMicRepublishCandidate(stream, processedStream, processorStop)
    if (audioProcessorStop === processorStop) audioProcessorStop = null
    if (rawMicStream === stream) setRawMicStream(null)
    throw mediaResetError()
  }

  onStream?.(processedStream)
  // Detect our own speech from the exact processed track being encoded. In
  // particular, quiet audio rejected by RNNoise or the volume gate must not
  // light the local indicator when peers cannot receive it.
  startSelfSpeakingDetector(processedStream)
  // Separate in-graph tap that survives muting, for the talking-while-muted warning.
  startMutedTalkDetector(stream, processorTap)

  // Negotiate the channel layout of the track actually handed to mediasoup,
  // not the raw capture feeding the processing graph.
  const resolvedMicSettings = micSettingsForPublishedStream(micSettings, processedStream)
  const opusOptions = buildMicOpusOptions(resolvedMicSettings)
  const audioProfile = micAudioProfileKey(resolvedMicSettings, opusOptions)

  const published = []
  try {
    const tracks = processedStream.getAudioTracks()
    if (tracks.length === 0)
      throw new Error('The selected microphone did not provide an audio track')
    for (const track of tracks) {
      if (!isCurrent()) throw mediaResetError()
      const producer = await transport.produce({
        track,
        ...opusOptions,
        appData: { produced: 'Audio' }
      })
      if (!isCurrent()) {
        producer.close()
        throw mediaResetError()
      }
      published.push(producer)
      producers.push(producer)
      localProducerIds.add(producer.id)
      if (micMuted) producer.pause()
      console.log(`[Soup] Producing ${track.kind} [id:${producer.id}]`)
    }
  } catch (err) {
    for (const producer of published) {
      producer.close()
      localProducerIds.delete(producer.id)
      producers = producers.filter((current) => current !== producer)
      void closeServerProducer(producer.id)
    }
    stopMicRepublishCandidate(stream, processedStream, processorStop)
    if (rawMicStream === stream) setRawMicStream(null)
    if (audioProcessorStop === processorStop) audioProcessorStop = null
    throw err
  }

  lastCommittedMicSettings = { ...resolvedMicSettings }
  lastCommittedAudioProfile = audioProfile

  console.log('[Soup] Publishing audio')
  emitMediaState('local-producer-ready')
  scheduleMediaReadyCheck(generation)
}

// Release a republish candidate that never became the current producer. This is
// deliberately explicit because profile replacements are produced with
// stopTracks:false so a failed produce does not destroy a track we may still
// need while deciding whether the transaction committed.
function stopMicRepublishCandidate(stream, processedStream, processorStop) {
  processorStop?.()
  const tracks = new Set([
    ...(stream?.getTracks?.() ?? []),
    ...(processedStream?.getTracks?.() ?? [])
  ])
  for (const track of tracks) track.stop()
}

async function disposeMicProducers(producerList, { notifyServer = true } = {}) {
  const ids = []
  for (const producer of producerList) {
    const track = producer.track
    producer.close()
    // Profile replacements use stopTracks:false; stopping explicitly also makes
    // cleanup correct for a candidate produced with that ownership mode.
    track?.stop()
    localProducerIds.delete(producer.id)
    ids.push(producer.id)
  }
  if (notifyServer) await Promise.all(ids.map((id) => closeServerProducer(id)))
}

function commitRepublishedMicProcessing({
  stream,
  processedStream,
  processorStop,
  processorTap,
  previousStop,
  micSettings,
  onStream
}) {
  previousStop?.()
  audioProcessorStop = processorStop
  setRawMicStream(stream)
  if (micSettings) lastCommittedMicSettings = { ...micSettings }
  // Keep both detectors tied to the same capture transaction that just became
  // current. Starting either one tears down its previous callback/tap.
  startSelfSpeakingDetector(processedStream)
  startMutedTalkDetector(stream, processorTap)
  onStream?.(processedStream)
}

function discardRepublishCandidate({ stream, processedStream, processorStop, previousStop }) {
  // acquireMicCapture has already stopped the previous raw track, so once a
  // candidate is abandoned the old processing graph cannot remain useful. Stop
  // it as well, but do not clear a newer graph installed by a reset/reconnect.
  previousStop?.()
  if (audioProcessorStop === previousStop) audioProcessorStop = null
  stopMicRepublishCandidate(stream, processedStream, processorStop)
}

// The capture source is released before a republish candidate opens so browser
// audio constraints actually take effect. If anything after that release
// fails, reopen the last committed profile and put a live track back on every
// existing audio producer before surfacing the original error.
// Stable recovery dependencies, bound once. Per-transaction values (the
// candidate streams/callbacks in `options`) and the mutable module reads
// (rawMicStream, micMuted) are merged in at each call.
const micRepublishRecoveryEnv = {
  acquireMicCapture,
  buildAudioProcessor,
  stopRawStream,
  stopCandidate: stopMicRepublishCandidate,
  onPreviousStopped: (previousStop) => {
    if (audioProcessorStop === previousStop) audioProcessorStop = null
  },
  onCommit: commitRepublishedMicProcessing,
  onError: (phase, err) => console.error(`[Soup] Failed ${phase}:`, err)
}

function restoreCommittedMicCapture(options) {
  return recoverMicRepublish({
    ...micRepublishRecoveryEnv,
    ...options,
    rawMicStream,
    micMuted
  })
}

// ─── Republish: apply new mic settings to the existing producer ──
// Reuses the existing audio producer(s) via replaceTrack() for ordinary setting
// changes. A profile change (for example mono speech -> future HiFi stereo) is
// produced first; only a successful replacement commits the producer list and
// its profile metadata.
//
// `graphOnly` asks for the cheap tier: the caller has established that the
// capture doesn't change (see micRepublishScope), so the processing graph is
// rebuilt on the capture we already hold — no gUM, no 50ms source release, no
// audible gap beyond the replaceTrack. It is a request, not an assertion: this
// path re-checks the capture key itself and falls back to the full transaction
// if they disagree.
export function republish(micSettings, onStream, { graphOnly = false } = {}) {
  const generation = mediaStateGeneration
  return enqueueRepublish(async () => {
    // Initial/reconnect publish and settings republish mutate the same capture,
    // processing graph and producer list. A setting change while publish is
    // awaiting getUserMedia must wait rather than stop its candidate underneath
    // it or create a second producer.
    if (publishInFlight?.generation === generation) await publishInFlight.promise
    return doRepublish(micSettings, onStream, generation, { graphOnly })
  })
}

async function doRepublish(micSettings, onStream, expectedGeneration, { graphOnly = false } = {}) {
  if (expectedGeneration !== mediaStateGeneration) throw mediaResetError()

  const transport = producerTransport
  if (!transport) throw new Error('Not connected to voice')

  const isCurrent = () =>
    expectedGeneration === mediaStateGeneration &&
    producerTransport === transport &&
    !transport.closed

  const audioProducers = producers.filter((p) => p.kind === 'audio' && !p.closed)
  const previousMicSettings = lastCommittedMicSettings ? { ...lastCommittedMicSettings } : null
  // The raw capture backing the current producer(s). Released *before* the new
  // one opens — it has to be, or Chromium hands back the old processing config
  // and the settings the user just applied are silently ignored (see
  // acquireMicCapture). Cost is a sub-second gap in outgoing audio while the
  // raw source feeding the published mono graph is reopened.
  const previousRawStream = rawMicStream
  const previousProcessorStop = audioProcessorStop

  // The cheap tier needs a live capture to build on, live producers to swap the
  // track onto, and a committed profile that really does ask for the same
  // capture. Anything else falls through to the full transaction — which is
  // always correct, just slower.
  if (
    graphOnly &&
    previousRawStream &&
    audioProducers.length > 0 &&
    previousMicSettings &&
    micCaptureKey(previousMicSettings) === micCaptureKey(micSettings)
  ) {
    return doGraphOnlyRepublish({
      micSettings,
      onStream,
      audioProducers,
      rawStream: previousRawStream,
      previousProcessorStop,
      isCurrent
    })
  }

  let stream
  try {
    stream = await acquireMicCapture(micSettings, previousRawStream)
  } catch (err) {
    console.error('[Soup] republish getUserMedia failed:', err.name, err.message)
    if (!isCurrent()) throw mediaResetError()
    const restored = await restoreCommittedMicCapture({
      audioProducers,
      micSettings: previousMicSettings,
      previousStop: previousProcessorStop,
      candidateStream: null,
      candidateProcessedStream: null,
      candidateProcessorStop: null,
      onStream,
      isCurrent
    })
    if (!restored && isCurrent()) {
      requestVoiceMediaRecovery('Microphone rollback failed')
    }
    const wrapped = new Error(`Failed to get audio device: ${err.message}`, { cause: err })
    wrapped.name = err?.name ?? 'Error'
    throw wrapped
  }

  // Build the candidate graph without tearing down the current graph yet. The
  // old raw capture has already been released by acquireMicCapture, but delaying
  // graph teardown keeps the local bookkeeping transactional if processing or
  // produce fails.
  let processedStream = stream
  let candidateProcessorStop = () => {}
  let candidateProcessorTap = null
  try {
    const processed = await buildAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    candidateProcessorStop = processed.stop
    candidateProcessorTap = processed.tap
  } catch (err) {
    console.error('[Soup] republish audio processor failed:', err)
  }

  // Profile comparison must describe the candidate track that will be
  // published. The raw device may be stereo, but the voice graph is mono.
  const resolvedMicSettings = micSettingsForPublishedStream(micSettings, processedStream)
  const opusOptions = buildMicOpusOptions(resolvedMicSettings)
  const audioProfile = micAudioProfileKey(resolvedMicSettings, opusOptions)
  const newTracks = processedStream.getTracks()

  // The candidate streams/stops are fixed for the rest of the transaction, so
  // bind the recovery/commit bundles once instead of repeating their arguments
  // at every branch below.
  const discardCandidate = () =>
    discardRepublishCandidate({
      stream,
      processedStream,
      processorStop: candidateProcessorStop,
      previousStop: previousProcessorStop
    })
  const restoreCommitted = () =>
    restoreCommittedMicCapture({
      audioProducers,
      micSettings: previousMicSettings,
      previousStop: previousProcessorStop,
      candidateStream: stream,
      candidateProcessedStream: processedStream,
      candidateProcessorStop,
      onStream,
      isCurrent
    })
  const commitCandidate = () =>
    commitRepublishedMicProcessing({
      stream,
      processedStream,
      processorStop: candidateProcessorStop,
      processorTap: candidateProcessorTap,
      previousStop: previousProcessorStop,
      micSettings: resolvedMicSettings,
      onStream
    })

  // The socket can drop while we were awaiting getUserMedia / the audio
  // processor above; onclose then runs resetMediaState(), closing the transport
  // and the producers we captured. Bail rather than produce/replaceTrack on a
  // corpse (InvalidStateError: closed) — the reconnect path re-publishes fresh.
  if (!isCurrent()) {
    discardCandidate()
    throw mediaResetError()
  }

  if (audioProducers.length === 0) {
    // No existing producer to reuse (first publish hasn't happened yet) -
    // produce fresh, mirroring publish().
    const freshProducers = []
    try {
      for (const track of newTracks) {
        const producer = await transport.produce({
          track,
          ...opusOptions,
          appData: { produced: 'Audio' }
        })
        freshProducers.push(producer)
      }
      if (!isCurrent()) {
        throw mediaResetError()
      }
    } catch (err) {
      await disposeMicProducers(freshProducers, { notifyServer: isCurrent() })
      discardCandidate()
      throw err
    }

    producers = producers.filter((p) => p.kind !== 'audio').concat(freshProducers)
    for (const producer of freshProducers) {
      localProducerIds.add(producer.id)
      if (micMuted) producer.pause()
      console.log(`[Soup] Republished ${producer.track.kind} [id:${producer.id}]`)
    }
    lastCommittedAudioProfile = audioProfile
    commitCandidate()
    console.log('[Soup] Audio republished with new settings')
    return
  }

  if (newTracks.length !== audioProducers.length) {
    const restored = await restoreCommitted()
    if (!restored && isCurrent()) requestVoiceMediaRecovery('Microphone rollback failed')
    throw new Error('Microphone track count changed during republish')
  }

  const profileChanged =
    lastCommittedAudioProfile !== null && lastCommittedAudioProfile !== audioProfile

  if (profileChanged) {
    // mediasoup/SFU replaces the prior Audio producer when this produce succeeds.
    // Keep the old local producer array untouched until every candidate succeeds.
    // stopTracks:false gives the transaction explicit ownership if it has to
    // discard a partially-created candidate.
    const replacementProducers = []
    try {
      for (const track of newTracks) {
        const producer = await transport.produce({
          track,
          ...opusOptions,
          stopTracks: false,
          appData: { produced: 'Audio' }
        })
        replacementProducers.push(producer)
      }
      if (!isCurrent()) {
        throw mediaResetError()
      }
    } catch (err) {
      if (!isCurrent()) {
        await disposeMicProducers(replacementProducers, { notifyServer: false })
        discardCandidate()
        throw mediaResetError()
      }
      // Restoring the committed capture and tearing down the rejected
      // replacement producers touch disjoint resources, so run them together.
      const [restored] = await Promise.all([
        restoreCommitted(),
        disposeMicProducers(replacementProducers)
      ])
      if (!restored && isCurrent()) requestVoiceMediaRecovery('Microphone rollback failed')
      throw err
    }

    const oldProducerSet = new Set(audioProducers)
    producers = producers
      .filter((producer) => !oldProducerSet.has(producer))
      .concat(replacementProducers)
    for (const producer of replacementProducers) {
      localProducerIds.add(producer.id)
      if (micMuted) producer.pause()
    }
    // The server has already marked the old producer as replaced; sending a
    // second CloseProducer would race the signaling FIFO and report NotFound.
    for (const producer of audioProducers) {
      localProducerIds.delete(producer.id)
      const oldTrack = producer.track
      producer.close()
      oldTrack?.stop()
    }
    lastCommittedAudioProfile = audioProfile
    commitCandidate()
    console.log('[Soup] Audio profile changed; producer replaced')
    return
  }

  // Swap the track on each existing audio producer in place. The
  // server-side producer (and any consumers peers already created for it)
  // stays alive, so peers keep receiving the same producer id.
  try {
    for (let i = 0; i < audioProducers.length; i++) {
      const producer = audioProducers[i]
      const track = newTracks[i]
      if (!track || producer.closed) continue
      if (!isCurrent()) throw new Error('Voice transport reset during republish')

      const oldTrack = producer.track
      await producer.replaceTrack({ track })
      oldTrack?.stop()

      // Update bitrate on the existing RTP sender without renegotiating.
      // Opus fmtp profile fields are negotiated at produce() time; the ceiling
      // itself is still kept consistent with the shared helper.
      const sender = producer.rtpSender
      if (sender) {
        const params = sender.getParameters()
        if (params.encodings?.length) {
          params.encodings[0].maxBitrate = opusOptions.encodings[0].maxBitrate
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
  } catch (err) {
    if (!isCurrent()) {
      discardCandidate()
      throw mediaResetError()
    }

    const restored = await restoreCommitted()
    if (!restored && isCurrent()) requestVoiceMediaRecovery('Microphone rollback failed')
    throw err
  }

  commitCandidate()
  console.log('[Soup] Audio republished with new settings')
}

// Rebuild only the processing graph, on the capture that is already open.
//
// The expensive part of a republish is the capture, not the graph: Chromium
// requires the old source to be fully released before new constraints take
// effect, which costs a release, a settle delay, and a cold getUserMedia. When
// the constraints are identical none of that buys anything — the gate, RNNoise
// and the mono/stereo fold all live downstream of the raw track.
//
// The old graph deliberately stays live until every producer has taken the new
// track, so a failure anywhere here can put the previous tracks straight back
// rather than leaving a producer holding an ended one. Opus options can't change
// on this path (a profile change alters the capture, so it never gets here), so
// producers and their negotiated parameters are untouched.
async function doGraphOnlyRepublish({
  micSettings,
  onStream,
  audioProducers,
  rawStream,
  previousProcessorStop,
  isCurrent
}) {
  let processedStream = rawStream
  let candidateProcessorStop = () => {}
  try {
    const processed = await buildAudioProcessor(rawStream, micSettings)
    processedStream = processed.stream
    candidateProcessorStop = processed.stop
  } catch (err) {
    console.error('[Soup] republish audio processor failed:', err)
  }

  // Only the candidate graph is ours to tear down here — the raw capture is
  // still the committed one, feeding the live chain.
  const discardCandidate = () =>
    stopMicRepublishCandidate(
      null,
      processedStream === rawStream ? null : processedStream,
      candidateProcessorStop
    )

  // A reset can land while the graph was building; it closed the transport and
  // the producers, and its own publish will rebuild everything from scratch.
  if (!isCurrent()) {
    discardCandidate()
    throw mediaResetError()
  }

  const newTracks = processedStream.getTracks()
  if (newTracks.length !== audioProducers.length) {
    discardCandidate()
    throw new Error('Microphone track count changed during republish')
  }

  // Previous processed tracks, kept alive until the swap is complete so it can
  // be undone; stopped only once the whole transaction commits.
  const replaced = []
  try {
    for (let i = 0; i < audioProducers.length; i++) {
      const producer = audioProducers[i]
      const track = newTracks[i]
      if (!track || producer.closed) continue
      if (!isCurrent()) throw new Error('Voice transport reset during republish')

      const oldTrack = producer.track
      await producer.replaceTrack({ track })
      replaced.push({ producer, oldTrack })

      if (micMuted) producer.pause()
      else producer.resume()
      console.log(`[Soup] Rebuilt processing graph on producer [id:${producer.id}]`)
    }
  } catch (err) {
    if (!isCurrent()) {
      discardCandidate()
      throw mediaResetError()
    }
    // Put the still-running old graph back on everything we already swapped.
    for (const { producer, oldTrack } of replaced) {
      if (!oldTrack || oldTrack.readyState === 'ended' || producer.closed) continue
      try {
        await producer.replaceTrack({ track: oldTrack })
      } catch (restoreErr) {
        console.error('[Soup] Failed graph-only rollback:', restoreErr)
      }
    }
    discardCandidate()
    throw err
  }

  // A processor-build failure can leave the current producer on the raw capture
  // track. That same raw track is the input to the candidate graph, so stopping
  // it here would turn the newly installed graph silent. Destination tracks from
  // the old graph are still safe (and necessary) to stop after the swap.
  const rawTracks = new Set(rawStream.getTracks())
  for (const { oldTrack } of replaced) {
    if (!rawTracks.has(oldTrack)) oldTrack?.stop()
  }
  commitRepublishedMicProcessing({
    stream: rawStream,
    processedStream,
    processorStop: candidateProcessorStop,
    previousStop: previousProcessorStop,
    micSettings: micSettingsForPublishedStream(micSettings, processedStream),
    onStream
  })
  console.log('[Soup] Audio processing graph rebuilt without reopening the capture')
}

// ─── Subscribe: receive remote audio ────────────────────────────
// Promise lock — concurrent NewProducer events share one in-flight
// transport setup instead of each creating their own and stomping.
async function subscribe() {
  if (consumerTransport && !consumerTransport.closed) return
  if (consumerTransport?.closed) consumerTransport = null

  if (subscribePromise) {
    await subscribePromise
    return
  }

  const generation = mediaStateGeneration
  const setup = (async () => {
    const loadedDevice = await loadDevice(generation)
    if (generation !== mediaStateGeneration) throw mediaResetError()

    const rawParams = await send('CreateConsumerTransport')
    if (generation !== mediaStateGeneration) throw mediaResetError()
    const transport = loadedDevice.createRecvTransport({
      ...mapTransportParams(rawParams),
      iceServers
    })

    const isCurrentTransport = () =>
      generation === mediaStateGeneration && consumerTransport === transport && !transport.closed

    watchTransportConnectivity(transport, 'Consumer', isCurrentTransport)

    transport.on('connect', ({ dtlsParameters }, callback, errback) => {
      if (!isCurrentTransport()) {
        errback(mediaResetError())
        return
      }
      send('ConnectConsumerTransport', { dtlsParameters })
        .then(() => {
          if (!isCurrentTransport()) throw mediaResetError()
          callback()
        })
        .catch((err) => errback(err))
    })

    // A reset while we were setting up already tore the session down. Adopting
    // this transport would leave every later consume pointed at a dead one with
    // nothing to clear it.
    if (generation !== mediaStateGeneration) {
      transport.close()
      throw mediaResetError()
    }

    consumerTransport = transport
    console.log('[Soup] Consumer transport ready')
  })()
  subscribePromise = setup

  // The setup promise must never outlive its own failure: leaving a rejected
  // promise in `subscribePromise` makes every later consumeProducer re-await the
  // same rejection, so one transient signaling error would kill all remote
  // consumption until a full media reset. `consumerTransport` needs no unwinding
  // here — the setup above publishes it only once it is fully built and still
  // current, and closes it itself otherwise.
  try {
    await setup
  } finally {
    // Only clear our own registration: a reset may have nulled it already and a
    // newer subscribe() may own the slot by now.
    if (subscribePromise === setup) subscribePromise = null
  }
}

// ─── Inbound audio health poll ───────────────────────────────────
// Start the shared health interval if it isn't already running. Called whenever
// an audio entry is registered; the tick stops itself once no audio entries
// remain, so only ever a single interval spins.
function startAudioHealthMonitor() {
  if (audioHealthTimer != null) return
  audioHealthTimer = setInterval(runAudioHealthTick, AUDIO_HEALTH_INTERVAL_MS)
}

function stopAudioHealthMonitor() {
  if (audioHealthTimer != null) {
    clearInterval(audioHealthTimer)
    audioHealthTimer = null
  }
}

function runAudioHealthTick() {
  const audioEntries = [...remoteConsumers.entries()].filter(([, entry]) => entry.kind === 'audio')
  // Nothing left to watch — release the interval; consumeProducer restarts it on
  // the next audio arrival.
  if (audioEntries.length === 0) {
    stopAudioHealthMonitor()
    return
  }
  for (const [producerId, entry] of audioEntries) {
    // Fire-and-forget: each entry is evaluated independently and swallows its own
    // errors, so a getStats reject on one doesn't stall the others.
    void evaluateAudioHealth(producerId, entry)
  }
}

// Record a heal action for backoff: stamp the time and double the cooldown
// (start at BASE, cap at MAX). Kept in audioHealHistory (outside the entry) so a
// full re-consume, which replaces the entry, can't reset the backoff.
function recordHeal(producerId, now) {
  const prev = audioHealHistory.get(producerId)
  const cooldownMs = prev
    ? Math.min(prev.cooldownMs * 2, AUDIO_HEAL_MAX_COOLDOWN_MS)
    : AUDIO_HEAL_BASE_COOLDOWN_MS
  audioHealHistory.set(producerId, { lastHealAt: now, cooldownMs })
}

// Pull one WebRTC stats sample for an audio consumer, compute WINDOWED (this
// interval only) delay/stall metrics, accumulate strikes, and take at most one
// repair action per tick (respecting the per-producer cooldown/backoff).
async function evaluateAudioHealth(producerId, entry) {
  let report
  try {
    report = await entry.consumer.getStats()
  } catch {
    // getStats can reject transiently around consumer teardown — skip this tick.
    return
  }
  // The entry may have been removed or healed (replaced) while getStats was in
  // flight — don't record stats onto a stale entry.
  if (remoteConsumers.get(producerId) !== entry) return

  let inbound = null
  let playout = null
  for (const stat of report.values()) {
    if (stat.type === 'inbound-rtp' && stat.kind === 'audio') inbound = stat
    else if (stat.type === 'media-playout') playout = stat
  }
  if (!inbound) return

  const health = entry.health ?? (entry.health = {})
  const prev = health.prev
  const cur = {
    jitterBufferDelay: inbound.jitterBufferDelay,
    jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
    packetsReceived: inbound.packetsReceived,
    concealedSamples: inbound.concealedSamples,
    totalSamplesReceived: inbound.totalSamplesReceived,
    totalPlayoutDelay: playout?.totalPlayoutDelay,
    totalSamplesCount: playout?.totalSamplesCount,
    timestamp: inbound.timestamp
  }
  health.prev = cur

  // First tick for an entry only records baselines — no deltas to evaluate yet.
  if (!prev) return

  const dPackets = cur.packetsReceived - prev.packetsReceived
  const havePlayout =
    cur.totalPlayoutDelay != null &&
    prev.totalPlayoutDelay != null &&
    cur.totalSamplesCount != null &&
    prev.totalSamplesCount != null
  const dPlayoutDelay = havePlayout ? cur.totalPlayoutDelay - prev.totalPlayoutDelay : null
  const dPlayoutSamples = havePlayout ? cur.totalSamplesCount - prev.totalSamplesCount : null

  const jbDelayMs = jitterBufferAvgMs(cur.jitterBufferDelay, cur.jitterBufferEmittedCount, prev)
  const jbDelaySec = jbDelayMs != null ? jbDelayMs / 1000 : null
  const dJbEmitted = cur.jitterBufferEmittedCount - prev.jitterBufferEmittedCount
  const playoutDelaySec =
    dPlayoutSamples != null && dPlayoutSamples > 0 ? dPlayoutDelay / dPlayoutSamples : null
  // RTP still arriving but the jitter buffer isn't emitting any samples → playout
  // stalled. Requires dPackets > 0, so deafen (server pauses the producer) and
  // DTX silence — both of which send no packets — can never trip this.
  const stalled = dPackets > 0 && dJbEmitted === 0

  // Bump the matching strike counter when bad this window, reset to 0 when
  // measurably good, leave unchanged when the metric was unavailable.
  if (jbDelaySec != null) {
    health.jbStrikes = jbDelaySec > AUDIO_HEALTH_BAD_DELAY_SEC ? (health.jbStrikes ?? 0) + 1 : 0
  }
  if (playoutDelaySec != null) {
    health.playoutStrikes =
      playoutDelaySec > AUDIO_HEALTH_BAD_DELAY_SEC ? (health.playoutStrikes ?? 0) + 1 : 0
  }
  // The stall condition always resolves this window (both deltas are known).
  health.stallStrikes = stalled ? (health.stallStrikes ?? 0) + 1 : 0

  if (import.meta.env.DEV) {
    console.log(
      `[Soup] audio health [${producerId}] jb=${jbDelaySec?.toFixed(3) ?? 'n/a'}s ` +
        `playout=${playoutDelaySec?.toFixed(3) ?? 'n/a'}s stalled=${stalled} ` +
        `strikes(jb=${health.jbStrikes ?? 0},playout=${health.playoutStrikes ?? 0},` +
        `stall=${health.stallStrikes ?? 0})`
    )
  }

  // Respect the per-producer cooldown before acting; keep strikes as they are.
  const now = Date.now()
  const backoff = audioHealHistory.get(producerId)
  if (backoff && now - backoff.lastHealAt < backoff.cooldownMs) return

  // Priority 1: a stall or jitter-buffer bloat lives inside the RTCRtpReceiver;
  // only recreating the consumer resets it → full re-consume.
  if (
    (health.stallStrikes ?? 0) >= AUDIO_HEALTH_STRIKES ||
    (health.jbStrikes ?? 0) >= AUDIO_HEALTH_STRIKES
  ) {
    const reason =
      (health.stallStrikes ?? 0) >= AUDIO_HEALTH_STRIKES
        ? `playout stalled (${health.stallStrikes} bad windows, ${dPackets} pkts/no emit)`
        : `jitter buffer delay ${jbDelaySec?.toFixed(3)}s`
    recordHeal(producerId, now)
    await healAudioConsumer(producerId, reason)
    return
  }

  // Priority 2: playout-path bloat is local — rebuild the Web Audio graph. If a
  // rebuild already happened once and playout trips AGAIN, escalate to a full
  // re-consume instead of rebuilding a second time.
  if ((health.playoutStrikes ?? 0) >= AUDIO_HEALTH_STRIKES) {
    if (health.rebuilt) {
      recordHeal(producerId, now)
      console.warn(
        `[Soup] audio playout still degraded after rebuild [${producerId}] ` +
          `${playoutDelaySec?.toFixed(3)}s — escalating to re-consume`
      )
      await healAudioConsumer(
        producerId,
        `playout delay ${playoutDelaySec?.toFixed(3)}s (post-rebuild)`
      )
      return
    }
    recordHeal(producerId, now)
    console.warn(
      `[Soup] audio playout delay ${playoutDelaySec?.toFixed(3)}s [${producerId}] — rebuilding graph`
    )
    teardownAudioGraph(entry)
    buildAudioGraph(entry)
    applyAllAudioState()
    health.playoutStrikes = 0
    health.rebuilt = true
  }
}

// Full re-consume: tear the consumer + audio graph down and consume the producer
// fresh. Needed when the bloat is inside the receiver's jitter buffer, which a
// local graph rebuild cannot reset.
async function healAudioConsumer(producerId, reason) {
  const entry = remoteConsumers.get(producerId)
  if (!entry || entry.kind !== 'audio') return
  if (ws?.readyState !== WebSocket.OPEN) return
  if (!consumerTransport || consumerTransport.closed) return
  if (audioHealsInFlight.has(producerId)) return
  audioHealsInFlight.add(producerId)

  console.warn(`[Soup] Healing audio consumer [${producerId}]: ${reason}`)
  try {
    // Remove + tear down locally FIRST: a racing ProducerClosed then finds no
    // entry and stays a no-op, and the fresh consume starts from a clean slate.
    removeRemoteConsumer(producerId)
    await closeServerConsumers([entry.consumerId])
    // Recreates the consumer, <audio> element, graph, detector, and re-applies
    // gain exactly like a fresh arrival.
    await consumeProducer(
      producerId,
      'audio',
      activeCallbacks.onVideoStream,
      entry.clientId,
      entry.producedType
    )
  } catch (err) {
    // If the producer died meanwhile (race with ProducerClosed), the server
    // rejects the Consume and we're already cleaned up locally — nothing to do.
    console.error(`[Soup] Audio heal failed [${producerId}]:`, err)
  } finally {
    audioHealsInFlight.delete(producerId)
    // NewProducer is edge-triggered. If the replacement failed transiently but
    // the producer still belongs to this generation, put it back on the bounded
    // consume retry path instead of leaving that peer permanently silent.
    ensureAudioConsumer(producerId)
  }
}

function setAudioJitterBufferTarget(consumer, kind, producedType) {
  // producedType is carried through signaling because producer appData is not
  // present on the remote Consumer. Keep this strictly audio-only: video
  // receivers must not inherit an audio latency target.
  if (kind !== 'audio') return
  const targetMs = producedType === 'Audio' ? 60 : producedType === 'ScreenShareAudio' ? 120 : null
  if (targetMs == null) return

  const receiver = consumer?.rtpReceiver
  if (!receiver || !('jitterBufferTarget' in receiver)) return
  try {
    receiver.jitterBufferTarget = targetMs
    console.log(`[Soup] Audio jitter buffer target set to ${targetMs}ms (${producedType})`)
  } catch (err) {
    // Browser support is experimental and may expose a read-only/clamped
    // implementation. The reactive 5s health self-heal remains the backstop.
    console.warn('[Soup] Failed to set audio jitter buffer target:', err)
  }
}

// Consumer RTP parameters are the negotiated source of truth for selectable
// layers. SVC encodes its counts in scalabilityMode (which is one-based), while
// H.264 simulcast exposes one RTP encoding per spatial layer. Convert both to
// the zero-based layer indexes expected by mediasoup's preferred-layers API.
function consumerLayerCapabilities(rtpParameters) {
  const encodings = rtpParameters?.encodings ?? []
  let maxSpatial = Math.max(0, encodings.length - 1)
  let maxTemporal = 0

  for (const encoding of encodings) {
    const { spatialLayers, temporalLayers } = parseScalabilityMode(encoding.scalabilityMode)
    maxSpatial = Math.max(maxSpatial, spatialLayers - 1)
    maxTemporal = Math.max(maxTemporal, temporalLayers - 1)
  }

  return { maxSpatial, maxTemporal }
}

// ─── Consume a remote producer ───────────────────────────────────
// Registered in `pendingConsumes` for its whole lifetime so the watch
// bookkeeping can see a consume that hasn't landed yet (see watchIntent.js).
function consumeProducer(producerId, kind, onStream, clientId, producedType) {
  const existing = pendingConsumes.get(producerId)
  if (existing) return existing
  const active = remoteConsumers.get(producerId)
  if (active) {
    return Promise.resolve({
      stream: active.stream,
      kind: active.kind,
      consumerId: active.consumerId
    })
  }
  const pending = doConsumeProducer(producerId, kind, onStream, clientId, producedType).finally(
    () => {
      // Only clear our own registration — a later consume for the same producer
      // (a self-heal re-consume, say) may already own the slot.
      if (pendingConsumes.get(producerId) === pending) {
        pendingConsumes.delete(producerId)
      }
    }
  )
  pendingConsumes.set(producerId, pending)
  return pending
}

async function discardUncommittedConsumer(consumer, generation, transport) {
  consumer.close()
  if (
    generation !== mediaStateGeneration ||
    consumerTransport !== transport ||
    ws?.readyState !== WebSocket.OPEN
  )
    return
  try {
    await send('CloseConsumer', { ids: [consumer.id] })
  } catch (cleanupError) {
    console.warn(`[Soup] Failed to clean up consumer ${consumer.id}:`, cleanupError)
  }
}

async function doConsumeProducer(producerId, kind, onStream, clientId, producedType) {
  const generation = mediaStateGeneration
  if (!consumerTransport) await subscribe()
  const transport = consumerTransport
  if (!transport || generation !== mediaStateGeneration || transport.closed) throw mediaResetError()

  const consumerParams = await send('Consume', {
    id: producerId,
    rtp_params: device.recvRtpCapabilities
  })

  if (consumerParams.error) {
    throw new Error(`Cannot consume producer ${producerId}: ${consumerParams.error}`)
  }

  if (generation !== mediaStateGeneration || consumerTransport !== transport || transport.closed) {
    throw mediaResetError()
  }

  const consumer = await transport.consume({
    id: consumerParams.id,
    producerId: consumerParams.producer_id,
    kind: consumerParams.kind,
    rtpParameters: consumerParams.rtp_parameters
  })

  if (generation !== mediaStateGeneration || consumerTransport !== transport || transport.closed) {
    consumer.close()
    throw mediaResetError()
  }

  // Set once before ResumeConsumer so the first decoded packets use the
  // requested target. Re-consumes from audio self-heal come through this same
  // function automatically.
  setAudioJitterBufferTarget(consumer, kind, producedType)

  const layerCapabilities = consumerLayerCapabilities(consumer.rtpParameters)
  const hasSelectableLayers = layerCapabilities.maxSpatial > 0 || layerCapabilities.maxTemporal > 0

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
  try {
    if (kind === 'audio') {
      await send('ResumeConsumer', { id: consumer.id })
      console.log(`[Soup] Consumer resumed [id:${consumer.id}]`)
    } else {
      await send('PauseConsumer', { id: consumer.id })
      console.log(`[Soup] Video consumer created paused [id:${consumer.id}]`)
    }
  } catch (err) {
    // The server has already allocated this consumer.  Do not leave a failed
    // Resume/Pause attempt as an untracked local receiver while the retry creates
    // another one.  When signaling is still current, close the server half in the
    // same response queue before retrying; a socket-reset path tears it down there.
    await discardUncommittedConsumer(consumer, generation, transport)
    throw err
  }

  if (generation !== mediaStateGeneration || consumerTransport !== transport || transport.closed) {
    consumer.close()
    throw mediaResetError()
  }

  // Build the entry up front so the audio graph, cleanup, and a later
  // health-driven rebuild can all reference it (a rebuild reuses entry.stream).
  const entry = {
    consumer,
    consumerId: consumer.id,
    kind,
    clientId,
    producedType,
    stream,
    cleanup: null,
    audioEl: null,
    gain: null
  }

  if (kind === 'audio') {
    // A muted <audio> element keeps the remote WebRTC track pulled; the audible
    // playback goes through Web Audio so per-client volume can exceed 100%. The
    // element stays OUTSIDE the rebuildable graph (buildAudioGraph) — it is not
    // part of the drift problem and must keep pulling the track continuously,
    // even across a health-driven graph rebuild.
    const audioEl = document.createElement('audio')
    try {
      audioEl.srcObject = stream
      audioEl.autoplay = true
      audioEl.muted = true
      document.body.appendChild(audioEl)
      audioEl.play().catch((err) => console.error('[Soup] Audio pump play failed:', err))
      entry.audioEl = audioEl

      // Rebuildable part: source -> gain -> destination (+ speaking detector).
      buildAudioGraph(entry)

      entry.cleanup = () => {
        teardownAudioGraph(entry)
        audioEl.pause()
        audioEl.srcObject = null
        audioEl.remove()
      }
    } catch (err) {
      teardownAudioGraph(entry)
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
      await discardUncommittedConsumer(consumer, generation, transport)
      throw err
    }
  } else if (kind === 'video') {
    // If this client already had a video producer (e.g. restarted screen
    // share before a ProducerClosed notice arrived), close out the stale
    // consumer/tile before adding the new one.
    for (const [pid, existing] of remoteConsumers) {
      if (existing.kind === 'video' && existing.clientId === clientId && pid !== producerId) {
        removeRemoteConsumer(pid)
        knownVideoProducers.delete(pid)
        activeCallbacks.onStreamEnded?.(pid, {
          replaced: true,
          clientId: existing.clientId,
          producedType: existing.producedType
        })
        break
      }
    }
    // Video is consumed paused above, so seed its bookkeeping as hidden/paused
    // — setVideoStreamRoles() will resume it only when a view role asks for it.
    entry.serverPaused = true
    entry.viewRole = 'hidden'
    entry.hasSelectableLayers = hasSelectableLayers
    entry.layerCapabilities = layerCapabilities
    onStream?.({
      stream,
      kind,
      consumerId: consumer.id,
      // Carried so the UI can look this tile up in the viewer map, which the
      // server keys by producer (one producer, many consumers watching it).
      producerId,
      clientId,
      codec: codecLabel(consumer.rtpParameters)
    })
  }

  // Never silently overwrite an existing entry: its consumer and Web Audio graph
  // would keep pulling RTP with nothing left pointing at them. Close-then-replace
  // instead, and tell the server so the stale consumer doesn't linger there too.
  const superseded = remoteConsumers.get(producerId)
  if (superseded) {
    console.warn(`[Soup] Replacing an existing consumer for producer ${producerId}`)
    removeRemoteConsumer(producerId)
    await closeServerConsumers([superseded.consumerId])
  }

  remoteConsumers.set(producerId, entry)

  if (kind === 'audio') {
    // Lazily spin up the shared inbound-audio health poll (no-op if running).
    startAudioHealthMonitor()
    applyAllAudioState()
  }

  console.log(`[Soup] Consuming ${kind} [id:${consumer.id}]`)
  return { stream, kind, consumerId: consumer.id }
}

// ─── Bandwidth rationing: per-stream view roles ──────────────────
// Drives server-side layer selection + pausing from the UI's current view so
// we don't pull every screen share at full 4K at once. Each consumer's
// negotiated RTP parameters define its actual spatial/temporal layer limits;
// the server forwards only the layer a given consumer asks for.
//
// REQUIRES matching server handlers (same style as Consume / ResumeConsumer):
//   SetConsumerPreferredLayers { id, spatial_layer, temporal_layer }
//       → serverConsumer.setPreferredLayers({ spatialLayer, temporalLayer })
//   PauseConsumer  { id } → serverConsumer.pause()
//   ResumeConsumer { id } → serverConsumer.resume()   (already implemented)
// All three must send a response, since send() awaits one.
function layersForViewRole(entry, role) {
  const { maxSpatial = 0, maxTemporal = 0 } = entry.layerCapabilities ?? {}

  if (role === 'thumbnail') return { spatialLayer: 0, temporalLayer: 0 }
  if (role === 'grid') {
    // A screen with L1Tx has no spatial tier to drop, so retain its only
    // resolution. SVC cameras use their middle layer; two-encoding simulcast
    // cameras retain their full layer for grid tiles as negotiated.
    return { spatialLayer: Math.min(1, maxSpatial), temporalLayer: maxTemporal }
  }
  return { spatialLayer: maxSpatial, temporalLayer: maxTemporal }
}

// Ask the server to forward only the given selectable layers for this consumer.
// The acknowledged preference is cached only after the server accepts it. A
// separate desired value makes role flips while a request is pending converge
// to the latest role without ever treating an unacknowledged request as cached.
function setConsumerPreferredLayers(entry, { spatialLayer, temporalLayer }) {
  if (!entry.hasSelectableLayers) return
  const layers = { spatialLayer, temporalLayer }
  entry.desiredPreferredLayers = layers

  if (entry.preferredLayersPending) return
  if (entry.preferredSpatial === spatialLayer && entry.preferredTemporal === temporalLayer) return

  entry.preferredLayersPending = true
  send('SetConsumerPreferredLayers', {
    id: entry.consumerId,
    spatial_layer: spatialLayer,
    temporal_layer: temporalLayer
  })
    .then(() => {
      entry.preferredSpatial = spatialLayer
      entry.preferredTemporal = temporalLayer
    })
    .catch((err) => {
      // Never leave an optimistic value behind: a later role application can
      // retry this request instead of assuming the server accepted it.
      entry.preferredSpatial = undefined
      entry.preferredTemporal = undefined
      console.warn('[Soup] SetConsumerPreferredLayers failed:', err)
    })
    .finally(() => {
      entry.preferredLayersPending = false
      const desired = entry.desiredPreferredLayers
      if (
        desired &&
        (desired.spatialLayer !== spatialLayer || desired.temporalLayer !== temporalLayer)
      ) {
        setConsumerPreferredLayers(entry, desired)
      }
    })
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

    const roleChanged = entry.viewRole !== role
    entry.viewRole = role

    if (role === 'hidden') {
      if (roleChanged) pauseVideoConsumer(entry)
    } else {
      // Set the forwarding tier while still paused, then resume. Requests are
      // serialized by the signaling FIFO, so a layered consumer cannot briefly
      // burst at its default highest layer before the preference takes effect.
      setConsumerPreferredLayers(entry, layersForViewRole(entry, role))
      if (roleChanged) resumeVideoConsumer(entry) // no-op unless server-paused
    }
  }
}

// ─── Reset all media state ───────────────────────────────────────
function resetMediaState() {
  mediaStateGeneration++
  rawMicEndedRepairGeneration = null
  clearMediaWatchdog()
  clearMediaReadyTimer()
  emitMediaState('reconnecting')
  selfSpeakingStop?.()
  selfSpeakingStop = null
  mutedTalkStop?.()
  mutedTalkStop = null
  resetActiveScreenShare()
  // Some profile-replacement producers intentionally use stopTracks:false so
  // a failed produce can be cleaned up transactionally. Take explicit ownership
  // at reset as well; the transport alone cannot stop those tracks.
  for (const producer of producers) {
    const track = producer.track
    producer.close()
    track?.stop()
  }
  producerTransport?.close()
  producerTransport = null
  consumerTransport?.close()
  consumerTransport = null
  stopScreenEncoderStats()
  producers = []
  localProducerIds.clear()
  knownVideoProducers.clear()
  knownScreenAudioProducers.clear()
  knownAudioProducers.clear()
  for (const producerId of audioConsumeRetryTimers.keys()) clearAudioConsumeRetry(producerId)
  audioConsumeRetryTimers.clear()
  audioConsumeRetryAttempts.clear()
  // Watch intent lives in the UI (React) and is re-asserted via setWatchedProducers
  // once producers replay after a reconnect/channel switch, so start from empty.
  watchedClientIds = new Set()
  watchedProducerIds = new Set()
  // In-flight consumes belong to the session being torn down. Their promises
  // reject (or resolve against a dead transport) on their own; dropping the
  // registrations here keeps the next session's bookkeeping clean.
  pendingConsumes.clear()
  // Audience is per-channel and replayed by NewConsumer on the next join, so a
  // channel switch must start from empty rather than showing the old room's.
  clearViewers()
  device = null
  deviceLoadInFlight = null
  stopAudioProcessor()
  // Release the raw mic capture — the producers above are closed, so no live
  // producer references it anymore (nothing to keep the OS mic open for).
  const releasedRawMicStream = rawMicStream
  setRawMicStream(null)
  stopRawStream(releasedRawMicStream)
  lastCommittedMicSettings = null
  lastCommittedAudioProfile = null
  // Idle the shared mic context between sessions; the next publish resumes it.
  suspendMicContext()
  subscribePromise = null
  // Stop the audio health poll and drop all its per-producer state. Per-entry
  // health rides on the entries themselves, cleared by remoteConsumers.clear().
  stopAudioHealthMonitor()
  audioHealHistory.clear()
  audioHealsInFlight.clear()
  for (const producerId of remoteConsumers.keys()) removeRemoteConsumer(producerId)
  resetFocusedScreenAudio()
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
  // Each mute starts a fresh warning budget, so muting and immediately talking
  // is always warned about even if the last warning was seconds ago.
  if (muted) lastTalkingWhileMutedAt = 0
  producers.filter((p) => p.kind === 'audio').forEach((p) => (muted ? p.pause() : p.resume()))
}
