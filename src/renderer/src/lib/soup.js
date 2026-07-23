// ─── Imports ────────────────────────────────────────────────────
import { Device, parseScalabilityMode } from 'mediasoup-client'
import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import { apiBase, wsBase, getServerHost } from './serverConfig'
import { authFetch } from './auth'
import { startScreenAudio, onScreenAudioError } from './screenAudio'
import { detachRtpSender, recoverMicRepublish, runBeforeServerProduce } from './mediaRecovery'

// ─── State ──────────────────────────────────────────────────────
let device
let ws
let producerTransport
let consumerTransport
let producers = []
let localProducerIds = new Set()
// The negotiated Opus profile belongs to the Producer, not to the mutable
// settings object. A WeakMap keeps the metadata alongside the mediasoup object
// without retaining producers after a transport reset.
const audioProducerProfiles = new WeakMap()
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
// The last capture configuration that was successfully committed to the live
// audio producer(s). Republish must be able to reopen this profile after it has
// released the old capture and a candidate gUM/processing/produce operation
// fails; otherwise the old producer can be left holding an ended track.
let lastCommittedMicSettings = null
// Self speaking detector, owned here rather than by a channel component so it
// survives ownership changes: a moderator move rebinds onClientSpeaking to the new
// channel, and the detector reports our own speaking through that live callback.
let selfSpeakingStop = null
// Separate detector on the RAW mic stream (stays live while muted, unlike the
// processed track the self indicator taps), used to warn when we talk while
// muted. Its handler + cooldown are set from the UI layer.
let mutedTalkStop = null
let onTalkingWhileMuted = null
let lastTalkingWhileMutedAt = 0
const TALKING_WHILE_MUTED_COOLDOWN_MS = 2500
let localClientId = null
// Set while a publish() is mid-flight so a concurrent caller joins the same
// promise instead of allocating a second producer transport (the server rejects a
// duplicate). Both the reset-driven republish and an adopt() can race here.
let publishInFlight = null
// Republish serializes the entire capture -> processing -> producer update
// transaction. micAcquireChain alone only protects getUserMedia; without this
// queue, rapid settings changes can replace tracks out of order.
let republishChain = Promise.resolve()
// Invalidates republish work that was queued or awaiting media after a reset.
// A stale operation must not attach its capture to a newly-created transport.
let mediaStateGeneration = 0
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

// Only the focused stream's screen-share audio should be audible - the
// client whose ScreenShareAudio should currently be unmuted, plus the
// volume/mute settings to apply to it.
let focusedClientId = null
let focusedVolume = 1
let focusedMuted = false

// ─── Shared 25 Hz audio ticker ────────────────────────────────────
// Speaking detectors and the live volume gate all need the same hidden-window-safe
// cadence. One timer avoids an independent wakeup for every stream while keeping
// analyser reads exactly where they were.
const AUDIO_TICK_INTERVAL_MS = 40
const audioTickerCallbacks = new Set()
let audioTickerTimer = null

function invokeAudioTickerCallback(callback) {
  try {
    callback()
  } catch (err) {
    // One broken analyser/gate must not stop the other participants' indicators.
    console.error('[Soup] 40ms audio ticker callback failed:', err)
  }
}

function stopAudioTicker() {
  if (audioTickerTimer !== null) {
    clearInterval(audioTickerTimer)
    audioTickerTimer = null
  }
}

function runAudioTicker() {
  // Iterate a snapshot so callbacks may unregister themselves or another
  // callback safely. Skip callbacks removed earlier in this same tick.
  for (const callback of [...audioTickerCallbacks]) {
    if (audioTickerCallbacks.has(callback)) invokeAudioTickerCallback(callback)
  }
  if (audioTickerCallbacks.size === 0) stopAudioTicker()
}

// Registering runs once immediately, preserving the old detector/gate startup
// behavior. The returned function is idempotent and stops the shared timer when
// the last callback leaves.
function registerAudioTickerCallback(callback) {
  audioTickerCallbacks.add(callback)
  if (audioTickerTimer === null) {
    audioTickerTimer = setInterval(runAudioTicker, AUDIO_TICK_INTERVAL_MS)
  }
  invokeAudioTickerCallback(callback)

  let registered = true
  return () => {
    if (!registered) return
    registered = false
    audioTickerCallbacks.delete(callback)
    if (audioTickerCallbacks.size === 0) stopAudioTicker()
  }
}

// Per-client local volume/mute overrides for mic audio (right-click controls
// in the sidebar) - keyed by clientId. Persisted to localStorage per server
// host (user ids are only unique per server) so a client's volume/mute survives
// app restarts. The in-memory Map mirrors the currently-connected host's slice
// of that store; ensureOverridesForCurrentHost() reloads it whenever the host
// changes (connect, disconnect, or switching servers).
const CLIENT_AUDIO_OVERRIDES_KEY = 'clientAudioOverrides'
let clientAudioOverrides = new Map()
let clientAudioOverridesHost

// ─── Reconnection state ──────────────────────────────────────────
// The voice socket can't "resume": when it drops, the server tears down our
// transports and removes us from the channel. Recovery is a full re-establish —
// re-assert channel membership (which mints a fresh ticket), reconnect, re-publish —
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

