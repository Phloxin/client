// A screen share whose video the native media engine sends: a pylon-media-host
// sidecar the main process runs (main/mediaEngine.js), on the session's third
// transport (SendAux), sealed with this client's own sender key and a kid of
// its own from the E2EE worker, in H264 or AV1 (soup/nativeCodec.js). On with the "Native
// screen share" setting (Advanced settings, Wayland and Windows), or PYLON_NATIVE_SHARE, which
// wins over it: `screen` as the setting does, `file:<H264 file, or IVF for AV1>` and the
// picture comes from that file, `pattern:<width>x<height>@<fps>` and the sidecar draws its
// test pattern and encodes it on the GPU, `off` for none. The main process decides
// (main/nativeShareSource.js) and says which in its status. For the screen the sidecar
// captures it (captureNativeScreen first): on Wayland through the desktop portal, on Windows
// the source the app's picker chose, which the main process holds.
// Plans: .plans/native-media-engine-m3-client.md, -m5b-capture.md, -m7-6-client.md,
// -av1-3-client.md, -m6-preview-2-client.md (the sharer's own picture, soup/nativePreview.js).
//
// startNativeShare resolves with a producer-like object that screenShare.js
// keeps in the share context's `producer`, so stop, pause, the server ending
// the share and replacement treat it like a Chromium producer. Closing it
// closes the sidecar and SendAux. A failure once it is live goes to onFailed,
// and screenShare carries the share on through Chromium.
//
// The frame key never goes into a log, an error or the test hooks.
import { e2eeEngineKey, e2eeReleaseEngineKey } from '../e2ee'
import { screenEncodingFor } from '../screenVideoProfile'
import { engineDtlsParameters } from './auxTransport'
import { nativeCodecMime } from './nativeCodec'
import {
  createPreviewGate,
  createPreviewPainter,
  jpegBytes,
  previewFps,
  previewRequest
} from './nativePreview'

// The file source's rate and the size its maximum bitrate is worked out for.
const FILE_FPS = 30
const FILE_SIZE = { width: 1280, height: 720 }
const START_BITRATE = 1_500_000
// The AAD source tag of a Stream (e2ee/index.js, SOURCE_TAG).
const STREAM_SOURCE_TAG = 3
const CONNECT_TIMEOUT_MS = 10_000
// ICE that stays disconnected this long counts as the engine failing.
const DISCONNECTED_FAIL_MS = 5_000
// Once connected the sidecar sends stats every second. None for this long counts as the
// engine failing (a hung sidecar).
const STATS_STALL_MS = 5_000
const HISTORY_LIMIT = 500
// The failure reason of a screen capture that ended by itself.
const CAPTURE_ENDED = 'engine-closed-capture_ended'

// What a native share that could not start throws when its screen capture
// ended meanwhile: the share ends, it does not fall back.
export class NativeCaptureEndedError extends Error {
  constructor() {
    super('The shared screen or window went away')
    this.name = 'NativeCaptureEndedError'
  }
}

function mediaEngine() {
  return typeof window === 'undefined' ? null : (window.api?.mediaEngine ?? null)
}

// What a native share sends, from main's status (nativeEngineStatus): { screen: true },
// { file: true } (main holds the file's path), { pattern: { width, height, fps } }, or null.
export function nativeShareSource(status) {
  switch (status?.source) {
    case 'screen':
      return { screen: true }
    case 'file':
      return { file: true }
    case 'pattern': {
      const { width, height, fps } = status.pattern ?? {}
      const positive = [width, height, fps].every((v) => Number.isInteger(v) && v > 0)
      return positive ? { pattern: { width, height, fps } } : null
    }
    default:
      return null
  }
}

let nextCapture = 1

// For the screen source: starts the sidecar and asks it for the screen,
// at most maxFps frames a second, waiting as long as the person takes in the
// portal on Wayland (on Windows the picker chose already). Returns { result, cancel }.
// `result` resolves with { width, height, format, dmabuf, pid, codecs } (codecs: the
// sidecar's hello.codecs), or { cancelled: true }
// when the person said no (the sidecar is closed then), and rejects when the portal or the
// sidecar failed or `cancel` closed the capture while it was still pending.
export function captureNativeScreen({ maxFps } = {}) {
  const engine = mediaEngine()
  if (!engine?.capture) {
    return {
      result: Promise.reject(new Error('The native media engine cannot capture')),
      cancel: () => {}
    }
  }
  const id = nextCapture++
  return {
    result: engine.capture({ maxFps, id }),
    cancel: () => void engine.cancelCapture?.(id).catch(() => {})
  }
}

