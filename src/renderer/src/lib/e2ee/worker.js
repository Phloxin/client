// The E2EE worker (server/backend/.voice_rewrite/PLAN-e2ee.md section 9). It owns both the MLS
// group state and every RTCRtpScriptTransform of this client, so secrets never leave it: the
// main thread only carries group events in and group requests out.
//
// All of this client's senders share one session (one kid, one counter), so nonces never repeat
// across sources. Keys follow the plan's barrier: an epoch is decryptable as soon as this member
// enters it, but frames are only sent under it after the node's Execute.
//
// Test modes (devtools, see index.js): 'static' derives every key from a shared text root like
// phase 0 did, and 'passthrough' touches nothing. Both exist only to look at frames.
import init, {
  E2eeSession,
  FrameSource,
  Receiver,
  Sender,
  codecId,
  senderKey,
  supportedFormats
} from './pkg/pylon_e2ee.js'
import wasmUrl from './pkg/pylon_e2ee_bg.wasm?url'

const KID = 0
// A client that isn't keyed this long after asking to join sends a fresh key package (5.3).
const JOIN_TIMEOUT_MS = 15_000
// Failed joins in a row before giving up on the call (5.3).
const MAX_FAILED_JOINS = 3
// How long an epoch stays decryptable after the Execute that replaced it (plan 4).
const RETIRE_AFTER_MS = 10_000

const STATIC_EPOCH = 0
const STATIC_FORMAT = 1

const DROP_LOG_INTERVAL_MS = 5000

// Capture file layout, read by `cargo run --example capture` in ../pylon-e2ee. Big endian.
//   header: "PE2C" | version u8 | mode u8 (0 passthrough, 1 encrypted) | kid u8 | self u64
//           | started_ms u64 | ended_ms u64 (unix time, so captures can be lined up)
//   record: role u8 | stage u8 | codec u8 | flags u8 | stream u32 | rtp_ts u32 | peer u64
//           | source_len u8 | source (the AAD source binding) | len u32
//           | bytes (the drop reason, utf-8, when flags has DROPPED)
// The capture tool checks encrypted captures with the static root, so capture in 'static'.
const CAPTURE_VERSION = 3
const CAPTURE_HEADER_LEN = 31
const RECORD_FIXED_LEN = 25
const CAPTURE_LIMIT_BYTES = 256 * 1024 * 1024
const ROLE_ID = { send: 0, recv: 1 }
const STAGE_IN = 0
const STAGE_OUT = 1
const FLAG_KEY = 1
const FLAG_DROPPED = 2

const encoder = new TextEncoder()

let mode = 'mls'
let staticRoot = null
let selfId = null
const streams = new Map() // transform id -> per-transform state and counters
const detached = new Set() // ids detached before their transform showed up
let capture = null

// ─── MLS state ───────────────────────────────────────────────────
let session = null // E2eeSession, for selfId
let inVoice = false
let joinTimer = null
let failedJoins = 0
// Waiting for CreateGroup or a Welcome after sending a key package.
let awaitingKeys = false
// The epoch whose Welcome added us. Its Execute is when video may resume (5.5).
let joinedEpoch = null
let mediaReady = false
let fatal = null
const retireTimers = new Set()

// ─── Static test mode ────────────────────────────────────────────
let staticSender = null
const staticReceivers = new Map() // owner client id -> Receiver

const ready = init({ module_or_path: wasmUrl }).then(() => {
  // Start somewhere random in the lower half: with the static test root a reload reuses keys.
  staticSender = new Sender(KID, crypto.getRandomValues(new Uint32Array(1))[0] >>> 1)
  rekeyStatic()
})

function post(message, transfer) {
  self.postMessage(message, transfer ?? [])
}

function unixSeconds() {
  return Math.floor(Date.now() / 1000)
}

function fromBase64(text) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(text)
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function toBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64()
  let binary = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

function errorName(err) {
  return err?.message ?? String(err)
}

// ─── Group protocol ──────────────────────────────────────────────

function ensureSession() {
  if (session || selfId == null) return session
  // A random counter start costs nothing and keeps nonces apart even if a key ever came back.
  session = new E2eeSession(selfId, KID, crypto.getRandomValues(new Uint32Array(1))[0] >>> 1)
  return session
}

