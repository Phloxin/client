// pylon-voice signaling protocol, v1, plus the event-socket stream ops that
// authorize screen streams on it.
//
// Everything that knows the wire format lives here: request encoders, the
// matcher that pairs answers and errors with requests, channel-state
// bookkeeping for the server's snapshot/delta events, close-code
// classification, and the stream requests and stream directory of the
// backend's event socket. No mediasoup, DOM or UI imports, so it runs under
// `node --test` (see protocol.test.mjs) and the soup layer stays a pure
// mediasoup-client driver.
//
// Contract: .plans/HANDOFF-voice-protocol-v1.md. Server source of truth:
// server/backend crates/pylon-voice/src/signal/proto/v1.rs (voice socket),
// crates/pylon-sfu/src/session.rs and session/{message,pending,id_space}.rs
// (what answers what), crates/pylon-sfu/src/node/ids.rs (ids), and
// src/events/socket.rs, src/events/socket/{ops,stream}.rs (stream ops).
//
// Wire conventions worth remembering:
//   - Messages are serde externally tagged enums: { "CreateSink": { ... } }, or
//     a bare string for a variant with no fields ({ "Group": "Rejoin" }).
//   - Every server frame is an envelope, { "seq": n, "ev": <message> }. seq
//     numbers the session's events from 1 and carries on across a resume; only
//     the handshake frames Session and Resumed have none (decodeFrame).
//   - Our own sources and sinks are LocalIds: JSON numbers (u32) this client
//     picks. CreateSource, CreateSink and Sync each name a new one, and every
//     new id must be above every id this socket used before, so one counter
//     per socket serves all three (the matcher's). An id is never reused, not
//     even after its create failed.
//   - Another client's source is a NodeId: the JSON string "<session>:<local>",
//     <session> being the owner's voice session. Only ever echo one the server
//     sent (CreateSink.source); a reconnect gives the owner's sources new ones.
//   - A wrong JSON type for either is a frame the server can't parse: it closes
//     the socket (4001 InvalidPayload). The encoders below refuse one instead.
//   - mediasoup-client wants string ids, so the soup layer hands it
//     String(localId) for our producers and consumers and the NodeId string
//     as-is for a remote producer. Only a NodeId has a colon, so the two never
//     collide in one map.
//   - Snowflakes (channel ids, client ids) are JSON strings.
//   - A stream key is an opaque string. Only ever echo one the server sent.
//   - A source's `kind` (ChannelSource, the Source reply) is adjacently tagged:
//     { type: SourceType, attr?: { codec?, stream_key? } }. `attr` is absent for
//     a Microphone. CreateSource still sends a bare SourceType plus stream_key.

// ─── Requests (client → server) ──────────────────────────────────

// `node`, `newNode` and `callback` are LocalIds (ours); `source` is a NodeId
// (another client's). Which answer, if any, each request gets is in the
// matcher's section below.
export const Request = Object.freeze({
  // First frame only, exactly once. The server answers with Session (the id
  // and resume token), then pushes RoutingParams (seq 1); a refused ticket
  // closes the socket with 4003 TicketRejected.
  identify: (ticket) => ({ Identify: { ticket } }),
  // First frame instead of Identify, to take over a session whose socket
  // dropped. `lastSeq` is the highest seq received on the session (0 if none).
  // Answered with Resumed { resume_token } (the token rotates on every resume),
  // and then the same event stream simply continues from lastSeq + 1, with the
  // original seq numbers: there is no snapshot to reconcile. A refusal (unknown
  // session, wrong or rotated token, grace over, no longer in voice) or a
  // lastSeq the server no longer has closes the socket with 4003
  // TicketRejected. `session` is the Session id as the server sent it (a
  // snowflake string).
  resume: (session, resumeToken, lastSeq = 0) => ({
    Resume: {
      session: String(session),
      resume_token: resumeToken,
      last_seq: seqNumber('last_seq', lastSeq)
    }
  }),
  // Answered with Done { callback } once every request sent before it has been
  // handled, and its answer or Error has arrived.
  sync: (callback) => ({ Sync: { callback: localId('callback', callback) } }),
  // Once per socket. No answer on success: the first Channel snapshot follows
  // it and means the session is ready. `e2eeFormats` lists the E2EE frame
  // formats this build speaks; a node pinning another refuses with
  // UpdateRequired.
  setCapabilities: (capabilities, e2eeFormats = []) => ({
    SetCapabilities: { capabilities, e2ee_formats: e2eeFormats }
  }),
  // Any time, before SetCapabilities too, once per transport.
  connectTransport: (direction, dtlsParameters) => ({
    ConnectTransport: { transport_parameters: { dtlsParameters }, direction }
  }),
  // New local ICE parameters for one transport, after a network change.
  // Answered with IceRestarted { direction, ice_parameters }, which go to
  // mediasoup-client's transport.restartIce(). Allowed before the session is
  // ready too.
  restartIce: (direction) => ({ RestartIce: { direction } }),
  // Names the new source `newNode`. Refused before SetCapabilities. `replaces`
  // names one of our own sources of the same kind to swap out atomically: peers
  // get SourceReplaced rather than a remove and an add, and the server closes
  // the old source, announcing it with a Closed ahead of this request's Source
  // answer.
  //
  // `streamKey` names the stream (event-socket op 11) a Stream or StreamAudio
  // source belongs to, and must be null for Microphone and Webcam. A
  // replacement inherits its predecessor's stream, so it may pass null; a
  // different key is refused.
  createSource: (newNode, kind, rtpParameters, replaces = null, streamKey = null) => ({
    CreateSource: {
      new_node: localId('new_node', newNode),
      kind,
      rtp_parameters: rtpParameters,
      replaces: replaces == null ? null : localId('replaces', replaces),
      stream_key: streamKey
    }
  }),
  // Names the new sink `newNode`, on another client's source. Refused before
  // SetCapabilities. The sink starts paused unless `config` says otherwise
  // (sinkConfigFields). Its Sink answer doesn't name the source again, so the
  // caller keeps track of which source each sink is for.
  createSink: (newNode, source, config) => ({
    CreateSink: {
      new_node: localId('new_node', newNode),
      source: nodeId('source', source),
      ...sinkConfigFields(config)
    }
  }),
  // Pause/resume, preferred layers or priority of one of our sinks.
  configureSink: (node, config) => ({
    ConfigureSink: { node: localId('node', node), ...sinkConfigFields(config) }
  }),
  // The owner's pause of one of our own Webcam, Stream or StreamAudio sources.
  // A Microphone is refused (NotSupported): mute is voice state, op 1.
  setSourcePaused: (node, paused) => ({
    SetSourcePaused: { node: localId('node', node), paused: paused === true }
  }),
  // One of our sources or sinks. Answered Closed { nodes: [node] } only while
  // the node is alive; one the server already closed has had its own Closed.
  close: (node) => ({ Close: { node: localId('node', node) } }),
  // A request for the channel's MLS delivery service (E2EE): { KeyPackage }, { GroupCreated },
  // { Commit } or { Ready }, with bytes as base64. No answer on success; what the delivery
  // service does with it arrives later as Group events. A KeyPackage the session refuses gets
  // Error { "Session", InvalidArgument }.
  group: (request) => ({ Group: request }),
  // Asks one of our sinks' source for a keyframe, once its frames decrypt again.
  requestKeyFrame: (node) => ({ RequestKeyFrame: { node: localId('node', node) } }),
  // SpeakingFlags we are speaking with. Sent on change, no answer.
  setSpeaking: (flags) => ({ SetSpeaking: { flags: flagBits('flags', flags) } })
})