// The size the encoder sends for a capture under the picker's maximum: scaled
// down to fit, never up, even sides (as the sidecar works it out).
function fittedSize(width, height, maxWidth, maxHeight) {
  const even = (v) => Math.max(v & ~1, 2)
  if (width <= maxWidth && height <= maxHeight) return { width: even(width), height: even(height) }
  const scale = Math.min(maxWidth / width, maxHeight / height)
  return { width: even(Math.round(width * scale)), height: even(Math.round(height * scale)) }
}

// Whether the main process can run the sidecar at all, the codecs the last sidecar's hello
// listed (null while none has said hello), the configured source's kind ('screen', 'file',
// 'pattern' or null) with the pattern's { width, height, fps }, whether the setting's row is
// shown, and PYLON_NATIVE_PREVIEW's { fps, max_width, max_height } in development (else null):
// { available, codecs, source, pattern, settingShown, preview }. Asked anew at each share.
const SOURCE_KINDS = new Set(['screen', 'file', 'pattern'])

export async function nativeEngineStatus() {
  try {
    const status = await mediaEngine()?.available?.()
    const codecs = Array.isArray(status?.codecs) ? status.codecs : null
    const source = SOURCE_KINDS.has(status?.source) ? status.source : null
    const pattern = source === 'pattern' && status?.pattern ? { ...status.pattern } : null
    const override = status?.preview
    const preview =
      override && [override.fps, override.max_width, override.max_height].every(Number.isInteger)
        ? { fps: override.fps, max_width: override.max_width, max_height: override.max_height }
        : null
    return {
      available: status?.available === true,
      codecs,
      source,
      pattern,
      settingShown: status?.settingShown === true,
      preview
    }
  } catch {
    return {
      available: false,
      codecs: null,
      source: null,
      pattern: null,
      settingShown: false,
      preview: null
    }
  }
}

// The sharer's own preview: the sidecar has no local track, so a canvas stands in. It shows a
// grey card until the sidecar's first preview picture, then the pictures (soup/nativePreview.js).
// Its stream delivers a frame whenever the canvas changes.
function placeholderStream() {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const draw = canvas.getContext('2d')
  draw.fillStyle = '#1e1f22'
  draw.fillRect(0, 0, canvas.width, canvas.height)
  draw.fillStyle = '#dbdee1'
  draw.font = '16px sans-serif'
  draw.textAlign = 'center'
  draw.fillText('Native screen share', canvas.width / 2, canvas.height / 2)
  return { stream: canvas.captureStream(), canvas }
}

// Puts a decoded preview picture on the canvas, which takes the picture's size.
function drawPreviewPicture(canvas, image) {
  if (canvas.width !== image.width || canvas.height !== image.height) {
    canvas.width = image.width
    canvas.height = image.height
  }
  canvas.getContext('2d').drawImage(image, 0, 0)
}

function decodePreviewPicture(picture) {
  const bytes = jpegBytes(picture?.jpeg)
  if (!bytes) return Promise.reject(new Error('preview picture is not base64'))
  return createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }))
}

// For the test hooks (PYLON_TEST=1): the preview's counts of the last few native shares, kept
// past their end. Counts, times and the canvas's size only, never a picture.
const PREVIEW_TALLY_LIMIT = 10
const previewTally = []

export function nativePreviewTally() {
  return previewTally.map((entry) => ({
    ...entry,
    requests: entry.requests.map((request) => ({ ...request })),
    counts: { ...entry.counts },
    canvas: { ...entry.canvas }
  }))
}