// Fire-and-forget: send without queuing a response handler. `send()` matches
// replies positionally and force-reconnects the socket if the queue head goes
// unanswered for 15s, so a message the server may not implement must NOT go
// through it — one unanswered request would drop the call.
// ponytail: switch this to send() once the server implements CloseConsumer AND
// is confirmed to reply to it; until then silence is the expected outcome.
function notify(type, data = null) {
  if (ws?.readyState !== WebSocket.OPEN) return
  try {
    ws.send(JSON.stringify(data ? { type, data } : { type }))
    console.log(`[Soup] Sent (no reply expected): ${type}`, data)
  } catch (err) {
    console.warn(`[Soup] Failed to send ${type}:`, err)
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

// ─── Stream viewers ─────────────────────────────────────────────
// Who is watching which screen share. The server tells us via NewConsumer (also
// replayed on join, so a late arrival learns the existing audience) and
// ConsumerClosed. ConsumerClosed identifies the consumer only by id, so we keep
// the id→(producer, client) mapping needed to undo it.
// Remote video producers we know about but may not be consuming. Tiles are
// driven by this — a stream is listed as soon as it exists, whether or not we
// have chosen to watch it.
const knownVideoProducers = new Map() // producerId -> { clientId, producedType }

const consumerOwners = new Map() // consumerId -> { producerId, clientId }
const producerViewers = new Map() // producerId -> Set<clientId>
let viewerSubscribers = []

const notifyViewers = () => {
  // Hand out a plain snapshot: subscribers are React components that must not
  // hold a reference to a Map we keep mutating underneath them.
  const snapshot = new Map([...producerViewers].map(([p, set]) => [p, [...set]]))
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
  viewerSubscribers.push(cb)
  cb(new Map([...producerViewers].map(([p, set]) => [p, [...set]])))
  return () => {
    viewerSubscribers = viewerSubscribers.filter((fn) => fn !== cb)
  }
}

// Bind consumer lifetime to the set of streams the user has explicitly chosen to
// watch (the play/stop buttons), NOT to whether a tile happens to be on screen.
// A consumer is our public "I am watching this" signal, so it must mean exactly
// that; binding it to visibility instead would also churn full renegotiations
// every time the carousel collapsed or the chat tab was selected.
export function setWatchedProducers(producerIds = []) {
  const wanted = new Set(producerIds.filter((id) => knownVideoProducers.has(id)))

  // The server takes a batch, so collect the whole diff and send one message —
  // switching away from a multi-stream view closes several at once.
  const closedIds = []
  for (const [producerId, entry] of remoteConsumers) {
    if (entry.kind !== 'video' || wanted.has(producerId)) continue
    closedIds.push(entry.consumerId)
    closeVideoConsumer(producerId)
  }
  if (closedIds.length > 0) notify('CloseConsumer', { ids: closedIds })

  for (const producerId of wanted) {
    if (remoteConsumers.has(producerId)) continue
    const { clientId, producedType } = knownVideoProducers.get(producerId)
    consumeProducer(
      producerId,
      'video',
      activeCallbacks.onVideoStream,
      clientId,
      producedType
    ).catch((err) => console.error(`[Soup] Failed to consume producer ${producerId}:`, err))
  }
}

// Local half of "stop watching". The server is told separately, in one batched
// CloseConsumer by the caller — a local consumer.close() alone is invisible to
// it, and we'd never drop out of anyone else's viewer list.
function closeVideoConsumer(producerId) {
  const entry = remoteConsumers.get(producerId)
  if (!entry) return
  remoteConsumers.delete(producerId)
  entry.consumer.close()
  if (entry.cleanup) {
    entry.cleanup()
    remoteCleanups = remoteCleanups.filter((fn) => fn !== entry.cleanup)
  }
  // The producer still exists — only our subscription ended. Keep the tile and
  // blank its stream so it returns to the stopped state rather than vanishing.
  activeCallbacks.onVideoStream?.({
    stream: null,
    kind: 'video',
    producerId,
    clientId: entry.clientId
  })
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
const VOICE_TICKET_PUSH_WAIT_MS = 3000
const VOICE_TICKET_MAX_AGE_MS = 20_000
let pushedTicket = null // { ticket, receivedAt } — unconsumed push
let ticketWaiter = null // resolver for an acquireTicket() currently waiting

// Hand a server-pushed ticket to whoever is connecting (or stash it for the
// connect that's about to start).
export function receiveVoiceTicket(ticket) {
  if (typeof ticket !== 'string' || ticket === '') return
  console.log('[Soup] Voice ticket pushed by server')
  pushedTicket = { ticket, receivedAt: Date.now() }
  const waiter = ticketWaiter
  ticketWaiter = null
  waiter?.()
}

// Consume the stash, refusing one old enough that the server may already have
// expired it (presenting a dead ticket costs us a failed socket, not a retry).
function takePushedTicket() {
  if (!pushedTicket) return null
  const { ticket, receivedAt } = pushedTicket
  pushedTicket = null
  return Date.now() - receivedAt > VOICE_TICKET_MAX_AGE_MS ? null : ticket
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

// A ticket for the connection we're about to open: the server's push if we have
// (or shortly get) one, else minted over REST.
async function acquireTicket() {
  const ticket = takePushedTicket() ?? (await waitForPushedTicket())
  if (ticket) return ticket
  // The user left while we were waiting — don't spend a request on a join
  // nobody is waiting for any more.
  if (intentionalClose) return null

  // No push — either it was lost or this join didn't cause a channel transition
  // the server would mint for. Ask for one directly (authFetch refreshes the
  // access token as needed).
  console.warn('[Soup] No pushed voice ticket; requesting one over REST')
  const res = await authFetch(`${apiBase()}/server/voice`)
  if (!res.ok) throw new Error(`Voice ticket request failed: ${res.status}`)
  const { ticket: fetched } = await res.json()
  return fetched
}

// Open the voice WebSocket: take a fresh (single-use, 30s) ticket, wire every
// handler, then authenticate. Used for the initial connection and every
// reconnect attempt — each call replaces the shared `ws`. A stale-socket guard
// on every handler ignores a superseded socket once a newer one takes over.
async function openSocket() {
  // Step 1 — get ticket
  const ticket = await acquireTicket()
  // Acquiring waits on the server's push (and possibly the network), so the
  // user may have left meanwhile — opening now would orphan a socket that
  // nothing is holding.
  if (!ticket || intentionalClose) return
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

      // Audio must be audible the moment it exists, so it still consumes eagerly.
      if (kind !== 'video') {
        consumeProducer(id, kind, activeCallbacks.onVideoStream, client_id, produced_type).catch(
          (err) => console.error(`[Soup] Failed to consume producer ${id}:`, err)
        )
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

    if (message.type === 'ConsumerClosed') {
      removeViewer(message.data.id)
      return
    }

    // A remote producer we were consuming has closed (e.g. the other
    // client stopped screen sharing) — close our consumer and remove its tile.
    if (message.type === 'ProducerClosed') {
      const { id, replaced = false } = message.data
      const known = knownVideoProducers.get(id)
      knownVideoProducers.delete(id)
      // A genuinely new producer with this id deserves a fresh cooldown, so drop
      // any heal backoff we were tracking for the one that just closed.
      audioHealHistory.delete(id)
      const entry = remoteConsumers.get(id)
      if (entry) {
        entry.consumer.close()
        remoteConsumers.delete(id)
        if (entry.cleanup) {
          entry.cleanup()
          remoteCleanups = remoteCleanups.filter((fn) => fn !== entry.cleanup)
        }
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
  // A ticket minted for a join we're abandoning: drop it so a later connect
  // can't present it instead of waiting for its own.
  pushedTicket = null
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
const rnnoiseWorkletLoads = new WeakMap()

function ensureRnnoiseWorklet(audioContext) {
  let load = rnnoiseWorkletLoads.get(audioContext)
  if (!load) {
    load = audioContext.audioWorklet.addModule(rnnoiseWorkletPath).catch((err) => {
      rnnoiseWorkletLoads.delete(audioContext)
      throw err
    })
    rnnoiseWorkletLoads.set(audioContext, load)
  }
  return load
}

async function createRnnoiseProcessor(audioContext) {
  const [binary] = await Promise.all([getRnnoiseBinary(), ensureRnnoiseWorklet(audioContext)])
  return new RnnoiseWorkletNode(audioContext, { maxChannels: 1, wasmBinary: binary })
}

async function getMicContext() {
  if (!micContext || micContext.state === 'closed') {
    micContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
  }
  if (micContext.state === 'suspended') await micContext.resume()
  return micContext
}

// ─── Build the local audio processing chain ──────────────────────
// Wires the captured mic stream through optional RNNoise denoising (an
// AudioWorklet that suppresses keyboard/typing and steady background noise
// while preserving voice) and the optional volume gate, in that order.
// Returns the processed stream plus a stop() that tears the chain down. The
// processed stream is also the source of truth for the local speaking indicator,
// so it reflects everything that can affect what peers receive (including
// RNNoise and a closed volume gate).
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
  let stopGateTicker = null

  if (needsRnnoise) {
    try {
      rnnoiseNode = await createRnnoiseProcessor(audioContext)
      node.connect(rnnoiseNode)
      node = rnnoiseNode
      console.log('[Soup] RNNoise denoiser applied')
    } catch (err) {
      // Fall through to whatever processing remains (or the raw stream).
      console.error('[Soup] RNNoise init failed, skipping:', err)
    }
  }

  if (needsGate) {
    const reader = createSpeechLevelReader(audioContext)
    const gate = audioContext.createGain()
    const gateController = createLevelGateController(audioContext, gate, reader.read, {
      threshold: micSettings.volumeGateThreshold
    })
    chainNodes.push(...reader.nodes, gate)
    // Analysis is a sidechain so the speech-band filters never color outgoing
    // audio. The untouched denoised signal passes through the controlled gain.
    node.connect(reader.input)
    node.connect(gate)
    node = gate

    // 25Hz via the shared ticker, not rAF: level detection needs far less than
    // display rate, and rAF is throttled/paused when the window is hidden — which
    // would stall the gate and stick outgoing audio gated/ungated while minimized.
    stopGateTicker = registerAudioTickerCallback(() => gateController.update())
    console.log('[Soup] Volume gate applied, threshold:', micSettings.volumeGateThreshold)
  }

  node.connect(destination)

  const stop = () => {
    stopGateTicker?.()
    stopGateTicker = null
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

// Chromium binds its audio processing (AGC / noise suppression / echo
// cancellation) to the shared capture source for a device, not to the individual
// track. A getUserMedia on a device that is still open silently inherits the
// processing the source was created with, so the new constraints are dropped and
// the old settings persist until every handle closes (i.e. an app restart).
// applyConstraints() does not reconfigure these flags either.
//
// So: serialize every mic acquisition, release the previous capture first, and
// let the source actually tear down before asking for a new one.
export function micConstraints(micSettings) {
  return {
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
}

// track.stop() returns before Chromium has torn the capture source down; a short
// hop lets the release land so the next open is cold.
// ponytail: fixed delay, not a readback of source state — there is no API to
// observe it. If constraints still stick occasionally, raise this.
const MIC_SOURCE_RELEASE_MS = 50

let micAcquireChain = Promise.resolve()

// Only one capture can define the device's processing, and while joined to a
// channel that capture belongs to the call. Anything else that wants mic audio
// (the settings meter) has to read this one rather than open its own — a second
// capture would inherit stale processing *and* poison the next republish.
const rawMicStreamListeners = new Set()

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
  rawMicStreamListeners.forEach((listener) => {
    try {
      listener(stream)
    } catch (err) {
      console.error('[Soup] rawMicStream listener failed:', err)
    }
  })
}

// Acquire a mic capture with `micSettings` applied for real. `previousStream` is
// the caller's own capture to release first — pass it rather than stopping it
// yourself, so the release and the re-open stay ordered.
export function acquireMicCapture(micSettings, previousStream) {
  const run = async () => {
    stopRawStream(previousStream)
    await new Promise((resolve) => setTimeout(resolve, MIC_SOURCE_RELEASE_MS))
    return navigator.mediaDevices.getUserMedia({ audio: micConstraints(micSettings) })
  }
  // .then(run, run) rather than .finally so a failed acquisition doesn't poison
  // the chain for the next caller.
  micAcquireChain = micAcquireChain.then(run, run)
  return micAcquireChain
}

// ─── Shared speech level measurement ───────────────────────────────
// Analyze a speech-band sidechain without modifying the audible signal. Time-domain
// RMS is stable across different pitches and spectral shapes; averaging byte-mapped
// FFT bins was not. The level is mapped from -60..-5 dBFS to 0..100 so whispering,
// normal speech, and loud speech occupy distinct parts of the meter instead of
// clustering near its upper end. Smoothing uses real elapsed time, so meter (rAF)
// and detector/gate (25 Hz) respond alike.
const SPEECH_LEVEL_FLOOR_DB = -60
const SPEECH_LEVEL_CEILING_DB = -5
const SPEECH_LEVEL_ATTACK_MS = 35
const SPEECH_LEVEL_RELEASE_MS = 180

export function createSpeechLevelReader(audioContext) {
  const highpass = audioContext.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 85
  highpass.Q.value = Math.SQRT1_2

  const lowpass = audioContext.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 4000
  lowpass.Q.value = Math.SQRT1_2

  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  highpass.connect(lowpass)
  lowpass.connect(analyser)

  const data = new Float32Array(analyser.fftSize)
  let smoothedLevel = 0
  let lastReadAt = null

  const read = () => {
    analyser.getFloatTimeDomainData(data)
    let sumSquares = 0
    for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i]

    const rms = Math.sqrt(sumSquares / data.length)
    const db = rms > 0 ? 20 * Math.log10(rms) : SPEECH_LEVEL_FLOOR_DB
    const rawLevel = Math.max(
      0,
      Math.min(
        100,
        ((db - SPEECH_LEVEL_FLOOR_DB) / (SPEECH_LEVEL_CEILING_DB - SPEECH_LEVEL_FLOOR_DB)) * 100
      )
    )

    const now = performance.now()
    if (lastReadAt == null) {
      smoothedLevel = rawLevel
    } else {
      const elapsedMs = Math.max(1, now - lastReadAt)
      const timeConstant =
        rawLevel > smoothedLevel ? SPEECH_LEVEL_ATTACK_MS : SPEECH_LEVEL_RELEASE_MS
      const alpha = 1 - Math.exp(-elapsedMs / timeConstant)
      smoothedLevel += (rawLevel - smoothedLevel) * alpha
      if (smoothedLevel < 0.05) smoothedLevel = 0
    }
    lastReadAt = now
    return smoothedLevel
  }

  return {
    input: highpass,
    analyser,
    nodes: [highpass, lowpass, analyser],
    read
  }
}

// Gate state shared by the live mic path and the settings test. A lower release
// threshold plus a short hold bridges syllable gaps; gain ramps avoid clicks.
export function createLevelGateController(
  audioContext,
  gate,
  read,
  { threshold = 15, hysteresis = 3, holdMs = 200, rampSeconds = 0.03 } = {}
) {
  let open = false
  let lastVoiceAt = 0
  gate.gain.setValueAtTime(0, audioContext.currentTime)

  const setOpen = (next) => {
    if (next === open) return
    open = next
    const now = audioContext.currentTime
    const current = gate.gain.value
    gate.gain.cancelScheduledValues(now)
    gate.gain.setValueAtTime(current, now)
    gate.gain.linearRampToValueAtTime(next ? 1 : 0, now + rampSeconds)
  }

  const update = (nextThreshold = threshold) => {
    const level = read()
    const now = performance.now()
    const releaseThreshold = Math.max(0, nextThreshold - hysteresis)

    if (!open) {
      if (level >= nextThreshold) {
        lastVoiceAt = now
        setOpen(true)
      }
    } else if (level >= releaseThreshold) {
      lastVoiceAt = now
    } else if (now - lastVoiceAt >= holdMs) {
      setOpen(false)
    }

    return { level, open }
  }

  return { update, isOpen: () => open }
}

// Build the same post-browser/post-RNNoise analysis sidechain used by the live
// gate. The returned outputNode is also suitable for local test playback.
export async function createMicLevelMonitor(audioContext, stream, micSettings) {
  const source = audioContext.createMediaStreamSource(stream)
  let outputNode = source
  let rnnoiseNode = null

  if (micSettings.useRnnoise) {
    try {
      rnnoiseNode = await createRnnoiseProcessor(audioContext)
      source.connect(rnnoiseNode)
      outputNode = rnnoiseNode
    } catch (err) {
      console.error('[Soup] RNNoise monitor init failed, using raw mic:', err)
    }
  }

  const reader = createSpeechLevelReader(audioContext)
  outputNode.connect(reader.input)

  const stop = () => {
    try {
      outputNode.disconnect(reader.input)
    } catch {
      // Already disconnected during a settings rebuild.
    }
    for (const node of reader.nodes) {
      try {
        node.disconnect()
      } catch {
        // A partially initialized monitor is safe to tear down.
      }
    }
    try {
      rnnoiseNode?.destroy()
    } catch {
      // The worklet may already have torn itself down.
    }
    try {
      source.disconnect()
    } catch {
      // Source may be the output node and already disconnected above.
    }
  }

  return { source, outputNode, analyser: reader.analyser, read: reader.read, stop }
}

// ─── Detect speaking activity on an audio stream ──────────────────
// Returns a stop function. Calls onChange(isSpeaking) whenever the
// speaking state changes, and once more with false on stop.
export function createSpeakingDetector(
  stream,
  onChange,
  {
    threshold = 12,
    hysteresis = 3,
    holdMs = 250,
    audioContext: providedContext = null,
    sourceNode: providedSource = null
  } = {}
) {
  if (!stream.getAudioTracks().length) return () => {}

  // When the caller hands us its playback context and the per-stream source node
  // (the remote-voice path does), detection adds only analysis nodes — no extra
  // AudioContext (a live render thread) and no second createMediaStreamSource per
  // stream (a separate, drift-prone track→WebAudio bridge). Standalone callers
  // (e.g. the settings mic test) pass neither and get a private context + own
  // source, closed on stop exactly as before.
  const ownContext = !providedContext
  const audioContext = providedContext ?? new (window.AudioContext || window.webkitAudioContext)()
  const reader = createSpeechLevelReader(audioContext)
  const source = providedSource ?? audioContext.createMediaStreamSource(stream)
  source.connect(reader.input)

  let speaking = false
  let lastVoiceAt = 0

  const tick = () => {
    const level = reader.read()
    const now = performance.now()
    const releaseThreshold = Math.max(0, threshold - hysteresis)

    if (!speaking) {
      if (level >= threshold) {
        speaking = true
        lastVoiceAt = now
        onChange(true)
      }
    } else if (level >= releaseThreshold) {
      lastVoiceAt = now
    } else if (now - lastVoiceAt >= holdMs) {
      speaking = false
      onChange(false)
    }
  }
  // 25Hz via the shared hidden-window-safe ticker. Registration invokes the
  // callback once immediately, matching the previous startup behavior.
  const unregisterTicker = registerAudioTickerCallback(tick)

  return () => {
    unregisterTicker()
    if (speaking) onChange(false)
    try {
      // A provided (shared) source also feeds the playback gain, so only detach
      // our own tap into the analysis chain — never a full source.disconnect().
      if (providedSource) source.disconnect(reader.input)
      else source.disconnect()
    } catch {
      // Cleanup may run after the node/context has already disconnected it.
    }
    for (const node of reader.nodes) {
      try {
        node.disconnect()
      } catch {
        // Analysis nodes may already be detached.
      }
    }
    // Only a context we created is ours to close; a shared playback context is
    // owned by getPlaybackContext() and must keep running for other streams.
    // close() rejects (async) if the context is already closed — e.g. this
    // cleanup runs twice during teardown. Skip when closed and swallow the
    // rejection so it never surfaces as an uncaught promise error.
    if (ownContext && audioContext.state !== 'closed') audioContext.close().catch(() => {})
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

// Detect speech on the RAW mic capture, which stays live while muted — muting
// pauses the producer, disabling the *processed* track the self indicator taps,
// not the raw stream. So when we speak while muted, this fires the warning
// (throttled). In passthrough mode (no RNNoise/gate) the raw track IS the
// produced track and gets disabled on mute, so detection is skipped there — an
// accepted gap for that non-default config.
function startMutedTalkDetector(stream) {
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
    { audioContext: getPlaybackContext() }
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

// The persisted `bitrate` field predates the current voice profiles and is kept
// only for settings compatibility. Encoding ceilings live here so initial
// publish and every produce-based republish use the same source of truth.
const MIC_AUDIO_PROFILES = {
  speech: {
    name: 'speech',
    maxBitrate: 96_000,
    maxPlaybackRate: 48_000,
    dtx: true,
    fec: true,
    nack: true,
    ptime: 20
  },
  // The setting is introduced with the HiFi UI in Phase 3. Keeping its Opus
  // profile here means that profile-changing republish already has one place to
  // compare negotiated parameters when that toggle lands.
  hifi: {
    name: 'hifi',
    maxBitrate: 192_000,
    maxPlaybackRate: 48_000,
    dtx: false,
    fec: true,
    nack: true,
    ptime: 20
  }
}

function selectedMicAudioProfile(micSettings) {
  return micSettings?.hifiVoice === true ? MIC_AUDIO_PROFILES.hifi : MIC_AUDIO_PROFILES.speech
}

// `resolvedChannelCount` is supplied internally from the track returned by
// getUserMedia. It intentionally wins over the ideal/requested setting: a
// device may satisfy an ideal stereo request with a mono track.
export function buildMicOpusOptions(micSettings) {
  const profile = selectedMicAudioProfile(micSettings)
  const resolvedChannelCount = Number(
    micSettings?.resolvedChannelCount ?? micSettings?.channelCount ?? 1
  )

  return {
    encodings: [{ maxBitrate: profile.maxBitrate }],
    codecOptions: {
      opusStereo: resolvedChannelCount === 2,
      opusMaxPlaybackRate: profile.maxPlaybackRate,
      opusMaxAverageBitrate: profile.maxBitrate,
      opusDtx: profile.dtx,
      opusPtime: profile.ptime,
      opusFec: profile.fec,
      opusNack: profile.nack
    }
  }
}

function micSettingsWithResolvedChannelCount(micSettings, stream) {
  let resolvedChannelCount
  try {
    resolvedChannelCount = stream?.getAudioTracks?.()[0]?.getSettings?.().channelCount
  } catch {
    // getSettings() is best-effort; the constraint remains a sensible fallback.
  }
  if (!Number.isFinite(resolvedChannelCount) || resolvedChannelCount < 1) {
    resolvedChannelCount = micSettings?.channelCount ?? 1
  }
  return { ...micSettings, resolvedChannelCount }
}

function micAudioProfileFor(micSettings, opusOptions) {
  const codecOptions = opusOptions.codecOptions
  return {
    name: selectedMicAudioProfile(micSettings).name,
    maxBitrate: opusOptions.encodings[0].maxBitrate,
    opusStereo: codecOptions.opusStereo,
    opusMaxPlaybackRate: codecOptions.opusMaxPlaybackRate,
    opusMaxAverageBitrate: codecOptions.opusMaxAverageBitrate,
    opusDtx: codecOptions.opusDtx,
    opusPtime: codecOptions.opusPtime,
    opusFec: codecOptions.opusFec,
    opusNack: codecOptions.opusNack
  }
}

function sameMicAudioProfile(left, right) {
  if (!left || !right) return false
  return (
    left.name === right.name &&
    left.maxBitrate === right.maxBitrate &&
    left.opusStereo === right.opusStereo &&
    left.opusMaxPlaybackRate === right.opusMaxPlaybackRate &&
    left.opusMaxAverageBitrate === right.opusMaxAverageBitrate &&
    left.opusDtx === right.opusDtx &&
    left.opusPtime === right.opusPtime &&
    left.opusFec === right.opusFec &&
    left.opusNack === right.opusNack
  )
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
    const produceOnServer = async () => {
      // Screen rung validation must finish before the SFU sees Produce. The SFU
      // atomically replaces a same-type producer, so validating afterward could
      // destroy the last live share when the candidate is rejected.
      await runBeforeServerProduce(appData, rtpParameters)
      return send('Produce', {
        produce_params: {
          rtp_params: rtpParameters,
          kind
        },
        produced_type: appData?.produced ?? 'Audio'
      })
    }

    produceOnServer()
      .then((res) => callback({ id: res.id }))
      .catch((err) => errback(err))
  })

  let stream
  try {
    stream = await acquireMicCapture(micSettings, rawMicStream)
  } catch (err) {
    console.error('[Soup] getUserMedia failed:', err.name, err.message)
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  // Track the raw capture so its OS mic handle can be released on teardown —
  // the processed track handed to the producer is usually a different track, so
  // stopping only that would leave the mic open.
  setRawMicStream(stream)

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
  // Detect our own speech from the exact processed track being encoded. In
  // particular, quiet audio rejected by RNNoise or the volume gate must not
  // light the local indicator when peers cannot receive it.
  startSelfSpeakingDetector(processedStream)
  // Separate raw-stream tap that survives muting, for the talking-while-muted warning.
  startMutedTalkDetector(stream)

  const resolvedMicSettings = micSettingsWithResolvedChannelCount(micSettings, stream)
  const opusOptions = buildMicOpusOptions(resolvedMicSettings)
  const audioProfile = micAudioProfileFor(resolvedMicSettings, opusOptions)

  for (const track of processedStream.getTracks()) {
    const producer = await producerTransport.produce({
      track,
      ...opusOptions,
      appData: { produced: 'Audio' }
    })
    producers.push(producer)
    audioProducerProfiles.set(producer, audioProfile)
    localProducerIds.add(producer.id)
    if (micMuted) producer.pause()
    console.log(`[Soup] Producing ${track.kind} [id:${producer.id}]`)
  }

  lastCommittedMicSettings = { ...resolvedMicSettings }

  console.log('[Soup] Publishing audio')
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

async function disposeMicProducers(producerList) {
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
  await Promise.all(ids.map((id) => closeServerProducer(id)))
}

function commitRepublishedMicProcessing({
  stream,
  processedStream,
  processorStop,
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
  startMutedTalkDetector(stream)
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
function restoreCommittedMicCapture(options) {
  return recoverMicRepublish({
    ...options,
    rawMicStream,
    acquireMicCapture,
    buildAudioProcessor,
    stopRawStream,
    stopCandidate: stopMicRepublishCandidate,
    micMuted,
    onPreviousStopped: (previousStop) => {
      if (audioProcessorStop === previousStop) audioProcessorStop = null
    },
    onCommit: commitRepublishedMicProcessing,
    onError: (phase, err) => console.error(`[Soup] Failed ${phase}:`, err)
  })
}

// ─── Republish: apply new mic settings to the existing producer ──
// Reuses the existing audio producer(s) via replaceTrack() for ordinary setting
// changes. A profile change (for example mono speech -> future HiFi stereo) is
// produced first; only a successful replacement commits the producer list and
// its profile metadata.
export function republish(micSettings, onStream) {
  const generation = mediaStateGeneration
  const operation = republishChain.then(
    () => doRepublish(micSettings, onStream, generation),
    () => doRepublish(micSettings, onStream, generation)
  )
  // Keep the chain usable after a rejected operation while returning the
  // original rejection to the caller.
  republishChain = operation.catch(() => {})
  return operation
}

async function doRepublish(micSettings, onStream, expectedGeneration) {
  if (expectedGeneration !== mediaStateGeneration) return

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
  // acquireMicCapture). Cost is a sub-second gap in outgoing audio in the
  // passthrough case, where the raw track IS the produced track.
  const previousRawStream = rawMicStream
  const previousProcessorStop = audioProcessorStop

  let stream
  try {
    stream = await acquireMicCapture(micSettings, previousRawStream)
  } catch (err) {
    console.error('[Soup] republish getUserMedia failed:', err.name, err.message)
    await restoreCommittedMicCapture({
      audioProducers,
      micSettings: previousMicSettings,
      previousStop: previousProcessorStop,
      candidateStream: null,
      candidateProcessedStream: null,
      candidateProcessorStop: null,
      onStream,
      isCurrent
    })
    throw new Error(`Failed to get audio device: ${err.message}`)
  }

  // Build the candidate graph without tearing down the current graph yet. The
  // old raw capture has already been released by acquireMicCapture, but delaying
  // graph teardown keeps the local bookkeeping transactional if processing or
  // produce fails.
  let processedStream = stream
  let candidateProcessorStop = () => {}
  try {
    const processed = await buildAudioProcessor(stream, micSettings)
    processedStream = processed.stream
    candidateProcessorStop = processed.stop
  } catch (err) {
    console.error('[Soup] republish audio processor failed:', err)
  }

  const resolvedMicSettings = micSettingsWithResolvedChannelCount(micSettings, stream)
  const opusOptions = buildMicOpusOptions(resolvedMicSettings)
  const audioProfile = micAudioProfileFor(resolvedMicSettings, opusOptions)
  const newTracks = processedStream.getTracks()

  // The socket can drop while we were awaiting getUserMedia / the audio
  // processor above; onclose then runs resetMediaState(), closing the transport
  // and the producers we captured. Bail rather than produce/replaceTrack on a
  // corpse (InvalidStateError: closed) — the reconnect path re-publishes fresh.
  if (!isCurrent()) {
    discardRepublishCandidate({
      stream,
      processedStream,
      processorStop: candidateProcessorStop,
      previousStop: previousProcessorStop
    })
    return
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
        await disposeMicProducers(freshProducers)
        discardRepublishCandidate({
          stream,
          processedStream,
          processorStop: candidateProcessorStop,
          previousStop: previousProcessorStop
        })
        return
      }
    } catch (err) {
      await disposeMicProducers(freshProducers)
      discardRepublishCandidate({
        stream,
        processedStream,
        processorStop: candidateProcessorStop,
        previousStop: previousProcessorStop
      })
      throw err
    }

    producers = producers.filter((p) => p.kind !== 'audio').concat(freshProducers)
    for (const producer of freshProducers) {
      audioProducerProfiles.set(producer, audioProfile)
      localProducerIds.add(producer.id)
      if (micMuted) producer.pause()
      console.log(`[Soup] Republished ${producer.track.kind} [id:${producer.id}]`)
    }
    commitRepublishedMicProcessing({
      stream,
      processedStream,
      processorStop: candidateProcessorStop,
      previousStop: previousProcessorStop,
      micSettings: resolvedMicSettings,
      onStream
    })
    console.log('[Soup] Audio republished with new settings')
    return
  }

  if (newTracks.length !== audioProducers.length) {
    await restoreCommittedMicCapture({
      audioProducers,
      micSettings: previousMicSettings,
      previousStop: previousProcessorStop,
      candidateStream: stream,
      candidateProcessedStream: processedStream,
      candidateProcessorStop,
      onStream,
      isCurrent
    })
    throw new Error('Microphone track count changed during republish')
  }

  const profileChanged = audioProducers.some((producer) => {
    const previousProfile = audioProducerProfiles.get(producer)
    return previousProfile && !sameMicAudioProfile(previousProfile, audioProfile)
  })

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
        await disposeMicProducers(replacementProducers)
        discardRepublishCandidate({
          stream,
          processedStream,
          processorStop: candidateProcessorStop,
          previousStop: previousProcessorStop
        })
        return
      }
    } catch (err) {
      await restoreCommittedMicCapture({
        audioProducers,
        micSettings: previousMicSettings,
        previousStop: previousProcessorStop,
        candidateStream: stream,
        candidateProcessedStream: processedStream,
        candidateProcessorStop,
        onStream,
        isCurrent
      })
      await disposeMicProducers(replacementProducers)
      throw err
    }

    const oldProducerSet = new Set(audioProducers)
    producers = producers
      .filter((producer) => !oldProducerSet.has(producer))
      .concat(replacementProducers)
    for (const producer of replacementProducers) {
      audioProducerProfiles.set(producer, audioProfile)
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
    commitRepublishedMicProcessing({
      stream,
      processedStream,
      processorStop: candidateProcessorStop,
      previousStop: previousProcessorStop,
      micSettings: resolvedMicSettings,
      onStream
    })
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
      discardRepublishCandidate({
        stream,
        processedStream,
        processorStop: candidateProcessorStop,
        previousStop: previousProcessorStop
      })
      return
    }

    await restoreCommittedMicCapture({
      audioProducers,
      micSettings: previousMicSettings,
      previousStop: previousProcessorStop,
      candidateStream: stream,
      candidateProcessedStream: processedStream,
      candidateProcessorStop,
      onStream,
      isCurrent
    })
    throw err
  }

  commitRepublishedMicProcessing({
    stream,
    processedStream,
    processorStop: candidateProcessorStop,
    previousStop: previousProcessorStop,
    micSettings: resolvedMicSettings,
    onStream
  })
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

// Screen shares deliberately have only temporal SVC (never spatial SVC or
// simulcast): sharp text needs the whole bitrate budget at full resolution.
// AV1/VP9 may support up to three temporal layers; H.264 must always remain
// plain because MediaFoundation rejects scalabilityMode on its screen encoder.
const SCREEN_SVC_RUNGS = ['L1T3', 'L1T2', 'plain']
const SCREEN_SVC_VERDICT_PREFIX = 'screenSvcVerdict:'

function screenCodecMime(codec) {
  return codec?.mimeType?.toLowerCase() ?? ''
}

function supportsScreenTemporalSvc(codec) {
  return /^video\/(av1|vp9)$/i.test(codec?.mimeType ?? '')
}

function screenSvcRungsFor(codec, startRung) {
  const rungs = supportsScreenTemporalSvc(codec) ? SCREEN_SVC_RUNGS : ['plain']
  const startIndex = startRung == null ? 0 : rungs.indexOf(startRung)
  return startIndex >= 0 ? rungs.slice(startIndex) : rungs
}

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

// Chromium's WebRTC sender is the only path that can use temporal SVC. Keep
// screenEncodingFor() bitrate/framerate-only: the native AV1 screen encoder
// reuses that helper with its intentionally plain RTP encoding.
function chromiumScreenEncodingFor(codec, rung, { width, height, fps, optimizeFor }) {
  const encoding = screenEncodingFor({ width, height, fps, codec, optimizeFor })
  const scalabilityMode = supportsScreenTemporalSvc(codec) && rung !== 'plain' ? rung : undefined
  return scalabilityMode ? { ...encoding, scalabilityMode } : encoding
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
// ponytail: sticky for this renderer session once set; cleared by
// resetScreenCodecPreference() when the encoder landscape changes (e.g. the
// hardware-acceleration toggle) so AV1 is re-probed.
const SCREEN_H264_KEY = 'screenPreferH264'
const SCREEN_H264_CACHE_VERSION_KEY = 'screenPreferH264Version'

function screenSvcVerdictKey(codec) {
  const mime = screenCodecMime(codec)
  return supportsScreenTemporalSvc(codec) && mime ? `${SCREEN_SVC_VERDICT_PREFIX}${mime}` : null
}

function cachedScreenSvcRung(codec) {
  const key = screenSvcVerdictKey(codec)
  if (!key) return null
  try {
    const rung = sessionStorage.getItem(key)
    return screenSvcRungsFor(codec).includes(rung) ? rung : null
  } catch {
    return null
  }
}

function cacheScreenSvcRung(codec, rung) {
  const key = screenSvcVerdictKey(codec)
  if (!key || !screenSvcRungsFor(codec).includes(rung)) return
  try {
    sessionStorage.setItem(key, rung)
  } catch {
    // Storage is only an optimization; retry the full rung ladder if unavailable.
  }
}

function clearScreenSvcRungStorage() {
  try {
    const keys = []
    for (let index = 0; index < sessionStorage.length; index++) {
      const key = sessionStorage.key(index)
      if (key?.startsWith(SCREEN_SVC_VERDICT_PREFIX)) keys.push(key)
    }
    for (const key of keys) sessionStorage.removeItem(key)
  } catch {
    // sessionStorage may be unavailable in unusual/private renderer contexts.
  }
}

// This is an optimization, not durable hardware capability knowledge. GPU
// process startup, driver state, and feature flags can differ across app
// launches (especially the first launch after an update), so a software result
// must not permanently pin future processes to H.264. Keep the optimization for
// later shares in this renderer, but force every fresh renderer to probe AV1.
function clearScreenCodecPreferenceStorage() {
  try {
    // Remove values written by older builds which incorrectly persisted this
    // decision across app restarts.
    localStorage.removeItem(SCREEN_H264_KEY)
    localStorage.removeItem(SCREEN_H264_CACHE_VERSION_KEY)
    sessionStorage.removeItem(SCREEN_H264_KEY)
  } catch {
    // localStorage is unavailable only in unusual/private renderer contexts;
    // the normal codec probe still works without the optimization cache.
  }
  clearScreenSvcRungStorage()
}

clearScreenCodecPreferenceStorage()

function hasScreenCodecPreference() {
  try {
    return sessionStorage.getItem(SCREEN_H264_KEY) === '1'
  } catch {
    return false
  }
}

// Forget the session's "AV1 is software here → use H.264" verdict so the next
// share re-probes AV1 from scratch. Call when something that changes which
// encoders exist has changed — notably toggling hardware acceleration, after
// which AV1 that was software may now be hardware (or vice-versa).
export function resetScreenCodecPreference() {
  try {
    sessionStorage.removeItem(SCREEN_H264_KEY)
    localStorage.removeItem(SCREEN_H264_KEY)
    localStorage.removeItem(SCREEN_H264_CACHE_VERSION_KEY)
  } catch {
    // Ignore storage failures; the next renderer session will still probe AV1.
  }
  clearScreenSvcRungStorage()
}

// User-forced screen codec from PREFER_SCREENSHARE_CODEC=H264|AV1|VP9 (normalized
// in preload). When set, it overrides both the AV1-first default and the adaptive
// H.264 downgrade — the user explicitly asked for this codec, so we keep it even
// if it comes up software. undefined when unset/invalid.
const FORCED_SCREEN_CODEC_MIME = {
  H264: 'video/h264',
  AV1: 'video/av1',
  VP9: 'video/vp9'
}[(typeof window !== 'undefined' && window.api?.preferScreenshareCodec) || '']

function forcedScreenCodec() {
  return FORCED_SCREEN_CODEC_MIME ? findVideoCodec(FORCED_SCREEN_CODEC_MIME) : undefined
}

// Screen share prefers AV1 for efficiency, then VP9. Chromium AV1/VP9 starts on
// a temporal-SVC rung and falls through L1T3 → L1T2 → plain when needed; H.264
// always stays plain. Sender stats remain the final HW/SW verdict because a
// positive MediaCapabilities answer is not reliable on Windows/RDNA3.
function pickVideoCodec() {
  // An explicit PREFER_SCREENSHARE_CODEC wins outright when the router advertises
  // it; fall through to the normal selection if it's unavailable.
  const forced = forcedScreenCodec()
  if (forced) return forced
  if (hasScreenCodecPreference()) {
    return findVideoCodec('video/h264') ?? findVideoCodec('video/vp9')
  }
  return findVideoCodec('video/av1') ?? findVideoCodec('video/vp9')
}

// Camera codec verdicts are deliberately independent from screen verdicts. A
// renderer that had to use software AV1 for screenshare may still have a good
// hardware VP9 camera encoder (and vice versa). Keep this session-only so a
// different Chromium/GPU process gets a fresh probe.
const CAMERA_H264_KEY = 'cameraPreferH264'

function hasCameraCodecPreference() {
  try {
    return sessionStorage.getItem(CAMERA_H264_KEY) === '1'
  } catch {
    return false
  }
}

export function resetCameraCodecPreference() {
  try {
    sessionStorage.removeItem(CAMERA_H264_KEY)
  } catch {
    // Ignore storage failures; the next camera probe will still run.
  }
}

function cacheCameraCodecPreference() {
  try {
    sessionStorage.setItem(CAMERA_H264_KEY, '1')
  } catch {
    // The next camera share will simply probe VP9 again.
  }
}

// Webcam prefers VP9 for real spatial layer rationing, unless this renderer has
// already measured a software/struggling VP9 encoder. H.264 is the efficient
// hardware fallback and gets two simulcast encodings; AV1 remains a last
// compatibility fallback only.
function pickCameraCodec() {
  const vp9 = findVideoCodec('video/vp9')
  const h264 = findVideoCodec('video/h264')
  const av1 = findVideoCodec('video/av1')
  if (hasCameraCodecPreference() && h264) return h264
  return vp9 ?? h264 ?? av1
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

function outboundLayerIsHigher(left, right) {
  const leftWidth = Number(left?.frameWidth) || 0
  const leftHeight = Number(left?.frameHeight) || 0
  const rightWidth = Number(right?.frameWidth) || 0
  const rightHeight = Number(right?.frameHeight) || 0
  const leftPixels = leftWidth * leftHeight
  const rightPixels = rightWidth * rightHeight
  if (leftPixels !== rightPixels) return leftPixels > rightPixels

  const leftFps = Number(left?.framesPerSecond) || 0
  const rightFps = Number(right?.framesPerSecond) || 0
  if (leftFps !== rightFps) return leftFps > rightFps

  // Some Chromium versions omit frame dimensions briefly during startup. RIDs
  // still preserve the usual low -> medium -> full simulcast ordering.
  const ridRank = (rid) => ({ q: 0, h: 1, f: 2 })[String(rid ?? '').toLowerCase()] ?? 0
  return ridRank(left?.rid) > ridRank(right?.rid)
}

// Aggregates one outbound-video getStats() report across simulcast encodings
// into a single sample — the live equivalent of chrome://webrtc-internals.
// Mutates previousByOutboundId (per-poller delta state); callers must never
// share that map across pollers. Each outbound encoding keeps its own previous
// sample: simulcast reports have different SSRCs and must never be diffed
// against one another. Returns null when no active outbound-rtp video report
// exists.
function computeOutboundVideoSample(stats, previousByOutboundId) {
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

  const activeOutbound = []
  const activeOutboundIds = new Set()
  for (const s of stats.values()) {
    // Chromium may expose a separate outbound RTX report. It has kind=video
    // but no encoded frames; mixing it into the primary report corrupts all
    // byte/frame deltas and can trigger a false codec downgrade.
    if (s.type !== 'outbound-rtp' || s.kind !== 'video' || s.framesEncoded == null) continue
    const outboundRtpId = s.id ?? `ssrc:${s.ssrc ?? 'unknown'}`
    if (s.active === false) {
      // If a simulcast layer is disabled and later comes back, its first
      // sample must not span the entire inactive period.
      previousByOutboundId.delete(outboundRtpId)
      continue
    }
    activeOutboundIds.add(outboundRtpId)
    activeOutbound.push({ id: outboundRtpId, stat: s })
  }

  // Drop samples for encodings no longer exposed by getStats (for example
  // after a sender reconfiguration), so a reused id cannot produce a stale
  // delta after a long gap.
  for (const previousId of previousByOutboundId.keys()) {
    if (!activeOutboundIds.has(previousId)) previousByOutboundId.delete(previousId)
  }
  if (activeOutbound.length === 0) return null

  let totalEncodeTimeDelta = 0
  let totalFramesDelta = 0
  let hasEncodeDelta = false
  let totalSendKbps = 0
  let hasSendDelta = false
  let totalPacketsSent = 0
  let totalRetransmittedPacketsSent = 0
  let totalNackCount = 0
  let totalPliCount = 0
  let totalPacketsLost = 0
  let hasPacketsLost = false
  let highestActive = null
  let anyCpuLimited = false
  let anyBandwidthLimited = false
  const hardwareVerdicts = []

  for (const { id: outboundRtpId, stat: s } of activeOutbound) {
    const previous = previousByOutboundId.get(outboundRtpId)
    const framesDelta =
      previous && s.framesEncoded >= previous.framesEncoded
        ? s.framesEncoded - previous.framesEncoded
        : null
    const encodeTimeDelta =
      previous &&
      Number.isFinite(s.totalEncodeTime) &&
      Number.isFinite(previous.totalEncodeTime) &&
      s.totalEncodeTime >= previous.totalEncodeTime
        ? s.totalEncodeTime - previous.totalEncodeTime
        : null
    const elapsedMs =
      previous && Number.isFinite(s.timestamp) && Number.isFinite(previous.timestamp)
        ? s.timestamp - previous.timestamp
        : 0
    const bytesDelta =
      previous &&
      Number.isFinite(s.bytesSent) &&
      Number.isFinite(previous.bytesSent) &&
      s.bytesSent >= previous.bytesSent
        ? s.bytesSent - previous.bytesSent
        : null

    if (framesDelta != null && encodeTimeDelta != null) {
      totalFramesDelta += framesDelta
      totalEncodeTimeDelta += encodeTimeDelta
      hasEncodeDelta = true
    }
    if (bytesDelta != null && elapsedMs > 0) {
      // Sum each encoding's rate. Summing the elapsed time would divide a
      // two-layer simulcast stream by two when both reports share a clock.
      totalSendKbps += (8 * bytesDelta) / elapsedMs
      hasSendDelta = true
    }

    totalPacketsSent += s.packetsSent ?? 0
    totalRetransmittedPacketsSent += s.retransmittedPacketsSent ?? 0
    totalNackCount += s.nackCount ?? 0
    totalPliCount += s.pliCount ?? 0
    const remoteInbound =
      remoteInboundByLocalId.get(outboundRtpId) ??
      (activeOutbound.length === 1 ? fallbackRemoteInbound : null)
    if (remoteInbound?.packetsLost != null) {
      totalPacketsLost += remoteInbound.packetsLost
      hasPacketsLost = true
    }

    const reason = s.qualityLimitationReason
    anyCpuLimited ||= reason === 'cpu'
    anyBandwidthLimited ||= reason === 'bandwidth'
    hardwareVerdicts.push(encoderIsHardware(s.encoderImplementation))
    if (highestActive == null || outboundLayerIsHigher(s, highestActive.stat)) {
      highestActive = { id: outboundRtpId, stat: s }
    }

    previousByOutboundId.set(outboundRtpId, {
      totalEncodeTime: s.totalEncodeTime ?? 0,
      framesEncoded: s.framesEncoded ?? 0,
      bytesSent: s.bytesSent ?? 0,
      timestamp: s.timestamp
    })
  }

  // Any active software encoder makes the aggregate software. If all active
  // encodings are known hardware, report hardware; otherwise keep the badge
  // unknown instead of treating a missing implementation as hardware.
  const hardware = hardwareVerdicts.some((verdict) => verdict === false)
    ? false
    : hardwareVerdicts.length > 0 && hardwareVerdicts.every((verdict) => verdict === true)
      ? true
      : null
  const topRemoteInbound =
    (highestActive && remoteInboundByLocalId.get(highestActive.id)) ??
    (activeOutbound.length === 1 ? fallbackRemoteInbound : null)
  const qualityLimitationReason = anyCpuLimited
    ? 'cpu'
    : anyBandwidthLimited
      ? 'bandwidth'
      : highestActive?.stat.qualityLimitationReason
  const encodeMsPerFrame =
    hasEncodeDelta && totalFramesDelta > 0 ? (totalEncodeTimeDelta * 1000) / totalFramesDelta : null
  const sendKbps = hasSendDelta ? totalSendKbps : null

  return {
    implementation: highestActive?.stat.encoderImplementation,
    hardware,
    qualityLimitationReason,
    width: highestActive?.stat.frameWidth,
    height: highestActive?.stat.frameHeight,
    fps: highestActive?.stat.framesPerSecond,
    encodeMsPerFrame,
    sendKbps,
    packetsSent: totalPacketsSent,
    retransmittedPacketsSent: totalRetransmittedPacketsSent,
    nackCount: totalNackCount,
    pliCount: totalPliCount,
    rttMs: topRemoteInbound?.roundTripTime != null ? topRemoteInbound.roundTripTime * 1000 : null,
    packetsLost: hasPacketsLost ? totalPacketsLost : undefined,
    fractionLost: topRemoteInbound?.fractionLost,
    availableOutgoingBitrate: candidatePair?.availableOutgoingBitrate,
    activeEncodings: activeOutbound.length
  }
}

// Poll the video sender's outbound-rtp stats every 3s and report to onStats:
// codec + whether the encoder is hardware or software (encoderImplementation, e.g.
// 'libaom' = software AV1) for the sharer's HW/SW tile badge, and qualityLimitationReason
// ('cpu' = the encoder can't keep up) which drives maybeDowngradeScreenCodec.
// Also logged in dev. Returns a stop function; only the most recent share is
// polled.
let encoderStatsStop = null
function startEncoderStatsLog(producer, onStats) {
  encoderStatsStop?.()
  const sender = producer.rtpSender
  if (!sender?.getStats) return
  const previousByOutboundId = new Map()
  const id = setInterval(async () => {
    try {
      const stats = await sender.getStats()
      const sample = computeOutboundVideoSample(stats, previousByOutboundId)
      if (!sample) return

      if (import.meta.env.DEV) {
        console.log(
          `[Soup] encoder: ${sample.implementation ?? '?'} ` +
            `(${sample.activeEncodings} active encoding${sample.activeEncodings === 1 ? '' : 's'})` +
            ` | limited by: ${sample.qualityLimitationReason ?? '?'}` +
            ` | ${sample.width ?? '?'}x${sample.height ?? '?'}` +
            `@${Math.round(sample.fps ?? 0)}fps` +
            (sample.encodeMsPerFrame != null
              ? ` | ${sample.encodeMsPerFrame.toFixed(1)}ms/frame`
              : '') +
            (sample.sendKbps != null ? ` | ${sample.sendKbps.toFixed(0)}kbps` : '') +
            (sample.rttMs != null ? ` | RTT ${sample.rttMs.toFixed(0)}ms` : '')
        )
      }

      onStats?.({ codec: codecLabel(producer.rtpParameters), ...sample })
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

// ─── Adaptive screen-share SVC fallback ──────────────────────────
// AV1/VP9 start at L1T3 and use an explicit rung state machine. A hard
// produce()/setParameters() failure tries the next rung with the same capture
// track; a software verdict first steps down within the codec, and only a plain
// unforced AV1/VP9 share falls to H.264. Sustained CPU pressure retains its
// existing direct H.264 fallback. Each successful rung is cached per session.
const CPU_STRIKES_TO_DOWNGRADE = 3 // ~3 polls × 3s ≈ 9s of sustained cpu limiting
const SCREEN_FALLBACK_BASE_COOLDOWN_MS = 5000
const SCREEN_FALLBACK_MAX_COOLDOWN_MS = 300_000

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

function screenRungKey(codec, rung) {
  return `${screenCodecMime(codec) || '__default__'}:${rung}`
}

function isScreenRungRejected(ctx, codec, rung) {
  return ctx.rejectedScreenRungs?.has(screenRungKey(codec, rung))
}

function rejectScreenRung(ctx, codec, rung) {
  ctx.rejectedScreenRungs?.add(screenRungKey(codec, rung))
}

function resetScreenFallbackCooldown(ctx) {
  ctx.fallbackFailureCount = 0
  ctx.fallbackCooldownUntil = 0
}

function armScreenFallbackCooldown(ctx) {
  const failureCount = ctx.fallbackFailureCount ?? 0
  const delay = Math.min(
    SCREEN_FALLBACK_MAX_COOLDOWN_MS,
    SCREEN_FALLBACK_BASE_COOLDOWN_MS * 2 ** Math.min(failureCount, 8)
  )
  ctx.fallbackFailureCount = failureCount + 1
  ctx.fallbackCooldownUntil = Date.now() + delay
  console.warn(`[Soup] Screen fallback cooling down for ${delay}ms`)
}

function screenFallbackIsCoolingDown(ctx) {
  return Date.now() < (ctx.fallbackCooldownUntil ?? 0)
}

// Serialize mediasoup produce operations for the single local video-share slot.
// If ownership changes during the await, close only the producer just created;
// never call a global teardown that could belong to the successor share.
function produceForShare(ctx, options) {
  let rejectedAttemptSender = null
  const result = enqueueShareProduce(async () => {
    try {
      if (!isActiveShare(ctx)) throw shareSupersededError()
      const producer = await ctx.transport.produce({
        ...options,
        // Chrome creates the transceiver before later SDP work can reject. The
        // callback is invoked before that work, so keep the sender outside the
        // mediasoup Producer as a cleanup handle for handler-level failures.
        onRtpSender: (sender) => {
          rejectedAttemptSender = sender
          options.onRtpSender?.(sender)
        }
      })
      if (!isActiveShare(ctx)) {
        producer.close()
        await closeServerProducer(producer.id)
        throw shareSupersededError()
      }
      return producer
    } catch (error) {
      if (rejectedAttemptSender) {
        try {
          await detachRtpSender(rejectedAttemptSender)
        } catch (detachError) {
          console.warn('[Soup] Failed to detach rejected screen RTP sender:', detachError)
        }
      }
      throw error
    }
  })

  return result
}

function screenEncodingCapabilityError(codec) {
  const error = new Error(
    `No viable screen encoding rung for ${codec?.mimeType ?? 'the default codec'}`
  )
  error.code = 'SCREEN_ENCODING_CAPABILITY_REJECTED'
  return error
}

// MediaCapabilities is only a negative pre-hint. Positive answers are known to
// be unreliable on Windows/RDNA3, so every accepted rung still goes through the
// sender-stats verdict. A forced codec intentionally bypasses this optimization.
async function hasNegativeScreenEncodingCapabilityHint(ctx, codec, encoding) {
  if (!supportsScreenTemporalSvc(codec) || forcedScreenCodec()) return false
  const mediaCapabilities = globalThis.navigator?.mediaCapabilities
  if (typeof mediaCapabilities?.encodingInfo !== 'function') return false

  try {
    const info = await mediaCapabilities.encodingInfo({
      type: 'webrtc',
      video: {
        contentType: codec.mimeType,
        width: Math.max(1, Math.round(ctx.width)),
        height: Math.max(1, Math.round(ctx.height)),
        framerate: encoding.maxFramerate,
        bitrate: encoding.maxBitrate,
        ...(encoding.scalabilityMode ? { scalabilityMode: encoding.scalabilityMode } : {})
      }
    })
    const negative = info?.supported === false || info?.powerEfficient === false
    if (negative) {
      console.warn(
        `[Soup] Skipping ${codec.mimeType} ${encoding.scalabilityMode ?? 'plain'} screen rung ` +
          'from negative MediaCapabilities hint'
      )
    }
    return negative
  } catch {
    // Unsupported query fields or browser errors are deliberately not a verdict.
    return false
  }
}

function screenProducerOptions(ctx, codec, encoding) {
  let sender = null
  return {
    track: ctx.track,
    codec,
    encodings: [encoding],
    // A failed produce/parameter attempt must not end the capture track: the
    // next SVC rung reuses it, and stopShareContext() remains its sole owner.
    stopTracks: false,
    codecOptions: { videoGoogleStartBitrate: 2500 },
    onRtpSender: (rtpSender) => {
      sender = rtpSender
    },
    appData: {
      produced: 'ScreenShare',
      beforeServerProduce: async (rtpParameters) => {
        await setSenderDegradationPreference(
          sender,
          ctx.optimizeFor === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
          { strict: true }
        )
        confirmScreenRung(rtpParameters, sender, encoding)
      }
    }
  }
}

async function discardUnadoptedShareProducer(producer) {
  try {
    producer.close()
  } finally {
    await closeServerProducer(producer.id)
  }
}

function screenRungExhaustedError(codec) {
  const error = new Error(
    `All screen encoding rungs were rejected for ${codec?.mimeType ?? 'the default codec'}`
  )
  error.code = 'SCREEN_ENCODING_RUNGS_EXHAUSTED'
  return error
}

// Try a codec's temporal-SVC ladder from the requested rung down to plain.
// Each candidate is fully configured before it is returned, so a failed
// produce()/setParameters() never consumes the shared capture track or becomes
// the active producer.
async function produceScreenWithFallback(ctx, codec, { startRung } = {}) {
  const firstRung = startRung ?? cachedScreenSvcRung(codec) ?? screenSvcRungsFor(codec)[0]
  const rungs = screenSvcRungsFor(codec, firstRung).filter(
    (rung) => !isScreenRungRejected(ctx, codec, rung)
  )
  if (rungs.length === 0) throw screenRungExhaustedError(codec)
  let lastError = null

  for (const rung of rungs) {
    const encoding = chromiumScreenEncodingFor(codec, rung, ctx)
    if (await hasNegativeScreenEncodingCapabilityHint(ctx, codec, encoding)) {
      rejectScreenRung(ctx, codec, rung)
      lastError = screenEncodingCapabilityError(codec)
      continue
    }

    let producer
    try {
      producer = await produceForShare(ctx, screenProducerOptions(ctx, codec, encoding))
      if (!isActiveShare(ctx) || ctx.track?.readyState === 'ended') {
        throw shareSupersededError()
      }
      cacheScreenSvcRung(codec, rung)
      return { producer, codec, rung, encoding }
    } catch (error) {
      if (producer) await discardUnadoptedShareProducer(producer)
      if (isShareSupersededError(error)) throw error
      rejectScreenRung(ctx, codec, rung)
      lastError = error
      console.warn(
        `[Soup] Screen ${codec?.mimeType ?? 'default'} ${rung} rung failed; trying the next rung:`,
        error
      )
    }
  }

  throw lastError ?? screenEncodingCapabilityError(codec)
}

function uniqueScreenCodecs(codecs) {
  const seen = new Set()
  return codecs.filter((codec) => {
    // Preserve mediasoup's default-codec path for routers that advertise none
    // of our explicit AV1/VP9/H.264 candidates.
    const mime = screenCodecMime(codec) || '__default__'
    if (seen.has(mime)) return false
    seen.add(mime)
    return true
  })
}

// A pre-produce failure may mean AV1/VP9 is advertised but unavailable in this
// Chromium process. Exhaust that codec's rung ladder first, then try the next
// compatible codec. An explicit PREFER_SCREENSHARE_CODEC never leaves its codec.
async function produceInitialScreenWithFallback(ctx, initialCodec) {
  const forced = forcedScreenCodec()
  const codecs = uniqueScreenCodecs(
    forced ? [forced] : [initialCodec, findVideoCodec('video/vp9'), findVideoCodec('video/h264')]
  )
  let lastError = null

  for (const codec of codecs) {
    try {
      return await produceScreenWithFallback(ctx, codec)
    } catch (error) {
      if (isShareSupersededError(error)) throw error
      lastError = error
      console.warn(`[Soup] Screen codec ${codec?.mimeType ?? 'default'} could not start:`, error)
    }
  }

  throw lastError ?? new Error('No supported screen-share video codec is available')
}

function adoptScreenProducer(ctx, candidate) {
  const previous = ctx.producer
  ctx.statsStop?.()
  ctx.statsStop = null
  ctx.producer = candidate.producer
  ctx.screenCodec = candidate.codec
  ctx.screenSvcRung = candidate.rung
  ctx.cpuStrikes = 0
  resetScreenFallbackCooldown(ctx)
  localProducerIds.add(candidate.producer.id)

  if (previous && previous !== candidate.producer) {
    previous.close()
    localProducerIds.delete(previous.id)
    // Producing ScreenShare atomically replaces its server-side predecessor;
    // closing previous.id explicitly would return NotFound and desync the FIFO.
    ctx.onProducerReplaced?.({
      previousProducerId: previous.id,
      producerId: candidate.producer.id,
      codec: codecLabel(candidate.producer.rtpParameters)
    })
  }

  logNegotiatedVideoCodec(candidate.producer, candidate.encoding.scalabilityMode)
  ctx.statsStop = startEncoderStatsLog(candidate.producer, (stats) => {
    // A getStats() call already in flight for the replaced producer may finish
    // after its interval is cleared. Do not let that stale software verdict skip
    // a freshly selected SVC rung.
    if (ctx.producer !== candidate.producer) return
    screenStatsHandler(ctx, stats)
  })
}

function nextScreenSvcRung(ctx) {
  const rungs = screenSvcRungsFor(ctx.screenCodec)
  const current = rungs.includes(ctx.screenSvcRung) ? ctx.screenSvcRung : 'plain'
  const index = rungs.indexOf(current)
  if (index < 0) return null
  return (
    rungs.slice(index + 1).find((rung) => !isScreenRungRejected(ctx, ctx.screenCodec, rung)) ?? null
  )
}

async function stepDownScreenSvcRung(ctx, reason) {
  const nextRung = nextScreenSvcRung(ctx)
  if (!nextRung) return false

  try {
    const candidate = await produceScreenWithFallback(ctx, ctx.screenCodec, { startRung: nextRung })
    if (!isActiveShare(ctx)) {
      await discardUnadoptedShareProducer(candidate.producer)
      throw shareSupersededError()
    }
    adoptScreenProducer(ctx, candidate)
    console.log(
      `[Soup] Screen ${ctx.screenCodec?.mimeType ?? 'default'} stepped down to ${candidate.rung} ` +
        `(${reason}) [id:${candidate.producer.id}]`
    )
    return true
  } catch (error) {
    if (isShareSupersededError(error)) throw error
    console.warn('[Soup] Screen SVC rungs exhausted; considering codec fallback:', error)
    return false
  }
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
  void maybeDowngradeScreenCodec(ctx, stats)
}

async function downgradeScreenCodecToH264(ctx, { softwareEncoder, reason }) {
  const current = ctx.producer?.rtpParameters?.codecs?.[0]?.mimeType ?? ''
  if (/h264/i.test(current)) return false

  const h264 = findVideoCodec('video/h264')
  if (!h264) return false

  const candidate = await produceScreenWithFallback(ctx, h264, { startRung: 'plain' })
  if (!isActiveShare(ctx)) {
    await discardUnadoptedShareProducer(candidate.producer)
    throw shareSupersededError()
  }
  adoptScreenProducer(ctx, candidate)

  // Only an observed software encoder proves that this renderer should skip
  // AV1/VP9 next time. CPU pressure alone must not create that preference.
  if (softwareEncoder) {
    try {
      sessionStorage.setItem(SCREEN_H264_KEY, '1')
    } catch {
      // The next share will simply probe again if sessionStorage is unavailable.
    }
  }
  console.log(`[Soup] Screen codec downgraded to H264 (${reason}) [id:${candidate.producer.id}]`)
  return true
}

async function maybeDowngradeScreenCodec(ctx, stats) {
  if (
    !isActiveShare(ctx) ||
    !ctx.producer ||
    ctx.screenTransition ||
    screenFallbackIsCoolingDown(ctx)
  )
    return

  const current = ctx.producer.rtpParameters?.codecs?.[0]?.mimeType ?? ''
  if (/h264/i.test(current)) return // already on the lightest codec

  const softwareEncoder = stats.hardware === false
  if (softwareEncoder) {
    // A measured software encoder may be caused by the SVC rung itself. Lower
    // that rung before abandoning AV1/VP9 for H.264.
    ctx.cpuStrikes = CPU_STRIKES_TO_DOWNGRADE
  } else {
    // Hardware (or not-yet-known) encoder: only step down under sustained cpu
    // limitation. Decay rather than reset so cpu/bandwidth oscillation cannot
    // avoid a needed fallback forever.
    ctx.cpuStrikes =
      stats.qualityLimitationReason === 'cpu' ? ctx.cpuStrikes + 1 : Math.max(0, ctx.cpuStrikes - 1)
  }
  if (ctx.cpuStrikes < CPU_STRIKES_TO_DOWNGRADE) return

  const forced = forcedScreenCodec()
  const nextRung = nextScreenSvcRung(ctx)
  // Preserve the existing forced-codec contract for CPU pressure: only a
  // measured software encoder walks the SVC ladder, and forced shares never
  // auto-switch to H.264.
  if (forced && !softwareEncoder) return
  if (forced && !nextRung) {
    armScreenFallbackCooldown(ctx)
    return
  }
  if (!forced && !nextRung) {
    const h264 = findVideoCodec('video/h264')
    if (!h264 || isScreenRungRejected(ctx, h264, 'plain')) {
      armScreenFallbackCooldown(ctx)
      return
    }
  }
  const reason = softwareEncoder ? 'software encoder' : 'cpu limited'
  const transition = (async () => {
    if (softwareEncoder && nextRung && (await stepDownScreenSvcRung(ctx, reason))) return
    // Forced-codec mode can lose temporal SVC rungs but may never switch codec.
    if (forced) {
      armScreenFallbackCooldown(ctx)
      return
    }
    const downgraded = await downgradeScreenCodecToH264(ctx, { softwareEncoder, reason })
    if (!downgraded) armScreenFallbackCooldown(ctx)
  })()
  ctx.screenTransition = transition

  try {
    await transition
  } catch (error) {
    if (isShareSupersededError(error)) return
    // Keep the current producer if every candidate failed; a later stats sample
    // should wait for the backoff before considering another transition.
    console.warn('[Soup] Screen fallback transition failed; keeping current producer:', error)
    armScreenFallbackCooldown(ctx)
    if (!softwareEncoder) ctx.cpuStrikes = 0
  } finally {
    if (ctx.screenTransition === transition) ctx.screenTransition = null
  }
}

function confirmScreenRung(rtpParameters, sender, encoding) {
  const expected = encoding.scalabilityMode
  if (!expected) return

  const negotiated = rtpParameters?.encodings?.[0]?.scalabilityMode
  let senderMode
  try {
    senderMode = sender?.getParameters?.().encodings?.[0]?.scalabilityMode
  } catch {
    // The negotiated RTP parameters below are still useful if sender readback
    // is unavailable in this browser.
  }
  const actual = senderMode ?? negotiated
  if (actual !== expected) {
    const error = new Error(`Screen sender selected ${actual ?? 'plain'} instead of ${expected}`)
    error.code = 'SCREEN_SCALABILITY_MODE_MISMATCH'
    throw error
  }
}

// Bias how the encoder sheds quality under CPU/bandwidth pressure, via the RTP
// sender's top-level degradationPreference. Mirrors the audio setParameters path
// (getParameters → mutate → setParameters). Strict mode is used while probing a
// screen rung: a rejected parameter update must reject that rung, not be cached.
async function setSenderDegradationPreference(sender, preference, { strict = false } = {}) {
  if (!sender) {
    const error = new Error('Screen producer has no RTP sender')
    if (strict) throw error
    console.warn('[Soup] Failed to set degradationPreference:', error)
    return false
  }
  try {
    const params = sender.getParameters()
    params.degradationPreference = preference
    await sender.setParameters(params)
    return true
  } catch (error) {
    if (strict) throw error
    console.warn('[Soup] Failed to set degradationPreference:', error)
    return false
  }
}

async function setDegradationPreference(producer, preference, options) {
  return setSenderDegradationPreference(producer.rtpSender, preference, options)
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
  onEncoderStats = undefined,
  // A fallback publishes a successor producer. The caller owns the self tile,
  // so it must replace its producer id for viewer bookkeeping to follow it.
  onProducerReplaced = undefined
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
    screenCodec: null,
    screenSvcRung: 'plain',
    screenTransition: null,
    rejectedScreenRungs: new Set(),
    fallbackFailureCount: 0,
    fallbackCooldownUntil: 0,
    onProducerReplaced
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

    const initialProducer = await produceInitialScreenWithFallback(ctx, screenCodec)
    if (!isActiveShare(ctx) || track.readyState === 'ended') {
      await discardUnadoptedShareProducer(initialProducer.producer)
      throw shareSupersededError()
    }
    adoptScreenProducer(ctx, initialProducer)
    console.log(
      `[Soup] Screen sharing ${initialProducer.codec?.mimeType ?? 'default'} ` +
        `${initialProducer.rung} [id:${initialProducer.producer.id}]`
    )

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
            opusMaxAverageBitrate: 96000,
            opusPtime: 20
          },
          encodings: [{ maxBitrate: 96000 }],
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

// ─── Camera codec probing and fallback ───────────────────────────
const CAMERA_FULL_MAX_BITRATE = 2_500_000
const CAMERA_THUMBNAIL_MAX_BITRATE = 300_000

function isH264Codec(codec) {
  return /video\/h264/i.test(codec?.mimeType ?? '')
}

function cameraEncodingsFor(codec, { simulcast = true } = {}) {
  if (isH264Codec(codec)) {
    return simulcast
      ? [
          { scaleResolutionDownBy: 4, maxBitrate: CAMERA_THUMBNAIL_MAX_BITRATE },
          { scaleResolutionDownBy: 1, maxBitrate: CAMERA_FULL_MAX_BITRATE }
        ]
      : [{ maxBitrate: CAMERA_FULL_MAX_BITRATE }]
  }

  // VP9 is the normal camera path. AV1 only reaches this helper when it is the
  // last codec advertised by an older/incomplete router, but it can use the same
  // spatial + temporal mode when available.
  return [{ maxBitrate: CAMERA_FULL_MAX_BITRATE, scalabilityMode: VIDEO_SCALABILITY_MODE }]
}

function uniqueCameraCodecs(codecs) {
  const seen = new Set()
  return codecs.filter((codec) => {
    if (!codec) return false
    const mime = screenCodecMime(codec) || '__default__'
    if (seen.has(mime)) return false
    seen.add(mime)
    return true
  })
}

function cameraCodecCandidates(initialCodec) {
  const h264 = findVideoCodec('video/h264')
  const av1 = findVideoCodec('video/av1')
  return uniqueCameraCodecs(
    hasCameraCodecPreference() && h264 ? [h264, av1] : [initialCodec, h264, av1]
  )
}

function cameraProducerOptions(ctx, codec, encodings) {
  return {
    track: ctx.track,
    codec,
    encodings,
    // Camera fallback may retry on the same capture track. mediasoup otherwise
    // stops the supplied track when produce() rejects, preventing the retry.
    stopTracks: false,
    codecOptions: { videoGoogleStartBitrate: 1500 },
    appData: { produced: 'Camera' }
  }
}

// H.264 first tries the two-layer simulcast shape. A browser/handler that
// rejects that shape gets one full-resolution encoding on the same track.
async function produceCameraWithFallback(ctx, codec) {
  const encodingAttempts = isH264Codec(codec)
    ? [cameraEncodingsFor(codec), cameraEncodingsFor(codec, { simulcast: false })]
    : [cameraEncodingsFor(codec)]
  let lastError = null

  for (const encodings of encodingAttempts) {
    let producer
    try {
      producer = await produceForShare(ctx, cameraProducerOptions(ctx, codec, encodings))
      if (!isActiveShare(ctx) || ctx.track?.readyState === 'ended') {
        await discardUnadoptedShareProducer(producer)
        throw shareSupersededError()
      }
      return { producer, codec, encodings }
    } catch (error) {
      if (isShareSupersededError(error)) throw error
      if (producer) await discardUnadoptedShareProducer(producer)
      lastError = error
      console.warn(
        `[Soup] Camera ${codec?.mimeType ?? 'default'} ` +
          `${encodings.length} encoding attempt failed; trying the next shape:`,
        error
      )
    }
  }

  throw lastError ?? new Error(`No viable camera encoding for ${codec?.mimeType ?? 'default'}`)
}

function adoptCameraProducer(ctx, candidate) {
  const previous = ctx.producer
  ctx.statsStop?.()
  ctx.statsStop = null
  ctx.producer = candidate.producer
  ctx.cameraCodec = candidate.codec
  ctx.cameraEncodings = candidate.encodings
  localProducerIds.add(candidate.producer.id)

  if (previous && previous !== candidate.producer) {
    previous.close()
    localProducerIds.delete(previous.id)
    // Producing Camera atomically replaces its server-side predecessor; do not
    // send a second close for the old id and race the signaling FIFO.
    ctx.onProducerReplaced?.({
      previousProducerId: previous.id,
      producerId: candidate.producer.id,
      codec: codecLabel(candidate.producer.rtpParameters)
    })
  }

  const scalabilityMode =
    candidate.encodings.length === 1 ? candidate.encodings[0].scalabilityMode : undefined
  logNegotiatedVideoCodec(candidate.producer, scalabilityMode)
  ctx.statsStop = startEncoderStatsLog(candidate.producer, (stats) => {
    if (ctx.producer !== candidate.producer) return
    cameraStatsHandler(ctx, stats)
  })
}

async function downgradeCameraToH264(ctx) {
  if (!isActiveShare(ctx) || isH264Codec(ctx.cameraCodec)) return false
  const h264 = findVideoCodec('video/h264')
  if (!h264) return false

  const candidate = await produceCameraWithFallback(ctx, h264)
  if (!isActiveShare(ctx)) {
    await discardUnadoptedShareProducer(candidate.producer)
    throw shareSupersededError()
  }
  await setDegradationPreference(candidate.producer, 'maintain-framerate')
  // stopShareContext() can run while setParameters is pending. Do not adopt a
  // successor into an already-stopped context: it would no longer be owned by
  // the context and its server-side producer could outlive the share.
  if (!isActiveShare(ctx) || ctx.track?.readyState === 'ended') {
    await discardUnadoptedShareProducer(candidate.producer)
    throw shareSupersededError()
  }
  adoptCameraProducer(ctx, candidate)
  cacheCameraCodecPreference()
  console.log(`[Soup] Camera codec downgraded to H264 simulcast [id:${candidate.producer.id}]`)
  return true
}

function cameraStatsHandler(ctx, stats) {
  if (!isActiveShare(ctx)) return
  ctx.onEncoderStats?.(stats)
  if (
    ctx.cameraTransition ||
    ctx.cameraFallbackAttempted ||
    !ctx.producer ||
    !/^video\/vp9$/i.test(ctx.cameraCodec?.mimeType ?? '')
  )
    return

  // A measured libvpx/software VP9 result is the camera probe's negative
  // verdict. Unknown implementations are intentionally left alone, and the
  // verdict is only written after H.264 replacement succeeds.
  if (stats.hardware !== false) return
  ctx.cameraFallbackAttempted = true
  const transition = downgradeCameraToH264(ctx).catch((error) => {
    if (!isShareSupersededError(error)) {
      console.warn('[Soup] Camera H264 fallback failed; keeping VP9:', error)
    }
    return false
  })
  ctx.cameraTransition = transition
  void transition.finally(() => {
    if (ctx.cameraTransition === transition) ctx.cameraTransition = null
  })
}

// ─── Share webcam ────────────────────────────────────────────────
// Streams a camera device into the same producer slot as screen share, so the
// existing stop/preview/remote-render paths all apply. Camera capture is capped
// at an HD/30fps ideal to avoid opening a 4K-native webcam that the sender would
// immediately crush into its 2.5 Mbps ceiling.
export async function shareCamera(deviceId, onEncoderStats, onProducerReplaced = undefined) {
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
    stopped: false,
    onEncoderStats,
    onProducerReplaced,
    cameraCodec: null,
    cameraEncodings: null,
    cameraTransition: null,
    cameraFallbackAttempted: false
  }
  await claimShareContext(ctx)

  try {
    const videoConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : {})
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints,
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

    const cameraCodec = pickCameraCodec()
    const candidateCodecs = cameraCodecCandidates(cameraCodec)
    let initialCandidate = null
    let lastError = null
    for (const codec of candidateCodecs) {
      try {
        initialCandidate = await produceCameraWithFallback(ctx, codec)
        break
      } catch (error) {
        if (isShareSupersededError(error)) throw error
        lastError = error
        console.warn(`[Soup] Camera codec ${codec?.mimeType ?? 'default'} could not start:`, error)
      }
    }
    if (!initialCandidate)
      throw lastError ?? new Error('No supported camera video codec is available')

    await setDegradationPreference(initialCandidate.producer, 'maintain-framerate')
    if (!isActiveShare(ctx) || ctx.track !== track || track.readyState === 'ended') {
      await discardUnadoptedShareProducer(initialCandidate.producer)
      throw shareSupersededError()
    }
    adoptCameraProducer(ctx, initialCandidate)
    if (isH264Codec(initialCandidate.codec) && initialCandidate.encodings.length > 1) {
      console.log('[Soup] Camera sharing with H264 simulcast (thumbnail + full layers)')
    }

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

// ─── Rebuildable remote-audio Web Audio graph ────────────────────
// Given an audio entry (carries stream / clientId / producedType), build the
// playback graph: one source node off entry.stream on the shared playback
// context -> gain (per-client volume, may exceed 1) -> destination, plus a
// speaking detector that TAPS that same source node (see createSpeakingDetector)
// instead of making its own context/source. Gain starts at 0; callers must run
// applyAllAudioState() afterwards to set the real volume. Isolated from the
// <audio> element so the graph can be torn down and rebuilt (health self-heal)
// without dropping the WebRTC track pull.
function buildAudioGraph(entry) {
  const ctx = getPlaybackContext()
  const srcNode = ctx.createMediaStreamSource(entry.stream)
  const gainNode = ctx.createGain()
  gainNode.gain.value = 0 // start silent; applyAllAudioState() sets the real value
  srcNode.connect(gainNode)
  gainNode.connect(ctx.destination)

  // Screen/tab audio isn't the client's voice - don't feed it into the speaking
  // indicator; clientId == null means we can't attribute speaking to anyone.
  let stopDetector = null
  if (entry.clientId != null && entry.producedType !== 'ScreenShareAudio') {
    stopDetector = createSpeakingDetector(
      entry.stream,
      (isSpeaking) => {
        activeCallbacks.onClientSpeaking?.(entry.clientId, isSpeaking)
      },
      { audioContext: ctx, sourceNode: srcNode }
    )
  }

  entry.srcNode = srcNode
  entry.gain = gainNode
  entry.stopDetector = stopDetector
}

// Tear down only the rebuildable graph nodes (leaves the <audio> element alone).
// Stop the detector first so it detaches its own tap into the source before we
// fully disconnect the source node.
function teardownAudioGraph(entry) {
  entry.stopDetector?.()
  entry.stopDetector = null
  try {
    entry.srcNode?.disconnect()
  } catch {
    // The media source may already be disconnected during transport reset.
  }
  try {
    entry.gain?.disconnect()
  } catch {
    // The gain node may already be disconnected during transport reset.
  }
  entry.srcNode = null
  entry.gain = null
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

  const dJbDelay = cur.jitterBufferDelay - prev.jitterBufferDelay
  const dJbEmitted = cur.jitterBufferEmittedCount - prev.jitterBufferEmittedCount
  const dPackets = cur.packetsReceived - prev.packetsReceived
  const havePlayout =
    cur.totalPlayoutDelay != null &&
    prev.totalPlayoutDelay != null &&
    cur.totalSamplesCount != null &&
    prev.totalSamplesCount != null
  const dPlayoutDelay = havePlayout ? cur.totalPlayoutDelay - prev.totalPlayoutDelay : null
  const dPlayoutSamples = havePlayout ? cur.totalSamplesCount - prev.totalSamplesCount : null

  const jbDelaySec = dJbEmitted > 0 ? dJbDelay / dJbEmitted : null
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
    remoteConsumers.delete(producerId)
    entry.cleanup()
    remoteCleanups = remoteCleanups.filter((fn) => fn !== entry.cleanup)
    entry.consumer.close()
    // Fire-and-forget: the server may not implement CloseConsumer yet and may not
    // reply, so this MUST go through notify(), never send() (see notify comment).
    notify('CloseConsumer', { ids: [entry.consumerId] })
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
  if (kind === 'audio') {
    await send('ResumeConsumer', { id: consumer.id })
    console.log(`[Soup] Consumer resumed [id:${consumer.id}]`)
  } else {
    await send('PauseConsumer', { id: consumer.id })
    console.log(`[Soup] Video consumer created paused [id:${consumer.id}]`)
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
    audioEl.srcObject = stream
    audioEl.autoplay = true
    audioEl.muted = true
    document.body.appendChild(audioEl)
    audioEl.play().catch((err) => console.error('[Soup] Audio pump play failed:', err))
    remoteAudioElements.push(audioEl)
    entry.audioEl = audioEl

    // Rebuildable part: source -> gain -> destination (+ speaking detector).
    buildAudioGraph(entry)

    entry.cleanup = () => {
      teardownAudioGraph(entry)
      audioEl.pause()
      audioEl.srcObject = null
      audioEl.remove()
      remoteAudioElements = remoteAudioElements.filter((el) => el !== audioEl)
    }
    remoteCleanups.push(entry.cleanup)
  } else if (kind === 'video') {
    // If this client already had a video producer (e.g. restarted screen
    // share before a ProducerClosed notice arrived), close out the stale
    // consumer/tile before adding the new one.
    for (const [pid, existing] of remoteConsumers) {
      if (existing.kind === 'video' && existing.clientId === clientId && pid !== producerId) {
        existing.consumer.close()
        remoteConsumers.delete(pid)
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

  if (entry.preferredLayersRequest) return
  if (entry.preferredSpatial === spatialLayer && entry.preferredTemporal === temporalLayer) return

  entry.preferredLayersRequest = layers
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
      entry.preferredLayersRequest = null
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
export function resetMediaState() {
  mediaStateGeneration++
  selfSpeakingStop?.()
  selfSpeakingStop = null
  mutedTalkStop?.()
  mutedTalkStop = null
  const activeShare = screenShareCtx
  if (activeShare) void stopShareContext(activeShare, { notifyServer: false })
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
  encoderStatsStop?.()
  producers = []
  localProducerIds.clear()
  knownVideoProducers.clear()
  // Audience is per-channel and replayed by NewConsumer on the next join, so a
  // channel switch must start from empty rather than showing the old room's.
  clearViewers()
  device = null
  stopAudioProcessor()
  // Release the raw mic capture — the producers above are closed, so no live
  // producer references it anymore (nothing to keep the OS mic open for).
  stopRawStream(rawMicStream)
  setRawMicStream(null)
  lastCommittedMicSettings = null
  // Idle the shared mic context between sessions; getMicContext() resumes it.
  if (micContext?.state === 'running') micContext.suspend().catch(() => {})
  subscribePromise = null
  // Stop the audio health poll and drop all its per-producer state. Per-entry
  // health rides on the entries themselves, cleared by remoteConsumers.clear().
  stopAudioHealthMonitor()
  audioHealHistory.clear()
  audioHealsInFlight.clear()
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
//
// Pinned to 48 kHz (like getMicContext): WebRTC/Opus emits 48 kHz, but an
// unpinned context follows the output device's rate. On a non-48 kHz device that
// forces every remote stream through Chromium's drift-prone track→WebAudio
// resampling FIFO, which is implicated in the accumulating playout delay/crackle.
function getPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    })
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
  ensureOverridesForCurrentHost()
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

// Read the full persisted { [host]: { [clientId]: { volume, muted } } } blob.
function readPersistedAudioOverrides() {
  try {
    return JSON.parse(localStorage.getItem(CLIENT_AUDIO_OVERRIDES_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

// Write the current host's in-memory overrides back to localStorage, pruning
// no-op entries (100% volume, unmuted) so resetting a client truly forgets it
// rather than leaving dead entries behind.
function persistCurrentHostOverrides() {
  const host = getServerHost()
  if (!host) return
  const all = readPersistedAudioOverrides()
  const slice = {}
  for (const [clientId, state] of clientAudioOverrides) {
    if (state.volume !== 1 || state.muted) slice[clientId] = state
  }
  if (Object.keys(slice).length) all[host] = slice
  else delete all[host]
  try {
    localStorage.setItem(CLIENT_AUDIO_OVERRIDES_KEY, JSON.stringify(all))
  } catch {
    // localStorage is unavailable only in unusual renderer contexts; overrides
    // still work for this session, they just won't survive a restart.
  }
}

// Reload clientAudioOverrides from storage whenever the connected host changes,
// so the Map always reflects the current server's saved volumes and never leaks
// one server's overrides onto another (user ids are only unique per server).
function ensureOverridesForCurrentHost() {
  const host = getServerHost()
  if (host === clientAudioOverridesHost) return
  clientAudioOverridesHost = host
  clientAudioOverrides = new Map()
  if (!host) return
  const slice = readPersistedAudioOverrides()[host] || {}
  for (const [clientId, state] of Object.entries(slice)) {
    clientAudioOverrides.set(clientId, {
      volume: typeof state.volume === 'number' ? state.volume : 1,
      muted: !!state.muted
    })
  }
}

// Called by the sidebar's per-client right-click controls to locally
// lower the volume of, or fully mute, a specific client's mic audio. The new
// value is persisted per server so it survives app restarts.
export function setClientAudioState(clientId, { volume, muted } = {}) {
  ensureOverridesForCurrentHost()
  const current = clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
  clientAudioOverrides.set(clientId, {
    volume: volume != null ? volume : current.volume,
    muted: muted != null ? muted : current.muted
  })
  persistCurrentHostOverrides()
  applyAllAudioState()
}

export function getClientAudioState(clientId) {
  ensureOverridesForCurrentHost()
  return clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
}

// ─── Getters ─────────────────────────────────────────────────────
export function isConnected() {
  return ws?.readyState === WebSocket.OPEN
}

// ─── Live per-stream debug stats (send + recv) ───────────────────
// Powers a UI diagnostics panel. Each tick enumerates our live producers (mic,
// screen/camera video, screen audio) and every remote consumer, pulls ONE
// getStats() per stream, and reports a flat per-class metrics object. This is a
// strictly READ-ONLY observer: it never mutates producers / screenShareCtx /
// remoteConsumers and keeps its OWN delta state in the returned closure. That is
// why double-polling a sender the encoder-stats logger also polls is safe — the
// previous-sample maps are separate, so the two pollers never corrupt each
// other's deltas.

// Windowed rate in kbps from a cumulative byte counter. Null on the first sample
// (no previous) or when the counters went backwards / are non-finite (a counter
// reset or teardown race), matching the delta guards used elsewhere in the file.
function streamDebugKbps(curBytes, curTs, prev) {
  if (!prev) return null
  if (![curBytes, curTs, prev.bytes, prev.timestamp].every(Number.isFinite)) return null
  const dt = curTs - prev.timestamp
  if (dt <= 0 || curBytes < prev.bytes) return null
  return (8 * (curBytes - prev.bytes)) / dt
}

// Windowed jitter-buffer delay in ms: Δ accumulated delay / Δ emitted count — the
// same average-per-emitted-sample math evaluateAudioHealth() uses. Null on the
// first sample or when the emitted count didn't advance this window (no fresh
// playout), so a stalled buffer reads as null rather than a stale huge number.
function streamDebugJitterBufferMs(curDelay, curEmitted, prev) {
  if (!prev) return null
  if (
    ![curDelay, curEmitted, prev.jitterBufferDelay, prev.jitterBufferEmittedCount].every(
      Number.isFinite
    )
  )
    return null
  const dEmitted = curEmitted - prev.jitterBufferEmittedCount
  if (dEmitted <= 0) return null
  return ((curDelay - prev.jitterBufferDelay) / dEmitted) * 1000
}

// send/audio: the local outbound-rtp carries our send rate; the paired
// remote-inbound-rtp carries what the far side observed (RTT / jitter / loss).
// Returns { metrics, snapshot } — snapshot is the cumulative baseline for the
// next tick's rate delta (preserved when no outbound report exists this tick).
function extractSendAudioMetrics(report, prev) {
  let outbound = null
  let remoteInbound = null
  for (const s of report.values()) {
    if (s.type === 'outbound-rtp' && s.kind === 'audio') outbound = s
    else if (s.type === 'remote-inbound-rtp' && s.kind === 'audio') remoteInbound = s
  }
  const metrics = {
    sendKbps: outbound ? streamDebugKbps(outbound.bytesSent, outbound.timestamp, prev) : null,
    packetsSent: outbound?.packetsSent ?? null,
    targetBitrate: outbound?.targetBitrate ?? null,
    rttMs: remoteInbound?.roundTripTime != null ? remoteInbound.roundTripTime * 1000 : null,
    jitterMs: remoteInbound?.jitter != null ? remoteInbound.jitter * 1000 : null,
    packetsLost: remoteInbound?.packetsLost ?? null,
    fractionLost: remoteInbound?.fractionLost ?? null
  }
  const snapshot = outbound
    ? { bytes: outbound.bytesSent, timestamp: outbound.timestamp }
    : (prev ?? null)
  return { metrics, snapshot }
}

// recv/video: one inbound-rtp video report. Rate and jitter-buffer fields are
// windowed against prev; the rest are the live cumulative/instantaneous values.
function extractRecvVideoMetrics(report, prev) {
  let inbound = null
  for (const s of report.values()) {
    if (s.type === 'inbound-rtp' && s.kind === 'video') {
      inbound = s
      break
    }
  }
  // Keep the row visible (stable chart identity) even before the first report.
  if (!inbound) return { metrics: {}, snapshot: prev ?? null }
  const metrics = {
    recvKbps: streamDebugKbps(inbound.bytesReceived, inbound.timestamp, prev),
    fps: inbound.framesPerSecond ?? null,
    width: inbound.frameWidth ?? null,
    height: inbound.frameHeight ?? null,
    framesDecoded: inbound.framesDecoded ?? null,
    framesDropped: inbound.framesDropped ?? null,
    freezeCount: inbound.freezeCount ?? null,
    totalFreezesDuration: inbound.totalFreezesDuration ?? null,
    keyFramesDecoded: inbound.keyFramesDecoded ?? null,
    pliCount: inbound.pliCount ?? null,
    nackCount: inbound.nackCount ?? null,
    packetsLost: inbound.packetsLost ?? null,
    jitterMs: inbound.jitter != null ? inbound.jitter * 1000 : null,
    jitterBufferMs: streamDebugJitterBufferMs(
      inbound.jitterBufferDelay,
      inbound.jitterBufferEmittedCount,
      prev
    ),
    decoderImplementation: inbound.decoderImplementation ?? null
  }
  const snapshot = {
    bytes: inbound.bytesReceived,
    timestamp: inbound.timestamp,
    jitterBufferDelay: inbound.jitterBufferDelay,
    jitterBufferEmittedCount: inbound.jitterBufferEmittedCount
  }
  return { metrics, snapshot }
}

// recv/audio: one inbound-rtp audio report. concealedSamplesDelta is the fresh
// concealment (PLC) this window; the buffer field is windowed like the video one.
function extractRecvAudioMetrics(report, prev) {
  let inbound = null
  for (const s of report.values()) {
    if (s.type === 'inbound-rtp' && s.kind === 'audio') {
      inbound = s
      break
    }
  }
  if (!inbound) return { metrics: {}, snapshot: prev ?? null }
  const concealedSamplesDelta =
    prev &&
    Number.isFinite(inbound.concealedSamples) &&
    Number.isFinite(prev.concealedSamples) &&
    inbound.concealedSamples >= prev.concealedSamples
      ? inbound.concealedSamples - prev.concealedSamples
      : null
  const metrics = {
    recvKbps: streamDebugKbps(inbound.bytesReceived, inbound.timestamp, prev),
    packetsReceived: inbound.packetsReceived ?? null,
    packetsLost: inbound.packetsLost ?? null,
    jitterMs: inbound.jitter != null ? inbound.jitter * 1000 : null,
    jitterBufferMs: streamDebugJitterBufferMs(
      inbound.jitterBufferDelay,
      inbound.jitterBufferEmittedCount,
      prev
    ),
    concealedSamplesDelta,
    concealmentEvents: inbound.concealmentEvents ?? null,
    audioLevel: inbound.audioLevel ?? null
  }
  const snapshot = {
    bytes: inbound.bytesReceived,
    timestamp: inbound.timestamp,
    jitterBufferDelay: inbound.jitterBufferDelay,
    jitterBufferEmittedCount: inbound.jitterBufferEmittedCount,
    concealedSamples: inbound.concealedSamples
  }
  return { metrics, snapshot }
}

// Start a periodic per-stream stats poll for a diagnostics UI. onSample is called
// once per tick with { ts, streams:[...] } (see the stream shape below). Returns a
// stop() that clears the interval and drops this call's delta state. Each call
// owns its closure state, so independent calls never corrupt one another.
export function startStreamDebugStats(onSample, intervalMs = 1000) {
  // send/video only: key -> the per-producer previousByOutboundId map that
  // computeOutboundVideoSample() mutates. Never shared across streams or with the
  // encoder-stats poller — each key gets its own map so simulcast SSRC deltas stay
  // isolated.
  const outboundPrevByKey = new Map()
  // The other three classes: key -> previous cumulative snapshot for delta math.
  const prevByKey = new Map()
  // Guard against stacking ticks: if a slow getStats fan-out is still resolving we
  // drop this wakeup entirely rather than doubling the effective poll rate.
  let inFlight = false

  const tick = async () => {
    if (inFlight) return
    inFlight = true
    try {
      // Keys observed this tick, to prune delta state for streams that departed.
      const seenKeys = new Set()
      const jobs = []

      // Module state is read LIVE here: producers is reassigned on reset and
      // screenShareCtx / remoteConsumers churn constantly, so a captured reference
      // would go stale. Referencing the module bindings each tick always sees the
      // current media state (a mid-tick resetMediaState just yields fewer streams).
      const pushSend = (producer, kind, producedType) => {
        const sender = producer.rtpSender
        // Mirror startEncoderStatsLog's guard: no sender/getStats → omit the stream.
        if (!sender?.getStats) return
        const key = `send:${producer.id}`
        seenKeys.add(key)
        const base = {
          key,
          direction: 'send',
          kind,
          producedType,
          producerId: producer.id,
          codec: codecLabel(producer.rtpParameters)
        }
        jobs.push(
          (async () => {
            try {
              const report = await sender.getStats()
              if (kind === 'video') {
                // One previousByOutboundId map per stream key (created on first use);
                // computeOutboundVideoSample owns/mutates it.
                let perStreamMap = outboundPrevByKey.get(key)
                if (!perStreamMap) {
                  perStreamMap = new Map()
                  outboundPrevByKey.set(key, perStreamMap)
                }
                // Returns null until an active outbound-rtp video report exists; emit
                // an empty metrics object so the row still renders during the gap.
                const metrics = computeOutboundVideoSample(report, perStreamMap) ?? {}
                return { ...base, metrics }
              }
              const { metrics, snapshot } = extractSendAudioMetrics(report, prevByKey.get(key))
              if (snapshot) prevByKey.set(key, snapshot)
              return { ...base, metrics }
            } catch {
              // A teardown-race getStats reject skips only THIS stream, not the tick.
              return null
            }
          })()
        )
      }

      const pushRecv = (producerId, entry) => {
        const consumer = entry.consumer
        const key = `recv:${entry.consumerId}`
        seenKeys.add(key)
        const base = {
          key,
          direction: 'recv',
          kind: entry.kind,
          producedType: entry.producedType,
          producerId,
          consumerId: entry.consumerId,
          clientId: entry.clientId,
          codec: codecLabel(consumer.rtpParameters)
        }
        // Only video entries carry server-pause / view-role bookkeeping.
        if (entry.kind === 'video') {
          base.paused = entry.serverPaused
          base.viewRole = entry.viewRole
        }
        jobs.push(
          (async () => {
            try {
              const report = await consumer.getStats()
              const { metrics, snapshot } =
                entry.kind === 'video'
                  ? extractRecvVideoMetrics(report, prevByKey.get(key))
                  : extractRecvAudioMetrics(report, prevByKey.get(key))
              if (snapshot) prevByKey.set(key, snapshot)
              return { ...base, metrics }
            } catch {
              return null
            }
          })()
        )
      }

      // Mic: possibly more than one during a republish overlap.
      for (const p of producers) {
        if (p.kind !== 'audio' || p.closed) continue
        pushSend(p, 'audio', p.appData?.produced ?? 'Audio')
      }
      // Screen/camera share: at most one video producer and one screen-audio one.
      const ctx = screenShareCtx
      if (ctx && !ctx.stopped) {
        if (ctx.producer && !ctx.producer.closed) {
          pushSend(
            ctx.producer,
            'video',
            ctx.producer.appData?.produced ?? (ctx.type === 'camera' ? 'Camera' : 'ScreenShare')
          )
        }
        if (ctx.audioProducer && !ctx.audioProducer.closed) {
          pushSend(ctx.audioProducer, 'audio', 'ScreenShareAudio')
        }
      }
      // Consumed remote streams.
      for (const [producerId, entry] of remoteConsumers) {
        if (entry.consumer?.closed) continue
        pushRecv(producerId, entry)
      }

      const streams = (await Promise.all(jobs)).filter((s) => s != null)

      // Prune delta state for keys not present this tick so a reused id (returning
      // after a gap) can't diff against an ancient sample.
      for (const map of [outboundPrevByKey, prevByKey]) {
        for (const key of map.keys()) {
          if (!seenKeys.has(key)) map.delete(key)
        }
      }

      onSample?.({ ts: Date.now(), streams })
    } catch {
      // Enumeration itself shouldn't throw (per-stream work is already guarded),
      // but never let a stray error wedge inFlight permanently.
    } finally {
      inFlight = false
    }
  }

  const timer = setInterval(tick, intervalMs)
  return function stop() {
    clearInterval(timer)
    outboundPrevByKey.clear()
    prevByKey.clear()
  }
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
