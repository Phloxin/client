// ─── Imports ────────────────────────────────────────────────────
import { Device } from 'mediasoup-client'
import { voiceSocketUrl } from '../serverConfig'
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
  isPermanentMicError,
  nextAudioConsumeRetryDelay,
  shouldKickVoiceReconnect,
  voiceSocketRecoveryAction
} from '../voiceRecoveryState'
import { configureMediaDevices, shortDeviceId, subscribeDeviceChange } from '../mediaDevices'
import { createSerialQueue } from '../serialQueue'
import { codecLabel, jitterBufferAvgMs } from '../streamStats'
import {
  acquireMicCapture,
  buildAudioProcessor,
  createSpeakingDetector,
  onMicContextLost,
  stopRawStream,
  suspendMicContext
} from './localAudio'
import {
  applyAllAudioState,
  buildAudioGraph,
  configurePlayback,
  getPlaybackContext,
  playbackDiagnostics,
  teardownAudioGraph
} from './playback'
import {
  applyChannelCodecs,
  configureScreenShare,
  endShareFromServer,
  getScreenShareContext,
  resetActiveScreenShare,
  stopScreenEncoderStats
} from './screenShare'
import { configureStreamDiagnostics } from './streamDiagnostics'
import { configureTestHooks } from '../testHooks'
import {
  e2eeFormats,
  e2eeGroupEvent,
  e2eeJoin,
  e2eeLeave,
  e2eeMediaReady,
  e2eeResume,
  e2eeSuspend,
  setE2eeHandlers,
  wrapRecvTransport,
  wrapSendTransport
} from '../e2ee'
import {
  CloseAction,
  CloseCode,
  Direction,
  EVENT_TYPES,
  Request,
  SourceType,
  SpeakingFlags,
  StreamDirectory,
  StreamOp,
  StreamRequest,
  VoiceChannelState,
  classifyClose,
  createEventCursor,
  createRequestMatcher,
  createStreamRequests,
  decodeFrame,
  mapTransportParams,
  producedTypeForSource,
  sinkConfigChanges,
  sinkConfigForViewRole,
  sinkLayerCapabilities,
  sourceMediaKind,
  sourceTypeForAppData,
  ViewRole,
  VoiceRequestError,
  VoiceTicketError,
  viewRoleFor,
  voiceTicketError
} from './protocol'

export {
  acquireMicCapture,
  createLevelGateController,
  createMicLevelMonitor,
  setVolumeGateThreshold
} from './localAudio'
export {
  getAllStreamAudioState,
  getClientAudioState,
  getStreamAudioState,
  setClientAudioState,
  setMasterVolume,
  setOutputDevice,
  setSoundMuted,
  setStreamAudioState,
  subscribeStreamAudio
} from './playback'
export {
  resetCameraCodecPreference,
  resetScreenCodecPreference,
  setSharePaused,
  shareCamera,
  shareScreen,
  stopScreenShare
} from './screenShare'
export { startStreamDebugStats, startVoiceConnectionStats } from './streamDiagnostics'

// This module drives mediasoup-client over the pylon-voice v1 signaling
// protocol. The wire format itself (encoders, answer matching, channel state,
// close codes, and the event-socket stream ops) lives in ./protocol.js;
// nothing here builds a frame by hand.
//
// Screen streams need the backend's say-so, given on the event socket that
// Main owns: it hands this module a sender and routes the stream replies and
// events here (see "Screen streams" below). Webcams and microphones need none.

// ─── State ──────────────────────────────────────────────────────
let device = null
let ws = null
// The live session's signaling (createSignal): its matcher (which also hands
// out the session's LocalIds), its place in the event stream, and whether the
// session has reached READY (its first Channel snapshot). One per session,
// kept across a resume; null between sessions.
let signal = null
// Both transports arrive with RoutingParams; the server creates them when we
// identify, so there is nothing to allocate on demand.
let producerTransport = null
let consumerTransport = null
let producers = []
const localProducerIds = new Set()
// Our own server sources (the mic, and anything screenShare publishes) by
// LocalId. Closed { nodes } can name them, so they need a node → type lookup.
const localSources = new Map() // LocalId -> SourceType
// Sources a CreateSource { replaces } in flight is swapping out. The server
// closes each one with a Closed ahead of the Source answer, which is the
// hand-over rather than a loss, so closeNodes leaves it to createSource.
const sourceReplacements = new Map() // LocalId -> { closed }
// The pause we last asked for on our own non-mic sources (SetSourcePaused), so
// a resume can restate one the node missed.
const localSourcePaused = new Map() // LocalId -> paused
// Sources whose SetSourcePaused was refused while the socket was down; sent
// again once the session is resumed (afterResume).
const unsentSourcePauses = new Set() // LocalId
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
// Detector on the processing chain's output node (stays live while muted,
// unlike the published track), used to warn when we talk while muted, and as
// the speaking source when there is no volume gate. Its warning handler is set
// from the UI layer.
let mutedTalkStop = null
let onTalkingWhileMuted = null
let lastTalkingWhileMutedAt = 0
// The warning is a toast plus a chime, so it nags rather than informs if it
// repeats every couple of seconds. Long enough that continuous talking gets
// re-warned occasionally; the count resets on each fresh mute (setMicMuted).
const TALKING_WHILE_MUTED_COOLDOWN_MS = 10_000
// Set while a publish() is mid-flight so a concurrent caller joins the same
// promise instead of producing a second mic. { generation, promise }. A publish
// started before a reset is never allowed to satisfy callers in the new session.
let publishInFlight = null
// Republish serializes the entire capture -> processing -> producer update
// transaction. The mic-acquisition queue alone only protects getUserMedia; without this
// queue, rapid settings changes can replace tracks out of order.
const enqueueRepublish = createSerialQueue()
// Invalidates work that was queued or awaiting media after a reset (socket
// close). A stale operation must not attach its capture to a newer session.
let mediaStateGeneration = 0
let activeCallbacks = {}
let micMuted = false
// The settings mic test is playing our mic back to us, so peers must not hear
// it. Silences the published mic like micMuted, without touching the user's
// own mute toggle (or the talking-while-muted warning, which follows that).
let micTestActive = false
const micSilenced = () => micMuted || micTestActive
// What the current speaking source says, and the SpeakingFlags last sent on
// this session (null: nothing sent yet).
let localSpeaking = false
let sentSpeakingFlags = null
// Our client id (setVoiceSelf), and whether our own ring is shown.
let selfId = null
let ownRingShown = false
// Sinks we hold, keyed by the id of the *source* they receive: its NodeId
// string, which is what mediasoup-client and the UI call a producer id (see
// "Remote sources").
const remoteConsumers = new Map()
// sink LocalId -> source id, for matching Closed { nodes } to the entry it
// ends. The Sink answer doesn't name its source, so this is the only link.
// Filled as soon as CreateSink answers, so a Closed racing setup is caught too.
const sinkSources = new Map()
// The media-side view of the current channel: Channel snapshot plus deltas.
const channelState = new VoiceChannelState()

configurePlayback({
  getRemoteConsumers: () => remoteConsumers
})
configureMediaDevices({
  getSelectedInputId: () => lastCommittedMicSettings?.deviceId ?? null
})
configureScreenShare({
  getDevice: () => device,
  getProducerTransport: () => producerTransport,
  getCallbacks: () => activeCallbacks,
  closeServerProducer,
  videoCodecAllowed: (mimeType) => channelState.allowsVideo(mimeType),
  createStream: createOwnStream,
  releaseStream: releaseOwnStream,
  setSourcePaused: setServerSourcePaused,
  localProducerIds
})
configureStreamDiagnostics({
  getProducerTransport: () => producerTransport,
  getConsumerTransport: () => consumerTransport,
  getProducers: () => producers,
  getScreenShareContext,
  getRemoteConsumers: () => remoteConsumers
})
configureTestHooks({
  getRemoteConsumers: () => remoteConsumers,
  getProducers: () => producers,
  getScreenShareContext,
  dropVoiceSocket: () =>
    forceVoiceReconnect('Test harness dropped the voice socket', CloseAction.Resume)
})

// ─── Inbound audio health monitoring / self-heal ─────────────────
// A remote voice's receive path can degrade over time (jitter buffer bloat or a
// stalled playout FIFO), leaving audio delayed/crackling until the remote peer
// leaves and rejoins. We poll each audio consumer's WebRTC stats and rebuild
// the local Web Audio graph when the bloat is in the playout path. Bloat inside
// the receiver's jitter buffer needs a full re-consume (healAudioConsumer).
const AUDIO_HEALTH_INTERVAL_MS = 5000
// Windowed avg delay considered pathological. Voice no longer pins a jitter
// buffer target (see setAudioJitterBufferTarget), so NetEq is free to hold
// several hundred ms on a genuinely jittery peer — that is it working, not
// failing. Only multi-second delay is unambiguously broken.
const AUDIO_HEALTH_BAD_DELAY_SEC = 1.0
const AUDIO_HEALTH_STRIKES = 2 // consecutive bad windows before acting
const AUDIO_HEAL_BASE_COOLDOWN_MS = 30_000
const AUDIO_HEAL_MAX_COOLDOWN_MS = 300_000
let audioHealthTimer = null
// sourceId -> { lastHealAt, cooldownMs }. Lives OUTSIDE the consumer entry so
// replacing the entry cannot reset the backoff.
const audioHealHistory = new Map()

// ─── Reconnection state ──────────────────────────────────────────
// Recovery has three steps, each falling back to the next, all retried with a
// growing, randomized delay (capped):
//   - the voice connection drops: the server keeps our session for a short
//     while and we pick it back up on a new connection. Nothing is torn down
//     and others see no change.
//   - the server won't let us pick it back up, or the session ended: we ask for
//     a fresh ticket and start a new session, still in the channel. Other
//     people's media comes back with the channel snapshot, and our mic is
//     published again.
//   - nothing works for VOICE_GIVE_UP_MS: leave the channel and say so.
// What each close code calls for is classifyClose's CloseAction.
const VOICE_RECONNECT_BASE_DELAY_MS = 1000
const VOICE_RECONNECT_MAX_DELAY_MS = 30000
// Socket open → READY (the first Channel). The node waits up to 5s for the
// backend's ticket push before it sends anything, so this has to cover that.
const VOICE_ESTABLISH_TIMEOUT_MS = 20000
// Socket open → Resumed and the Done behind its replay. The node waits up to 5s
// for a still-attached socket to hand the session over.
const VOICE_RESUME_TIMEOUT_MS = 10000
const VOICE_REQUEST_TIMEOUT_MS = 15000
// A join that never reaches READY is retried (each retry with a new ticket, op
// 13) until this many attempts have failed, then reported.
const INITIAL_CONNECT_ATTEMPTS = 3
let reconnectAttempts = 0
let reconnectTimer = null
let reconnectInFlight = false // an attempt is mid-flight; don't start a second
let intentionalClose = false // set by disconnect() so onclose won't reconnect
let everReady = false // only auto-reconnect drops of a session that reached READY
// Invalidates a ticket wait/socket open that outlives disconnect followed by a
// new join, so an old attempt can't install a socket for the new session.
let voiceConnectionGeneration = 0
// Why the current recovery started, and which step it's on. Both exist for
// the log export, so a reconnect failure can tell a dead events socket from a
// ticket or identify failure.
let lastVoiceReconnectReason = null
let voiceConnectStep = null
// What onDisconnect should report when the socket's close handler delivers it
// (set when we give up on voice rather than the user leaving).
let pendingDisconnectInfo = undefined
let currentSocketCloseHandler = null
let socketCloseDeadlineTimer = null
let mediaWatchdogTimer = null
let mediaReadyTimer = null
let mediaWatchdogRecoveryUsed = false
// The last capture attempt failed because the device isn't there (a headset
// unplugged mid-call), not because of a permission. The session is fine, so
// the watchdog must not spend a reconnect on it. Cleared once a capture is
// installed again.
let localCaptureLost = false
const MEDIA_WATCHDOG_DELAY_MS = 15000
// Re-arm interval once a check has already found media degraded. Longer than
// the first pass, so a session that stays broken reports periodically instead
// of filling the export.
const MEDIA_WATCHDOG_DEGRADED_DELAY_MS = 30000
// Brings an armed check forward when something it waits on may have changed.
const MEDIA_WATCHDOG_DEVICE_DELAY_MS = 3000
const MEDIA_READY_SETTLE_MS = 300
// How long a transport that was connected may sit disconnected before its ICE
// is restarted. ICE often recovers by itself from a brief path change.
const TRANSPORT_DISCONNECTED_GRACE_MS = 4000

function clearMediaWatchdog() {
  if (mediaWatchdogTimer != null) clearTimeout(mediaWatchdogTimer)
  mediaWatchdogTimer = null
}

function clearMediaReadyTimer() {
  if (mediaReadyTimer != null) clearTimeout(mediaReadyTimer)
  mediaReadyTimer = null
}

function emitMediaState(state, details = {}) {
  activeCallbacks.onMediaState?.({
    state,
    generation: mediaStateGeneration,
    ...details
  })
}