// The server can't parse a LocalId that isn't a u32 or a NodeId that isn't a
// string, and closes the socket for it (4004). Refuse one here, where the
// caller is, rather than lose the session to it.
function seqNumber(name, value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a seq (an integer from 0), got ${value}`)
  }
  return value
}

function localId(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`${name} must be a LocalId (a u32 this client picked), got ${value}`)
  }
  return value
}

function flagBits(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new TypeError(`${name} must be flags (a u32), got ${value}`)
  }
  return value
}

function nodeId(name, value) {
  if (typeof value !== 'string') {
    throw new TypeError(`${name} must be a NodeId string, as the server sent it, got ${value}`)
  }
  return value
}

// SinkConfig, which CreateSink and ConfigureSink carry flattened into the
// message. Every field is optional, and a missing one leaves the server's value
// alone:
//   layers:   { spatial, temporal? }, the preferred simulcast/SVC layers (video only)
//   priority: 1–255, the sink's share of a short downlink (mediasoup priority)
//   paused:   our own pause. A sink flows only when this and our voice state allow it.
export function sinkConfigFields({ layers, priority, paused } = {}) {
  const fields = {}
  if (layers != null) {
    fields.layers = {
      spatial: checkedByte('layers.spatial', layers.spatial, 0),
      temporal: layers.temporal == null ? null : checkedByte('layers.temporal', layers.temporal, 0)
    }
  }
  if (priority != null) fields.priority = checkedByte('priority', priority, 1)
  if (paused != null) fields.paused = paused === true
  return fields
}

// The server reads these as u8 and refuses priority 0. Catch a bad value here,
// where the caller is, rather than as an InvalidArgument a round trip later.
function checkedByte(name, value, min) {
  if (!Number.isInteger(value) || value < min || value > 255) {
    throw new RangeError(`Sink ${name} must be an integer from ${min} to 255, got ${value}`)
  }
  return value
}

// Events: everything the caller applies. Channel and Closed can also settle a
// request in the matcher (see there), and are applied either way.
export const EVENT_TYPES = new Set([
  'Channel',
  'ClientsJoined',
  'ClientsLeft',
  'SourcesAdded',
  'SourcesRemoved',
  'SourceReplaced',
  // Another member's source changed. Today only its owner's pause.
  'SourceUpdated',
  'Codecs',
  'Speakers',
  // The layers one of our video sinks is forwarding now (null: none).
  'SinkLayers',
  // The channel's MLS delivery service, for this session (lib/e2ee).
  'Group',
  // Our own sources and sinks that closed, for any reason: our Close (its
  // answer), a channel move, a revoked lease, the source leaving the channel, a
  // resync, or a source's producer dying on the server.
  'Closed'
])

export const Direction = Object.freeze({ Send: 'Send', Receive: 'Receive' })

export const SourceType = Object.freeze({
  Microphone: 'Microphone',
  Webcam: 'Webcam',
  Stream: 'Stream',
  StreamAudio: 'StreamAudio'
})

export const SpeakingFlags = Object.freeze({ MICROPHONE: 1 })

// The server's video codec ladder (VideoCodec), best first, with each codec's
// mime type. Channel/Codecs list a channel's allowed codecs in this order.
const VIDEO_CODEC_MIME = Object.freeze({
  Av1: 'video/av1',
  Vp9: 'video/vp9',
  H264: 'video/h264',
  Vp8: 'video/vp8'
})

// mediasoup mime type ("video/AV1") → VideoCodec, or null for one off the ladder.
export function videoCodecForMime(mimeType) {
  const mime = typeof mimeType === 'string' ? mimeType.toLowerCase() : ''
  return Object.keys(VIDEO_CODEC_MIME).find((codec) => VIDEO_CODEC_MIME[codec] === mime) ?? null
}

// VideoCodec → lowercase mime type, or null.
export function videoCodecMime(codec) {
  return VIDEO_CODEC_MIME[codec] ?? null
}

// The externally tagged variant name of an encoded message.
export function messageType(message) {
  if (typeof message === 'string') return message
  if (message != null && typeof message === 'object') {
    const keys = Object.keys(message)
    if (keys.length === 1) return keys[0]
  }
  return null
}

// Parse one text frame into { type, data }. A unit variant (a bare string; no
// top-level message is one today) has data null. Throws on anything that isn't
// a single externally tagged variant, so a malformed frame is never mistaken
// for an answer.
export function decodeMessage(text) {
  return decodeEvent(JSON.parse(text))
}

function decodeEvent(message) {
  const type = messageType(message)
  if (type == null) throw new Error('Voice frame is not an externally tagged message')
  return { type, data: typeof message === 'string' ? null : message[type] }
}

// ─── Frames and the event stream ─────────────────────────────────
// Every server frame is { "seq": n, "ev": <message> }. The session numbers
// every event it emits from 1 (RoutingParams is 1) and keeps the last few in a
// window, so a resume replays what the client missed with the same numbers.
// The two handshake frames the node sends itself, Session (after Identify) and
// Resumed (after Resume), carry no seq.
const HANDSHAKE_TYPES = new Set(['Session', 'Resumed'])

// Parse one server frame into { seq, type, data }, seq null for a handshake
// frame. Throws on a frame without `ev`, a handshake frame with a seq, and any
// other frame without a valid one: none of them can be placed in the stream.
export function decodeFrame(text) {
  const frame = JSON.parse(text)
  if (frame == null || typeof frame !== 'object' || !Object.hasOwn(frame, 'ev')) {
    throw new Error('Voice frame is not a { seq, ev } envelope')
  }
  const { type, data } = decodeEvent(frame.ev)
  const seq = frame.seq ?? null
  if (HANDSHAKE_TYPES.has(type)) {
    if (seq != null) throw new Error(`${type} frame carries a seq`)
  } else if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new Error(`${type} frame has no valid seq (${frame.seq})`)
  }
  return { seq, type, data }
}

// Where a session is in its event stream: `lastSeq`, the highest seq applied,
// is what a Resume sends. A frame at or below it is a duplicate and is skipped:
// the node filters the events it held before a resume against the replay
// already, this is defence in depth. One per session, kept across a resume; a
// new session starts again at 0.
export function createEventCursor(lastSeq = 0) {
  seqNumber('lastSeq', lastSeq)
  return {
    get lastSeq() {
      return lastSeq
    },
    // True for a frame not seen yet, which moves the cursor to it; false for
    // a duplicate.
    accept(seq) {
      seqNumber('seq', seq)
      if (seq <= lastSeq) return false
      lastSeq = seq
      return true
    }
  }
}

// ─── Errors ──────────────────────────────────────────────────────

export const ErrorCode = Object.freeze({
  InvalidState: 'InvalidState',
  NotFound: 'NotFound',
  InvalidArgument: 'InvalidArgument',
  NotSupported: 'NotSupported',
  // A stream source or sink without the lease for it (see the stream section).
  Denied: 'Denied',
  Internal: 'Internal',
  // SetCapabilities: this build can't speak the node's E2EE frame format.
  UpdateRequired: 'UpdateRequired'
})

// A request the server answered with Error. Not fatal: the socket stays open.
//   object: "Session" | { Transport: "Send" | "Receive" } | { Source: n } | { Sink: n },
//           n being one of our LocalIds. A failed create names its new node.
//   code:   one of ErrorCode
export class VoiceRequestError extends Error {
  constructor(request, payload = {}) {
    const code = payload.code ?? 'Internal'
    const detail = payload.message || code
    super(
      `${request ?? 'Voice request'} failed: ${describeSfuObject(payload.object)} ${code} (${detail})`
    )
    this.name = 'VoiceRequestError'
    this.request = request
    this.object = payload.object ?? null
    this.code = code
    this.serverMessage = payload.message ?? ''
  }

  // The source this request needed is gone, or never was in the channel: a
  // NotFound on the source or sink it was about (a CreateSink names its new
  // sink). Expected for a CreateSink racing SourcesRemoved, so callers ignore it.
  get sourceGone() {
    return (
      this.code === ErrorCode.NotFound && (this.object?.Sink != null || this.object?.Source != null)
    )
  }

  // Refused for want of a stream lease: a stream source without (or past) its
  // publish lease, or a sink on one without a watch.
  get denied() {
    return this.code === ErrorCode.Denied
  }

  // This client is too old (or too new) for the node's E2EE. No rejoin fixes it.
  get updateRequired() {
    return this.code === ErrorCode.UpdateRequired
  }
}

function describeSfuObject(object) {
  if (object == null) return 'unknown'
  if (typeof object === 'string') return object
  const type = messageType(object)
  return type ? `${type}(${object[type]})` : 'unknown'
}

// The server sent an answer no request is waiting for. That means client and
// server disagree about the stream, so the session is unusable.
export class VoiceProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VoiceProtocolError'
  }
}

// ─── Answers and errors ──────────────────────────────────────────
// v1 has no request ids, and no rule that every request gets one reply. The
// session handles requests strictly in order. A request that fails is answered
// with Error, which names the object it is about. One that succeeds is
// answered only when it has something to report:
//
//   Identify                        RoutingParams, pushed once identify succeeds
//                                   (after Session; failure closes with 4003)
//   SetCapabilities                 the first Channel snapshot: the session is ready
//   Sync { callback }               Done { callback }
//   ConnectTransport { direction }  TransportConnected { direction }
//   RestartIce { direction }        IceRestarted { direction, ice_parameters }
//   CreateSource { new_node }       Source { node: new_node }
//   CreateSink { new_node }         Sink { node: new_node }
//   Close { node }                  Closed { nodes: [node] }, if the node was still alive
//
// ConfigureSink, SetSourcePaused, RequestKeyFrame, SetSpeaking and Group have
// no success answer. A request on one of our ids that is no longer alive
// (closed, or its create failed) gets nothing at all, not even an Error.
//
// So the matcher pairs by what an answer or Error is about, not by position:
//   request(message)        waits for the answer above, found by its key (the
//                           callback, the direction, the new node), or for an
//                           Error naming the request's object
//   create(build)           request() for a CreateSource or CreateSink, around a
//                           new node it names itself
//   requestSynced(message)  a request without a success answer, with a Sync right
//                           behind it: Done means it went through, and an Error
//                           naming its object before that Done means it didn't
//   notify(message)         sends one and forgets it
//
// Close goes out with notify and is never awaited: a source or sink can close
// on the server before our Close is handled, and that Close then gets no
// answer. Every Closed is applied as an event instead, and one for a node
// already gone locally is a no-op. An Error no request claims (a notified
// request failing) is handed back to the caller to log.
//
// A session outlives its socket (resume). detach() parks the requests still
// waiting while the socket is gone. After Resumed, the replayed stream answers
// every one the server got, like any answer; resume() sends a Sync behind the
// replay, and whatever is still waiting when its Done arrives was lost with the
// socket and goes out again. See resume() below.
//
//   transmit(frame)        writes one already-serialized frame; may throw
//   onTimeout(type)        the oldest request still waiting went unanswered for timeoutMs
//   onProtocolError(error) an answer arrived that no request is waiting for
export function createRequestMatcher({
  transmit,
  timeoutMs = 15_000,
  onTimeout = () => {},
  onProtocolError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  // Requests still waiting, oldest first:
  //   { type, answer, key, objects, messages, build, resolve, reject, failed,
  //     inDoubt, boundary }
  // `failed` marks a synced request its Error already rejected, kept until its
  // Done so that Done is accounted for. `messages` are the frames it went out
  // as; `build` (a create's) makes it again around a new node. `inDoubt` marks
  // a request sent before the last resume, which may never have reached the
  // server; `boundary` the Sync a resume sends to find out (see resume()).
  const pending = []
  let lastId = 0
  let ready = false
  let timer = null
  let closedError = null
  // Set while detached: the socket is gone, the session may be resumed.
  let detachedError = null
  // The newest resume's Sync. Only its Done sorts out what was lost.
  let boundary = null
  // Notified requests (Close, RequestKeyFrame) not known to have arrived yet:
  // { message, mark, inDoubt, doubtUntil }, `mark` being the newest id when it
  // went out. An answer naming a newer id (Done, Source, Sink) is for a request
  // sent after it on the same socket, so it arrived too. One in doubt (sent
  // before a resume) only counts ids up to `doubtUntil`, the newest id before
  // that resume: a later one went out on another socket. Kept so a resume can
  // send a lost one again; both are harmless twice (a Close of a closed node
  // is dropped).
  const notified = []

  const armOldest = () => {
    if (timer != null) clearTimer(timer)
    timer = null
    const oldest = pending[0]
    if (!oldest || !(timeoutMs > 0) || detachedError) return
    // Answers come in request order, so only the oldest request is actually
    // awaiting the server. Later ones get their full budget once they're oldest.
    timer = setTimer(() => {
      timer = null
      if (pending[0] !== oldest) return
      onTimeout(oldest.type)
    }, timeoutMs)
  }

  const remove = (entry) => {
    const index = pending.indexOf(entry)
    if (index === -1) return
    pending.splice(index, 1)
    if (index === 0) armOldest()
  }

  // A new LocalId, above every id this socket has used. Only ever taken right
  // before the frame that uses it goes out (create, requestSynced): the server
  // refuses a new id that isn't above the last one it saw. A socket never gets
  // near u32's limit.
  const newId = () => ++lastId

  // Queue `entry`, then write `messages` in order. A failed write takes the
  // entry back out.
  const enqueue = (entry, messages) => {
    pending.push(entry)
    if (pending.length === 1) armOldest()
    try {
      for (const message of messages) transmit(JSON.stringify(message))
    } catch (err) {
      remove(entry)
      entry.reject(err)
    }
  }

  // Closed for good, or detached: no new request goes out.
  const refusal = () => closedError ?? detachedError

  // Send a request with a success answer and resolve with that answer's
  // payload (the Channel snapshot, for SetCapabilities), or reject with
  // VoiceRequestError. `build` is a create's (see create()).
  const submit = (message, build) =>
    new Promise((resolve, reject) => {
      const type = messageType(message)
      if (refusal()) {
        reject(refusal())
        return
      }
      if (!Object.hasOwn(SUCCESS_ANSWER, type ?? '')) {
        reject(new Error(`${type ?? 'Unknown message'} has no success answer to wait for`))
        return
      }
      const body = message[type] ?? {}
      const entry = {
        type,
        answer: SUCCESS_ANSWER[type],
        key: requestKey(type, body),
        objects: errorObjects(type, body),
        messages: [message],
        build,
        resolve,
        reject,
        failed: false,
        inDoubt: false,
        boundary: false
      }
      enqueue(entry, entry.messages)
    })
  const request = (message) => submit(message, null)

  // CreateSource or CreateSink: `build(node)` makes the request around a new
  // node, and it goes out at once, so new ids reach the server in order. A
  // create lost with a socket is built again around another new node, so
  // callers take the node from the answer ({ node }), never from `build`.
  const create = (build) => {
    if (refusal()) return Promise.reject(refusal())
    let message
    try {
      message = build(newId())
    } catch (err) {
      // An id taken and never sent is skipped, which the server allows.
      return Promise.reject(err)
    }
    return submit(message, build)
  }

  // Send a request without a success answer, then a Sync. Resolves on that
  // Sync's Done; rejects with VoiceRequestError when an Error naming the
  // request's object comes first. A request on a node the server has already
  // closed is dropped there, so it resolves as well.
  const requestSynced = (message) =>
    new Promise((resolve, reject) => {
      const type = messageType(message)
      if (refusal()) {
        reject(refusal())
        return
      }
      if (type == null || Object.hasOwn(SUCCESS_ANSWER, type)) {
        reject(new Error(`${type ?? 'Unknown message'} has an answer of its own; use request()`))
        return
      }
      const callback = newId()
      const entry = {
        type,
        answer: 'Done',
        key: callback,
        objects: errorObjects(type, message[type] ?? {}),
        messages: [message, Request.sync(callback)],
        build: null,
        resolve: () => resolve(),
        reject,
        failed: false,
        inDoubt: false,
        boundary: false
      }
      enqueue(entry, entry.messages)
    })

  // Write a request and forget it. One with a success answer has to go
  // through request(), or its answer would arrive with nothing waiting for it.
  const notify = (message) => {
    if (refusal()) throw refusal()
    const type = messageType(message)
    if (Object.hasOwn(SUCCESS_ANSWER, type ?? '')) {
      throw new Error(`${type} gets an answer; send it with request()`)
    }
    transmit(JSON.stringify(message))
    // The caller restates SetSpeaking after a resume; an old one is never resent.
    if (type === 'SetSpeaking') return
    notified.push({ message, mark: lastId, inDoubt: false, doubtUntil: 0 })
    if (notified.length > NOTIFIED_LIMIT) notified.shift()
  }

  // Everything notified before the request that named `id` has arrived.
  const confirmNotified = (id) => {
    if (!Number.isInteger(id)) return
    for (let i = notified.length - 1; i >= 0; i--) {
      const sent = notified[i]
      if (sent.mark < id && (!sent.inDoubt || id <= sent.doubtUntil)) notified.splice(i, 1)
    }
  }

  // An Error goes to the oldest waiting request whose object it names. Errors
  // come in request order, so that is the request it answers, unless a notified
  // request on the same object, sent earlier, failed too. False when no request
  // claims it.
  const claimError = (data) => {
    const entry = pending.find(
      (waiting) =>
        !waiting.failed && waiting.objects.some((object) => sameObject(object, data.object))
    )
    if (!entry) return false
    if (entry.answer === 'Done') entry.failed = true
    else remove(entry)
    entry.reject(new VoiceRequestError(entry.type, data))
    return true
  }

  // Route one decoded server frame. Returns true when it was only an answer
  // (consumed here), false for anything the caller should still apply: events
  // (Channel and Closed included, whatever they settled here), unknown types,
  // and an Error no request claims.
  const handle = ({ type, data }) => {
    if (type === 'Error') return claimError(data ?? {})
    if (type === 'Channel') {
      // The first one is the session becoming ready, and SetCapabilities' only
      // sign of success. Later ones follow a channel move or a resync.
      ready = true
      const entry = pending.find((waiting) => waiting.answer === 'Channel')
      if (entry) {
        remove(entry)
        entry.resolve(data)
      }
      return false
    }
    if (!ANSWER_TYPES.has(type)) return false
    const key = answerKey(type, data)
    if (type === 'Done' || type === 'Source' || type === 'Sink') confirmNotified(key)
    const entry = pending.find((waiting) => waiting.answer === type && waiting.key === key)
    if (!entry) {
      const about = key == null ? '' : ` for ${key}`
      onProtocolError(new VoiceProtocolError(`Unexpected ${type}${about} with nothing waiting`))
      return true
    }
    remove(entry)
    if (!entry.failed) entry.resolve(data)
    return true
  }

  // Reject everything in flight and refuse new requests (the session is over).
  const close = (error) => {
    closedError = error
    detachedError = null
    boundary = null
    notified.length = 0
    if (timer != null) clearTimer(timer)
    timer = null
    for (const entry of pending.splice(0)) {
      if (!entry.failed) entry.reject(error)
    }
  }

  // The socket dropped but the session may be resumed. Requests still waiting
  // stay queued, unanswered and untimed, for resume(); new ones are refused
  // with `error` until then. A resume that was still waiting for its Done
  // stays queued too, and the next resume's Sync takes over from it.
  const detach = (error) => {
    if (closedError) return
    detachedError = error
    if (timer != null) clearTimer(timer)
    timer = null
  }

  // A Resume worked (Resumed arrived) and `transmit` now writes to the new
  // socket. The stream picks up after the last event we saw, so every request
  // the server got before the drop is answered by the replay, through handle()
  // like any answer. What the server never got can't be told apart yet, so
  // this sends a Sync behind the replay: the session handles requests in order,
  // so once its Done arrives, every request sent before the drop that is still
  // waiting was lost with the socket, and goes out again:
  //   - a create, built again around a new node (its old one is now below ids
  //     the server has seen, so it would be refused);
  //   - a request settled by a Sync (and a bare Sync), with a new callback;
  //   - ConnectTransport and RestartIce, as they were. Like the synced ones,
  //     they're safe to repeat: a duplicate is ignored or answers with an
  //     Error, which settles nothing worse than a loss would;
  //   - Identify and SetCapabilities can't be lost by a session that resumed
  //     (only a ready one can), so one still waiting fails;
  //   - and a notified request (Close, RequestKeyFrame) sent before the drop
  //     and not confirmed since, as it was.
  // New requests are accepted again at once; they go out after the Sync, so
  // they're never in doubt. A drop before the Done leaves everything waiting
  // for the next resume, whose Sync takes over. Resolves on the Done, after the
  // resends are out; rejects if the session closes first, or if this Sync was
  // itself lost and a newer resume's Done settled things instead.
  const resume = () =>
    new Promise((resolve, reject) => {
      if (closedError) {
        reject(closedError)
        return
      }
      detachedError = null
      for (const entry of pending) entry.inDoubt = true
      for (const sent of notified) {
        // Already in doubt from an earlier resume: still only its own socket's ids count.
        if (sent.inDoubt) continue
        sent.inDoubt = true
        sent.doubtUntil = lastId
      }
      const callback = newId()
      const entry = {
        type: 'Sync',
        answer: 'Done',
        key: callback,
        objects: [],
        messages: [Request.sync(callback)],
        build: null,
        resolve: () => {
          if (boundary !== entry) {
            resolve()
            return
          }
          boundary = null
          resendLost()
          resolve()
        },
        reject,
        failed: false,
        inDoubt: false,
        boundary: true
      }
      boundary = entry
      armOldest()
      enqueue(entry, entry.messages)
    })

  // The newest resume's Done: what is still in doubt never reached the server.
  const resendLost = () => {
    const lost = pending.filter((entry) => entry.inDoubt)
    const lostNotified = notified.filter((sent) => sent.inDoubt)
    if (lost.length === 0 && lostNotified.length === 0) return
    for (const entry of lost) pending.splice(pending.indexOf(entry), 1)
    for (const sent of lostNotified) notified.splice(notified.indexOf(sent), 1)
    const resend = []
    for (const entry of lost) {
      entry.inDoubt = false
      if (entry.boundary) {
        // An older resume's Sync, lost with its socket. This Done covers it.
        entry.reject(new Error('Superseded by a later resume'))
      } else if (entry.failed) {
        // Its Error arrived and only its Sync was lost: nothing to account for.
      } else if (entry.build) {
        let message
        try {
          message = entry.build(newId())
        } catch (err) {
          entry.reject(err)
          continue
        }
        const type = messageType(message)
        const body = message[type] ?? {}
        entry.key = requestKey(type, body)
        entry.objects = errorObjects(type, body)
        entry.messages = [message]
        pending.push(entry)
        resend.push(message)
      } else if (entry.answer === 'Done') {
        const callback = newId()
        entry.key = callback
        entry.messages =
          entry.type === 'Sync'
            ? [Request.sync(callback)]
            : [entry.messages[0], Request.sync(callback)]
        pending.push(entry)
        resend.push(...entry.messages)
      } else if (entry.answer === 'TransportConnected' || entry.answer === 'IceRestarted') {
        pending.push(entry)
        resend.push(...entry.messages)
      } else {
        entry.reject(new VoiceProtocolError(`${entry.type} was lost and can't be sent again`))
      }
    }
    for (const sent of lostNotified) {
      sent.inDoubt = false
      sent.mark = lastId
      notified.push(sent)
      resend.push(sent.message)
    }
    armOldest()
    try {
      for (const message of resend) transmit(JSON.stringify(message))
    } catch {
      // The new socket is gone already. Its close detaches again, and the next
      // resume's Sync sorts these out once more.
    }
  }

  return {
    request,
    create,
    requestSynced,
    notify,
    handle,
    close,
    detach,
    resume,
    get size() {
      return pending.length
    },
    get detached() {
      return detachedError != null
    },
    // The first Channel snapshot has arrived: the session is READY. Set as the
    // snapshot is handled, before the caller applies it.
    get ready() {
      return ready
    }
  }
}

