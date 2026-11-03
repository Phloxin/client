// End-to-end encryption of every media frame (server/backend/.voice_rewrite/PLAN-e2ee.md). The
// SFU only ever forwards ciphertext. E2EE is mandatory: there's no way to join voice without it.
//
// Every producer and consumer gets an RTCRtpScriptTransform attached through mediasoup-client's
// onRtpSender / onRtpReceiver hooks. Those run right after the transceiver is created and before
// any negotiation, so no frame ever leaves (or reaches the decoder) untransformed.
//
// Keys come from one MLS group per voice channel, run by the voice node's delivery service. The
// worker holds all of it; this module only carries the node's group events in (e2eeGroupEvent)
// and the worker's group requests out (setE2eeHandlers.request).
//
// Devtools handle, for looking at frames:
//   pylonE2ee.status                                   - group state: epoch, call code, roster
//   pylonE2ee.mode / setMode('mls' | 'static' | 'passthrough')
//                                                      - test modes; every client in a call
//                                                        must match. Not kept across reloads.
//   pylonE2ee.setRoot('text')                         - the 'static' mode's shared root
//   pylonE2ee.capture(10)                              - record 10s of frames to a file
//   pylonE2ee.capture(20, '14:05:00')                  - start at that local time; run it on every
//                                                        client so the captures line up
//   await pylonE2ee.stats()                            - per-transform frame and drop counts
import E2eeWorker from './worker.js?worker'
import { SourceType, sourceTypeForAppData } from '../soup/protocol'

const MODES = ['mls', 'static', 'passthrough']
const DEFAULT_ROOT = 'pylon-phase0'

let mode = 'mls'
let root = DEFAULT_ROOT
let selfId = null
let worker = null
let nextTransformId = 1
let nextWorkerRequest = 1
const workerRequests = new Map()
// Receive transform id -> sink node, for the keyframe requests decryption asks for.
const transformSinks = new Map()

let handlers = {}
let status = {
  status: 'idle',
  fatal: null,
  epoch: null,
  callCode: null,
  roster: [],
  mediaReady: false
}
const statusListeners = new Set()

// Fails if this runtime can't encrypt media, which means it can't join voice at all.
function ensureWorker() {
  if (worker) return worker
  if (typeof RTCRtpScriptTransform !== 'function') {
    throw new Error('Voice encryption needs RTCRtpScriptTransform, which this runtime lacks')
  }
  worker = new E2eeWorker({ name: 'pylon-e2ee' })
  worker.onmessage = onWorkerMessage
  worker.onerror = (event) => console.error('[E2EE] worker error:', event.message ?? event)
  pushConfig()
  return worker
}

function pushConfig() {
  worker?.postMessage({ type: 'config', mode, root, selfId })
}

function onWorkerMessage({ data }) {
  switch (data.type) {
    case 'request':
      sendGroupRequest(data.request)
      break
    case 'status':
      setStatus(data)
      break
    case 'fatal':
      handlers.onFatal?.(data.reason)
      break
    case 'keyframe': {
      const sink = transformSinks.get(data.id)
      if (sink != null) handlers.onKeyFrame?.(sink)
      break
    }
    case 'formats':
    case 'stats':
      workerRequests.get(data.request)?.(data)
      workerRequests.delete(data.request)
      break
    case 'capture':
      saveCapture(data)
      break
  }
}

function askWorker(message) {
  const request = nextWorkerRequest++
  return new Promise((resolve) => {
    workerRequests.set(request, resolve)
    ensureWorker().postMessage({ ...message, request })
  })
}

function sendGroupRequest(request) {
  const send = handlers.request
  if (!send) {
    console.warn('[E2EE] no voice session to send a group request on')
    return
  }
  const type = Object.keys(request)[0]
  Promise.resolve(send(request)).catch((err) => {
    console.warn(`[E2EE] group ${type} failed:`, err?.message ?? err)
    // Only a refusal counts against the join. A socket going down ends the session, and the
    // next one starts the join over (e2eeSuspend).
    if (err?.name === 'VoiceRequestError') {
      worker?.postMessage({
        type: 'request-failed',
        request: type,
        code: err.code,
        message: err.message
      })
    }
  })
}

function setStatus({ status: next, fatal, epoch, callCode, roster, mediaReady }) {
  const wasReady = status.mediaReady
  status = { status: next, fatal, epoch, callCode, roster, mediaReady }
  for (const listener of statusListeners) listener(status)
  if (mediaReady !== wasReady) handlers.onMediaReadyChange?.(mediaReady)
}