function remoteAudioIsReady() {
  return (
    channelState.hasSnapshot &&
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

// Ready means the session is READY, the Channel snapshot is applied, our mic is
// live on a connected send transport, and every microphone in the channel has
// a sink. The short settle keeps it from flapping while a snapshot's sinks are
// still landing; every sink completion re-evaluates.
function scheduleMediaReadyCheck(generation = mediaStateGeneration) {
  clearMediaReadyTimer()
  const isReady = () =>
    !intentionalClose &&
    generation === mediaStateGeneration &&
    signal?.ready === true &&
    !signal.detached &&
    localAudioIsReady() &&
    remoteAudioIsReady()
  if (!isReady()) return

  mediaReadyTimer = setTimeout(() => {
    mediaReadyTimer = null
    if (!isReady()) return
    clearMediaWatchdog()
    mediaWatchdogRecoveryUsed = false
    // A repair that got media all the way back has earned another one. Without
    // this, a second unplug in the same session would go unrepaired.
    rawMicEndedRepairGeneration = null
    // The counts travel with the state so the channel component can compare
    // them against its own roster.
    emitMediaState('ready', {
      knownAudioProducers: knownAudioProducers.size,
      activeAudioConsumers: [...remoteConsumers.keys()].filter((id) => knownAudioProducers.has(id))
        .length
    })
  }, MEDIA_READY_SETTLE_MS)
}

// A transient local-media failure gets one full voice reconnect.  If the same
// recovery budget is already spent, report a bounded failure instead of looping
// forever or leaving the UI on an endless reconnect overlay.
export function requestVoiceMediaRecovery(reason = 'Voice media recovery failed') {
  if (intentionalClose || !everReady) return false
  if (mediaWatchdogRecoveryUsed) {
    emitMediaState('failed', { reason })
    return false
  }
  mediaWatchdogRecoveryUsed = true
  emitMediaState('reconnecting', { reason })
  // Media that never came up is the session's fault, not the socket's.
  forceVoiceReconnect(reason, CloseAction.Fresh)
  return true
}

function armMediaWatchdog(generation, delay = MEDIA_WATCHDOG_DELAY_MS) {
  clearMediaWatchdog()
  mediaWatchdogTimer = setTimeout(() => {
    mediaWatchdogTimer = null
    if (intentionalClose || generation !== mediaStateGeneration) return
    // Nothing can be fixed while the socket is down; the resume re-checks.
    if (signal?.detached) {
      armMediaWatchdog(generation, MEDIA_WATCHDOG_DEGRADED_DELAY_MS)
      return
    }
    const expectedRemote = knownAudioProducers.size
    const activeRemote = [...remoteConsumers.keys()].filter((id) =>
      knownAudioProducers.has(id)
    ).length
    const localReady = localAudioIsReady()
    const resolved = localReady && remoteAudioIsReady()
    console.warn(
      `[Soup] media watchdog generation=${generation} local=${localReady} ` +
        `remote=${activeRemote}/${expectedRemote} snapshot=${channelState.hasSnapshot} ` +
        playbackDiagnostics()
    )
    // Media came back between the arm and the fire, so the ready check now
    // owns it and there's nothing left to watch here.
    if (resolved) {
      scheduleMediaReadyCheck(generation)
      return
    }
    if (!localReady) {
      if (publishInFlight == null && localCaptureLost) {
        // The microphone is gone, not the session. A reconnect can't conjure
        // the device and only drops us out of the channel. Hand it to the
        // publish ladder (VoiceChannel), which retries it and meanwhile falls
        // back to the default input. A ladder already running ignores this.
        emitMediaState('local-capture-lost')
        armMediaWatchdog(generation, MEDIA_WATCHDOG_DEGRADED_DELAY_MS)
        return
      }
      // A publish already working is the repair, so tearing the socket down
      // under it would only restart the same work from further back. The
      // recovery budget is one-shot. Once it's spent, this is the only thing
      // that keeps checking, so it has to re-arm itself.
      if (
        publishInFlight != null ||
        !requestVoiceMediaRecovery('Local microphone was not ready after connect')
      ) {
        armMediaWatchdog(generation, MEDIA_WATCHDOG_DEGRADED_DELAY_MS)
      }
      return
    }
    // A missing remote is retried by ensureAudioSink; invoke it again here in
    // case its bounded retries ran out.
    for (const id of knownAudioProducers.keys()) ensureAudioSink(id)
    scheduleMediaReadyCheck(generation)
    armMediaWatchdog(generation, MEDIA_WATCHDOG_DEGRADED_DELAY_MS)
  }, delay)
}

// A device re-enumerating is the only event that can fix a capture that
// failed because it was missing, and 15s of extra silence waiting for the
// next routine check is most of the outage. This only brings an already-armed
// check forward, and only over a healthy idle session. A reconnect or a
// publish in flight is already the repair and must not be raced.
subscribeDeviceChange(() => {
  if (
    intentionalClose ||
    mediaWatchdogTimer == null ||
    reconnectInFlight ||
    reconnectTimer != null ||
    publishInFlight != null ||
    ws?.readyState !== WebSocket.OPEN ||
    localAudioIsReady()
  )
    return
  armMediaWatchdog(mediaStateGeneration, MEDIA_WATCHDOG_DEVICE_DELAY_MS)
})

// ─── Signaling ───────────────────────────────────────────────────
// Every request goes through the live socket's matcher (protocol.js), the one
// place answers and errors are paired with requests. Only a request with a
// success answer is awaited (request, requestCreate). One without it either
// gets a Sync behind it when the caller has to know it went through
// (requestSynced), or is sent and forgotten (notify).
function request(message) {
  if (!signal) return Promise.reject(new Error('Voice socket not open'))
  return signal.matcher.request(message)
}

// A CreateSource or CreateSink. `build(node)` makes it around the new node's
// LocalId, which the live socket's matcher takes from its counter and sends at
// once, so the id belongs to the socket the request goes out on.
function requestCreate(build) {
  if (!signal) return Promise.reject(new Error('Voice socket not open'))
  return signal.matcher.create(build)
}

function requestSynced(message) {
  if (!signal) return Promise.reject(new Error('Voice socket not open'))
  return signal.matcher.requestSynced(message)
}

function notify(message) {
  if (!signal) throw new Error('Voice socket not open')
  signal.matcher.notify(message)
}

// ─── E2EE ────────────────────────────────────────────────────────
// Every frame is end-to-end encrypted (lib/e2ee). Its worker runs the channel's MLS group: it
// gets the node's Group events from handleEvent and sends its Group requests through here.
setE2eeHandlers({
  // Group has no success answer. The Sync behind it says the session took it, and an
  // Error { "Session" } before that Done says it didn't.
  request: (groupRequest) => requestSynced(Request.group(groupRequest)),
  onFatal: (reason) =>
    failVoice(
      reason === 'update-required'
        ? 'This version of Pylon can no longer join voice on this server; update to continue'
        : "Couldn't set up encryption for this call"
    ),
  // A video sink decrypts again after dropping frames, so its decoder needs a keyframe. Sent
  // and forgotten: one for a sink the server already closed is dropped there, and a failure
  // arrives as an Error nothing waits for, which is logged when it comes.
  onKeyFrame: (sinkNode) => {
    try {
      notify(Request.requestKeyFrame(sinkNode))
    } catch (err) {
      console.warn(`[Soup] Keyframe request for sink ${sinkNode} not sent:`, err?.message ?? err)
    }
  },
  // Video sinks stay paused until we can decrypt what they'd carry (applyViewRole).
  onMediaReadyChange: () => {
    for (const entry of remoteConsumers.values()) applyViewRole(entry)
  }
})

// Called (by screenShare and the mic paths) once a local producer is closed.
// A source the server already closed (a switch, or a replacement) is no
// longer in localSources and needs nothing.
function closeServerProducer(id) {
  const node = ownNode(id)
  const type = localSources.get(node)
  if (!localSources.delete(node)) return
  localSourcePaused.delete(node)
  if (type === SourceType.Stream) publishStreamViewers()
  closeServerNode(node)
}

// Close one of our nodes on the server. Never awaited: a node the server has
// already closed gets no answer (its own Closed came first), and the answer
// for one it hadn't is a Closed like any other, a no-op by then because the
// caller let go of the node before sending this. The only failure is the
// socket going away, which closes the node anyway.
function closeServerNode(node) {
  try {
    notify(Request.close(node))
  } catch (err) {
    console.warn(`[Soup] Close for node ${node} not delivered:`, err?.message ?? err)
  }
}

// ─── Screen streams (event socket) ──────────────────────────────
// The backend authorizes every Stream / StreamAudio source and every sink on
// one, by stream key (protocol.js, "Event socket: screen streams"). Main owns
// the event socket: it gives us a sender (setEventSocketSender) and routes op 11
// and 12, { err } frames, Ready.streams and the stream dispatch events here.
const STREAM_REQUEST_TIMEOUT_MS = 10_000
// How long a watch waits for the backend to announce a stream (StreamStarted).
// The voice socket shows a new stream's sources before the backend hears from
// the voice node that it's live, and the backend refuses to watch it until then.
const STREAM_ANNOUNCE_WAIT_MS = 10_000
// How long a new share waits for our previous stream to end. The backend allows
// one stream per client, and lets go of one that had sources only once the
// voice node reports the last of them closed.
const OWN_STREAM_END_WAIT_MS = 5_000

let eventSocketSend = () => false
// Every live stream in the channels we can see, with its viewers.
const streamDirectory = new StreamDirectory()
const streamRequests = createStreamRequests({
  transmit: (frame) => eventSocketSend(frame),
  timeoutMs: STREAM_REQUEST_TIMEOUT_MS,
  onOrphan: releaseOrphanStreamReply
})

// `send(frame)` writes one { op, data } frame to the event socket and returns
// false when it isn't open.
export function setEventSocketSender(send) {
  eventSocketSend = typeof send === 'function' ? send : () => false
}

// Op 11 or 12 from the event socket. Returns whether it was one of them.
export function receiveStreamReply(msg) {
  return streamRequests.handle(msg)
}

// An { err } frame from the event socket. It may answer a stream request (see
// createStreamRequests). Returns true when it failed a share start, whose
// caller reports the error itself; any other err is still the caller's to show.
export function receiveEventSocketError(message) {
  // A refused ticket request (op 13, or the join's op 1) for a connect that is
  // waiting on its ticket.
  const ticketError = voiceTicketError(message)
  if (ticketError != null && failTicketWait(ticketError)) {
    console.warn(`[Soup] Voice ticket refused: ${message}`)
    return true
  }
  const op = streamRequests.fail(message)
  if (op != null) console.warn(`[Soup] Stream request (op ${op}) failed: ${message}`)
  return op === StreamOp.CREATE_STREAM
}

// The event socket closed. The op 6, 11 and 12 still owed to us won't come: a
// resume doesn't replay them.
export function eventSocketClosed() {
  streamRequests.reset()
  const waiter = ticketWaiter
  ticketWaiter = null
  waiter?.()
}

// Ready.streams: every live stream in the channels we can see.
export function applyReadyStreams(streams) {
  const { started, ended } = streamDirectory.applyReady(streams)
  for (const key of started) streamAnnounced(key)
  for (const key of ended) streamGone(key)
  publishStreamViewers()
  publishLiveStreams()
}

// StreamStarted, StreamViewersUpdated and StreamEnded dispatch events. Returns
// whether `ev` was one of them. They may repeat what Ready already said.
export function applyStreamEvent(ev, data) {
  switch (ev) {
    case 'StreamStarted':
      if (streamDirectory.started(data)) {
        console.log(`[Soup] Stream ${data.stream_key} started by ${data.owner}`)
        streamAnnounced(data.stream_key)
      }
      break
    case 'StreamViewersUpdated':
      streamDirectory.viewersUpdated(data)
      break
    case 'StreamEnded':
      if (streamDirectory.ended(data)) console.log(`[Soup] Stream ${data.stream_key} ended`)
      streamGone(data?.stream_key)
      break
    default:
      return false
  }
  publishStreamViewers()
  publishLiveStreams()
  return true
}

// ─── Our own stream ─────────────────────────────────────────────
// `claimed` once a source was created with its key. A claimed stream ends only
// when its last source closes, and until the backend hears that it refuses
// another CreateStream from us. So stopping a share closes its sources (the
// stream then ends by itself), and the next share waits for that StreamEnded.
// A stream that never got a source has nothing to close, and is handed back
// with op 10 instead (EndStream), or the backend would hold it for 30s.
let ownStream = null // { key, claimed, ending }
const ownStreamEndWaiters = new Set()

// The screen share's createStream: ask for a stream in our current channel and
// resolve with its key.
async function createOwnStream() {
  if (ownStream?.claimed) {
    console.log(`[Soup] Waiting for stream ${ownStream.key} to end before starting another`)
    await waitForOwnStreamEnd()
  } else if (ownStream) {
    releaseOwnStream(ownStream.key)
  }
  const channelId = channelState.channelId
  if (!signal?.ready || channelId == null) throw new Error('Not connected to voice')
  const generation = mediaStateGeneration
  const key = await streamRequests.create(channelId)
  // The session ended while we asked.
  if (generation !== mediaStateGeneration) {
    // A new session in the same channel would find it still held.
    if (!intentionalClose) streamRequests.notify(StreamRequest.end(key))
    throw mediaResetError()
  }
  ownStream = { key, claimed: false, ending: false }
  console.log(`[Soup] Stream ${key} created`)
  return key
}

// The screen share's releaseStream, called when a share stops (see above).
function releaseOwnStream(key) {
  if (!ownStream || ownStream.key !== key) return
  if (ownStream.claimed) {
    ownStream.ending = true
    return
  }
  ownStream = null
  console.log(`[Soup] Ending stream ${key}, which never got a source`)
  streamRequests.notify(StreamRequest.end(key))
}

function waitForOwnStreamEnd() {
  if (!ownStream?.claimed) return Promise.resolve()
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      ownStreamEndWaiters.delete(done)
      resolve()
    }
    const timer = setTimeout(() => {
      // Ask anyway. The worst case is the backend's "already streaming".
      console.warn(`[Soup] Stream ${ownStream?.key} has not ended; starting the next one anyway`)
      ownStream = null
      done()
    }, OWN_STREAM_END_WAIT_MS)
    ownStreamEndWaiters.add(done)
  })
}

// The screen share's setSourcePaused: the owner's pause of one of our Stream,
// StreamAudio or Webcam sources. SetSourcePaused has no success answer, so a
// Sync behind it says it went through. A source a replacement swapped out
// meanwhile is already closed on the server, which drops the request without a
// word; the share re-applies its pause to the successor.
async function setServerSourcePaused(producerId, paused) {
  const node = ownNode(producerId)
  if (!localSources.has(node)) return false
  localSourcePaused.set(node, paused === true)
  try {
    await requestSynced(Request.setSourcePaused(node, paused))
    console.log(`[Soup] Source ${node} ${paused ? 'paused' : 'resumed'}`)
    return true
  } catch (err) {
    if (signal?.detached) unsentSourcePauses.add(node)
    console.warn(`[Soup] SetSourcePaused for source ${node} failed:`, err?.message ?? err)
    return false
  }
}

// ─── Watching streams ───────────────────────────────────────────
// A sink on a stream's source needs a watch on the stream (op 8, answered by
// op 12). Watches belong to our current channel: the backend revokes them when
// we leave or switch, and a stream that ends takes its watch with it. We give
// one back (op 9) once nothing of its stream is received or wanted.
const grantedWatches = new Set() // stream keys
const announceWaiters = new Map() // stream key -> Set of resolvers

// The backend now knows the stream is live, so it can be watched.
function streamAnnounced(key) {
  for (const done of [...(announceWaiters.get(key) ?? [])]) done(true)
}

// A stream we knew of is over: StreamEnded, or missing from a new Ready.
function streamGone(key) {
  if (key == null) return
  grantedWatches.delete(key)
  if (ownStream?.key === key) {
    ownStream = null
    for (const done of [...ownStreamEndWaiters]) done()
  }
}

// Resolves true once the stream is announced (StreamStarted or Ready), or
// false if it isn't within STREAM_ANNOUNCE_WAIT_MS.
function waitForStreamAnnounced(key) {
  if (streamDirectory.has(key)) return Promise.resolve(true)
  return new Promise((resolve) => {
    let waiters = announceWaiters.get(key)
    if (!waiters) announceWaiters.set(key, (waiters = new Set()))
    const done = (announced) => {
      clearTimeout(timer)
      waiters.delete(done)
      if (waiters.size === 0 && announceWaiters.get(key) === waiters) announceWaiters.delete(key)
      resolve(announced)
    }
    const timer = setTimeout(() => done(false), STREAM_ANNOUNCE_WAIT_MS)
    waiters.add(done)
  })
}

// Make sure we hold a watch on a stream before sinking its sources. Concurrent
// callers share one op 8 (createStreamRequests coalesces by key).
async function ensureStreamWatch(key) {
  if (grantedWatches.has(key)) return
  const generation = mediaStateGeneration
  if (!(await waitForStreamAnnounced(key))) {
    throw new Error(`Stream ${key} was never announced by the server`)
  }
  if (generation !== mediaStateGeneration) throw mediaResetError()
  if (grantedWatches.has(key)) return
  await streamRequests.watch(key)
  // A watch granted to a session that has since ended was revoked with it.
  if (generation !== mediaStateGeneration) throw mediaResetError()
  if (!grantedWatches.has(key)) console.log(`[Soup] Watching stream ${key}`)
  grantedWatches.add(key)
}

// Give back (op 9) every watch whose stream we no longer receive or want
// anything from. Runs after the watch set shrinks and after an abandoned sink
// lands, so a sink still being set up keeps its watch until then.
function releaseUnusedStreamWatches() {
  for (const key of [...grantedWatches]) {
    const inUse = channelState
      .streamSources(key)
      .some((source) => isConsumingSource(source.node) || sourceIsWatched(source.node))
    if (inUse) continue
    grantedWatches.delete(key)
    console.log(`[Soup] No longer watching stream ${key}`)
    streamRequests.notify(StreamRequest.stopWatching(key))
  }
}

// An op 11 or 12 nothing was waiting for: it timed out, or an { err } meant
// for another request failed it. Give back what it granted.
function releaseOrphanStreamReply({ op, streamKey }) {
  if (op === StreamOp.STREAM_CREATED) {
    console.warn(`[Soup] Ending stream ${streamKey}, which no share is waiting for`)
    streamRequests.notify(StreamRequest.end(streamKey))
    return
  }
  // A late watch still counts if that stream is wanted now.
  grantedWatches.add(streamKey)
  releaseUnusedStreamWatches()
}

// ─── Stream viewers ─────────────────────────────────────────────
// Who is watching each stream in our channel, keyed like the video grid's tiles:
// by the stream's video source id (for our own stream, our Stream source).
// Built from Ready.streams and StreamViewersUpdated, so only the backend's word
// counts: a viewer is a client with a live sink on the stream.
const streamViewerListeners = new Set()
let streamViewers = new Map() // video source id -> viewer client ids