function publishStatus() {
  let status = 'idle'
  if (fatal) status = 'failed'
  else if (inVoice && session?.epoch != null && !awaitingKeys)
    status = mediaReady ? 'ready' : 'keyed'
  else if (inVoice) status = 'joining'
  const keyed = status === 'ready' || status === 'keyed'
  post({
    type: 'status',
    status,
    fatal,
    epoch: keyed ? session.epoch : null,
    callCode: keyed ? (session.callCode() ?? null) : null,
    roster: keyed ? session.roster() : [],
    mediaReady: inVoice && mediaReady
  })
}

function sendRequest(request) {
  post({ type: 'request', request })
}

function clearJoinTimer() {
  if (joinTimer != null) clearTimeout(joinTimer)
  joinTimer = null
}

// Asks to join (or rejoin) with a fresh key package, and starts the join timeout.
function sendKeyPackage() {
  if (!inVoice || fatal || !ensureSession()) return
  let keyPackage
  try {
    keyPackage = session.keyPackage(unixSeconds())
  } catch (err) {
    console.error('[E2EE] could not make a key package:', err)
    return failJoin('key-package')
  }
  awaitingKeys = true
  clearJoinTimer()
  joinTimer = setTimeout(() => {
    joinTimer = null
    if (awaitingKeys) failJoin('join timed out')
  }, JOIN_TIMEOUT_MS)
  sendRequest({ KeyPackage: { key_package: toBase64(keyPackage) } })
  publishStatus()
}

// A join that failed on our side: a timeout, or a commit or welcome we couldn't process. After
// MAX_FAILED_JOINS in a row the call can't be encrypted, and E2EE is mandatory.
function failJoin(reason) {
  failedJoins++
  console.warn(`[E2EE] join failed (${reason}), attempt ${failedJoins} of ${MAX_FAILED_JOINS}`)
  if (failedJoins >= MAX_FAILED_JOINS) {
    fatal = 'e2ee-failed'
    clearJoinTimer()
    publishStatus()
    post({ type: 'fatal', reason: fatal })
    return
  }
  sendKeyPackage()
}

function markKeyed() {
  awaitingKeys = false
  failedJoins = 0
  clearJoinTimer()
}

// A new voice session or channel. `params` is the snapshot's GroupParams.
function joinVoice(params, move) {
  inVoice = true
  fatal = null
  failedJoins = 0
  if (!ensureSession()) {
    console.error('[E2EE] no client id yet; cannot join')
    return
  }
  try {
    session.setParams(params.ciphersuite, fromBase64(params.external_sender), params.format)
  } catch (err) {
    fatal = 'update-required'
    console.error('[E2EE] node group params refused:', errorName(err))
    publishStatus()
    post({ type: 'fatal', reason: fatal })
    return
  }
  // The old channel's group is useless in a new one. A reconnect into the same channel keeps it:
  // the rejoin replaces our leaf in the same group, and its keys bridge the gap.
  if (move) {
    session.leave()
    mediaReady = false
  }
  joinedEpoch = null
  sendKeyPackage()
}

function leaveVoice() {
  inVoice = false
  awaitingKeys = false
  clearJoinTimer()
  for (const timer of retireTimers) clearTimeout(timer)
  retireTimers.clear()
  joinedEpoch = null
  mediaReady = false
  fatal = null
  failedJoins = 0
  session?.leave()
  publishStatus()
}

function scheduleRetire(epoch) {
  const timer = setTimeout(() => {
    retireTimers.delete(timer)
    try {
      session?.retire(epoch)
    } catch {
      // The session moved on; nothing to retire.
    }
  }, RETIRE_AFTER_MS)
  retireTimers.add(timer)
}

function commitAs(epoch) {
  const out = session.commit()
  const welcome = out.welcome
  sendRequest({
    Commit: {
      epoch,
      commit: toBase64(out.commit),
      welcome: welcome ? toBase64(welcome) : null
    }
  })
  out.free()
}