// Notified requests a resume may still have to send again (see notified).
const NOTIFIED_LIMIT = 256

// The answer each request waits for on success (see above). Close is left out
// on purpose: its answer is applied as an event, never waited for.
const SUCCESS_ANSWER = Object.freeze({
  Identify: 'RoutingParams',
  SetCapabilities: 'Channel',
  Sync: 'Done',
  ConnectTransport: 'TransportConnected',
  RestartIce: 'IceRestarted',
  CreateSource: 'Source',
  CreateSink: 'Sink'
})

// Messages that only ever answer a request. Channel is an event too.
const ANSWER_TYPES = new Set([
  'RoutingParams',
  'Done',
  'TransportConnected',
  'IceRestarted',
  'Source',
  'Sink'
])

// What finds the request an answer is for. RoutingParams and Channel need no
// key: a socket sends one Identify and one SetCapabilities.
function requestKey(type, body) {
  switch (type) {
    case 'Sync':
      return body.callback
    case 'ConnectTransport':
    case 'RestartIce':
      return body.direction
    case 'CreateSource':
    case 'CreateSink':
      return body.new_node
    default:
      return null
  }
}

function answerKey(type, data) {
  switch (type) {
    case 'Done':
      return data?.callback ?? null
    case 'TransportConnected':
    case 'IceRestarted':
      return data?.direction ?? null
    case 'Source':
    case 'Sink':
      return data?.node ?? null
    default:
      return null
  }
}

