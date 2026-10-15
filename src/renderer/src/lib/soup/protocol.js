// pylon-voice signaling protocol, v1, plus the event-socket stream ops that
// authorize screen streams on it.
//
// Everything that knows the wire format lives here: request encoders, the
// reply matcher, channel-state bookkeeping for the server's snapshot/delta
// events, close-code classification, and the stream requests and stream
// directory of the backend's event socket. No mediasoup, DOM or UI imports, so
// it runs under `node --test` (see protocol.test.mjs) and the soup layer stays
// a pure mediasoup-client driver.
//
// Contract: .plans/HANDOFF-voice-protocol-v1.md. Server source of truth:
// server/backend crates/pylon-voice/src/signal/proto/v1.rs (voice socket) and
// src/events/socket.rs, src/events/socket/{ops,stream}.rs (stream ops).
//
// Wire conventions worth remembering:
//   - Messages are serde externally tagged enums: { "CreateSink": { ... } }, or
//     the bare string "GetRoutingParams" for a message with no fields.
//   - NodeId (every source and sink) is a JSON number. mediasoup-client wants
//     string ids, so the soup layer stringifies at that boundary only.
//   - Snowflakes (channel ids, client ids) are JSON strings.
//   - A stream key is an opaque string. Only ever echo one the server sent.
//   - A source's `kind` (ChannelSource, the Source reply) is adjacently tagged:
//     { type: SourceType, attr?: { codec?, stream_key? } }. `attr` is absent for
//     a Microphone. CreateSource still sends a bare SourceType plus stream_key.

export const PROTOCOL_VERSION = 1

// ─── Requests (client → server) ──────────────────────────────────

export const Request = Object.freeze({
  // First frame only, exactly once. Never answered: success is silent and
  // failure closes the socket with 4001.
  identify: (ticket) => ({ Identify: { ticket } }),
  // Only before SessionReady (refused afterwards).
  getRoutingParams: () => 'GetRoutingParams',
  // Only before SessionReady. Its success reply *is* SessionReady. `e2eeFormats` lists the
  // E2EE frame formats this build speaks; a node pinning another refuses with UpdateRequired.
  setCapabilities: (capabilities, e2eeFormats = []) => ({
    SetCapabilities: { capabilities, e2ee_formats: e2eeFormats }
  }),
  // Any time, once per transport.
  connectTransport: (direction, dtlsParameters) => ({
    ConnectTransport: { transport_parameters: { dtlsParameters }, direction }
  }),
  // After SessionReady. `replaces` names one of our own sources of the same
  // kind to swap out atomically: peers get SourceReplaced rather than a remove
  // and an add, and the server closes the old source, announcing it with a
  // Closed ahead of this request's Source reply.
  //
  // `streamKey` names the stream (event-socket op 11) a Stream or StreamAudio
  // source belongs to, and must be null for Microphone and Webcam. A
  // replacement inherits its predecessor's stream, so it may pass null; a
  // different key is refused.
  createSource: (kind, rtpParameters, replaces = null, streamKey = null) => ({
    CreateSource: { kind, rtp_parameters: rtpParameters, replaces, stream_key: streamKey }
  }),
  // The sink starts paused unless `config` says otherwise (sinkConfigFields).
  createSink: (source, config) => ({ CreateSink: { source, ...sinkConfigFields(config) } }),
  // Pause/resume, preferred layers or priority of one of our sinks. An unknown
  // node still gets SinkConfigured (a no-op), like Close.
  sinkConfigure: (node, config) => ({ SinkConfigure: { node, ...sinkConfigFields(config) } }),
  // The owner's pause of one of our own Webcam, Stream or StreamAudio sources.
  // A Microphone is refused (NotSupported): mute is voice state, op 1.
  setSourcePaused: (node, paused) => ({ SetSourcePaused: { node, paused: paused === true } }),
  // One of our sources or sinks. Always succeeds, even for a node the server
  // has already closed.
  close: (node) => ({ Close: { node } }),
  // A request for the channel's MLS delivery service (E2EE): { KeyPackage }, { GroupCreated },
  // { Commit } or { Ready }, with bytes as base64. Answered GroupReceived once the session took
  // it; what the delivery service does with it arrives later as Group events. A KeyPackage the
  // session refuses gets InvalidArgument.
  group: (request) => ({ Group: request }),
  // Asks one of our sinks' source for a keyframe, once its frames decrypt again.
  requestKeyFrame: (node) => ({ RequestKeyFrame: { node } })
})

// SinkConfig, which CreateSink and SinkConfigure carry flattened into the
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