// One GroupEvent from the node (PLAN-e2ee.md 6.6).
function handleGroupEvent(event) {
  if (!inVoice || fatal || !session) return
  const type = typeof event === 'string' ? event : Object.keys(event ?? {})[0]
  const data = typeof event === 'string' ? null : event[type]

  switch (type) {
    case 'CreateGroup': {
      let info
      try {
        info = session.found(fromBase64(data.group_id), unixSeconds())
      } catch (err) {
        console.error('[E2EE] could not found the group:', errorName(err))
        return failJoin('found')
      }
      markKeyed()
      joinedEpoch = 0
      // The founder is alone and already sending.
      mediaReady = true
      sendRequest({ GroupCreated: { group_info: toBase64(info) } })
      break
    }

    case 'Proposals': {
      try {
        session.proposals(data.epoch, data.proposals.map(fromBase64))
      } catch (err) {
        // While waiting for a welcome, our old leaf may still see the old group's traffic.
        if (awaitingKeys) return
        console.warn('[E2EE] rejected proposals:', errorName(err))
        return failJoin('proposals')
      }
      if (String(data.committer) === selfId) {
        try {
          commitAs(data.epoch)
        } catch (err) {
          console.error('[E2EE] could not commit:', errorName(err))
        }
      }
      break
    }

    case 'CommitRequested':
      try {
        commitAs(data.epoch)
      } catch (err) {
        console.error('[E2EE] could not commit:', errorName(err))
      }
      break

    case 'Commit': {
      let next
      try {
        next = session.applyCommit(data.epoch, fromBase64(data.commit))
      } catch (err) {
        if (awaitingKeys) return
        console.warn('[E2EE] rejected a commit:', errorName(err))
        return failJoin('commit')
      }
      if (next == null) {
        // The commit removed us while we're still in the channel.
        if (!awaitingKeys) failJoin('removed')
        return
      }
      sendRequest({ Ready: { epoch: next } })
      break
    }

    case 'Welcome': {
      const rejoin = session.epoch != null && mediaReady
      try {
        session.join(data.epoch, fromBase64(data.welcome), fromBase64(data.ratchet_tree))
      } catch (err) {
        console.warn('[E2EE] rejected a welcome:', errorName(err))
        return failJoin('welcome')
      }
      markKeyed()
      joinedEpoch = data.epoch
      // A rejoin into the group we were already sending in keeps video flowing. A first join
      // waits for this epoch's Execute, so the first keyframe is one it can decrypt (5.5).
      mediaReady = rejoin
      break
    }

    case 'Execute': {
      let replaced
      try {
        replaced = session.execute(data.epoch)
      } catch {
        // We never entered this epoch, e.g. its Welcome went to our replaced leaf.
        return
      }
      if (replaced != null) scheduleRetire(replaced)
      if (!mediaReady && data.epoch === joinedEpoch) mediaReady = true
      break
    }

    case 'Rejoin':
      // The node asked (lost events, or a refound). Not a failure of ours.
      sendKeyPackage()
      break

    default:
      console.warn('[E2EE] unknown group event:', type)
      return
  }
  publishStatus()
}

// ─── Static test keys ────────────────────────────────────────────

function staticKey(clientId) {
  if (!staticRoot || clientId == null) return null
  try {
    return senderKey(staticRoot, clientId)
  } catch {
    return null
  }
}

function rekeyStatic() {
  if (!staticSender) return
  const key = staticKey(selfId)
  if (key) staticSender.setKey(STATIC_FORMAT, STATIC_EPOCH, key)
  else staticSender.clearKey()

  for (const receiver of staticReceivers.values()) receiver.free()
  staticReceivers.clear()
}

function staticReceiverFor(owner) {
  let receiver = staticReceivers.get(owner)
  if (receiver) return receiver

  const key = staticKey(owner)
  if (!key) return null
  receiver = new Receiver()
  receiver.setKey(STATIC_FORMAT, STATIC_EPOCH, key)
  staticReceivers.set(owner, receiver)
  return receiver
}

// ─── Messages from the main thread ───────────────────────────────

self.onmessage = async ({ data }) => {
  await ready
  switch (data.type) {
    case 'config': {
      mode = data.mode
      staticRoot = data.root ? encoder.encode(data.root) : null
      if (data.selfId !== selfId) {
        // Another account: nothing of the old session applies.
        session?.leave()
        session?.free()
        session = null
        selfId = data.selfId
      }
      rekeyStatic()
      break
    }
    case 'formats':
      post({ type: 'formats', request: data.request, formats: Array.from(supportedFormats()) })
      break
    case 'join':
      joinVoice(data.params, data.move === true)
      break
    case 'leave':
      leaveVoice()
      break
    case 'suspend':
      // The socket session ended. Nothing can be sent until the next one joins again.
      awaitingKeys = false
      clearJoinTimer()
      break
    case 'group':
      handleGroupEvent(data.event)
      break
    case 'request-failed':
      // A key package the session refused fails like a join: retry, then give up.
      if (data.request === 'KeyPackage' && awaitingKeys) failJoin(`refused: ${data.message}`)
      break
    case 'capture':
      startCapture(data.ms)
      break
    case 'detach': {
      const stream = streams.get(data.id)
      if (stream) {
        streams.delete(data.id)
        stream.abort.abort()
      } else {
        detached.add(data.id)
      }
      break
    }
    case 'stats':
      post({
        type: 'stats',
        request: data.request,
        streams: [...streams.values()].map(publicStats)
      })
      break
  }
}