// The objects an Error about this request can name (pylon-sfu session.rs
// `dispatch` and session/pending.rs).
function errorObjects(type, body) {
  switch (type) {
    case 'SetCapabilities':
    case 'Group':
      return ['Session']
    case 'ConnectTransport':
    case 'RestartIce':
      return [{ Transport: body.direction }]
    // Every create failure names the new node: not the source a sink was for,
    // not the source being replaced, not the send transport.
    case 'CreateSource':
      return [{ Source: body.new_node }]
    case 'CreateSink':
      return [{ Sink: body.new_node }]
    // The node is named as what it really is, so a ConfigureSink sent to a
    // source fails on { Source }, a SetSourcePaused sent to a sink on { Sink }.
    case 'ConfigureSink':
    case 'SetSourcePaused':
    case 'RequestKeyFrame':
      return [{ Source: body.node }, { Sink: body.node }]
    default:
      return []
  }
}

function sameObject(a, b) {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  const type = messageType(a)
  return type != null && type === messageType(b) && a[type] === b[type]
}

// ─── Channel state ───────────────────────────────────────────────
// The media-side view of the current channel, rebuilt from every Channel
// snapshot and patched by the deltas (clients, sources, codecs). Clients and
// sources never include this client. Every mutator returns what actually
// changed, so the caller can drive mediasoup from the diff and stay idempotent
// across a resync snapshot that repeats sources it already handled.
export class VoiceChannelState {
  constructor() {
    this.reset()
  }