// Starts the native share in D11's order. Everything made is unmade when a
// later step fails, and the error is rethrown.
//   streamKey      the backend stream it publishes into (already created)
//   aux            soup/index.js's SendAux functions (configureScreenShare)
//   isActive()     false once the share was stopped or superseded
//   superseded()   the error to throw then
//   onFailed(reason)     the live share failed (D14), called at most once
//   onEnded(reason)      the live share's capture ended by itself (M5b D11): the
//                  share ends, no fallback. Called at most once, never with onFailed
//   optimizeFor    the share's 'detail' or 'motion'
//   capture        for the screen: captureNativeScreen's result, its sidecar
//                  waiting for `open`
//   video          for the screen: the picker's { width, height, fps }, the
//                  maximum size and the rate
//   codec          'H264' or 'AV1' (soup/nativeCodec.js)
//   configured     what is sent: nativeShareSource() of main's status
//   previewSeen()  whether the sharer's own screen tile is seen now: the preview is asked for
//                  only while it is (setPreviewSeen on the result follows it afterwards)
//   previewOverride  PYLON_NATIVE_PREVIEW's { fps, max_width, max_height } from main's status,
//                  or null (development only)
export async function startNativeShare({
  streamKey,
  aux,
  isActive,
  superseded,
  onFailed,
  onEnded,
  optimizeFor,
  capture = null,
  video = null,
  codec = 'H264',
  configured = null,
  previewSeen = () => false,
  previewOverride = null
}) {
  const engine = mediaEngine()
  if (!engine || !configured) throw new Error('The native media engine is not configured')
  if (configured.screen && !capture) throw new Error('The screen was not captured')
  const pattern = configured.pattern ?? null
  // The size and rate the maximum bitrate is worked out for, and what is sent.
  let shape = pattern ?? { ...FILE_SIZE, fps: FILE_FPS }
  let source = pattern
    ? { pattern: { width: pattern.width, height: pattern.height, fps: pattern.fps } }
    : { file: { fps: FILE_FPS } }
  if (configured.screen) {
    const fitted = fittedSize(capture.width, capture.height, video.width, video.height)
    shape = { ...fitted, fps: video.fps }
    source = { screen: { fps: video.fps, max_width: video.width, max_height: video.height } }
  }

  const history = []
  const note = (name, fields = {}) => {
    history.push({ name, t: Date.now(), ...fields })
    if (history.length > HISTORY_LIMIT) history.shift()
  }

  // A capture's sidecar is ours already, and runs until closed.
  let pid = capture?.pid ?? null
  let lastStats = null
  let live = false
  let failed = false
  let closed = false
  let paused = false
  let connected = false
  let disconnectedTimer = null
  let statsTimer = null
  let keyEngine = null
  let sourceId = null
  // What aux.create() gave: SendAux on the session it was made on.
  let auxHandle = null
  let engineOpen = capture != null
  let preview = null
  // The canvas the preview stream is captured from, what draws the sidecar's pictures on it,
  // and this share's entry in previewTally.
  let previewCanvas = null
  let painter = null
  let tally = null
  // Turns "the self tile is seen" into requests, at most one change in 250 ms (B2).
  let previewGate = null
  // The placeholder track itself. The preview stream may carry a capture track by the time
  // this closes (a fallback), which is not ours to stop.
  let placeholderTrack = null
  // Events that came before the open said which process is ours.
  let early = []
  let waitConnected = null
  let openedRtp = null
  // Why the engine failed while starting, if it did.
  let startFailure = null

  const failure = (reason) => {
    if (closed || failed) return
    note('failed', { reason })
    if (!live) {
      startFailure ??= reason
      waitConnected?.reject(new Error(`media engine failed before it was live (${reason})`))
      return
    }
    failed = true
    previewGate?.close()
    if (tally) tally.failedAt = Date.now()
    clearTimeout(disconnectedTimer)
    clearTimeout(statsTimer)
    // The capture ended by itself: the share ends, Chromium would only ask again.
    if (reason === CAPTURE_ENDED) {
      console.log('[Soup] Native screen share: the capture ended')
      if (engineOpen) {
        engineOpen = false
        engine.close(pid).catch(() => {})
      }
      onEnded?.('capture-ended')
      return
    }
    console.warn(`[Soup] Native screen share failed: ${reason}`)
    // The source stays until its replacement takes over from it.
    if (engineOpen) {
      engineOpen = false
      engine.close(pid).catch(() => {})
    }
    onFailed?.(reason)
  }

  const watchStats = () => {
    clearTimeout(statsTimer)
    statsTimer = setTimeout(() => {
      statsTimer = null
      failure('engine-stalled')
    }, STATS_STALL_MS)
  }

  const onEvent = (event) => {
    if (closed) return
    if (pid == null) {
      early.push(event)
      return
    }
    if (event.pid !== pid) return
    if (event.type === 'stats') {
      lastStats = event
      if (connected && !failed) watchStats()
      return
    }
    // The sharer's screen: drawn on the canvas only, never logged or kept in the history.
    if (event.type === 'preview') {
      painter?.offer(event)
      return
    }
    note(
      event.type,
      event.type === 'ice_state'
        ? { state: event.state }
        : event.type === 'capture_changed'
          ? { width: event.width, height: event.height }
          : event.type === 'closed'
            ? { reason: event.reason }
            : {}
    )
    switch (event.type) {
      case 'connected':
        connected = true
        watchStats()
        waitConnected?.resolve()
        break
      case 'ice_state':
        if (event.state === 'disconnected') {
          if (live && disconnectedTimer == null) {
            disconnectedTimer = setTimeout(() => {
              disconnectedTimer = null
              failure('ice-disconnected')
            }, DISCONNECTED_FAIL_MS)
          }
        } else if (event.state === 'connected' || event.state === 'completed') {
          clearTimeout(disconnectedTimer)
          disconnectedTimer = null
        }
        break
      case 'error':
        if (event.fatal) failure('engine-error')
        else console.warn(`[Soup] Native engine: ${event.message}`)
        break
      case 'closed':
        failure(`engine-closed-${event.reason}`)
        break
      case 'exit':
        engineOpen = false
        failure('engine-exited')
        break
    }
  }
  const unsubscribe = engine.onEvent(onEvent)

  // The newest { format, epoch, key } from the worker, and the one the sidecar has.
  let latestKey = null
  let engineKey = null
  const deliverKey = () => {
    if (pid == null || latestKey === engineKey) return
    engineKey = latestKey
    engine.setKey(pid, latestKey).catch(() => failure('key-not-delivered'))
  }
  const onKeyChange = (change) => {
    if (closed || failed) return
    if (change.type === 'engine-key-lost') {
      failure('key-withdrawn')
      return
    }
    note('key', { epoch: change.epoch })
    latestKey = { format: change.format, epoch: change.epoch, key: change.key }
    deliverKey()
  }

  // `ownSource`: our source leaves our own books here too. A live share's
  // callers do that themselves (stopShareContext), or the node already did
  // (a replacement).
  const undo = ({ ownSource = false } = {}) => {
    if (closed) return
    closed = true
    clearTimeout(disconnectedTimer)
    clearTimeout(statsTimer)
    unsubscribe()
    previewGate?.close()
    if (keyEngine != null) e2eeReleaseEngineKey(keyEngine)
    keyEngine = null
    if (engineOpen) engine.close(pid).catch(() => {})
    engineOpen = false
    // Before SendAux closes it on the node, so its Closed is no surprise.
    if (ownSource && sourceId != null) auxHandle?.closeSource(sourceId)
    auxHandle?.close().catch((err) => {
      console.log('[Soup] Closing the native share transport:', err?.message ?? err)
    })
    auxHandle = null
    if (tally) tally.endedAt = Date.now()
    placeholderTrack?.stop()
    // No copy of the key outlives the share.
    latestKey = null
    engineKey = null
  }

  // The sharer's own picture (soup/nativePreview.js): once live, and while the sharer's own
  // screen tile is seen (B1 and B2 of .plans/native-media-engine-preview-cost.md), the sidecar
  // is asked for preview pictures (fps 0 stops them while it is not), drawn on the preview
  // stream's canvas while the share is ours and the
  // placeholder track is still that stream's (a fallback swaps in Chromium's capture track).
  // A sidecar without pictures answers with a non-fatal error, and the grey card stays.
  const previewDrawable = () =>
    !closed &&
    !failed &&
    placeholderTrack?.readyState === 'live' &&
    preview?.getVideoTracks().includes(placeholderTrack) === true
  const requestPreview = (fps) => {
    if (closed || failed || !engineOpen || pid == null || !engine.preview) return
    tally?.requests.push({ fps, t: Date.now() })
    note('preview-request', { fps })
    engine.preview(pid, previewRequest(fps, previewOverride)).catch(() => {})
  }
  const startPreview = () => {
    tally = {
      pid,
      startedAt: Date.now(),
      failedAt: null,
      endedAt: null,
      lastDrawnAt: null,
      requests: [],
      counts: null,
      canvas: { width: previewCanvas.width, height: previewCanvas.height }
    }
    painter = createPreviewPainter({
      decode: decodePreviewPicture,
      draw: (image) => {
        drawPreviewPicture(previewCanvas, image)
        tally.canvas = { width: previewCanvas.width, height: previewCanvas.height }
        tally.lastDrawnAt = Date.now()
      },
      release: (image) => image?.close?.(),
      canDraw: previewDrawable
    })
    tally.counts = painter.counts
    previewTally.push(tally)
    if (previewTally.length > PREVIEW_TALLY_LIMIT) previewTally.shift()
    // While no pictures come the canvas keeps the last one (B3).
    previewGate = createPreviewGate({
      send: (seen) => requestPreview(seen ? previewFps(previewOverride) : 0)
    })
    previewGate.set(previewSeen() === true)
  }

  const step = (name) => {
    if (!isActive()) throw superseded()
    if (startFailure) throw new Error(`media engine failed before it was live (${startFailure})`)
    note(name)
  }

  try {
    step('create-transport')
    const handle = await aux.create()
    auxHandle = handle
    step('transport')
    const transport = handle.parameters
    if (!transport) throw new Error('The voice node sent no SendAux parameters')

    const { engine: engineId, kid, counter, ...firstKey } = await e2eeEngineKey(onKeyChange)
    keyEngine = engineId
    latestKey ??= { format: firstKey.format, epoch: firstKey.epoch, key: firstKey.key }
    step('key')

    const maxBitrate = screenEncodingFor({
      width: shape.width,
      height: shape.height,
      fps: shape.fps,
      codec: { mimeType: nativeCodecMime(codec) },
      optimizeFor
    }).maxBitrate
    note('open', { epoch: latestKey.epoch, codec })
    engineOpen = true
    engineKey = latestKey
    let opened
    try {
      opened = await engine.open({
        router_rtp_capabilities: aux.routerCapabilities(),
        transport,
        e2ee: {
          format: engineKey.format,
          epoch: engineKey.epoch,
          key: engineKey.key,
          kid,
          counter,
          source: { tag: STREAM_SOURCE_TAG, stream_key: streamKey }
        },
        source,
        video: { start_bitrate: START_BITRATE, max_bitrate: maxBitrate, codec }
      })
    } catch (err) {
      engineOpen = false
      throw err
    }
    pid = opened.pid
    openedRtp = opened.rtp_parameters
    note('opened', { pid, kid })
    for (const event of early.splice(0)) onEvent(event)
    early = null
    // A key that changed while the open was on its way.
    deliverKey()
    if (!isActive()) throw superseded()

    // A message the node cannot parse would end the whole voice session.
    const dtlsParameters = engineDtlsParameters(opened.dtls_parameters)
    step('connect-transport')
    await handle.connect(dtlsParameters)
    step('create-source')
    sourceId = await handle.createSource(opened.rtp_parameters, streamKey)
    step('start')
    if ((await engine.start(pid)) !== true) throw new Error('media engine is gone')

    if (!connected) {
      await new Promise((resolve, reject) => {
        if (startFailure) {
          reject(new Error(`media engine failed before it was live (${startFailure})`))
          return
        }
        const timer = setTimeout(
          () => reject(new Error('media engine did not connect in time')),
          CONNECT_TIMEOUT_MS
        )
        waitConnected = {
          resolve: () => {
            clearTimeout(timer)
            resolve()
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          }
        }
      })
      waitConnected = null
    }
    step('live')
    live = true
    const placeholder = placeholderStream()
    preview = placeholder.stream
    previewCanvas = placeholder.canvas
    placeholderTrack = preview.getVideoTracks()[0] ?? null
    console.log(`[Soup] Native screen share live: source ${sourceId}, engine pid ${pid}, ${codec}`)
    // The preview never costs the share.
    try {
      startPreview()
    } catch (err) {
      console.warn('[Soup] Native share preview did not start:', err?.message ?? err)
    }
  } catch (err) {
    undo({ ownSource: true })
    if (startFailure === CAPTURE_ENDED || /capture_ended/.test(err?.message ?? '')) {
      throw new NativeCaptureEndedError()
    }
    throw err
  }

  return {
    native: true,
    id: sourceId,
    kind: 'video',
    appData: { produced: 'ScreenShare', streamKey },
    rtpParameters: openedRtp,
    rtpSender: null,
    preview,
    get closed() {
      return closed
    },
    get paused() {
      return paused
    },
    // The node pauses the source (setSharePaused). The engine keeps sending.
    pause() {
      paused = true
    },
    resume() {
      paused = false
    },
    // Whether the sharer's own screen tile is seen (B2): pictures only while it is.
    setPreviewSeen(seen) {
      if (!closed && !failed) previewGate?.set(seen === true)
    },
    close() {
      if (closed) return
      note('close')
      undo()
    },
    getStats: async () => new Map(),
    replaceTrack: async () => {
      throw new Error('A native screen share has no track to replace')
    },
    // For the test hooks (PYLON_TEST=1). No key material.
    testInfo: () => ({
      native: true,
      sourceId,
      pid,
      live,
      failed,
      closed,
      stats: lastStats,
      events: history.map((entry) => ({ ...entry })),
      preview: tally ? { counts: { ...tally.counts }, canvas: { ...tally.canvas } } : null
    })
  }
}