// ─── Transforms ──────────────────────────────────────────────────

// The source binding this transform's frames are sealed for, or null if the main thread didn't
// name a valid one (every frame is then dropped).
function frameSource(source) {
  if (!source) return null
  try {
    return new FrameSource(source.tag, source.streamKey ?? undefined)
  } catch {
    return null
  }
}

self.onrtctransform = async ({ transformer }) => {
  const { id, role, kind = null, codec = null, owner = null, source = null } = transformer.options
  if (detached.delete(id)) return

  const stream = {
    id,
    role,
    kind,
    owner,
    source,
    binding: null,
    sourceBytes: new Uint8Array(0),
    hint: codec,
    mime: undefined,
    codec: 0,
    frames: 0,
    passed: 0,
    drops: {},
    // Video only: frames were dropped since the last good one, so the decoder needs a keyframe
    // once frames decrypt again (5.5).
    failing: false,
    lastDropLog: 0,
    abort: new AbortController()
  }
  streams.set(id, stream)

  await ready
  if (stream.abort.signal.aborted) return
  stream.binding = frameSource(source)
  if (stream.binding) stream.sourceBytes = stream.binding.bytes
  const step = role === 'send' ? encryptFrame : decryptFrame
  try {
    await transformer.readable
      .pipeThrough(
        new TransformStream({ transform: (frame, controller) => step(stream, frame, controller) })
      )
      .pipeTo(transformer.writable, { signal: stream.abort.signal })
  } catch (err) {
    if (!stream.abort.signal.aborted) console.warn(`[E2EE] ${role} #${id} transform ended:`, err)
  } finally {
    if (streams.get(id) === stream) streams.delete(id)
    stream.binding?.free()
    stream.binding = null
    forgetSenderIfUnused(stream)
  }
}

function forgetSenderIfUnused(stream) {
  if (stream.role !== 'recv' || stream.owner == null || !session) return
  for (const other of streams.values()) {
    if (other.role === 'recv' && other.owner === stream.owner) return
  }
  try {
    session.forgetSender(stream.owner)
  } catch {
    // Not a valid client id; nothing was kept for it.
  }
}

function frameInfo(stream, frame) {
  const meta = frame.getMetadata?.() ?? {}
  const mime = meta.mimeType || stream.hint
  if (mime !== stream.mime) {
    stream.mime = mime
    stream.codec = mime ? codecId(mime) : 0
  }
  return {
    codec: stream.codec,
    key: frame.type === 'key',
    rtpTimestamp: meta.rtpTimestamp ?? frame.timestamp ?? 0
  }
}

function encryptFrame(stream, frame, controller) {
  stream.frames++
  const info = frameInfo(stream, frame)
  const data = new Uint8Array(frame.data)
  record(stream, STAGE_IN, info, data)

  if (mode === 'passthrough' || data.byteLength === 0)
    return pass(stream, info, frame, data, controller)
  if (!info.codec) return drop(stream, info, 'no-codec')
  if (!stream.binding) return drop(stream, info, 'no-source')

  let sealed
  try {
    if (mode === 'static') {
      if (!staticSender) return drop(stream, info, 'no-key')
      sealed = staticSender.encrypt(info.codec, stream.binding, data)
    } else {
      if (!session) return drop(stream, info, 'no-key')
      sealed = session.encrypt(info.codec, stream.binding, data)
    }
  } catch (err) {
    return drop(stream, info, errorName(err))
  }
  frame.data = sealed.buffer
  pass(stream, info, frame, sealed, controller)
}

function decryptFrame(stream, frame, controller) {
  stream.frames++
  const info = frameInfo(stream, frame)
  const data = new Uint8Array(frame.data)
  record(stream, STAGE_IN, info, data)

  if (mode === 'passthrough' || data.byteLength === 0)
    return pass(stream, info, frame, data, controller)
  if (!info.codec) return drop(stream, info, 'no-codec')
  if (!stream.binding) return drop(stream, info, 'no-source')
  if (stream.owner == null) return drop(stream, info, 'no-key')

  let opened
  try {
    if (mode === 'static') {
      const receiver = staticReceiverFor(stream.owner)
      if (!receiver) return drop(stream, info, 'no-key')
      opened = receiver.decrypt(info.codec, stream.binding, data)
    } else {
      if (!session) return drop(stream, info, 'no-key')
      opened = session.decrypt(stream.owner, info.codec, stream.binding, data)
    }
  } catch (err) {
    if (stream.kind === 'video') stream.failing = true
    return drop(stream, info, errorName(err))
  }
  frame.data = opened.buffer
  if (stream.failing) {
    stream.failing = false
    // The decoder missed frames; ask the sender for a keyframe (5.5).
    post({ type: 'keyframe', id: stream.id })
  }
  pass(stream, info, frame, opened, controller)
}