// The success reply each request expects. Identify is absent on purpose.
export const EXPECTED_REPLY = Object.freeze({
  GetRoutingParams: 'RoutingParams',
  SetCapabilities: 'SessionReady',
  ConnectTransport: 'TransportConnected',
  CreateSource: 'Source',
  CreateSink: 'Sink',
  SinkConfigure: 'SinkConfigured',
  SetSourcePaused: 'SourcePaused',
  Close: 'Closed',
  Group: 'GroupReceived',
  RequestKeyFrame: 'KeyFrameRequested'
})

// Closed is in both sets: it's the reply to Close and also the server closing
// our nodes on its own. See the matcher for how the two are told apart.
export const REPLY_TYPES = new Set([...Object.values(EXPECTED_REPLY), 'Error'])

// Unsolicited events. Apart from Closed, these never touch the request queue.
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
  'Closed'
])

export const Direction = Object.freeze({ Send: 'Send', Receive: 'Receive' })

export const SourceType = Object.freeze({
  Microphone: 'Microphone',
  Webcam: 'Webcam',
  Stream: 'Stream',
  StreamAudio: 'StreamAudio'
})

// The server's video codec ladder, best first. Channel/Codecs list a channel's
// allowed codecs in this order.
export const VideoCodec = Object.freeze({ Av1: 'Av1', Vp9: 'Vp9', H264: 'H264', Vp8: 'Vp8' })

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

// Parse one text frame into { type, data }. A unit variant ("SessionReady")
// has data null. Throws on anything that isn't a single externally tagged
// variant, so a malformed frame is never mistaken for a reply.
export function decodeMessage(text) {
  const message = JSON.parse(text)
  const type = messageType(message)
  if (type == null) throw new Error('Voice frame is not an externally tagged message')
  return { type, data: typeof message === 'string' ? null : message[type] }
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
//   object: "Session" | { Transport: "Send" | "Receive" } | { Source: n } | { Sink: n }
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

  // The server no longer has (or never had) the source this request named.
  // Expected for a CreateSink racing SourcesRemoved, so callers ignore it.
  get sourceGone() {
    return this.code === ErrorCode.NotFound && this.object?.Source != null
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

// The server sent something the request queue can't account for: a reply with
// nothing in flight, or a reply of the wrong type for the head request. Both
// mean client and server disagree about the stream, so the session is unusable.
export class VoiceProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'VoiceProtocolError'
  }
}