export function subscribeStreamViewers(cb) {
  streamViewerListeners.add(cb)
  cb(streamViewers)
  return () => streamViewerListeners.delete(cb)
}

function publishStreamViewers() {
  const next = new Map()
  for (const { streamKey, viewers } of streamDirectory.streams.values()) {
    const id = streamVideoSourceId(streamKey)
    if (id != null) next.set(id, [...viewers].sort())
  }
  if (sameIdListMap(next, streamViewers)) return
  streamViewers = next
  for (const cb of streamViewerListeners) {
    try {
      cb(next)
    } catch (err) {
      console.error('[Soup] Stream viewer listener failed:', err)
    }
  }
}

function streamVideoSourceId(key) {
  if (ownStream?.key === key) {
    for (const [node, type] of localSources) {
      if (type === SourceType.Stream) return ownId(node)
    }
    return null
  }
  const video = channelState.streamSources(key).find((source) => source.kind === SourceType.Stream)
  return video ? video.node : null
}

// Two maps of sorted id lists hold the same thing.
function sameIdListMap(a, b) {
  if (a.size !== b.size) return false
  for (const [key, ids] of a) {
    const other = b.get(key)
    if (!other || other.length !== ids.length) return false
    if (ids.some((id, index) => other[index] !== id)) return false
  }
  return true
}

// ─── Live streams ───────────────────────────────────────────────
// Who is streaming in each channel we can see, from the same Ready.streams and
// stream events as the viewer map. The backend sends these whether or not we're
// in voice, so the sidebar can show streamers in every channel. Webcams aren't
// streams and don't appear here.
const liveStreamListeners = new Set()
let liveStreams = new Map() // channel id -> owner client ids

export function subscribeLiveStreams(cb) {
  liveStreamListeners.add(cb)
  cb(liveStreams)
  return () => liveStreamListeners.delete(cb)
}

function publishLiveStreams() {
  const next = streamDirectory.ownersByChannel()
  if (sameIdListMap(next, liveStreams)) return
  liveStreams = next
  for (const cb of liveStreamListeners) {
    try {
      cb(next)
    } catch (err) {
      console.error('[Soup] Live stream listener failed:', err)
    }
  }
}

// ─── Remote sources ──────────────────────────────────────────────
// Keyed by source id, which for another client's source is its NodeId string
// ("<session>:<local>") exactly as the server sent it: that's the id
// mediasoup-client and the UI use (the UI round-trips them through strings),
// and what CreateSink echoes back.
//
// Our own sources and sinks are LocalIds, numbers we picked, and go to
// mediasoup-client and the UI as strings too (ownId). A NodeId always has a
// colon and a stringified LocalId never does, so maps that hold both, like
// the video grid's tiles, can't mix them up. And since sources and sinks share
// one counter, a LocalId names one or the other, never both.
const ownId = (node) => String(node)
const ownNode = (id) => Number(id)

// Remote video sources in the channel, watched or not. Tiles are driven by
// this — a stream is listed as soon as it exists.
const knownVideoProducers = new Map() // sourceId -> { clientId, producedType }
// Remote stream-audio sources. Like video, only received while that client's
// stream is actually watched (only the focused stream is ever audible).
const knownScreenAudioProducers = new Map() // sourceId -> { clientId }
// Remote microphones. Always received; kept until SourcesRemoved so a failed
// sink can be retried locally.
const knownAudioProducers = new Map() // sourceId -> { clientId, generation }
const audioSinkRetryTimers = new Map()
const audioSinkRetryAttempts = new Map()
// Client ids whose streams are currently watched, so stream audio arriving
// after the watch started is received on arrival.
let watchedClientIds = new Set()
// The video sources those clients are watched *through*. Held so a sink that
// lands after the watch moved on can re-check the current intent.
let watchedProducerIds = new Set()
// sourceId -> in-flight consumeSource() promise. A sink is invisible to
// remoteConsumers for several round-trips, so every "already receiving?" test
// has to consult this too (see watchIntent.js).
const pendingSinks = new Map()

// Bind sink lifetime to the set of streams the user has explicitly chosen to
// watch (the play/stop buttons), NOT to whether a tile happens to be on screen.
export function setWatchedProducers(producerIds = []) {
  const intent = resolveWatchIntent({
    requestedProducerIds: producerIds,
    videoProducers: knownVideoProducers,
    screenAudioProducers: knownScreenAudioProducers,
    activeConsumers: remoteConsumers,
    pendingConsumeIds: pendingSinks.keys()
  })
  watchedProducerIds = intent.watchedProducerIds
  watchedClientIds = intent.watchedClientIds

  for (const { producerId, kind } of intent.close) {
    if (kind === 'video') closeVideoConsumer(producerId)
    else closeScreenAudioConsumer(producerId)
  }

  // Sinks still being set up for a stream nobody wants any more. They own no
  // consumer yet, so their teardown rides the setup itself.
  for (const producerId of intent.abandon) closeSinkWhenItLands(producerId)

  for (const { producerId } of intent.consume) {
    consumeSource(producerId).catch((err) =>
      console.error(`[Soup] Failed to receive source ${producerId}:`, err)
    )
  }

  // Streams we stopped watching entirely. One with a sink still landing keeps
  // its watch until closeSinkWhenItLands is done with it.
  releaseUnusedStreamWatches()
}

// Are we receiving this source, or about to be? Both halves matter: the map
// only fills in after the sink is set up.
function isConsumingSource(id) {
  return remoteConsumers.has(id) || pendingSinks.has(id)
}

// Does the current watch intent still cover this source?
function sourceIsWatched(id) {
  return isProducerWatched({
    producerId: id,
    watchedProducerIds,
    watchedClientIds,
    videoProducers: knownVideoProducers,
    screenAudioProducers: knownScreenAudioProducers
  })
}

function clearAudioSinkRetry(id) {
  const timer = audioSinkRetryTimers.get(id)
  if (timer != null) clearTimeout(timer)
  audioSinkRetryTimers.delete(id)
  audioSinkRetryAttempts.delete(id)
}

// Receive a remote microphone with a small, idempotent local retry budget. A
// source that went away fails with NotFound and is dropped quietly: its
// SourcesRemoved is already on the way. Once the budget is spent the media
// watchdog retries on its slower cadence.
function ensureAudioSink(id) {
  const known = knownAudioProducers.get(id)
  if (
    !known ||
    known.generation !== mediaStateGeneration ||
    isConsumingSource(id) ||
    audioSinkRetryTimers.has(id)
  )
    return

  const generation = mediaStateGeneration
  consumeSource(id)
    .then(() => {
      clearAudioSinkRetry(id)
      scheduleMediaReadyCheck(generation)
    })
    .catch((err) => {
      if (
        knownAudioProducers.get(id) !== known ||
        generation !== mediaStateGeneration ||
        intentionalClose ||
        err?.sourceGone
      )
        return
      const attempt = audioSinkRetryAttempts.get(id) ?? 0
      const delay = nextAudioConsumeRetryDelay(attempt)
      if (delay == null) {
        clearAudioSinkRetry(id)
        console.error(`[Soup] Giving up on audio from source ${id} for now:`, err)
        return
      }
      audioSinkRetryAttempts.set(id, attempt + 1)
      console.warn(`[Soup] Retrying audio sink for source ${id} in ${delay}ms:`, err)
      const timer = setTimeout(() => {
        audioSinkRetryTimers.delete(id)
        ensureAudioSink(id)
      }, delay)
      audioSinkRetryTimers.set(id, timer)
    })
}

// Stop receiving something whose sink hasn't landed yet: chain the close onto
// the in-flight setup. The intent is re-checked when it lands — the user may
// have started watching again meanwhile.
function closeSinkWhenItLands(id, { forceClose = false } = {}) {
  const pending = pendingSinks.get(id)
  if (!pending) return
  pending
    .then(() => {
      if (!forceClose && sourceIsWatched(id)) return
      const entry = remoteConsumers.get(id)
      if (!entry) return
      if (entry.kind === 'video') closeVideoConsumer(id)
      else closeScreenAudioConsumer(id)
    })
    // A setup that failed left nothing behind to close.
    .catch(() => {})
    // The stream's watch may be the last thing still held for it.
    .finally(releaseUnusedStreamWatches)
}

// Remove the registry entry before tearing down its consumer and optional audio
// graph, so racing close/heal paths see an already-clean state. Returns the
// removed entry for callers that still need its metadata.
//
// Only the local half. The server closes a sink on its own when its source
// goes, so `closeSink` is for the paths where we are the ones letting go.
function removeRemoteConsumer(id, { closeSink = false } = {}) {
  const entry = remoteConsumers.get(id)
  if (!entry) return null
  remoteConsumers.delete(id)
  // A Closed for this sink already arrived if sinkSources lost it.
  const serverHasSink = sinkSources.delete(entry.sinkNode)
  entry.consumer.close()
  entry.cleanup?.()
  if (closeSink && serverHasSink) closeServerNode(entry.sinkNode)
  return entry
}

// "Stop watching" a stream: the source stays, our sink of it goes.
function closeVideoConsumer(id) {
  const entry = removeRemoteConsumer(id, { closeSink: true })
  if (!entry) return
  // The source still exists — only our subscription ended. Keep the tile and
  // blank its stream so it returns to the stopped state rather than vanishing.
  activeCallbacks.onVideoStream?.({
    stream: null,
    kind: 'video',
    producerId: id,
    clientId: entry.clientId
  })
}

// "Stop watching" for a stream's audio. Mirrors closeVideoConsumer.
function closeScreenAudioConsumer(id) {
  removeRemoteConsumer(id, { closeSink: true })
}

// ─── Channel events ──────────────────────────────────────────────
// Server events, after the matcher has seen them: a Closed may be the answer to
// our Close, and the first Channel is what SetCapabilities waits for, but both
// are applied here like any other.
function handleEvent(type, data) {
  switch (type) {
    case 'Channel':
      applyChannelSnapshot(data)
      break
    case 'Group':
      e2eeGroupEvent(data)
      break
    case 'ClientsJoined':
      channelState.addClients(data?.clients)
      break
    case 'ClientsLeft':
      channelState.removeClients(data?.clients)
      break
    case 'SourcesAdded':
      addRemoteSources(channelState.addSources(data?.sources))
      break
    case 'SourcesRemoved':
      removeRemoteSources(channelState.removeSources(data?.nodes))
      break
    case 'SourceReplaced':
      replaceRemoteSource(channelState.replaceSource(data?.old, data?.new))
      break
    case 'SourceUpdated':
      updateRemoteSource(channelState.updateSource(data?.source))
      break
    case 'Codecs':
      channelState.setCodecs(data?.codecs)
      console.log(`[Soup] Channel video codecs now ${describeCodecs(channelState.codecs)}`)
      applyChannelCodecs()
      break
    case 'Speakers':
      applySpeakers(channelState.setSpeakers(data?.speakers))
      break
    case 'SinkLayers':
      applySinkLayers(data)
      break
    case 'Closed':
      closeNodes(data?.nodes ?? [])
      break
  }
}

// A Channel snapshot replaces the channel state. The first one is the session
// becoming READY (the matcher marks it before this runs); later ones follow
// every channel switch and every server-side resync. Before one, the server has
// already sent Closed for each sink whose source is gone (on a switch: all of
// them), so this only has to diff sources and fill in missing sinks.
function applyChannelSnapshot(data) {
  const previousChannelId = channelState.channelId
  const firstOfSession = !channelState.hasSnapshot
  const { added, removed, updated, speakers } = channelState.applySnapshot(data)
  const switched = previousChannelId != null && previousChannelId !== channelState.channelId
  // Each session and each channel is a new membership on the node, which needs its own key
  // package. A resync of the same session comes with a Group Rejoin instead.
  if (firstOfSession || switched) e2eeJoin(channelState.group, { move: switched })
  console.log(
    `[Soup] Channel ${channelState.channelId} snapshot: ${channelState.clients.size} ` +
      `client(s), ${channelState.sources.size} source(s), ` +
      `codecs ${describeCodecs(channelState.codecs)}` +
      (switched ? ` (switched from ${previousChannelId})` : '')
  )
  // The backend revoked our watches with the move; streams here need new ones.
  if (switched) grantedWatches.clear()
  removeRemoteSources(removed)
  addRemoteSources(added)
  // A resync can carry a pause the deltas never told us about.
  for (const source of updated) updateRemoteSource(source)
  // A resync repeats sources we already know. A mic among them that lost its
  // sink, or never got one, is picked up again here.
  for (const id of knownAudioProducers.keys()) ensureAudioSink(id)
  applySpeakers(speakers)
  // A switch already closed our video sources; a resync keeps them, and the
  // codecs may have moved meanwhile.
  applyChannelCodecs()
  scheduleMediaReadyCheck()
}

function describeCodecs(codecs) {
  if (!codecs) return 'unknown'
  return `${codecs.allowed.join('/') || 'none'} (preferred ${codecs.preferred ?? 'none'})`
}

function addRemoteSources(sources) {
  for (const { node: id, owner: clientId, kind: type, streamKey, paused } of sources) {
    console.log(
      `[Soup] Source ${id} added (${type} from ${clientId}` +
        (streamKey != null ? `, stream ${streamKey}` : '') +
        (paused ? ', paused' : '') +
        ')'
    )

    // Stream audio is bound to a stream: like video, it waits for a watch.
    if (type === SourceType.StreamAudio) {
      knownScreenAudioProducers.set(id, { clientId })
      if (watchedClientIds.has(clientId) && !isConsumingSource(id)) {
        consumeSource(id).catch((err) =>
          console.error(`[Soup] Failed to receive stream audio ${id}:`, err)
        )
      }
      continue
    }

    // Mic audio must be audible the moment it exists.
    if (type === SourceType.Microphone) {
      knownAudioProducers.set(id, { clientId, generation: mediaStateGeneration })
      ensureAudioSink(id)
      continue
    }

    // Video does NOT receive here: it waits for an explicit watch
    // (setWatchedProducers). Register it and announce a tile with no stream.
    knownVideoProducers.set(id, { clientId, producedType: producedTypeForSource(type) })
    activeCallbacks.onVideoStream?.({
      stream: null,
      kind: 'video',
      producerId: id,
      clientId,
      paused
    })
    // Only a replacement arrives already watched (see replaceRemoteSource).
    // Its stream's watch carries over, so this needs no new op 8.
    if (watchedProducerIds.has(id) && !isConsumingSource(id)) {
      consumeSource(id).catch((err) =>
        console.error(`[Soup] Failed to receive replacement source ${id}:`, err)
      )
    }
  }
  if (sources.length > 0) {
    scheduleMediaReadyCheck()
    publishStreamViewers()
  }
}

// A member paused or resumed one of their sources (SourceUpdated). Viewers
// show a paused frame instead of the last one; the source and our sink of it
// both stay.
function updateRemoteSource(source) {
  if (!source) return
  const id = source.node
  console.log(`[Soup] Source ${id} ${source.paused ? 'paused' : 'resumed'} by its owner`)
  if (sourceMediaKind(source.kind) !== 'video') return
  activeCallbacks.onStreamPaused?.({
    producerId: id,
    clientId: source.owner,
    paused: source.paused
  })
}

// SinkLayers: the layers one of our video sinks forwards now. null means none
// (paused, or no layer fits the downlink). Kept on the entry for diagnostics.
function applySinkLayers({ node, layers = null } = {}) {
  const id = sinkSources.get(node)
  const entry = id == null ? null : remoteConsumers.get(id)
  if (entry?.sinkNode !== node) return
  entry.currentLayers = layers
  if (import.meta.env.DEV) {
    console.log(
      `[Soup] Sink ${node} forwarding ` +
        (layers ? `spatial ${layers.spatial}, temporal ${layers.temporal ?? 'all'}` : 'nothing')
    )
  }
}

// A peer swapped a source for a new one of the same kind (a codec or profile
// change). The server has already closed our sink of the old one: its Closed
// came first. The old source leaves as a replacement, so the UI keeps its tile
// for the successor, and a stream we were watching stays watched under its
// new node without waiting for the UI to re-assert the watch.
function replaceRemoteSource({ removed, added }) {
  if (removed) {
    console.log(`[Soup] Source ${removed.node} replaced by ${added?.node ?? '?'}`)
    if (added && watchedProducerIds.delete(removed.node)) watchedProducerIds.add(added.node)
    removeRemoteSources([removed], { replaced: added != null })
  }
  if (added) addRemoteSources([added])
}