  reset() {
    this.channelId = null
    // { allowed: VideoCodec[], preferred: VideoCodec }: the video codecs every
    // member can decode, best first. The server refuses video in any other.
    this.codecs = null
    this.clients = new Set()
    // Other clients' sources, by NodeId string as the server sent it.
    this.sources = new Map() // NodeId -> { node, owner, kind, codec, streamKey, paused }
    this.speakers = new Set()
    // The node's E2EE GroupParams: { ciphersuite, external_sender, format }.
    this.group = null
    this.hasSnapshot = false
  }

  // Replace everything. Returns the source diff against the previous state
  // (`updated`: sources kept whose state changed, e.g. a pause the deltas
  // missed before a resync) plus the speaker diff (see setSpeakers).
  applySnapshot({ channel_id, codecs, clients = [], sources = [], speakers = [], group = null }) {
    const previous = this.sources
    const next = new Map()
    for (const source of sources) next.set(source.node, normalizeSource(source))

    const added = [...next.values()].filter((source) => !previous.has(source.node))
    const removed = [...previous.values()].filter((source) => !next.has(source.node))
    const updated = [...next.values()].filter(
      (source) => previous.has(source.node) && !sameSource(previous.get(source.node), source)
    )

    this.channelId = channel_id == null ? null : String(channel_id)
    this.setCodecs(codecs)
    this.clients = new Set(clients.map(String))
    this.sources = next
    this.group = group
    this.hasSnapshot = true
    return { added, removed, updated, speakers: this.setSpeakers(speakers) }
  }

  addClients(clients = []) {
    const added = []
    for (const client of clients.map(String)) {
      if (this.clients.has(client)) continue
      this.clients.add(client)
      added.push(client)
    }
    return added
  }

  removeClients(clients = []) {
    const removed = []
    for (const client of clients.map(String)) {
      if (this.clients.delete(client)) removed.push(client)
    }
    return removed
  }

  addSources(sources = []) {
    const added = []
    for (const raw of sources) {
      if (this.sources.has(raw.node)) continue
      const source = normalizeSource(raw)
      this.sources.set(source.node, source)
      added.push(source)
    }
    return added
  }

  removeSources(nodes = []) {
    const removed = []
    for (const node of nodes) {
      const source = this.sources.get(node)
      if (!source) continue
      this.sources.delete(node)
      removed.push(source)
    }
    return removed
  }