function pass(stream, info, frame, bytes, controller) {
  stream.passed++
  record(stream, STAGE_OUT, info, bytes)
  controller.enqueue(frame)
}

// Fail closed: a frame that can't be encrypted is never sent, and one that can't be decrypted
// never reaches the decoder.
function drop(stream, info, reason) {
  stream.drops[reason] = (stream.drops[reason] ?? 0) + 1
  record(stream, STAGE_OUT, info, null, reason)

  const now = Date.now()
  if (now - stream.lastDropLog >= DROP_LOG_INTERVAL_MS) {
    stream.lastDropLog = now
    const from = stream.owner ? ` from ${stream.owner}` : ''
    const counts = Object.entries(stream.drops)
      .map(([reason, count]) => `${reason}=${count}`)
      .join(', ')
    console.warn(
      `[E2EE] ${stream.role} #${stream.id} (${stream.kind}${from}) dropping frames: ${counts}`
    )
  }
}

function publicStats({ id, role, kind, owner, source, mime, frames, passed, drops }) {
  return {
    id,
    role,
    kind,
    owner,
    source: source ? `${source.tag}${source.streamKey ? ` ${source.streamKey}` : ''}` : null,
    codec: mime ?? null,
    frames,
    passed,
    drops: { ...drops }
  }
}

// ─── Capture ─────────────────────────────────────────────────────

function clientIdBits(id) {
  try {
    return BigInt.asUintN(64, BigInt(id))
  } catch {
    return 0n
  }
}

function startCapture(ms) {
  if (capture) clearTimeout(capture.timer)
  capture = {
    chunks: [],
    bytes: CAPTURE_HEADER_LEN,
    startedAt: Date.now(),
    timer: setTimeout(finishCapture, ms)
  }
  console.log(`[E2EE] capturing frames for ${ms / 1000}s`)
}

function record(stream, stage, info, bytes, reason) {
  if (!capture) return

  const payload = reason ? encoder.encode(reason) : (bytes ?? new Uint8Array(0))
  const source = stream.sourceBytes
  const headerLen = RECORD_FIXED_LEN + source.byteLength
  const size = headerLen + payload.byteLength
  if (capture.bytes + size > CAPTURE_LIMIT_BYTES) {
    finishCapture()
    return
  }

  const chunk = new Uint8Array(size)
  const view = new DataView(chunk.buffer)
  view.setUint8(0, ROLE_ID[stream.role])
  view.setUint8(1, stage)
  view.setUint8(2, info.codec)
  view.setUint8(3, (info.key ? FLAG_KEY : 0) | (reason ? FLAG_DROPPED : 0))
  view.setUint32(4, stream.id)
  view.setUint32(8, info.rtpTimestamp >>> 0)
  view.setBigUint64(12, clientIdBits(stream.role === 'send' ? selfId : stream.owner))
  view.setUint8(20, source.byteLength)
  chunk.set(source, 21)
  view.setUint32(21 + source.byteLength, payload.byteLength)
  chunk.set(payload, headerLen)

  capture.chunks.push(chunk)
  capture.bytes += size
}

function finishCapture() {
  if (!capture) return
  const { chunks, startedAt, timer } = capture
  capture = null
  clearTimeout(timer)

  const header = new Uint8Array(CAPTURE_HEADER_LEN)
  const view = new DataView(header.buffer)
  header.set(encoder.encode('PE2C'), 0)
  view.setUint8(4, CAPTURE_VERSION)
  view.setUint8(5, mode === 'passthrough' ? 0 : 1)
  view.setUint8(6, KID)
  view.setBigUint64(7, clientIdBits(selfId))
  view.setBigUint64(15, BigInt(startedAt))
  view.setBigUint64(23, BigInt(Date.now()))

  new Blob([header, ...chunks]).arrayBuffer().then((buffer) => {
    post({ type: 'capture', buffer, mode, records: chunks.length }, [buffer])
  })
}