function removeRemoteSources(sources, { replaced = false } = {}) {
  for (const { node: id, owner, streamKey } of sources) {
    console.log(`[Soup] Source ${id} removed`)
    const knownVideo = knownVideoProducers.get(id)
    knownVideoProducers.delete(id)
    knownScreenAudioProducers.delete(id)
    knownAudioProducers.delete(id)
    clearAudioSinkRetry(id)
    audioHealHistory.delete(id)
    // A sink still being set up notices its source is gone; this covers one
    // that lands anyway.
    if (pendingSinks.has(id)) closeSinkWhenItLands(id, { forceClose: true })
    // Normally Closed already took the sink; this is the fallback.
    const entry = removeRemoteConsumer(id)
    // Tiles are source-driven, so the tile must go whether or not we were
    // receiving it — an unwatched stream has no sink to close.
    if (entry?.kind === 'video' || knownVideo) {
      activeCallbacks.onStreamEnded?.(id, {
        replaced,
        clientId: entry?.clientId ?? knownVideo?.clientId ?? owner,
        producedType: entry?.producedType ?? knownVideo?.producedType
      })
    }
    // A stream ends when its last source closes, and its watch with it. No op
    // 9 for that (StreamEnded may not have caught up yet, but the watch is dead).
    if (streamKey != null && channelState.streamSources(streamKey).length === 0) {
      grantedWatches.delete(streamKey)
    }
  }
  if (sources.length > 0) {
    scheduleMediaReadyCheck()
    publishStreamViewers()
  }
}

// Speakers is the full set of speaking members, including us. channelState
// turns it into a diff so each client's ring only changes when it should.
function applySpeakers({ started, stopped }) {
  for (const clientId of stopped) {
    if (clientId !== selfId) activeCallbacks.onClientSpeaking?.(clientId, false)
  }
  for (const clientId of started) {
    if (clientId !== selfId) activeCallbacks.onClientSpeaking?.(clientId, true)
  }
}

// Our own ring is drawn from local state, so Speakers skips us.
export function setVoiceSelf(id) {
  selfId = id == null ? null : String(id)
}

function setLocalSpeaking(next) {
  localSpeaking = next
  syncSpeaking()
}

function syncSpeaking(force = false) {
  const flags = localSpeaking && !micSilenced() ? SpeakingFlags.MICROPHONE : 0
  if (selfId != null && ownRingShown !== (flags !== 0)) {
    ownRingShown = flags !== 0
    activeCallbacks.onClientSpeaking?.(selfId, ownRingShown)
  }
  if (!force && flags === sentSpeakingFlags) return
  if (!signal?.ready || signal.detached) return
  try {
    notify(Request.setSpeaking(flags))
    sentSpeakingFlags = flags
  } catch (err) {
    console.warn('[Soup] SetSpeaking not sent:', err?.message ?? err)
  }
}

// Closed names nodes the server closed, by LocalId: our sinks, or our own
// sources. It also answers our own Close, by which time the node is gone here.
function closeNodes(nodes) {
  for (const node of nodes) {
    const replacement = sourceReplacements.get(node)
    if (replacement) {
      replacement.closed = true
      continue
    }
    if (localSources.has(node)) {
      closeLocalSource(node)
      continue
    }
    const id = sinkSources.get(node)
    if (id == null) continue // already gone locally
    sinkSources.delete(node)
    const entry = remoteConsumers.get(id)
    // A sink still being set up isn't registered yet; its setup sees the
    // missing sinkSources entry and discards itself.
    if (entry?.sinkNode !== node) continue
    console.log(`[Soup] Sink ${node} for source ${id} closed by server`)
    // No blank-tile announcement for video: the server only closes a sink
    // whose source is going away (SourcesRemoved ends the tile, and
    // SourceReplaced hands it to the successor), on a channel switch (the old
    // channel's tiles go with it), or when the backend revokes our watch of
    // its stream, which it does for op 9 (we had let go already) or a move.
    removeRemoteConsumer(id)
  }
  scheduleMediaReadyCheck()
}

// The server closes our webcam/stream sources on a channel switch (the mic is
// kept and keeps its node), our stream sources when the backend ends the
// stream (EndStream from another of our sessions, or the voice node losing its
// backend link), and any source whose producer died on the server. Stop the
// capture behind a closed source so nothing keeps encoding into it.
function closeLocalSource(node) {
  const type = localSources.get(node)
  if (!localSources.delete(node)) return
  localSourcePaused.delete(node)
  const id = ownId(node)
  console.log(`[Soup] Own ${type} source ${id} closed by server`)

  if (type === SourceType.Microphone) {
    // Only we close or replace the mic, unless its producer died on the
    // server. Release it and let the watchdog bring it back.
    const closed = producers.filter((producer) => producer.id === id)
    producers = producers.filter((producer) => producer.id !== id)
    for (const producer of closed) {
      const track = producer.track
      producer.close()
      track?.stop()
    }
    localProducerIds.delete(id)
    armMediaWatchdog(mediaStateGeneration, MEDIA_WATCHDOG_DEVICE_DELAY_MS)
    return
  }

  // The whole share goes, and its owner hears why. Its other source (if the
  // same Closed doesn't already name it) is closed on the server too.
  endShareFromServer(id)
  publishStreamViewers()
}

// ─── Connect to the voice node ───────────────────────────────────
// Callbacks: onConnect (a session is READY or resumed — after the initial
// connect and every reconnect; publishes the mic, a no-op while it's live),
// onDisconnect (deliberate leave, or { failed: true, reason, leave } when voice
// gave up; `leave: false` means the backend already has us out of voice, or
// another device took it over, so op 1 must not be sent), onReconnecting (a
// new session is starting: remote media is gone, but we stay "joined"),
// onMediaState, onVideoStream, onStreamEnded, onClientSpeaking (driven by the
// server's Speakers), onScreenAudioError. Tickets come through the event
// socket, which Main owns (setVoiceServerHooks).
export async function connect(callbacks = {}) {
  // A rapid leave→join can arrive before the prior browser close event. Finish
  // that session synchronously while its callbacks still belong to it;
  // otherwise the new connect would inherit stale transports/callbacks.
  if (ws) {
    intentionalClose = true
    const previousSocket = ws
    previousSocket.close()
    currentSocketCloseHandler?.({ code: 1000, reason: 'Superseded by new voice connection' })
    if (ws === previousSocket) throw new Error('Previous voice socket could not be closed')
  } else if (signal) {
    // A session waiting to be resumed has no socket to close.
    intentionalClose = true
    endSession(signal, mediaResetError())
    activeCallbacks.onDisconnect?.(pendingDisconnectInfo)
  }
  const connectionGeneration = ++voiceConnectionGeneration
  activeCallbacks = { ...callbacks }
  intentionalClose = false
  everReady = false
  reconnectAttempts = 0
  lastVoiceReconnectReason = null
  pendingDisconnectInfo = undefined
  mediaWatchdogRecoveryUsed = false
  clearGiveUpTimer()
  // Cancel any pending reconnect from a prior session so it can't fire alongside
  // this fresh connection.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  // Watch OS connectivity. The node pings the voice socket, but the browser
  // never shows us those pings, so a silent network drop can leave the socket
  // looking open on our side; these kick recovery. addEventListener dedupes the
  // stable refs, so repeat calls are safe.
  window.addEventListener('offline', handleOffline)
  window.addEventListener('online', handleOnline)

  const isStale = () => intentionalClose || connectionGeneration !== voiceConnectionGeneration
  // The first attempt presents the ticket the join's op 1 minted; a retry asks
  // for a new one (op 13) while staying in the channel. A join while the backend
  // already had us in voice (say, through another device) mints nothing, so
  // that one asks with op 13 straight away.
  let needTicket = voiceServerHooks.inVoice?.() === true
  for (let attempt = 1; ; attempt++) {
    try {
      if (needTicket) {
        voiceConnectStep = 'ticket-request'
        requestNewTicket()
      }
      await openSocket(connectionGeneration)
      return
    } catch (err) {
      if (isStale()) throw mediaResetError()
      // The join's op 1 itself was refused for want of a voice node, which
      // leaves us out of the channel: op 13 can't help.
      const joinRefused = !needTicket && err?.voiceUnavailable === true
      if (err?.retryable === false || joinRefused || attempt >= INITIAL_CONNECT_ATTEMPTS) {
        console.error(`[Soup] Voice connect failed at ${voiceConnectStep ?? 'unknown'} step:`, err)
        disconnect()
        throw err
      }
      console.warn(
        `[Soup] Voice connect attempt ${attempt} failed at ${voiceConnectStep ?? 'unknown'} ` +
          `step (${err?.message}); asking for a new ticket`
      )
      await new Promise((resolve) => setTimeout(resolve, reconnectDelay(attempt - 1)))
      if (isStale()) throw mediaResetError()
      needTicket = true
    }
  }
}

// ─── Voice tickets ───────────────────────────────────────────────
// A ticket is single-use, expires 30s after the server mints it, and is bound
// to this client, its login session and the voice node; not to a channel. It
// only ever arrives as an op 6 push on the event socket: after an op 1 that
// moves us from no channel into one, or in answer to op 13, which asks for one
// while we stay in the channel. Main routes the push here. Minting a ticket
// revokes this login session's older unused ones, so only the newest push is
// ever good.
//
// The push often lands before openSocket() asks for it (op 1 goes out first),
// so it's stashed rather than awaited-only. It also names the voice node it is
// good for (voice_endpoint), so the two are stashed and used together.
const VOICE_TICKET_PUSH_WAIT_MS = 10_000
const VOICE_TICKET_MAX_AGE_MS = 20_000
let pushedTicket = null // { ticket, voiceEndpoint, receivedAt } — unconsumed push
let ticketWaiter = null // resolver for an acquireTicket() currently waiting

// What the event socket can do for voice, set by Main:
//   requestTicket()  ask for a ticket: op 13 while the backend lists us in a
//                    voice channel, otherwise op 1 back into the channel we
//                    mean to be in (the backend lost us: a fresh Ready without
//                    us). Returns 'sent', 'offline' (the event socket
//                    is down: retry later) or 'not-in-voice' (we don't mean to
//                    be in voice: stop).
//   inVoice()        whether the backend still has us in a voice channel, or we
//                    are on our way back into one. Decides what 4008 means.
let voiceServerHooks = {}

export function setVoiceServerHooks(hooks) {
  voiceServerHooks = { ...hooks }
}

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

// A ticket refusal ({ err } after op 13 or the join's op 1) for the connect
// waiting on a ticket. False when nothing is waiting.
function failTicketWait(code) {
  const waiter = ticketWaiter
  if (!waiter) return false
  ticketWaiter = null
  waiter({ error: code })
  return true
}

// Consume the stash, refusing one old enough that the server may already have
// expired it (presenting a dead ticket costs us a 4003 and another round trip).
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
    waiter = (refusal) => finish(refusal ?? takePushedTicket())
    ticketWaiter = waiter
    timer = setTimeout(() => finish(null), VOICE_TICKET_PUSH_WAIT_MS)
  })
}

// { ticket, voiceEndpoint }, { error: VoiceTicketError }, or null (none came).
async function acquireTicket() {
  return takePushedTicket() ?? (await waitForPushedTicket())
}

// Ask the backend for a new ticket (see setVoiceServerHooks). Throws when the
// request can't go out.
function requestNewTicket() {
  // An unused ticket from before is revoked by the one this mints.
  pushedTicket = null
  const outcome = voiceServerHooks.requestTicket?.() ?? 'offline'
  if (outcome === 'not-in-voice') throw ticketRefusal(VoiceTicketError.NotInVoice)
  if (outcome !== 'sent') throw connectFailure('Not connected to the server')
}

function ticketRefusal(code) {
  if (code === VoiceTicketError.NotInVoice) {
    const error = connectFailure('Not in a voice channel any more', { retryable: false })
    error.notInVoice = true
    return error
  }
  // No node can take the channel right now. Retried with backoff until the
  // give-up deadline.
  const error = connectFailure('Voice is unavailable on the server right now')
  error.voiceUnavailable = true
  return error
}

// A failed connect attempt. `retryable` says whether a new ticket can fix it;
// `action` is the CloseAction it calls for once a session was up (a socket's
// close code, or Resume / Fresh for a socket we closed ourselves).
function connectFailure(message, { retryable = true, closeCode, action } = {}) {
  const error = new Error(message)
  error.name = 'VoiceConnectError'
  error.retryable = retryable
  if (closeCode != null) error.closeCode = closeCode
  if (action != null) error.action = action
  return error
}

// The live session's signaling. One per voice *session*, which can outlive a
// socket: a resume attaches the next socket to the same signal, matcher, ids
// and event stream. `session` is the node's Session { id, resumeToken } (null
// until it arrives, and on a node that sends none), `url` the socket it lives
// on, `cursor` the highest seq applied (what a Resume sends as last_seq).
function createSignal(url) {
  const current = {
    socket: null,
    url,
    session: null,
    cursor: createEventCursor(),
    // Why we closed the current socket ourselves, reported in place of the
    // generic close error.
    failure: null,
    matcher: null,
    // The last few frames we sent, for the log when the server closes with
    // 4001 (it couldn't parse one of them).
    recentFrames: [],
    // READY: the matcher has seen the first Channel snapshot, which it marks
    // before that snapshot is applied, so its sinks can already be set up.
    get ready() {
      return this.matcher?.ready === true
    },
    // The socket is gone, and the session waits on the node for a resume.
    get detached() {
      return this.matcher?.detached === true
    }
  }
  current.matcher = createRequestMatcher({
    transmit: (frame) => {
      const socket = current.socket
      if (socket?.readyState !== WebSocket.OPEN) throw new Error('Voice socket not open')
      socket.send(frame)
      const shown = frame.length > 300 ? `${frame.slice(0, 300)}…` : frame
      console.log('[Soup] Sent:', shown)
      current.recentFrames.push(shown)
      if (current.recentFrames.length > 5) current.recentFrames.shift()
    },
    timeoutMs: VOICE_REQUEST_TIMEOUT_MS,
    // Nothing came back: most likely a half-open socket, which a resume fixes.
    onTimeout: (type) =>
      abandonSocket(
        current,
        connectFailure(`Voice request timed out (${type})`, { action: CloseAction.Resume })
      ),
    // An answer nothing asked for: client and server disagree about the
    // request stream, so nothing after this can be trusted. Start over with a
    // new session.
    onProtocolError: (error) => {
      console.error('[Soup] Voice protocol error:', error)
      abandonSocket(current, connectFailure(error.message, { action: CloseAction.Fresh }))
    }
  })
  return current
}