  // A member swapped one source for another of the same kind. Returns the
  // source that went (null if we never had it) and the one that came (null if
  // we already had it).
  replaceSource(old, source) {
    const [removed = null] = this.removeSources([old])
    const [added = null] = source == null ? [] : this.addSources([source])
    return { removed, added }
  }

  // SourceUpdated: a source we know changed (today, its owner paused or
  // resumed it). Returns the updated source, or null when it's unknown to us
  // or nothing changed.
  updateSource(raw) {
    if (raw == null || !this.sources.has(raw.node)) return null
    const source = normalizeSource(raw)
    if (sameSource(this.sources.get(source.node), source)) return null
    this.sources.set(source.node, source)
    return source
  }

  // The sources of one stream.
  streamSources(streamKey) {
    if (streamKey == null) return []
    return [...this.sources.values()].filter((source) => source.streamKey === streamKey)
  }

  setCodecs(codecs) {
    this.codecs =
      codecs == null
        ? null
        : { allowed: [...(codecs.allowed ?? [])], preferred: codecs.preferred ?? null }
    return this.codecs
  }

  // Would the server take video in this codec right now? A codec off its
  // ladder isn't checked, and nothing is before the first snapshot.
  allowsVideo(mimeType) {
    const codec = videoCodecForMime(mimeType)
    return codec == null || this.codecs == null || this.codecs.allowed.includes(codec)
  }

  // Speakers is always the full set (including this client). Replace, then
  // report who started and who stopped so per-client callbacks can be fired.
  setSpeakers(speakers = []) {
    const next = new Set(speakers.map(String))
    const started = [...next].filter((id) => !this.speakers.has(id))
    const stopped = [...this.speakers].filter((id) => !next.has(id))
    this.speakers = next
    return { started, stopped }
  }

  source(node) {
    return this.sources.get(node) ?? null
  }
}

// Flattens a ChannelSource. `node` stays the NodeId string the server sent,
// to be echoed back in CreateSink. `kind` becomes its SourceType. `codec` is the
// VideoCodec a Webcam / Stream is sent in, null for audio. `streamKey` is the
// stream of a Stream / StreamAudio, null for a Microphone or Webcam. All three
// are fixed for the source's life: a codec change replaces the source.
// `paused` is its owner's pause (SetSourcePaused).
function normalizeSource({ node, owner, kind, paused = false }) {
  const { codec = null, stream_key: streamKey = null } = kind?.attr ?? {}
  return {
    node,
    owner: owner == null ? null : String(owner),
    kind: kind?.type ?? null,
    codec,
    streamKey: streamKey == null ? null : String(streamKey),
    paused: paused === true
  }
}

function sameSource(a, b) {
  return (
    a.owner === b.owner &&
    a.kind === b.kind &&
    a.codec === b.codec &&
    a.streamKey === b.streamKey &&
    a.paused === b.paused
  )
}

// ─── mediasoup-client mapping ────────────────────────────────────

// Microphone / StreamAudio are audio; Webcam / Stream are video.
export function sourceMediaKind(sourceType) {
  return sourceType === SourceType.Webcam || sourceType === SourceType.Stream ? 'video' : 'audio'
}

// The rest of the client still speaks in the old producer vocabulary
// (playback, watch intent, diagnostics, the video grid). Map at the boundary
// so those modules don't need to change with the wire format.
const PRODUCED_TO_SOURCE = {
  Audio: SourceType.Microphone,
  ScreenShare: SourceType.Stream,
  ScreenShareAudio: SourceType.StreamAudio,
  Camera: SourceType.Webcam
}
const SOURCE_TO_PRODUCED = Object.fromEntries(
  Object.entries(PRODUCED_TO_SOURCE).map(([produced, source]) => [source, produced])
)

// SourceType for a local producer's appData ({ produced: 'Audio' | ... }).
export function sourceTypeForAppData(appData) {
  return PRODUCED_TO_SOURCE[appData?.produced ?? 'Audio'] ?? null
}

// Legacy producedType label for a remote source's SourceType.
export function producedTypeForSource(sourceType) {
  return SOURCE_TO_PRODUCED[sourceType] ?? sourceType
}

// RoutingParams' transport descriptors are the one snake_case object in the
// protocol; the values inside are already mediasoup camelCase.
export function mapTransportParams(params) {
  if (params == null) return null
  return {
    id: params.id,
    iceParameters: params.ice_parameters,
    iceCandidates: params.ice_candidates,
    dtlsParameters: params.dtls_parameters
  }
}

// ─── Video view roles → sink config ──────────────────────────────
// The video grid says which remote videos it shows and how big
// (setVideoStreamRoles), and each video sink's SinkConfig follows from that:
// hidden video is paused on the server (no bytes at all), shown video is
// resumed on the layers its size needs, and the focused stream gets first
// claim on a short downlink.
export const ViewRole = Object.freeze({
  Focused: 'focused',
  Grid: 'grid',
  Thumbnail: 'thumbnail',
  Hidden: 'hidden'
})

const FOCUSED_SINK_PRIORITY = 2
const DEFAULT_SINK_PRIORITY = 1

// A sink's role (by consumer id) in the grid's current view. Visible tiles are
// grid tiles when nothing is focused, carousel thumbnails otherwise. The
// focused id wins even when it's also listed as visible.
export function viewRoleFor(
  consumerId,
  { focusedConsumerId = null, visibleConsumerIds = [] } = {}
) {
  if (consumerId != null && consumerId === focusedConsumerId) return ViewRole.Focused
  const visible =
    visibleConsumerIds instanceof Set ? visibleConsumerIds : new Set(visibleConsumerIds)
  if (!visible.has(consumerId)) return ViewRole.Hidden
  return focusedConsumerId == null ? ViewRole.Grid : ViewRole.Thumbnail
}

// The layers a sink can choose from, read off its Sink rtp_parameters. Each
// encoding is a simulcast stream, and an encoding's scalabilityMode ("L1T3",
// "S2T3", "L3T3_KEY") gives its SVC spatial and temporal layer counts.
export function sinkLayerCapabilities(rtpParameters) {
  const encodings = rtpParameters?.encodings ?? []
  let maxSpatial = Math.max(0, encodings.length - 1)
  let maxTemporal = 0
  for (const encoding of encodings) {
    const mode = /^[LS]([1-9]\d?)T([1-9]\d?)/.exec(encoding?.scalabilityMode ?? '')
    if (!mode) continue
    maxSpatial = Math.max(maxSpatial, Number(mode[1]) - 1)
    maxTemporal = Math.max(maxTemporal, Number(mode[2]) - 1)
  }
  return { maxSpatial, maxTemporal }
}

// The SinkConfig a video sink should have in a role. Hidden only pauses, so the
// next role resumes it on whatever layers it then asks for. Layers are left out
// for a sink with nothing to choose between.
export function sinkConfigForViewRole(role, { maxSpatial = 0, maxTemporal = 0 } = {}) {
  if (role === ViewRole.Hidden) return { paused: true }
  let layers
  if (role === ViewRole.Thumbnail) {
    layers = { spatial: 0, temporal: 0 }
  } else if (role === ViewRole.Grid) {
    // A screen share (L1Tx) has no spatial tier to drop, so it keeps its only
    // resolution. An SVC camera takes its middle layer; a two-encoding
    // simulcast camera keeps its full one.
    layers = { spatial: Math.min(1, maxSpatial), temporal: maxTemporal }
  } else {
    layers = { spatial: maxSpatial, temporal: maxTemporal }
  }
  const selectable = maxSpatial > 0 || maxTemporal > 0
  return {
    paused: false,
    priority: role === ViewRole.Focused ? FOCUSED_SINK_PRIORITY : DEFAULT_SINK_PRIORITY,
    ...(selectable ? { layers } : {})
  }
}