// ─── Reply matching ──────────────────────────────────────────────
// v1 has no request ids. The session handles requests strictly in order and
// sends exactly one reply (success or Error) per request, except Identify. So
// replies resolve the head of a FIFO. This is the only place that pairs replies
// with requests: when request ids land, swap the queue for a map here.
//
// Closed is the exception. It answers Close, but the server also sends it
// unprompted, and v1 can't tell the two apart. So a Closed settles the head
// Close only when it names exactly that Close's node (the reply is always
// Closed { nodes: [node] }), and it is always handed on as an event as well.
// Applying a close twice is a no-op, and an unprompted Closed that happens to
// settle a Close only settles it early: that node is closed either way. Its
// real reply then shows up as one more no-op event.
//
//   transmit(frame)   writes one already-serialized frame; may throw
//   onTimeout(type)   the head request went unanswered for timeoutMs
//   onProtocolError(error) a reply arrived that no request accounts for
export function createRequestMatcher({
  transmit,
  timeoutMs = 15_000,
  onTimeout = () => {},
  onProtocolError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  const pending = []
  let timer = null
  let closedError = null

  const armHead = () => {
    if (timer != null) clearTimer(timer)
    timer = null
    const head = pending[0]
    if (!head || !(timeoutMs > 0)) return
    // Only the head is actually awaiting the server. Later entries get their
    // full budget once they reach the front.
    timer = setTimer(() => {
      timer = null
      if (pending[0] !== head) return
      onTimeout(head.type)
    }, timeoutMs)
  }

  // Send a request and resolve with its success payload (null for a unit reply
  // such as SessionReady), or reject with VoiceRequestError.
  const request = (message) =>
    new Promise((resolve, reject) => {
      const type = messageType(message)
      if (closedError) {
        reject(closedError)
        return
      }
      if (!Object.hasOwn(EXPECTED_REPLY, type ?? '')) {
        reject(new Error(`${type ?? 'Unknown message'} is not a request that gets a reply`))
        return
      }
      const entry = { type, message, resolve, reject }
      pending.push(entry)
      if (pending.length === 1) armHead()
      try {
        transmit(JSON.stringify(message))
      } catch (err) {
        const index = pending.indexOf(entry)
        if (index !== -1) pending.splice(index, 1)
        if (index === 0) armHead()
        reject(err)
      }
    })

  // Write a frame that gets no reply (Identify). Never queued.
  const notify = (message) => {
    if (closedError) throw closedError
    transmit(JSON.stringify(message))
  }

  // Route one decoded server frame. Returns true when it was only a reply
  // (consumed by the queue), false for anything the caller should still apply
  // as an event: events, unknown types, and every Closed.
  const handle = ({ type, data }) => {
    if (type === 'Closed') {
      if (answersClose(pending[0], data)) {
        const head = pending.shift()
        armHead()
        head.resolve(data)
      }
      return false
    }
    if (!REPLY_TYPES.has(type)) return false
    const head = pending.shift()
    armHead()
    if (!head) {
      onProtocolError(new VoiceProtocolError(`Unexpected ${type} with no request in flight`))
      return true
    }
    if (type === 'Error') {
      head.reject(new VoiceRequestError(head.type, data ?? {}))
      return true
    }
    if (EXPECTED_REPLY[head.type] !== type) {
      const error = new VoiceProtocolError(
        `Expected ${EXPECTED_REPLY[head.type]} for ${head.type}, got ${type}`
      )
      head.reject(error)
      onProtocolError(error)
      return true
    }
    head.resolve(data)
    return true
  }

  // Reject everything in flight and refuse new requests (socket closed).
  const close = (error) => {
    closedError = error
    if (timer != null) clearTimer(timer)
    timer = null
    for (const entry of pending.splice(0)) entry.reject(error)
  }

  return {
    request,
    notify,
    handle,
    close,
    get size() {
      return pending.length
    },
    get headType() {
      return pending[0]?.type ?? null
    }
  }
}

function answersClose(entry, data) {
  const nodes = data?.nodes
  return (
    entry?.type === 'Close' &&
    Array.isArray(nodes) &&
    nodes.length === 1 &&
    nodes[0] === entry.message.Close.node
  )
}

// ─── Channel state ───────────────────────────────────────────────
// The media-side view of the current channel, rebuilt from every Channel
// snapshot and patched by the deltas (clients, sources, codecs). Members and
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
    this.members = new Set()
    this.sources = new Map() // NodeId -> { node, owner, kind, codec, streamKey, paused }
    this.speakers = new Set()
    // The node's E2EE GroupParams: { ciphersuite, external_sender, format }.
    this.group = null
    this.hasSnapshot = false
  }

  // Replace everything. Returns the source diff against the previous state
  // (`updated`: sources kept whose state changed, e.g. a pause the deltas
  // missed before a resync) plus the speaker diff (see setSpeakers).
  applySnapshot({ channel_id, codecs, members = [], sources = [], speakers = [], group = null }) {
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
    this.members = new Set(members.map(String))
    this.sources = next
    this.group = group
    this.hasSnapshot = true
    return { added, removed, updated, speakers: this.setSpeakers(speakers) }
  }

  addClients(clients = []) {
    const added = []
    for (const client of clients.map(String)) {
      if (this.members.has(client)) continue
      this.members.add(client)
      added.push(client)
    }
    return added
  }

  removeClients(clients = []) {
    const removed = []
    for (const client of clients.map(String)) {
      if (this.members.delete(client)) removed.push(client)
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

// Flattens a ChannelSource. `kind` becomes its SourceType. `codec` is the
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
export const CloseCode = Object.freeze({
  UNSUPPORTED: 4000,
  FAIL_IDENTIFY: 4001,
  INTERNAL_ERROR: 4002,
  SESSION_TERMINATED: 4003,
  PARSE: 4004,
  REQUEST_FAILED: 4005,
  KICKED: 4006,
  E2EE_FAILED: 4007
})

// What a voice socket close means for the client.
//   recoverable: leave + rejoin for a fresh ticket can fix it
//   expected:    the normal result of leaving voice
export function classifyClose(code) {
  switch (code) {
    case CloseCode.UNSUPPORTED:
      return { reason: 'unsupported protocol version', recoverable: false, expected: false }
    case CloseCode.FAIL_IDENTIFY:
      return { reason: 'voice ticket rejected', recoverable: true, expected: false }
    case CloseCode.INTERNAL_ERROR:
      return { reason: 'voice server error', recoverable: true, expected: false }
    case CloseCode.SESSION_TERMINATED:
      return { reason: 'voice session ended by server', recoverable: true, expected: true }
    case CloseCode.PARSE:
      return {
        reason: 'voice server could not parse a message',
        recoverable: false,
        expected: false
      }
    case CloseCode.REQUEST_FAILED:
      return { reason: 'voice request failed', recoverable: true, expected: false }
    // Kicked or banned by a moderator. Rejoining on our own would undo that.
    case CloseCode.KICKED:
      return { reason: 'removed from voice', recoverable: false, expected: false }
    // The channel's E2EE delivery service failed on the node. A fresh session builds a new group.
    case CloseCode.E2EE_FAILED:
      return { reason: 'voice encryption failed on the server', recoverable: true, expected: false }
    default:
      return { reason: 'voice connection lost', recoverable: true, expected: false }
  }
}