// Open a voice socket and take it to READY. Without `resumeFrom` it takes the
// pushed ticket, identifies and builds a new session (establishSession). With
// it, it resumes that detached session: Resume { last_seq }, then Resumed, then
// the same event stream carries on from last_seq + 1, applied as ordinary
// events. The matcher's Sync behind the replay finds the requests lost with
// the old socket (createRequestMatcher's resume()); its Done is when the
// resume is done. Each call replaces the shared `ws`. A stale-socket guard on
// every handler ignores a superseded socket once a newer one takes over.
//
// Resolves once the session is READY (or resumed). Rejects (with err.retryable
// and, for a socket the server closed, err.action) when it never gets there; by
// then the socket is closed and `ws` is free again.
async function openSocket(connectionGeneration = voiceConnectionGeneration, resumeFrom = null) {
  if (ws) throw connectFailure('A voice socket is already closing or connected')
  let url = resumeFrom?.url ?? null
  let acquired = null
  if (!resumeFrom) {
    voiceConnectStep = 'ticket'
    acquired = await acquireTicket()
    // The user may have left while we waited — opening now would orphan a socket
    // that nothing is holding.
    if (intentionalClose || connectionGeneration !== voiceConnectionGeneration) {
      throw mediaResetError()
    }
    if (!acquired) throw connectFailure('No voice ticket arrived from the server')
    if (acquired.error) throw ticketRefusal(acquired.error)
    url = voiceSocketUrl(acquired.voiceEndpoint)
    if (!url) {
      throw connectFailure('Voice is unavailable: the server sent no voice endpoint', {
        retryable: false
      })
    }
  }

  voiceConnectStep = resumeFrom ? 'resume' : 'connect'
  console.log(`[Soup] Voice endpoint: ${url}${resumeFrom ? ' (resuming)' : ''}`)
  const socket = new WebSocket(url)
  ws = socket
  const current = resumeFrom ?? createSignal(url)
  current.socket = socket
  current.failure = null
  signal = current
  // This socket carried a usable session: READY (a new session), or Resumed.
  let resumed = false
  const attached = () => (resumeFrom ? resumed : current.ready)

  let settled = false
  let resolveEstablished
  let rejectEstablished
  const established = new Promise((resolve, reject) => {
    resolveEstablished = resolve
    rejectEstablished = reject
  })
  const settle = (error = null) => {
    if (settled) return
    settled = true
    clearTimeout(establishTimer)
    if (error) rejectEstablished(error)
    else resolveEstablished()
  }
  const establishTimer = setTimeout(
    () => {
      abandonSocket(
        current,
        connectFailure(`Voice session setup timed out (${voiceConnectStep ?? 'unknown'} step)`, {
          action: CloseAction.Resume
        })
      )
    },
    resumeFrom ? VOICE_RESUME_TIMEOUT_MS : VOICE_ESTABLISH_TIMEOUT_MS
  )

  // ─── Assign ALL handlers before anything can fire ───────────────
  socket.onmessage = (event) => {
    if (ws !== socket) return // superseded by a newer socket
    let message
    try {
      message = decodeFrame(event.data)
    } catch (err) {
      // A frame we can't read may have been an answer a request is waiting for,
      // or an event the media state can't do without. Start over instead.
      console.error('[Soup] Unreadable voice frame:', err, event.data)
      abandonSocket(
        current,
        connectFailure('Unreadable voice frame', { action: CloseAction.Fresh })
      )
      return
    }
    // The handshake frames, the only ones without a seq (decodeFrame checks).
    if (message.seq == null) {
      console.log('[Soup] Received:', message.type, message.data ?? '')
      // The first frame after Identify: what a resume needs.
      if (message.type === 'Session') {
        const id = message.data?.id
        const resumeToken = message.data?.resume_token
        current.session =
          id != null && typeof resumeToken === 'string' ? { id: String(id), resumeToken } : null
        return
      }
      // Resumed: the first frame after a Resume the node accepted.
      const resumeToken = message.data?.resume_token
      if (!resumeFrom || resumed || !current.session || typeof resumeToken !== 'string') {
        abandonSocket(current, connectFailure('Unexpected Resumed', { action: CloseAction.Fresh }))
        return
      }
      resumed = true
      // The token rotates on every resume; the old one is spent.
      current.session.resumeToken = resumeToken
      console.log(
        `[Soup] Session ${current.session.id} resumed after seq ${current.cursor.lastSeq}; ` +
          'replaying what was missed'
      )
      current.matcher.resume().then(
        () => {
          if (signal !== current || ws !== socket) return
          afterResume(current)
          settle()
        },
        // The session closed, or this socket went too and a later resume's Sync
        // took over: that socket's close or attempt owns the outcome.
        () => {}
      )
      return
    }
    // A resumed stream continues only after Resumed.
    if (resumeFrom && !resumed) {
      abandonSocket(
        current,
        connectFailure(`${message.type} before Resumed`, { action: CloseAction.Fresh })
      )
      return
    }
    // Seen already: a duplicate between the events held across the drop and the
    // replay. The node filters these too; this is defence in depth.
    if (!current.cursor.accept(message.seq)) {
      console.log(`[Soup] Skipped duplicate ${message.type} (seq ${message.seq})`)
      return
    }
    console.log(`[Soup] Received #${message.seq}:`, message.type, message.data ?? '')
    if (current.matcher.handle(message)) return
    if (EVENT_TYPES.has(message.type)) {
      try {
        handleEvent(message.type, message.data)
      } catch (err) {
        console.error(`[Soup] Failed to apply ${message.type}:`, err)
      }
      return
    }
    if (message.type === 'Error') {
      // Nothing was waiting on it: a request sent and forgotten failed.
      console.warn('[Soup]', new VoiceRequestError(null, message.data ?? {}).message)
      return
    }
    console.warn('[Soup] Unhandled voice message:', message.type)
  }

  const handleSocketClose = (event) => {
    if (ws !== socket) return // a newer socket has already taken over
    clearTimeout(socketCloseDeadlineTimer)
    socketCloseDeadlineTimer = null
    currentSocketCloseHandler = null
    // Release the global socket before callbacks or reconnect scheduling. A
    // recovery attempt may now begin, but only after this handler has torn down
    // (or detached) the session it belonged to.
    ws = null
    current.socket = null
    const wasAttached = attached()
    const close = classifyClose(event.code)
    console.log('[Soup] Voice socket closed — code:', event.code, 'reason:', event.reason)
    if (event.code === CloseCode.InvalidPayload) {
      console.error(
        '[Soup] Voice server could not parse a frame we sent. Last sent:',
        current.recentFrames
      )
    }
    const failure = current.failure
    current.failure = null
    const closeError = connectFailure(
      `Voice socket closed (${event.code || 'no code'}: ${event.reason || close.reason})`,
      { closeCode: event.code, action: close.action }
    )
    // Our own close says what it was for; the code it carries doesn't.
    const error = failure ?? closeError
    error.action ??= close.action

    if (intentionalClose) {
      // Leaving: 4008 (or our own close) is the expected end, not an error.
      endSession(current, closeError)
      settle(error)
      const info = pendingDisconnectInfo
      pendingDisconnectInfo = undefined
      activeCallbacks.onDisconnect?.(info)
      return
    }
    if (!wasAttached || !settled) {
      // Still establishing: the attempt's caller (connect / attemptReconnect)
      // owns the outcome through the rejected promise. A new session dies with
      // its socket; a session being resumed stays detached for the next try.
      if (!resumeFrom) endSession(current, closeError)
      else if (resumed) current.matcher.detach(closeError)
      settle(failure ?? closeOutcome(close, closeError))
      return
    }
    // A live session lost its socket.
    lastVoiceReconnectReason ??= `socket close ${event.code || 'no code'} (${close.reason})`
    handleSessionDrop(current, error.action, close, error)
  }
  currentSocketCloseHandler = handleSocketClose
  socket.onclose = handleSocketClose

  socket.onerror = (err) => {
    console.error('[Soup] Voice WebSocket error:', err)
  }

  // ─── onopen last so handlers are guaranteed to be in place ──────
  socket.onopen = () => {
    if (ws !== socket) return
    if (resumeFrom) {
      console.log(`[Soup] Voice socket open, resuming session ${current.session?.id}`)
      try {
        socket.send(
          JSON.stringify(
            Request.resume(current.session.id, current.session.resumeToken, current.cursor.lastSeq)
          )
        )
      } catch (err) {
        abandonSocket(
          current,
          connectFailure(`Resume not sent: ${err?.message ?? err}`, { action: CloseAction.Resume })
        )
      }
      return
    }
    console.log('[Soup] Voice socket open, identifying')
    establishSession(current, acquired.ticket).then(
      () => settle(),
      (err) => {
        const error = err instanceof Error ? err : new Error(String(err))
        // mediasoup's UnsupportedError: this device can't use the router's
        // codecs, which no new ticket will change.
        error.retryable ??= error.name !== 'UnsupportedError'
        error.action ??= CloseAction.Fresh
        abandonSocket(current, error)
      }
    )
  }

  await established
  clearGiveUpTimer()
  if (everReady) {
    // Recovery outcomes have to reach pylon.log, and only warn/error do.
    console.warn(
      `[Soup] Voice ${resumeFrom ? 'resumed' : 'reconnected'} (attempt ${reconnectAttempts || 1} ` +
        `after ${lastVoiceReconnectReason ?? 'socket close'})`
    )
  }
  everReady = true
  lastVoiceReconnectReason = null
  reconnectAttempts = 0
  voiceConnectStep = null
  armMediaWatchdog(mediaStateGeneration)
  syncSpeaking(true)
  Promise.resolve(activeCallbacks.onConnect?.()).catch((err) =>
    console.error('[Soup] onConnect failed:', err)
  )
}

// Identify → Session → RoutingParams → Device + both transports →
// SetCapabilities → Channel. Neither request has an answer of its own, so the
// matcher waits on what follows each. The server pushes RoutingParams once
// identify succeeds, and closes with 4003 when the ticket is refused.
// SetCapabilities joins the channel, and the Channel snapshot after it is its
// sign of success (the session is READY), applied as an event as well; a
// refusal is an Error on the session.
async function establishSession(current, ticket) {
  const generation = mediaStateGeneration
  const isCurrent = () => signal === current && generation === mediaStateGeneration

  voiceConnectStep = 'identify'
  const routing = await current.matcher.request(Request.identify(ticket))
  if (!isCurrent()) throw mediaResetError()
  emitMediaState('authenticated')

  voiceConnectStep = 'device'
  const sendParams = mapTransportParams(routing?.producer_transport)
  const recvParams = mapTransportParams(routing?.consumer_transport)
  if (!sendParams || !recvParams) throw connectFailure('Voice server sent no transports')
  // Never publish a half-loaded Device: a reset can land while it loads.
  const candidate = new Device()
  await candidate.load({ routerRtpCapabilities: routing.router_capabilities })
  if (!isCurrent()) throw mediaResetError()
  device = candidate
  producerTransport = createSendTransport(candidate, sendParams, generation)
  consumerTransport = createRecvTransport(candidate, recvParams, generation)

  voiceConnectStep = 'capabilities'
  // Throws if this runtime can't encrypt media: E2EE is mandatory.
  const formats = await e2eeFormats()
  if (!isCurrent()) throw mediaResetError()
  try {
    await current.matcher.request(Request.setCapabilities(candidate.recvRtpCapabilities, formats))
  } catch (err) {
    if (err?.updateRequired) {
      const error = new Error(UPDATE_REQUIRED_MESSAGE)
      error.retryable = false
      throw error
    }
    throw err
  }
  if (!isCurrent()) throw mediaResetError()
  console.log('[Soup] Voice session ready')
}

const UPDATE_REQUIRED_MESSAGE =
  'This version of Pylon can no longer join voice on this server; update to continue'

// ─── Resume ──────────────────────────────────────────────────────
// A resumed session is the same event stream picked up where we left it. The
// replay brought every Source, Sink, Closed, TransportConnected, SinkLayers,
// Channel and Group event we missed, applied as they came; the matcher sent
// again whatever was lost with the socket; our transports and media never
// stopped. All that's left is what we wanted while the socket was down, which
// was refused then:
//   - a video sink's view role (a refused ConfigureSink makes applyViewRole
//     forget the sink's config, so it sends all of it again);
//   - the pause of one of our own sources;
//   - a connection repair that had to wait for the socket.
function afterResume(current) {
  console.log(`[Soup] Session resumed, caught up at seq ${current.cursor.lastSeq}`)
  for (const entry of remoteConsumers.values()) applyViewRole(entry)
  // The node cleared our speaking flags while it held the session.
  syncSpeaking(true)

  const pauses = [...unsentSourcePauses]
  unsentSourcePauses.clear()
  for (const node of pauses) {
    // A microphone's pause is voice state (op 1), never sent here.
    if (!localSources.has(node)) continue
    void setServerSourcePaused(ownId(node), localSourcePaused.get(node) === true)
  }

  const restarts = [...pendingIceRestarts]
  pendingIceRestarts.clear()
  for (const direction of restarts) restartTransportIce(direction, 'deferred until the resume')

  e2eeResume()
}

// A ready session lost its socket. `action` is what the close calls for
// (CloseAction), `close` the classified close code. `immediate` starts a new
// session without waiting out a backoff (after a refused resume).
function handleSessionDrop(current, action, close, error, { immediate = false } = {}) {
  switch (action) {
    case CloseAction.Resume:
      // Without a Session from the node there's nothing to resume with.
      if (current.session) {
        detachSession(current, error)
        return
      }
      startNewSession(current, error, { immediate })
      return
    case CloseAction.Fresh:
      startNewSession(current, error, { immediate })
      return
    case CloseAction.IfInVoice:
      // We left voice or were moved off this node. The backend's word on
      // whether we're still in a channel arrives on the event socket; a ticket
      // request it no longer agrees with comes back not_in_voice, which stops.
      if (voiceServerHooks.inVoice?.() !== false) {
        startNewSession(current, error, { immediate })
        return
      }
      console.log('[Soup] Voice session ended and we are no longer in a voice channel')
      failVoice('Voice session ended', { quiet: true })
      return
    case CloseAction.Update:
      failVoice(UPDATE_REQUIRED_MESSAGE)
      return
    default:
      // Replaced: another of our devices took voice over. Kicked: the backend
      // already took us out. Either way an op 1 leave would be wrong.
      failVoice(
        close.name === 'Replaced'
          ? 'Voice was taken over by another device'
          : `Voice disconnected: ${close.reason}`,
        { leave: false }
      )
  }
}

// What a close during setup means for the attempt: the close error, made
// final (retryable: false) for the codes no new ticket fixes.
function closeOutcome(close, closeError) {
  const final = (message, extra = {}) =>
    Object.assign(
      connectFailure(message, {
        retryable: false,
        closeCode: closeError.closeCode,
        action: close.action
      }),
      extra
    )
  switch (close.action) {
    case CloseAction.Update:
      return final(UPDATE_REQUIRED_MESSAGE)
    case CloseAction.Stop:
      return final(
        close.name === 'Replaced'
          ? 'Voice was taken over by another device'
          : `Voice disconnected: ${close.reason}`,
        { leave: false }
      )
    case CloseAction.IfInVoice:
      if (voiceServerHooks.inVoice?.() === false) {
        return Object.assign(ticketRefusal(VoiceTicketError.NotInVoice), {
          closeCode: closeError.closeCode,
          action: close.action
        })
      }
      return closeError
    default:
      return closeError
  }
}

// The server holds the session for a short while (VOICE_RESUME_GRACE) as we
// reconnect and pick it back up. Media keeps flowing if only the connection
// broke, so nothing is torn down and others see no change.
function detachSession(current, error) {
  console.warn(`[Soup] Voice socket lost (${error.message}); resuming the session`)
  current.matcher.detach(error)
  emitMediaState('reconnecting', { reason: lastVoiceReconnectReason })
  startGiveUpTimer()
  scheduleVoiceReconnect()
}

// The session is over: tear its media down and build a new one (get a ticket,
// then sign in again) while staying in the channel. Others see us reconnect.
function startNewSession(current, error, { immediate = false } = {}) {
  console.warn(`[Soup] Voice session lost (${error.message}); starting a new one`)
  endSession(current, error)
  emitMediaState('reconnecting', { reason: lastVoiceReconnectReason })
  activeCallbacks.onReconnecting?.()
  startGiveUpTimer()
  scheduleVoiceReconnect({ immediate })
}

// Everything that belonged to a session, gone: its pending requests rejected,
// its media torn down.
function endSession(current, error) {
  if (signal === current) signal = null
  current.matcher.close(error)
  resetMediaState()
}

// Close a socket whose signaling can't be trusted any more (request timeout,
// protocol error, unreadable frame, failed setup). Its close handler then
// resumes or rebuilds a READY session (by error.action), or fails the attempt
// still establishing.
function abandonSocket(current, error) {
  if (!current || !current.socket || ws !== current.socket) return
  current.failure ??= error
  lastVoiceReconnectReason = error.message
  console.warn(`[Soup] ${error.message}; closing voice socket`)
  current.socket.close()
  armSocketCloseDeadline(current.socket)
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
    currentSocketCloseHandler?.({ code: 1006, reason: 'Local close timeout' })
  }, 3000)
}