// The fields of `desired` that differ from `current` (what we last asked the
// server for), or null when there's nothing to send. A field `desired` leaves
// out isn't compared.
export function sinkConfigChanges(current = {}, desired = {}) {
  const changes = {}
  if (desired.paused != null && desired.paused !== current.paused) changes.paused = desired.paused
  if (desired.priority != null && desired.priority !== current.priority) {
    changes.priority = desired.priority
  }
  if (desired.layers != null && !sameLayers(desired.layers, current.layers)) {
    changes.layers = desired.layers
  }
  return Object.keys(changes).length > 0 ? changes : null
}

function sameLayers(a, b) {
  return (
    a != null &&
    b != null &&
    a.spatial === b.spatial &&
    (a.temporal ?? null) === (b.temporal ?? null)
  )
}

// ─── Event socket: screen streams ────────────────────────────────
// The backend authorizes streams; the voice socket only carries their media. A
// stream is named by a stream key, an opaque public string.
//   Publish: op 7 asks for a key (answered by op 11), then CreateSource for the
//            Stream and/or StreamAudio with that key within 30s.
//   Watch:   op 8 (answered by op 12), then CreateSink on the stream's sources,
//            the ones whose ChannelSource kind carries the key.
//   Stop:    op 9 stops watching, op 10 ends our own stream. Neither is answered.
// Requests use the event socket's { op, data } envelope. Op 11 and 12 come back
// flat ({ op, stream_key }) and unsequenced, so like op 6 a resume never
// replays them. A failure is { err: String }, saying nothing about which
// request it answers (see createStreamRequests).
export const StreamOp = Object.freeze({
  CREATE_STREAM: 7,
  WATCH_STREAM: 8,
  STOP_WATCHING_STREAM: 9,
  END_STREAM: 10,
  STREAM_CREATED: 11,
  STREAM_WATCHING: 12
})

export const StreamRequest = Object.freeze({
  // We must be in that voice channel, hold STREAM there, and have no other
  // stream, pending or live.
  create: (channelId) => ({
    op: StreamOp.CREATE_STREAM,
    data: { channel_id: String(channelId) }
  }),
  // The stream must be live (StreamStarted) in our current channel, and not ours.
  watch: (streamKey) => ({ op: StreamOp.WATCH_STREAM, data: { stream_key: streamKey } }),
  stopWatching: (streamKey) => ({
    op: StreamOp.STOP_WATCHING_STREAM,
    data: { stream_key: streamKey }
  }),
  end: (streamKey) => ({ op: StreamOp.END_STREAM, data: { stream_key: streamKey } })
})

// A stream request that failed ({ err }), timed out, or never went out.
export class StreamRequestError extends Error {
  constructor(message, { request = null, timedOut = false } = {}) {
    super(message)
    this.name = 'StreamRequestError'
    this.request = request // the op asked for: 7 (create) or 8 (watch)
    this.timedOut = timedOut
  }
}

// Pairs op 11 and 12 with the op 7 and 8 that asked for them. The backend
// answers event-socket frames one at a time and in order, so op 11 answers the
// oldest create still waiting and op 12 the oldest watch of its key.
//
// Failures are the weak spot. { err } names neither op nor key, and op 1 and
// op 5 fail with the same frame. An err rejects the oldest stream request still
// waiting, which is right unless an op 1 or 5 sent just before it failed too.
// A wrong guess costs that one request: it fails, and its real reply arrives
// later with nothing waiting for it. onOrphan gets that reply so the caller
// can give back what it was granted (op 10 for a create, op 9 for a watch).
//
//   transmit(frame)             send one { op, data } frame; false (or a throw)
//                               when the event socket isn't open
//   onOrphan({ op, streamKey }) an op 11 or 12 that nothing was waiting for
export function createStreamRequests({
  transmit,
  timeoutMs = 10_000,
  onOrphan = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const pending = [] // { op, streamKey, promise, resolve, reject, timer }, oldest first

  // Take an entry out of the queue. False if something else already did.
  const take = (entry) => {
    const index = pending.indexOf(entry)
    if (index === -1) return false
    pending.splice(index, 1)
    if (entry.timer != null) clearTimer(entry.timer)
    entry.timer = null
    return true
  }

  const transmitted = (frame) => {
    try {
      return transmit(frame) !== false
    } catch {
      return false
    }
  }

  const send = (op, frame, streamKey = null) => {
    const entry = { op, streamKey, timer: null }
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve
      entry.reject = reject
    })
    if (!transmitted(frame)) {
      entry.reject(new StreamRequestError('Not connected to the server', { request: op }))
      return entry.promise
    }
    pending.push(entry)
    if (timeoutMs > 0) {
      entry.timer = setTimer(() => {
        entry.timer = null
        if (!take(entry)) return
        entry.reject(
          new StreamRequestError(`Stream request (op ${op}) timed out`, {
            request: op,
            timedOut: true
          })
        )
      }, timeoutMs)
    }
    return entry.promise
  }

  // Ask for a stream in `channelId`. Resolves with its stream key.
  const create = (channelId) => send(StreamOp.CREATE_STREAM, StreamRequest.create(channelId))

  // Ask to watch a stream. Resolves (with the key) once sinks may be created on
  // it. Watching a key that is already being asked for joins that request.
  const watch = (streamKey) => {
    const waiting = pending.find(
      (entry) => entry.op === StreamOp.WATCH_STREAM && entry.streamKey === streamKey
    )
    if (waiting) return waiting.promise
    return send(StreamOp.WATCH_STREAM, StreamRequest.watch(streamKey), streamKey)
  }

  // Ops 9 and 10, which are never answered. Returns whether the frame went out.
  const notify = (frame) => transmitted(frame)

  // Route one event-socket frame. True when it was op 11 or 12 (handled here).
  const handle = (msg) => {
    if (msg?.op !== StreamOp.STREAM_CREATED && msg?.op !== StreamOp.STREAM_WATCHING) return false
    const streamKey = typeof msg.stream_key === 'string' ? msg.stream_key : null
    if (streamKey == null) return true
    const entry =
      msg.op === StreamOp.STREAM_CREATED
        ? pending.find((waiting) => waiting.op === StreamOp.CREATE_STREAM)
        : pending.find(
            (waiting) => waiting.op === StreamOp.WATCH_STREAM && waiting.streamKey === streamKey
          )
    if (entry && take(entry)) entry.resolve(streamKey)
    else onOrphan({ op: msg.op, streamKey })
    return true
  }

  // An { err } frame. Rejects the oldest stream request still waiting and
  // returns the op it had asked for, or null when none was waiting (so the err
  // answered something else).
  const fail = (message) => {
    const entry = pending[0]
    if (!entry || !take(entry)) return null
    entry.reject(new StreamRequestError(message || 'Stream request failed', { request: entry.op }))
    return entry.op
  }

  // The event socket closed. A resume doesn't replay op 11 or 12, so nothing
  // still waiting will be answered.
  const reset = (error = new StreamRequestError('Event socket closed')) => {
    for (const entry of pending.splice(0)) {
      if (entry.timer != null) clearTimer(entry.timer)
      entry.timer = null
      entry.reject(error)
    }
  }

  return {
    create,
    watch,
    notify,
    handle,
    fail,
    reset,
    get size() {
      return pending.length
    }
  }
}