function saveCapture({ buffer, mode: capturedMode, records }) {
  const url = URL.createObjectURL(new Blob([buffer], { type: 'application/octet-stream' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `pylon-e2ee-${selfId ?? 'unknown'}-${capturedMode}-${Date.now()}.bin`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
  const mib = (buffer.byteLength / (1024 * 1024)).toFixed(1)
  console.log(`[E2EE] capture ready: ${records} records, ${mib} MiB`)
}

// ─── Voice session hooks (soup) ──────────────────────────────────

// The local user's client id. Its credential and frame keys are bound to it.
export function setE2eeSelf(id) {
  const next = id == null ? null : String(id)
  if (next === selfId) return
  selfId = next
  pushConfig()
}

//   request(groupRequest)  sends `{ Group: groupRequest }` with a Sync behind it: resolves once
//                          the session took it, rejects (VoiceRequestError) when it refused it
//   onFatal(reason)        'update-required' or 'e2ee-failed': the call can't be encrypted
//   onKeyFrame(sinkNode)   a video sink decrypts again after failures; ask for a keyframe
//   onMediaReadyChange(ready) video sinks may (or may no longer) be resumed (plan 5.5)
export function setE2eeHandlers(next) {
  handlers = { ...next }
}

// The frame formats this build speaks, for SetCapabilities. Throws if this runtime can't encrypt
// media at all.
export async function e2eeFormats() {
  const { formats } = await askWorker({ type: 'formats' })
  return formats
}

// Joins the channel's group, after a session's first Channel snapshot or a channel switch.
// `params` is the snapshot's GroupParams.
export function e2eeJoin(params, { move = false } = {}) {
  if (!params) {
    console.error('[E2EE] the channel snapshot has no group params')
    handlers.onFatal?.('update-required')
    return
  }
  ensureWorker().postMessage({ type: 'join', params, move })
}

// Left voice: drop the group and every key.
export function e2eeLeave() {
  worker?.postMessage({ type: 'leave' })
}

// The voice socket closed and a reconnect may follow. The group and its keys stay, since the
// reconnect's rejoin replaces our leaf in it; only the join timeout stops until then.
export function e2eeSuspend() {
  worker?.postMessage({ type: 'suspend' })
}

// The voice session resumed. A key package lost with the old socket is sent again.
export function e2eeResume() {
  worker?.postMessage({ type: 'resume' })
}

// One `Group` event from the voice node.
export function e2eeGroupEvent(event) {
  worker?.postMessage({ type: 'group', event })
}

// Whether video sinks may be resumed: false between joining a channel and the first Execute
// that includes us, so the first keyframe a sink asks for is one we can decrypt (plan 5.5).
export function e2eeMediaReady() {
  return status.mediaReady
}

// ─── UI ──────────────────────────────────────────────────────────

// { status: 'idle' | 'joining' | 'keyed' | 'ready' | 'failed', fatal, epoch, callCode, roster,
//   mediaReady }. `roster` is every client id that can decrypt the call (plan 5.7).
export function getE2eeStatus() {
  return status
}

export function subscribeE2ee(listener) {
  statusListeners.add(listener)
  return () => statusListeners.delete(listener)
}

// The roster resolved against the live client list: who can decrypt the call, and which of them
// aren't anyone we know (a listener the server added behind the channel's back, plan 5.7).
export function e2eeListeners(e2ee, clients, selfId) {
  const names = new Map(clients.map((client) => [String(client.id), client.name]))
  const self = selfId == null ? null : String(selfId)
  const listeners = (e2ee.roster ?? []).map((id) => ({
    id,
    self: id === self,
    name: id === self ? 'You' : (names.get(id) ?? null)
  }))
  const unknown = listeners.filter((l) => !l.self && l.name == null)
  return { listeners, unknown }
}

// ─── Transforms ──────────────────────────────────────────────────

function attach(target, options) {
  const id = nextTransformId++
  target.transform = new RTCRtpScriptTransform(ensureWorker(), { ...options, id })
  return id
}

// Chromium does not end a transform's streams when its sender or receiver goes away, so the
// worker is told explicitly once the producer or consumer is gone (or never came to be).
function detach(id) {
  if (id == null) return
  transformSinks.delete(id)
  worker?.postMessage({ type: 'detach', id })
}

async function tracked(create, id) {
  try {
    const endpoint = await create()
    if (endpoint.closed) detach(id())
    else endpoint.observer.once('close', () => detach(id()))
    return endpoint
  } catch (err) {
    detach(id())
    throw err
  }
}

// The AAD source tag of each source type (plan 3.4). A frame only decrypts for the source it was
// sent from, so the node can't play one of a sender's sources into another's sink.
const SOURCE_TAG = {
  [SourceType.Microphone]: 1,
  [SourceType.Webcam]: 2,
  [SourceType.Stream]: 3,
  [SourceType.StreamAudio]: 4
}

// `{ tag, streamKey }` for a source type, or null when it isn't one we know (the worker then
// drops every frame).
function sourceBinding(type, streamKey) {
  const tag = SOURCE_TAG[type]
  if (tag == null) return null
  const keyed = type === SourceType.Stream || type === SourceType.StreamAudio
  return { tag, streamKey: keyed ? (streamKey ?? null) : null }
}

export function wrapSendTransport(transport) {
  const produce = transport.produce.bind(transport)
  transport.produce = (options = {}) => {
    const kind = options.track?.kind ?? null
    let id = null
    return tracked(
      () =>
        produce({
          ...options,
          onRtpSender: (rtpSender) => {
            id = attach(rtpSender, {
              role: 'send',
              kind,
              // The worker prefers each frame's own mimeType; this covers frames without one.
              codec: options.codec?.mimeType ?? (kind === 'audio' ? 'audio/opus' : null),
              source: sourceBinding(
                sourceTypeForAppData(options.appData),
                options.appData?.streamKey
              )
            })
            options.onRtpSender?.(rtpSender)
          }
        }),
      () => id
    )
  }
  return transport
}

// Consumers must pass, in appData:
//   owner:  the client id of the source's owner, whose key decrypts it
//   source: the source's `{ kind: SourceType, streamKey }` from its ChannelSource
//   sink:   the sink node, which keyframe requests name
export function wrapRecvTransport(transport) {
  const consume = transport.consume.bind(transport)
  transport.consume = (options) => {
    let id = null
    return tracked(
      () =>
        consume({
          ...options,
          onRtpReceiver: (rtpReceiver) => {
            const { owner, source, sink } = options.appData ?? {}
            id = attach(rtpReceiver, {
              role: 'recv',
              kind: options.kind,
              codec: options.rtpParameters?.codecs?.[0]?.mimeType ?? null,
              owner: owner == null ? null : String(owner),
              source: sourceBinding(source?.kind, source?.streamKey)
            })
            if (sink != null) transformSinks.set(id, sink)
            options.onRtpReceiver?.(rtpReceiver)
          }
        }),
      () => id
    )
  }
  return transport
}

// ─── Devtools ────────────────────────────────────────────────────

// Milliseconds until `at`: a local 'HH:MM' or 'HH:MM:SS' today, or anything Date accepts.
function captureDelay(at) {
  const clock = typeof at === 'string' && /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(at)
  const target = clock
    ? new Date().setHours(Number(clock[1]), Number(clock[2]), Number(clock[3] ?? 0), 0)
    : new Date(at).getTime()
  if (Number.isNaN(target)) throw new Error(`can't read capture start time ${at}`)
  const delay = target - Date.now()
  if (delay < 0) throw new Error(`capture start time ${at} has already passed`)
  return delay
}

globalThis.pylonE2ee = {
  get status() {
    return status
  },
  get mode() {
    return mode
  },
  setMode(next) {
    if (!MODES.includes(next)) throw new Error(`mode must be one of ${MODES.join(', ')}`)
    mode = next
    pushConfig()
    return mode
  },
  get root() {
    return root
  },
  setRoot(next = DEFAULT_ROOT) {
    root = String(next)
    pushConfig()
    return root
  },
  capture(seconds = 10, at = null) {
    const delay = at == null ? 0 : captureDelay(at)
    const start = () => ensureWorker().postMessage({ type: 'capture', ms: seconds * 1000 })
    if (delay > 0) {
      console.log(`[E2EE] capture starts in ${(delay / 1000).toFixed(1)}s`)
      setTimeout(start, delay)
    } else start()
  },
  async stats() {
    const { streams } = await askWorker({ type: 'stats' })
    console.table(streams.map(({ drops, ...rest }) => ({ ...rest, drops: JSON.stringify(drops) })))
    return streams
  }
}