function reconnectDelay(attempt) {
  return Math.round(
    Math.min(VOICE_RECONNECT_MAX_DELAY_MS, VOICE_RECONNECT_BASE_DELAY_MS * 2 ** attempt) *
      (0.5 + Math.random() * 0.5)
  )
}

// Schedule a reconnect with capped exponential backoff and jitter (a node
// restart reconnects everyone at once). `immediate` skips the wait, for a
// resume the node refused: the new session should follow at once.
function scheduleVoiceReconnect({ immediate = false } = {}) {
  if (intentionalClose || reconnectTimer) return
  const delay = immediate ? 0 : reconnectDelay(reconnectAttempts)
  reconnectAttempts++
  console.warn(`[Soup] Reconnecting voice in ${delay}ms (attempt ${reconnectAttempts})`)
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    attemptReconnect()
  }, delay)
}

// One reconnect attempt: Resume a detached session, or else ask for a ticket
// (op 13) and identify into a new session.
async function attemptReconnect() {
  if (intentionalClose || reconnectInFlight) return
  const connectionGeneration = voiceConnectionGeneration
  const isStale = () => intentionalClose || connectionGeneration !== voiceConnectionGeneration
  reconnectInFlight = true
  const detached = signal?.detached === true ? signal : null
  const resuming = detached?.session != null
  try {
    if (resuming) {
      voiceConnectStep = 'resume'
      await openSocket(connectionGeneration, detached)
    } else {
      // A detached session with nothing to resume it by is over.
      if (detached) startNewSessionNow(detached, connectFailure('No resume token'))
      voiceConnectStep = 'ticket-request'
      requestNewTicket()
      await openSocket(connectionGeneration)
    }
  } catch (err) {
    if (isStale()) return
    if (resuming && signal === detached && detached.detached) {
      const action = err?.action ?? CloseAction.Resume
      if (action === CloseAction.Resume) {
        console.warn(`[Soup] Voice resume failed (${err?.message}); trying again`)
        scheduleVoiceReconnect()
        return
      }
      // The node refused the resume (4003: the session is gone, or the token
      // rotated under a lost Resumed) or wants something else: go by the code.
      reconnectInFlight = false
      handleSessionDrop(detached, action, classifyClose(err?.closeCode), err, { immediate: true })
      return
    }
    if (err?.notInVoice) {
      failVoice('No longer in a voice channel', { quiet: true })
      return
    }
    if (err?.retryable === false) {
      failVoice(err.message, { leave: err.leave !== false })
      return
    }
    console.error(`[Soup] Voice reconnect failed at ${voiceConnectStep ?? 'unknown'} step:`, err)
    scheduleVoiceReconnect()
  } finally {
    reconnectInFlight = false
  }
}

// startNewSession for a detached session, from inside a reconnect attempt that
// goes on to ask for the ticket itself (so nothing is scheduled).
function startNewSessionNow(current, error) {
  console.warn(`[Soup] Voice session lost (${error.message}); starting a new one`)
  endSession(current, error)
  activeCallbacks.onReconnecting?.()
}

// ─── Give-up deadline ────────────────────────────────────────────
// A session that stays lost this long is given up: op 1 leave and "voice
// disconnected". Below the backend's VOICE_CONNECT_GRACE (45 s), so our own
// leave usually beats its reaper.
const VOICE_GIVE_UP_MS = 40_000
let giveUpTimer = null

function startGiveUpTimer() {
  if (giveUpTimer != null) return
  giveUpTimer = setTimeout(() => {
    giveUpTimer = null
    if (intentionalClose) return
    if (ws != null && signal?.ready && !signal.detached && ws === signal.socket) return
    failVoice('Voice disconnected: could not reconnect to the voice server')
  }, VOICE_GIVE_UP_MS)
}

function clearGiveUpTimer() {
  if (giveUpTimer != null) clearTimeout(giveUpTimer)
  giveUpTimer = null
}

// Give up on voice. onDisconnect gets { failed: true, reason, leave } so the
// UI can say why, and leaves the channel (op 1) unless `leave` is false.
// `quiet` reports a plain disconnect instead (we're out of voice already, and
// the event socket has said so).
function failVoice(reason, { leave = true, quiet = false } = {}) {
  if (quiet) console.warn(`[Soup] ${reason}; stopping voice`)
  else console.error(`[Soup] ${reason}; giving up on voice`)
  const callbacks = activeCallbacks
  const info = quiet ? undefined : { failed: true, reason, leave }
  const hadSocket = ws != null
  disconnect()
  // With a socket still open, its close handler delivers onDisconnect.
  if (hadSocket) pendingDisconnectInfo = info
  else callbacks.onDisconnect?.(info)
}

// Recover from a detected network failure. The browser never shows us the
// node's pings, so a half-open socket can sit in OPEN without firing onclose;
// the OS online/offline events, a transport that won't recover, and the media
// watchdog call this. `action` is what the lost socket calls for: Resume (the
// network went away; the session is fine) or Fresh (the session's media is
// broken). No-op unless we have a live, non-intentional session.
function forceVoiceReconnect(reason, action = CloseAction.Resume) {
  if (!everReady || intentionalClose) return
  lastVoiceReconnectReason = reason
  const state = voiceSocketRecoveryAction(ws?.readyState)
  // A socket that still thinks it's open/connecting is the half-open case:
  // close it so onclose runs the normal resume or rebuild.
  if (state === 'close') {
    if (signal?.socket === ws) {
      abandonSocket(signal, connectFailure(reason, { action }))
    } else {
      console.warn(`[Soup] ${reason} — closing half-open voice socket to recover`)
      ws.close()
      armSocketCloseDeadline(ws)
    }
    return
  }
  // CLOSING/CLOSED still owns the teardown callback. Starting a replacement
  // now would overwrite `ws`, make the old onclose stale, and preserve its dead
  // transports.
  if (state === 'wait-for-close') {
    armSocketCloseDeadline(ws)
    return
  }
  // No socket: waiting out a backoff (or a resume). A broken session is not
  // worth resuming.
  if (action === CloseAction.Fresh && signal?.detached) {
    startNewSessionNow(signal, connectFailure(reason))
  }
  if (reconnectInFlight) return
  console.warn(`[Soup] ${reason} — retrying voice connection now`)
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempts = 0
  attemptReconnect()
}

// The backend lost us (a fresh Ready that doesn't list us in voice):
// drop the session and get back in. The new session's ticket comes from an op
// 1 back into our channel (setVoiceServerHooks.requestTicket).
export function restartVoiceSession(reason) {
  console.warn(`[Soup] ${reason}; starting a new voice session`)
  forceVoiceReconnect(reason, CloseAction.Fresh)
}

// The events socket finished a handshake. A ticket request (op 13) can't leave
// the client while it's down, so a new session sitting in backoff is waiting
// on something that's already fixed; kick it instead of waiting out a backoff
// that can outlive the UI's rejoin timeout. A session the event-socket outage
// never touched (it only costs us the event socket for VOICE_EVENT_GRACE)
// reports itself ready again, which is what the UI's recovery waits for.
export function notifyEventsSessionRestored() {
  if (
    !intentionalClose &&
    ws != null &&
    ws === signal?.socket &&
    signal.ready &&
    !signal.detached &&
    reconnectTimer == null &&
    !reconnectInFlight
  ) {
    scheduleMediaReadyCheck()
    return
  }
  if (
    !shouldKickVoiceReconnect({
      everAuthenticated: everReady,
      intentionalClose,
      reconnectPending: reconnectTimer != null,
      reconnectInFlight,
      reconnectAttempts
    })
  )
    return
  // A socket that still exists owns its own teardown.
  if (voiceSocketRecoveryAction(ws?.readyState) !== 'retry') return
  console.warn('[Soup] Events session restored, retrying voice connection now')
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  reconnectAttempts = 0
  attemptReconnect()
}

// OS reports the network interface went down: close the dead socket now so
// the resume attempts start (they fail until we're back online).
function handleOffline() {
  forceVoiceReconnect('Network offline')
}

// OS reports connectivity is back. A live socket keeps its session; the
// network path under the transports changed, so restart ICE on them. Without
// a socket, resume now rather than waiting out the current backoff.
function handleOnline() {
  if (!everReady || intentionalClose) return
  if (ws != null && ws === signal?.socket && ws.readyState === WebSocket.OPEN && !signal.detached) {
    restartTransportIce(Direction.Send, 'Network online')
    restartTransportIce(Direction.Receive, 'Network online')
    return
  }
  forceVoiceReconnect('Network online')
}

// ─── ICE restart ─────────────────────────────────────────────────
// A transport whose ICE fails or stays disconnected asks the node for new ICE
// parameters (RestartIce → IceRestarted) and hands them to
// transport.restartIce(). One restart per transport at a time; if it isn't
// connected again within ICE_RESTART_TIMEOUT_MS, the session is rebuilt.
const ICE_RESTART_TIMEOUT_MS = 10_000
const iceRestarts = new Map() // direction -> timer
// Restarts that came up while the socket was down, run once it's resumed.
const pendingIceRestarts = new Set()

function transportFor(direction) {
  return direction === Direction.Send ? producerTransport : consumerTransport
}

function restartTransportIce(direction, reason) {
  const transport = transportFor(direction)
  if (intentionalClose || !transport || transport.closed) return
  // Never connected (no produce or consume yet): nothing to restart.
  if (transport.connectionState === 'new') return
  if (iceRestarts.has(direction)) return
  if (!signal || signal.detached || ws == null || ws !== signal.socket) {
    pendingIceRestarts.add(direction)
    return
  }
  console.warn(`[Soup] ${reason}; restarting ICE on the ${direction} transport`)
  const generation = mediaStateGeneration
  const isCurrent = () =>
    generation === mediaStateGeneration &&
    transportFor(direction) === transport &&
    !transport.closed
  iceRestarts.set(
    direction,
    setTimeout(() => {
      iceRestarts.delete(direction)
      if (!isCurrent() || transport.connectionState === 'connected') return
      // The socket went down meanwhile: try again once it's resumed.
      if (signal?.detached) {
        pendingIceRestarts.add(direction)
        return
      }
      forceVoiceReconnect(
        `${direction} transport did not recover after an ICE restart`,
        CloseAction.Fresh
      )
    }, ICE_RESTART_TIMEOUT_MS)
  )
  request(Request.restartIce(direction))
    .then((answer) => {
      if (!isCurrent()) return
      return transport.restartIce({ iceParameters: answer?.ice_parameters })
    })
    .catch((err) =>
      console.warn(`[Soup] ICE restart of the ${direction} transport failed:`, err?.message ?? err)
    )
}

function clearIceRestart(direction) {
  const timer = iceRestarts.get(direction)
  if (timer != null) clearTimeout(timer)
  iceRestarts.delete(direction)
  pendingIceRestarts.delete(direction)
}

// ─── Disconnect ──────────────────────────────────────────────────
// Leaving voice. The caller also sends op 1 with channel_id null; the node
// would close the socket with 4008 then, but we close it first.
export function disconnect() {
  voiceConnectionGeneration++
  intentionalClose = true
  // Leaving voice drops the call's group and every key. A reconnect keeps them instead: its
  // rejoin replaces our leaf in the same group.
  e2eeLeave()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  clearGiveUpTimer()
  reconnectAttempts = 0
  // A ticket minted for a join we're abandoning: drop it so a later connect
  // can't present it, and wake a connect still waiting for one.
  pushedTicket = null
  const waiter = ticketWaiter
  ticketWaiter = null
  waiter?.()
  window.removeEventListener('offline', handleOffline)
  window.removeEventListener('online', handleOnline)
  // Let the (guarded) onclose handler run resetMediaState + onDisconnect and
  // null out `ws`; closing synchronously here would race that cleanup.
  if (ws) {
    const socket = ws
    socket.close()
    armSocketCloseDeadline(socket)
  } else if (signal) {
    // A session waiting to be resumed has no socket to close.
    endSession(signal, mediaResetError())
  }
}

// ─── Transports ──────────────────────────────────────────────────
// producer_transport is our send transport (it creates sources),
// consumer_transport our receive transport (it creates sinks).
function createSendTransport(loadedDevice, params, generation) {
  const transport = wrapSendTransport(loadedDevice.createSendTransport(params))
  const isCurrentTransport = () =>
    generation === mediaStateGeneration && producerTransport === transport && !transport.closed

  watchTransportConnectivity(transport, 'Send', isCurrentTransport)
  transport.on('connect', ({ dtlsParameters }, callback, errback) =>
    connectTransport(Direction.Send, dtlsParameters, isCurrentTransport, callback, errback)
  )
  transport.on('produce', ({ rtpParameters, appData }, callback, errback) => {
    createSource(rtpParameters, appData, isCurrentTransport)
      .then((node) => callback({ id: ownId(node) }))
      .catch((err) => errback(err))
  })
  return transport
}

function createRecvTransport(loadedDevice, params, generation) {
  const transport = wrapRecvTransport(loadedDevice.createRecvTransport(params))
  const isCurrentTransport = () =>
    generation === mediaStateGeneration && consumerTransport === transport && !transport.closed

  watchTransportConnectivity(transport, 'Receive', isCurrentTransport)
  transport.on('connect', ({ dtlsParameters }, callback, errback) =>
    connectTransport(Direction.Receive, dtlsParameters, isCurrentTransport, callback, errback)
  )
  return transport
}

// mediasoup-client fires 'connect' on a transport's first produce/consume.
// Waiting for TransportConnected (rather than calling back as soon as the
// request is sent, which the in-order server would also allow) costs one round
// trip per transport and gives a clean failure path.
function connectTransport(direction, dtlsParameters, isCurrentTransport, callback, errback) {
  if (!isCurrentTransport()) {
    errback(mediaResetError())
    return
  }
  request(Request.connectTransport(direction, dtlsParameters))
    .then(() => {
      if (!isCurrentTransport()) throw mediaResetError()
      callback()
    })
    .catch((err) => errback(err))
}

// The send transport's 'produce': CreateSource with the source type the
// producer's appData names (see sourceTypeForAppData). We name the new source;
// once its Source answer confirms it, that LocalId (as a string) is the
// producer's id. An Error naming it fails the produce.
//
// appData.replaces (a producer id) swaps that source for this one on the
// server. The old producer stays the caller's to close locally, with no Close
// of its own: the server has closed it by the time this resolves.
//
// appData.streamKey is the stream (createOwnStream) a Stream or StreamAudio
// source publishes into. A replacement carries it too: the server would take
// it without, but sending the same key keeps every stream CreateSource alike.
async function createSource(rtpParameters, appData, isCurrentTransport) {
  if (!isCurrentTransport()) throw mediaResetError()
  const type = sourceTypeForAppData(appData)
  if (!type) throw new Error(`No voice source type for producer "${appData?.produced}"`)
  const streamKey =
    type === SourceType.Stream || type === SourceType.StreamAudio
      ? (appData?.streamKey ?? null)
      : null
  // The server would refuse it (Denied) after waiting 2s for a lease.
  if ((type === SourceType.Stream || type === SourceType.StreamAudio) && streamKey == null) {
    throw new Error(`A ${type} source needs a stream key`)
  }
  // Screen rung validation must finish before the server sees the source.
  await runBeforeServerProduce(appData, rtpParameters)
  if (!isCurrentTransport()) throw mediaResetError()

  const replaces = appData?.replaces == null ? null : ownNode(appData.replaces)
  const replacement = replaces == null ? null : { closed: false }
  if (replacement) sourceReplacements.set(replaces, replacement)
  let created
  try {
    created = await requestCreate((node) =>
      Request.createSource(node, type, rtpParameters, replaces, streamKey)
    )
  } catch (err) {
    // Nothing was handed over, so a Closed for the old source meanwhile (say,
    // a channel switch) was a real close.
    if (replacement?.closed) closeLocalSource(replaces)
    throw err
  } finally {
    if (replacement && sourceReplacements.get(replaces) === replacement) {
      sourceReplacements.delete(replaces)
    }
  }
  if (replaces != null) localSources.delete(replaces)
  if (!isCurrentTransport()) throw mediaResetError()
  const { node } = created
  localSources.set(node, type)
  // From here the stream ends only when its sources close.
  if (streamKey != null && ownStream?.key === streamKey) ownStream.claimed = true
  console.log(
    `[Soup] Source ${node} created (${type})` +
      (replaces != null ? `, replacing ${replaces}` : '') +
      (streamKey != null ? ` in stream ${streamKey}` : '')
  )
  if (type === SourceType.Stream) publishStreamViewers()
  return node
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
      clearIceRestart(label)
      scheduleMediaReadyCheck()
      return
    }
    if (state === 'closed') {
      clearDegradedTimer()
      return
    }
    if (state === 'failed') {
      clearDegradedTimer()
      restartTransportIce(label, `${label} transport failed`)
      return
    }
    // ICE can briefly report disconnected/connecting while changing network
    // paths. Once a transport was healthy, bound that state, then restart its
    // ICE (which rebuilds the session if even that doesn't bring it back).
    if (wasConnected && (state === 'disconnected' || state === 'connecting')) {
      clearDegradedTimer()
      degradedTimer = setTimeout(() => {
        degradedTimer = null
        if (
          isCurrentTransport() &&
          transport.connectionState !== 'connected' &&
          transport.connectionState !== 'closed'
        ) {
          restartTransportIce(label, `${label} transport remained ${transport.connectionState}`)
        }
      }, TRANSPORT_DISCONNECTED_GRACE_MS)
    }
  })
}