// Live streams the event socket has announced, in every channel we can see:
// Ready.streams, then StreamStarted / StreamViewersUpdated / StreamEnded. The
// events may repeat what Ready already said, so every mutator is idempotent
// and reports whether anything changed. Keyed by stream key.
export class StreamDirectory {
  constructor() {
    this.streams = new Map() // streamKey -> { streamKey, owner, channelId, viewers: Set }
  }

  // Ready replaces everything. Returns the keys that appeared and went.
  applyReady(streams = []) {
    const next = new Map()
    for (const stream of streams ?? []) {
      if (typeof stream?.stream_key !== 'string') continue
      next.set(stream.stream_key, {
        streamKey: stream.stream_key,
        owner: snowflake(stream.owner),
        channelId: snowflake(stream.channel_id),
        viewers: new Set((stream.viewers ?? []).map(String))
      })
    }
    const started = [...next.keys()].filter((key) => !this.streams.has(key))
    const ended = [...this.streams.keys()].filter((key) => !next.has(key))
    this.streams = next
    return { started, ended }
  }

  // StreamStarted. True for a stream we didn't know.
  started({ stream_key, owner, channel_id } = {}) {
    if (typeof stream_key !== 'string' || this.streams.has(stream_key)) return false
    this.streams.set(stream_key, {
      streamKey: stream_key,
      owner: snowflake(owner),
      channelId: snowflake(channel_id),
      viewers: new Set()
    })
    return true
  }

  // StreamViewersUpdated: deltas. An unknown stream is ignored; Ready or its
  // StreamStarted would have named it first.
  viewersUpdated({ stream_key, added = [], removed = [] } = {}) {
    const stream = this.streams.get(stream_key)
    if (!stream) return false
    let changed = false
    for (const id of (added ?? []).map(String)) {
      if (stream.viewers.has(id)) continue
      stream.viewers.add(id)
      changed = true
    }
    for (const id of (removed ?? []).map(String)) {
      if (stream.viewers.delete(id)) changed = true
    }
    return changed
  }

  // StreamEnded. A stream we don't know is a no-op.
  ended({ stream_key } = {}) {
    return this.streams.delete(stream_key)
  }

  has(streamKey) {
    return this.streams.has(streamKey)
  }

  get(streamKey) {
    return this.streams.get(streamKey) ?? null
  }

  viewers(streamKey) {
    return [...(this.streams.get(streamKey)?.viewers ?? [])]
  }

  // Who is streaming where: channel id -> sorted owner ids. Covers every channel
  // we can see, whether or not we're in voice.
  ownersByChannel() {
    const owners = new Map()
    for (const { owner, channelId } of this.streams.values()) {
      if (owner == null || channelId == null) continue
      let ids = owners.get(channelId)
      if (!ids) owners.set(channelId, (ids = []))
      if (!ids.includes(owner)) ids.push(owner)
    }
    for (const ids of owners.values()) ids.sort()
    return owners
  }

  clear() {
    this.streams.clear()
  }
}

function snowflake(value) {
  return value == null ? null : String(value)
}

// ─── Close codes ─────────────────────────────────────────────────
// One table for both sockets, the backend's /ws and the voice node's /voice
// (server: crates/utils/src/close_code.rs, `utils::CloseCode`). Callers switch
// on the action, not on the socket.
export const CloseCode = Object.freeze({
  ServerShutdown: 1001,
  UpdateRequired: 4000,
  InvalidPayload: 4001,
  AuthFailed: 4002,
  TicketRejected: 4003,
  Replaced: 4004,
  HeartbeatTimeout: 4005,
  Kicked: 4006,
  Banned: 4007,
  VoiceEnded: 4008,
  E2eeFailed: 4009,
  InternalError: 4010
})

export const CloseAction = Object.freeze({
  // Reconnect with backoff and pick up where we were: /ws resumes its event
  // stream, /voice sends Resume.
  Resume: 'resume',
  // Reconnect without resuming. On /voice: a new ticket (op 13), then Identify.
  Fresh: 'fresh',
  // /ws: refresh the access token and reconnect; log in again if that fails.
  Reauth: 'reauth',
  // /voice: we left voice or were moved off this node. A new ticket only if
  // we're still in a voice channel.
  IfInVoice: 'if-in-voice',
  // Don't reconnect on our own.
  Stop: 'stop',
  // Stop and ask for an update.
  Update: 'update'
})

const CLOSE_TABLE = Object.freeze({
  [CloseCode.ServerShutdown]: ['ServerShutdown', CloseAction.Resume, 'server shutting down'],
  [CloseCode.UpdateRequired]: ['UpdateRequired', CloseAction.Update, 'update required'],
  [CloseCode.InvalidPayload]: [
    'InvalidPayload',
    CloseAction.Fresh,
    'server could not read a frame'
  ],
  [CloseCode.AuthFailed]: ['AuthFailed', CloseAction.Reauth, 'authentication failed'],
  [CloseCode.TicketRejected]: ['TicketRejected', CloseAction.Fresh, 'voice ticket rejected'],
  [CloseCode.Replaced]: ['Replaced', CloseAction.Stop, 'replaced by a newer connection'],
  [CloseCode.HeartbeatTimeout]: ['HeartbeatTimeout', CloseAction.Resume, 'heartbeat timeout'],
  [CloseCode.Kicked]: ['Kicked', CloseAction.Stop, 'kicked'],
  [CloseCode.Banned]: ['Banned', CloseAction.Stop, 'banned'],
  [CloseCode.VoiceEnded]: ['VoiceEnded', CloseAction.IfInVoice, 'voice session ended'],
  [CloseCode.E2eeFailed]: ['E2eeFailed', CloseAction.Fresh, 'voice encryption failed'],
  [CloseCode.InternalError]: ['InternalError', CloseAction.Resume, 'server error']
})

// What a close means: { name, action, reason }. Anything not in the table (no
// code, 1006, 1005, 1000) is a dropped connection, which resumes.
export function classifyClose(code) {
  const known = CLOSE_TABLE[code]
  if (!known) return { name: null, action: CloseAction.Resume, reason: 'connection lost' }
  const [name, action, reason] = known
  return { name, action, reason }
}

// ─── Voice tickets on the event socket ───────────────────────────
// Op 13 asks for a ticket while in a voice channel; it is answered with op 6,
// like the join that mints the first one. A refusal is a plain { err } frame
// until the event socket sends coded errors, so the two
// refusals that matter are told apart by their text (the backend's
// services/voice.rs and voice_control.rs).
export const REQUEST_VOICE_TICKET_OP = 13

export const VoiceTicketError = Object.freeze({
  // Not in a voice channel (any more): stop.
  NotInVoice: 'not_in_voice',
  // No voice node can take the channel right now: back off and retry.
  VoiceUnavailable: 'voice_unavailable'
})

const VOICE_TICKET_ERROR_TEXT = Object.freeze({
  'Client must join a voice channel before requesting a voice ticket': VoiceTicketError.NotInVoice,
  'Voice media is unavailable': VoiceTicketError.VoiceUnavailable
})

// The VoiceTicketError an { err } message means, or null for any other.
export function voiceTicketError(message) {
  return VOICE_TICKET_ERROR_TEXT[message] ?? null
}