function mediaResetError() {
  const error = new Error('Voice media state reset during operation')
  error.name = 'VoiceMediaResetError'
  return error
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
  if (stream) localCaptureLost = false
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
      console.warn('[Soup] Raw microphone track ended, attempting one repair')
      if (!settings || !producerTransport || producerTransport.closed) {
        requestVoiceMediaRecovery('Microphone capture ended')
        return
      }
      republish(settings)
        // Reaching ready again is what re-arms this repair for a later loss.
        .then(() => scheduleMediaReadyCheck())
        .catch((err) => {
          if (isPermanentMicError(err)) {
            console.error('[Soup] Microphone capture needs user action:', micFailureDetail(err))
            emitMediaState('failed', { reason: err.name })
            return
          }
          if (err?.micCaptureFailure) {
            // The device is absent, not the session, so a reconnect would only
            // cost an outage. The publish ladder waits for it to come back.
            console.warn('[Soup] Microphone repair failed:', micFailureDetail(err))
            emitMediaState('local-capture-lost', { reason: err.name })
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

// The mic chain renders on its own context. If that fails (the output device
// it runs on went away), the producer keeps a live track that only carries
// silence and nothing else notices. Rebuild the chain on the capture we hold.
// A capture that died too is the 'ended' repair's, which rebuilds the chain.
onMicContextLost(() => {
  const settings = lastCommittedMicSettings
  if (intentionalClose || !settings || !hasLiveAudioProducer()) return
  republish(settings, undefined, { graphOnly: true }).catch((err) => {
    if (err?.name === 'VoiceMediaResetError') return
    console.error('[Soup] Mic chain rebuild after a context loss failed:', err)
    // The capture is fine, so this was the producer or its transport.
    requestVoiceMediaRecovery('Microphone chain rebuild failed')
  })
})

// Register the "you're talking while muted" handler (UI plays a sound + shows a
// warning toast). Mirrored in from the app layer.
export function setTalkingWhileMutedHandler(fn) {
  onTalkingWhileMuted = fn
}

// Warn (throttled) when we speak while muted. `tap` is the processing chain's
// pre-destination node (see buildAudioProcessor): it stays live while muted, and
// it has already been through RNNoise and the volume gate, so a warning only
// fires on audio loud/clean enough that peers would have received it. Without a
// chain (processor build failed) we fall back to the raw capture, which is then
// what would have been published anyway.
function startLocalSpeakingDetector(stream, tap, gated) {
  mutedTalkStop?.()
  let current = true
  const stop = createSpeakingDetector(
    stream,
    (isSpeaking) => {
      if (!gated && current) setLocalSpeaking(isSpeaking)
      if (!isSpeaking || !micMuted || micTestActive) return
      const now = performance.now()
      if (now - lastTalkingWhileMutedAt < TALKING_WHILE_MUTED_COOLDOWN_MS) return
      lastTalkingWhileMutedAt = now
      onTalkingWhileMuted?.()
    },
    tap
      ? { audioContext: tap.context, sourceNode: tap.node }
      : { audioContext: getPlaybackContext() }
  )
  mutedTalkStop = () => {
    current = false
    stop()
  }
}

// A chain whose gate drives local speaking only while it is the committed one.
async function buildSpeakingAudioProcessor(stream, micSettings) {
  let stop = null
  const processed = await buildAudioProcessor(stream, micSettings, {
    onGateOpenChange: (open) => {
      if (stop != null && stop === audioProcessorStop) setLocalSpeaking(open)
    }
  })
  stop = processed.stop
  return processed
}

// OverconstrainedError's message is empty in Chromium, and the offending
// constraint is only on err.constraint. Without this, a capture failure is
// indistinguishable in a log export from any other device error.
function micFailureDetail(err, micSettings) {
  const constraint = err?.constraint ? ` constraint=${err.constraint}` : ''
  const deviceId =
    micSettings === undefined ? lastCommittedMicSettings?.deviceId : micSettings?.deviceId
  return `${err?.name ?? 'Error'}: ${err?.message || '(no message)'}${constraint} requested=${shortDeviceId(deviceId)}`
}

// ─── Publish: send local audio ───────────────────────────────────
// Single-flight: onConnect and a channel adopt() can both call this at once,
// and two concurrent publishes would create two Microphone sources.
//
// The fast-path guard is "we are already transmitting", NOT "a session
// exists": a publish that died before producing (getUserMedia denied,
// processor or produce failure) must stay retryable, or the user sits in the
// channel sending nothing until something else happens to trigger a republish.
export async function publish(micSettings, onStream) {
  if (hasLiveAudioProducer()) return
  // The mic's source is still up on the server and only its capture died (the
  // device dropped mid-call). Reopen the capture onto it: producing here would
  // put a second Microphone source beside the dead one.
  if (producers.some((producer) => producer.kind === 'audio' && !producer.closed)) {
    await republish(micSettings, onStream)
    scheduleMediaReadyCheck()
    return
  }
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

async function doPublish(micSettings, onStream, generation) {
  // The send transport comes with the session. Without a READY session we're
  // between sockets, and the next onConnect publishes again.
  const transport = producerTransport
  if (generation !== mediaStateGeneration || !signal?.ready || !transport || transport.closed) {
    throw mediaResetError()
  }
  const isCurrent = () =>
    generation === mediaStateGeneration && producerTransport === transport && !transport.closed

  let stream
  try {
    stream = await acquireMicCapture(micSettings, rawMicStream)
  } catch (err) {
    console.error('[Soup] getUserMedia failed:', micFailureDetail(err, micSettings))
    // Preserve the browser error name so callers can distinguish a temporary
    // device handoff from permission/constraint failures that need user action,
    // and mark it as capture acquisition: a voice-socket reconnect is not a
    // repair for a device that is not plugged in.
    try {
      if (err != null && typeof err === 'object') err.micCaptureFailure = true
    } catch {
      // A non-extensible platform error only costs the caller this hint.
    }
    if (isCurrent()) localCaptureLost = !isPermanentMicError(err)
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
  let processorGated = false
  let processorGateOpen = () => false
  try {
    const processed = await buildSpeakingAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    audioProcessorStop = processed.stop
    processorStop = processed.stop
    processorTap = processed.tap
    processorGated = processed.gated
    processorGateOpen = processed.gateOpen
  } catch (err) {
    console.error('[Soup] Failed to build audio processor:', err)
    // Fall back to unprocessed stream
  }

  // A reset (socket drop) can land while we were awaiting the capture and the
  // processing graph — it closes this transport. Drop the candidate rather than
  // produce on a corpse; the reconnect's publish() starts over.
  if (!isCurrent()) {
    stopMicRepublishCandidate(stream, processedStream, processorStop)
    if (audioProcessorStop === processorStop) audioProcessorStop = null
    if (rawMicStream === stream) setRawMicStream(null)
    throw mediaResetError()
  }

  onStream?.(processedStream)
  // In-graph tap that survives muting, for the talking-while-muted warning.
  startLocalSpeakingDetector(stream, processorTap, processorGated)
  setLocalSpeaking(processorGateOpen())

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
      // The server also starts a mic source created while muted paused; this
      // is for instant local feedback.
      if (micSilenced()) producer.pause()
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
  syncSpeaking(true)

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
  processorGated,
  processorGateOpen,
  previousStop,
  micSettings,
  onStream
}) {
  previousStop?.()
  audioProcessorStop = processorStop
  setRawMicStream(stream)
  if (micSettings) lastCommittedMicSettings = { ...micSettings }
  // Keep the speaking detector tied to the same capture transaction that
  // just became current. Starting it tears down its previous callback/tap.
  startLocalSpeakingDetector(stream, processorTap, processorGated === true)
  setLocalSpeaking(processorGateOpen?.() === true)
  syncSpeaking(true)
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
  // The committed profile is what a restore reopens, so its deviceId is the one
  // that failed here.
  onError: (phase, err) => console.error(`[Soup] Failed ${phase}:`, micFailureDetail(err), err)
}

function restoreCommittedMicCapture(options) {
  return recoverMicRepublish({
    ...micRepublishRecoveryEnv,
    ...options,
    rawMicStream,
    micMuted: micSilenced()
  })
}

// ─── Republish: apply new mic settings to the existing producer ──
// Reuses the existing audio producer(s) via replaceTrack() for ordinary setting
// changes. A profile change (for example mono speech -> HiFi stereo) needs a
// new producer, which replaces the old source on the server.
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
    console.error('[Soup] republish getUserMedia failed:', micFailureDetail(err, micSettings))
    if (!isCurrent()) throw mediaResetError()
    localCaptureLost = !isPermanentMicError(err)
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
      // Deliberately not requestVoiceMediaRecovery. A voice-socket reconnect
      // can't conjure a device that isn't plugged in, and spending the
      // one-shot budget here disarmed the watchdog for the rest of the
      // session in the field. The publish ladder owns device loss, the
      // watchdog stays as the backstop for whatever it can't fix.
      console.warn(
        '[Soup] Microphone rollback failed after a capture failure, watching local media'
      )
      armMediaWatchdog(mediaStateGeneration)
    }
    const wrapped = new Error(`Failed to get audio device: ${err.message}`, { cause: err })
    wrapped.name = err?.name ?? 'Error'
    // Callers must be able to tell "the device is gone" from a transport or
    // produce failure, which a reconnect really can repair.
    wrapped.micCaptureFailure = true
    throw wrapped
  }

  // Build the candidate graph without tearing down the current graph yet. The
  // old raw capture has already been released by acquireMicCapture, but delaying
  // graph teardown keeps the local bookkeeping transactional if processing or
  // produce fails.
  let processedStream = stream
  let candidateProcessorStop = () => {}
  let candidateProcessorTap = null
  let candidateProcessorGated = false
  let candidateProcessorGateOpen = () => false
  try {
    const processed = await buildSpeakingAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    candidateProcessorStop = processed.stop
    candidateProcessorTap = processed.tap
    candidateProcessorGated = processed.gated
    candidateProcessorGateOpen = processed.gateOpen
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
      processorGated: candidateProcessorGated,
      processorGateOpen: candidateProcessorGateOpen,
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
      if (micSilenced()) producer.pause()
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
    // Each candidate replaces its predecessor's source on the server, so peers
    // move to the new source (SourceReplaced) instead of hearing both for a
    // moment. The mic publishes a single track, so this is one swap, and a
    // failed produce leaves the old source untouched.
    // Keep the old local producer array untouched until every candidate
    // succeeds. stopTracks:false gives the transaction explicit ownership if
    // it has to discard a partially-created candidate.
    const replacementProducers = []
    try {
      for (const [index, track] of newTracks.entries()) {
        const producer = await transport.produce({
          track,
          ...opusOptions,
          stopTracks: false,
          appData: { produced: 'Audio', replaces: audioProducers[index].id }
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
      if (micSilenced()) producer.pause()
    }
    // The server closed the old sources as part of the swap; this only
    // releases them locally (closeServerProducer finds nothing to close).
    await disposeMicProducers(audioProducers)
    lastCommittedAudioProfile = audioProfile
    commitCandidate()
    console.log('[Soup] Audio profile changed; producer replaced')
    return
  }

  // Swap the track on each existing audio producer in place. The server-side
  // source (and every peer's sink of it) stays alive under the same node.
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

      if (micSilenced()) producer.pause()
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
  let candidateProcessorTap = null
  let candidateProcessorGated = false
  let candidateProcessorGateOpen = () => false
  try {
    const processed = await buildSpeakingAudioProcessor(rawStream, micSettings)
    processedStream = processed.stream
    candidateProcessorStop = processed.stop
    candidateProcessorTap = processed.tap
    candidateProcessorGated = processed.gated
    candidateProcessorGateOpen = processed.gateOpen
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

      if (micSilenced()) producer.pause()
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
    processorTap: candidateProcessorTap,
    processorGated: candidateProcessorGated,
    processorGateOpen: candidateProcessorGateOpen,
    previousStop: previousProcessorStop,
    micSettings: micSettingsForPublishedStream(micSettings, processedStream),
    onStream
  })
  console.log('[Soup] Audio processing graph rebuilt without reopening the capture')
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
  // Nothing left to watch — release the interval; the next audio sink restarts it.
  if (audioEntries.length === 0) {
    stopAudioHealthMonitor()
    return
  }
  for (const [id, entry] of audioEntries) {
    // Fire-and-forget: each entry is evaluated independently and swallows its own
    // errors, so a getStats reject on one doesn't stall the others.
    void evaluateAudioHealth(id, entry)
  }
}

// Record a heal action for backoff: stamp the time and double the cooldown
// (start at BASE, cap at MAX).
function recordHeal(id, now) {
  const prev = audioHealHistory.get(id)
  const cooldownMs = prev
    ? Math.min(prev.cooldownMs * 2, AUDIO_HEAL_MAX_COOLDOWN_MS)
    : AUDIO_HEAL_BASE_COOLDOWN_MS
  audioHealHistory.set(id, { lastHealAt: now, cooldownMs })
}

// Pull one WebRTC stats sample for an audio consumer, compute WINDOWED (this
// interval only) delay/stall metrics, accumulate strikes, and take at most one
// repair action per tick (respecting the per-source cooldown/backoff).
async function evaluateAudioHealth(id, entry) {
  let report
  try {
    report = await entry.consumer.getStats()
  } catch {
    // getStats can reject transiently around consumer teardown — skip this tick.
    return
  }
  // The entry may have been removed or replaced while getStats was in flight —
  // don't record stats onto a stale entry.
  if (remoteConsumers.get(id) !== entry) return

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
  // stalled. Requires dPackets > 0, so deafen (server pauses the sink) and
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
      `[Soup] audio health [${id}] jb=${jbDelaySec?.toFixed(3) ?? 'n/a'}s ` +
        `playout=${playoutDelaySec?.toFixed(3) ?? 'n/a'}s stalled=${stalled} ` +
        `strikes(jb=${health.jbStrikes ?? 0},playout=${health.playoutStrikes ?? 0},` +
        `stall=${health.stallStrikes ?? 0})`
    )
  }

  // Respect the per-source cooldown before acting; keep strikes as they are.
  const now = Date.now()
  const backoff = audioHealHistory.get(id)
  if (backoff && now - backoff.lastHealAt < backoff.cooldownMs) return

  // Priority 1: a stall or jitter-buffer bloat lives inside the RTCRtpReceiver;
  // only recreating the sink resets it.
  if (
    (health.stallStrikes ?? 0) >= AUDIO_HEALTH_STRIKES ||
    (health.jbStrikes ?? 0) >= AUDIO_HEALTH_STRIKES
  ) {
    const reason =
      (health.stallStrikes ?? 0) >= AUDIO_HEALTH_STRIKES
        ? `playout stalled (${health.stallStrikes} bad windows, ${dPackets} pkts/no emit)`
        : `jitter buffer delay ${jbDelaySec?.toFixed(3)}s`
    recordHeal(id, now)
    healAudioConsumer(id, reason)
    return
  }

  // Priority 2: playout-path bloat is local — rebuild the Web Audio graph. If a
  // rebuild already happened once and playout trips AGAIN, escalate to a full
  // re-consume instead of rebuilding a second time.
  if ((health.playoutStrikes ?? 0) >= AUDIO_HEALTH_STRIKES) {
    if (health.rebuilt) {
      recordHeal(id, now)
      console.warn(
        `[Soup] audio playout still degraded after rebuild [${id}] ` +
          `${playoutDelaySec?.toFixed(3)}s — escalating to re-consume`
      )
      healAudioConsumer(id, `playout delay ${playoutDelaySec?.toFixed(3)}s (post-rebuild)`)
      return
    }
    recordHeal(id, now)
    console.warn(
      `[Soup] audio playout delay ${playoutDelaySec?.toFixed(3)}s [${id}] — rebuilding graph`
    )
    teardownAudioGraph(entry)
    buildAudioGraph(entry)
    applyAllAudioState()
    health.playoutStrikes = 0
    health.rebuilt = true
  }
}

// Full re-consume of a degraded remote audio source: close the sink, then
// receive the source again on a fresh one. The server handles requests in
// order, so the old sink is gone before the new one exists and the audio is
// never doubled. Rate-limited by recordHeal.
function healAudioConsumer(id, reason) {
  const entry = remoteConsumers.get(id)
  if (!entry || entry.kind !== 'audio' || !signal?.ready) return
  console.warn(`[Soup] Re-receiving audio from source ${id}: ${reason}`)
  // Local teardown first, so a racing Closed or SourcesRemoved finds nothing.
  removeRemoteConsumer(id, { closeSink: true })
  if (knownAudioProducers.has(id)) {
    ensureAudioSink(id)
  } else if (knownScreenAudioProducers.has(id) && sourceIsWatched(id)) {
    consumeSource(id).catch((err) =>
      console.error(`[Soup] Failed to re-receive stream audio ${id}:`, err)
    )
  }
}

function setAudioJitterBufferTarget(consumer, kind, producedType) {
  // producedType is carried through signaling because producer appData is not
  // present on the remote Consumer. Keep this strictly audio-only: video
  // receivers must not inherit an audio latency target.
  if (kind !== 'audio') return
  // Voice deliberately sets NO target: NetEq sizes its own buffer from measured
  // jitter, which is the one thing it is genuinely good at. Screen-share audio
  // keeps its target: it is music-like, continuity matters more than latency.
  const targetMs = producedType === 'ScreenShareAudio' ? 120 : null
  if (targetMs == null) return

  const receiver = consumer?.rtpReceiver
  if (!receiver || !('jitterBufferTarget' in receiver)) return
  try {
    receiver.jitterBufferTarget = targetMs
    console.log(`[Soup] Audio jitter buffer target set to ${targetMs}ms (${producedType})`)
  } catch (err) {
    // Browser support is experimental and may expose a read-only/clamped
    // implementation. The reactive 5s health monitor remains the backstop.
    console.warn('[Soup] Failed to set audio jitter buffer target:', err)
  }
}

// ─── Receive a remote source ─────────────────────────────────────
// Registered in `pendingSinks` for its whole lifetime so the watch bookkeeping
// can see a sink that hasn't landed yet (see watchIntent.js).
function consumeSource(id) {
  const existing = pendingSinks.get(id)
  if (existing) return existing
  const active = remoteConsumers.get(id)
  if (active) {
    return Promise.resolve({
      stream: active.stream,
      kind: active.kind,
      consumerId: active.consumerId
    })
  }
  const pending = createSinkFor(id).finally(() => {
    // Only clear our own registration — a later setup for the same source may
    // already own the slot.
    if (pendingSinks.get(id) === pending) pendingSinks.delete(id)
  })
  pendingSinks.set(id, pending)
  return pending
}

function sourceGoneError(id) {
  const error = new Error(`Voice source ${id} is gone`)
  error.name = 'VoiceSourceGoneError'
  error.sourceGone = true
  return error
}

// CreateSink for a source (`id`, its NodeId), with the stream watch a stream
// source needs first. A Denied means the watch we counted on is gone (revoked,
// or never granted on the node), so forget it and ask for it once more. Each
// attempt names a new sink: an id is used up even when its create fails.
async function requestSink(id, streamKey, isCurrent) {
  for (let attempt = 0; ; attempt++) {
    if (streamKey != null) {
      await ensureStreamWatch(streamKey)
      if (!isCurrent()) throw mediaResetError()
      if (channelState.source(id) == null) throw sourceGoneError(id)
    }
    try {
      return await requestCreate((node) => Request.createSink(node, id))
    } catch (err) {
      if (!err?.denied || streamKey == null || attempt > 0) throw err
      console.warn(`[Soup] Sink for source ${id} denied; asking to watch stream ${streamKey} again`)
      grantedWatches.delete(streamKey)
    }
  }
}

// [watch →] CreateSink → recvTransport.consume() → ConfigureSink. The server
// creates every sink paused. Audio is resumed at once; video stays paused until
// the video grid gives it a view role (applyViewRole), since a stream nobody
// is looking at costs nothing paused. The first consume also fires the receive
// transport's 'connect' (ConnectTransport Receive).
async function createSinkFor(id) {
  const generation = mediaStateGeneration
  const transport = consumerTransport
  if (!signal?.ready || !transport || transport.closed) throw mediaResetError()
  const source = channelState.source(id)
  if (!source) throw sourceGoneError(id)
  const kind = sourceMediaKind(source.kind)
  const producedType = producedTypeForSource(source.kind)
  const clientId = source.owner
  const isCurrent = () =>
    generation === mediaStateGeneration && consumerTransport === transport && !transport.closed

  const sink = await requestSink(id, source.streamKey, isCurrent)
  if (!isCurrent()) throw mediaResetError()
  sinkSources.set(sink.node, id)
  // Closed for this sink, or SourcesRemoved for its source, while we were
  // still setting it up.
  const sinkGone = () => sinkSources.get(sink.node) !== id || channelState.source(id) == null
  // Tear down a sink that never committed, and close it on the server unless
  // a Closed already took it (or a reset already forgot it).
  const discard = (consumer) => {
    consumer?.close()
    if (sinkSources.get(sink.node) !== id) return
    sinkSources.delete(sink.node)
    closeServerNode(sink.node)
  }
  if (sinkGone()) {
    discard(null)
    throw sourceGoneError(id)
  }

  let consumer
  try {
    consumer = await transport.consume({
      id: ownId(sink.node),
      producerId: id,
      kind,
      rtpParameters: sink.rtp_parameters,
      // The owner's key decrypts this sink, and only frames sent from this source (lib/e2ee).
      appData: {
        owner: clientId,
        source: { kind: source.kind, streamKey: source.streamKey },
        sink: sink.node
      }
    })
  } catch (err) {
    discard(null)
    throw err
  }
  if (!isCurrent()) {
    consumer.close()
    throw mediaResetError()
  }
  if (sinkGone()) {
    discard(consumer)
    throw sourceGoneError(id)
  }

  // Set before the resume so the first decoded packets use the target.
  setAudioJitterBufferTarget(consumer, kind, producedType)
  const stream = new MediaStream([consumer.track])

  // What we last asked the server for this sink, which view roles diff against.
  const sinkConfig = { paused: true }
  if (kind === 'audio') {
    // ConfigureSink has no success answer; the Sync behind it says the resume
    // went through, and a failure still fails the sink (and so gets retried).
    try {
      await requestSynced(Request.configureSink(sink.node, { paused: false }))
    } catch (err) {
      discard(consumer)
      throw err
    }
    sinkConfig.paused = false
    if (!isCurrent()) {
      consumer.close()
      throw mediaResetError()
    }
    if (sinkGone()) {
      discard(consumer)
      throw sourceGoneError(id)
    }
  }

  // Build the entry up front so the audio graph, cleanup, and a later
  // health-driven rebuild can all reference it (a rebuild reuses entry.stream).
  const entry = {
    consumer,
    consumerId: ownId(sink.node),
    sinkNode: sink.node,
    kind,
    clientId,
    producedType,
    stream,
    cleanup: null,
    audioEl: null,
    gain: null,
    sinkConfig,
    // The layers this sink can choose from, and the ones it forwards now
    // (SinkLayers). Video only.
    layerCapabilities: kind === 'video' ? sinkLayerCapabilities(sink.rtp_parameters) : null,
    currentLayers: null
  }

  if (kind === 'audio') {
    // A muted <audio> element keeps the remote WebRTC track pulled; the audible
    // playback goes through Web Audio so per-client volume can exceed 100%. The
    // element stays OUTSIDE the rebuildable graph (buildAudioGraph) — it must
    // keep pulling the track continuously, even across a health-driven rebuild.
    const audioEl = document.createElement('audio')
    try {
      audioEl.srcObject = stream
      audioEl.autoplay = true
      audioEl.muted = true
      document.body.appendChild(audioEl)
      audioEl.play().catch((err) => console.error('[Soup] Audio pump play failed:', err))
      entry.audioEl = audioEl

      // Rebuildable part: source -> gain -> destination.
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
      discard(consumer)
      throw err
    }
  } else {
    activeCallbacks.onVideoStream?.({
      stream,
      kind,
      consumerId: entry.consumerId,
      // Carried so the UI can key the tile by source, whether or not it is
      // being received.
      producerId: id,
      clientId,
      codec: codecLabel(consumer.rtpParameters),
      paused: channelState.source(id)?.paused === true
    })
  }

  // Never silently overwrite an existing entry: its consumer and Web Audio graph
  // would keep pulling RTP with nothing left pointing at them.
  if (remoteConsumers.has(id)) {
    console.warn(`[Soup] Replacing an existing sink for source ${id}`)
    removeRemoteConsumer(id, { closeSink: true })
  }
  remoteConsumers.set(id, entry)

  if (kind === 'audio') {
    // Lazily spin up the shared inbound-audio health poll (no-op if running).
    startAudioHealthMonitor()
    applyAllAudioState()
  } else {
    // The grid may already have a role for it; if not, it stays paused until
    // the grid shows its tile.
    applyViewRole(entry)
  }

  console.log(`[Soup] Receiving ${producedType} source ${id} through sink ${sink.node}`)
  return { stream, kind, consumerId: entry.consumerId }
}

// ─── Bandwidth rationing: per-stream view roles ──────────────────
// The video grid reports which remote videos it shows (by consumer id) and
// which one is focused, and every video sink's pause, layers and priority
// follow (sinkConfigForViewRole): focused gets its full layers, grid tiles a
// middle one, carousel thumbnails the lowest, and anything not shown is paused
// on the server, so it costs no downlink at all. Only changes are sent, so the
// grid may call this on every focus or visibility change, and a sink that
// lands later picks up the roles the grid last asked for.
let streamRoles = { focusedConsumerId: null, visibleConsumerIds: new Set() }

export function setVideoStreamRoles({ focusedConsumerId = null, visibleConsumerIds = [] } = {}) {
  streamRoles = { focusedConsumerId, visibleConsumerIds: new Set(visibleConsumerIds) }
  for (const entry of remoteConsumers.values()) applyViewRole(entry)
}

function applyViewRole(entry) {
  if (entry.kind !== 'video') return
  // Until the first Execute that includes us, a resumed sink would only bring frames (and a
  // keyframe) we can't decrypt yet (plan 5.5).
  const role = e2eeMediaReady() ? viewRoleFor(entry.consumerId, streamRoles) : ViewRole.Hidden
  const changes = sinkConfigChanges(
    entry.sinkConfig,
    sinkConfigForViewRole(role, entry.layerCapabilities ?? undefined)
  )
  if (!changes) return
  // Recorded before it's sent. The server handles requests in order, so the
  // last one sent is where the sink ends up, and one ConfigureSink sets the
  // layers before it resumes, so a sink never bursts at its top layer first.
  // It has no success answer; the Sync behind it is what tells a failure apart.
  Object.assign(entry.sinkConfig, changes)
  requestSynced(Request.configureSink(entry.sinkNode, changes)).catch((err) => {
    // Forget what we asked for, so the next role change sends it all again.
    entry.sinkConfig = {}
    console.warn(`[Soup] ConfigureSink for sink ${entry.sinkNode} failed:`, err?.message ?? err)
  })
}

// ─── Reset all media state ───────────────────────────────────────
// Everything that belonged to the session that just ended. The node ends it
// on its side, so there is nothing to tell it.
function resetMediaState() {
  mediaStateGeneration++
  for (const timer of iceRestarts.values()) clearTimeout(timer)
  iceRestarts.clear()
  pendingIceRestarts.clear()
  // The session's group requests can't be answered any more; the next session rejoins.
  e2eeSuspend()
  rawMicEndedRepairGeneration = null
  localCaptureLost = false
  clearMediaWatchdog()
  clearMediaReadyTimer()
  // Speaking rings belong to the session; clear them before forgetting who
  // was speaking.
  for (const clientId of channelState.speakers) activeCallbacks.onClientSpeaking?.(clientId, false)
  channelState.reset()
  mutedTalkStop?.()
  mutedTalkStop = null
  setLocalSpeaking(false)
  sentSpeakingFlags = null
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
  localSources.clear()
  localSourcePaused.clear()
  unsentSourcePauses.clear()
  sourceReplacements.clear()
  knownVideoProducers.clear()
  knownScreenAudioProducers.clear()
  knownAudioProducers.clear()
  for (const id of audioSinkRetryTimers.keys()) clearAudioSinkRetry(id)
  audioSinkRetryTimers.clear()
  audioSinkRetryAttempts.clear()
  // Watch intent lives in the UI (React) and is re-asserted via
  // setWatchedProducers once the next snapshot lists the streams again.
  watchedClientIds = new Set()
  watchedProducerIds = new Set()
  // In-flight sinks belong to the session being torn down. Their promises
  // reject on their own; dropping the registrations keeps the next session's
  // bookkeeping clean.
  pendingSinks.clear()
  sinkSources.clear()
  // A new session asks for its watches again (op 8). A stream of ours that got a
  // source ends as its sources close with the session; a new share still waits
  // for its StreamEnded. One that never got a source is handed back (op 10)
  // unless we're leaving voice, which revokes it anyway: a new session in the
  // same channel would otherwise find it still held.
  grantedWatches.clear()
  if (ownStream?.claimed) ownStream.ending = true
  else {
    if (ownStream && !intentionalClose) streamRequests.notify(StreamRequest.end(ownStream.key))
    ownStream = null
  }
  device = null
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
  // Stop the audio health poll and drop all its per-source state. Per-entry
  // health rides on the entries themselves, removed below.
  stopAudioHealthMonitor()
  audioHealHistory.clear()
  for (const id of [...remoteConsumers.keys()]) removeRemoteConsumer(id)
  // No tiles are left to hang viewers on.
  publishStreamViewers()
  console.log('[Soup] Media state reset')
}

// ─── Rebind callbacks (e.g. when switching channels) ──────────────
export function rebindCallbacks(newCallbacks) {
  activeCallbacks = { ...activeCallbacks, ...newCallbacks }
}

// ─── Mute controls ────────────────────────────────────────────────
// Local pause for instant feedback. The server enforces mute/deafen itself from
// the op 1 voice state (there is no voice-socket request for it).
export function setMicMuted(muted) {
  micMuted = muted
  syncSpeaking()
  // Each mute starts a fresh warning budget, so muting and immediately talking
  // is always warned about even if the last warning was seconds ago.
  if (muted) lastTalkingWhileMutedAt = 0
  applyMicPause()
}

// Silence the published mic while the settings mic test runs (see micTestActive).
// Purely local like setMicMuted: peers just stop receiving audio, they don't see
// a mute icon.
export function setMicTestActive(active) {
  micTestActive = active
  syncSpeaking()
  applyMicPause()
}

function applyMicPause() {
  const silenced = micSilenced()
  producers.filter((p) => p.kind === 'audio').forEach((p) => (silenced ? p.pause() : p.resume()))
}
