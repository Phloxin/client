// Main-process host for pylon-media-host, the native media engine's sidecar
// (native/media-engine/PROTOCOL.md). Each sidecar is a child process driven
// with the protocol's JSON lines on its stdin and stdout; its stderr goes to
// this process's log, line by line. The renderer reaches it over mediaengine:*
// IPC (the preload's window.api.mediaEngine):
//   available()     { available, codecs, source, pattern, settingShown, preview }: whether a native
//                   share is configured (PYLON_NATIVE_SHARE, else the "Native screen share"
//                   setting in app-settings.json: nativeShareSource.js) and the sidecar
//                   binary is there, the codecs the last sidecar's hello listed (null while
//                   none has said hello in this app's life), the configured source's kind
//                   ('screen', 'file', 'pattern' or null), the pattern's size and rate for
//                   'pattern', and whether the setting's row is shown (Windows or Wayland,
//                   and a sidecar binary), and in development PYLON_NATIVE_PREVIEW's preview
//                   size and rate (previewRequest.js, else null). Read anew on each call, so
//                   a change of the setting takes effect at the next share
//   capture({ maxFps, id })  for the screen source only: starts a sidecar,
//                   says hello, sends `capture` (at most maxFps frames a second)
//                   and waits for capture_ready: on Wayland as long as the person
//                   takes in the portal's dialog, on Windows for the source the
//                   app's picker chose (what main holds for this share, see
//                   setupMediaEngine). Resolves with capture_ready's fields and the
//                   sidecar's hello.codecs as `codecs`, or
//                   { cancelled: true } (the sidecar is then closed), or rejects
//   cancelCapture(id)  closes capture id's sidecar while it is still pending
//   open(params)    sends `open` to the sidecar capture() started, or starts one
//                   and says hello first; resolves with `opened` (and the pid) or
//                   rejects. Its `source` is this process's own reading of the
//                   configured source, and only the fields `open` has are passed on.
//                   Its video.codec ('H264' when absent, or 'AV1') goes to the sidecar
//                   only when that sidecar's hello listed it, else the open fails
//   start(pid), setKey(pid, key), close(pid)   the protocol's messages, for the
//                   sidecar with that pid only
//   preview(pid, { fps, max_width, max_height })   asks that sidecar for the sharer's
//                   preview pictures; refused (false) outside the protocol's limits
// and gets 'mediaengine:event' messages: ice_state, connected, stats, error,
// capture_changed, preview, closed, and exit once the process is gone. One sidecar per
// window at a time.
//
// `open` and `key` carry the frame key, so nothing written to a sidecar is ever
// logged. `preview` messages are the sharer's screen: they go only to the window that
// owns the sidecar and are never logged, nor their size. The portal's restore token stays here, in memory for the life of the
// app, and is not logged either (Wayland only: Windows has none).
import { app, ipcMain } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { previewOverride, previewRequestBody } from './previewRequest'
import {
  nativeShareSettingApplies,
  nativeShareSource,
  nativeShareSourceKind
} from './nativeShareSource'

const PROTOCOL = 1
// A sidecar whose stdin was closed and that hasn't exited by then is killed.
const KILL_AFTER_MS = 2000
// How long hello and open together may take before the open counts as failed.
const OPEN_TIMEOUT_MS = 10_000
// The file source's rate (the renderer works its bitrate out for the same).
const FILE_FPS = 30
// Sidecar messages the renderer is told of.
const EVENTS = new Set([
  'ice_state',
  'connected',
  'stats',
  'error',
  'capture_changed',
  'preview',
  'closed'
])
// Sidecar messages that answer a request.
const ANSWERS = new Set(['hello', 'opened', 'capture_ready', 'capture_cancelled'])

// webContents id -> engine
const engines = new Map()
const isWindows = process.platform === 'win32'
// On Windows: () => the `capture` target for this share, from main's own state (index.js).
let windowsCaptureTarget = null
// () => whether the "Native screen share" setting is on (index.js, app-settings.json).
let nativeShareSetting = () => false
let unavailableLogged = false
let quitting = false
// The last restore token the portal gave, passed with the next capture.
let restoreToken = null
// hello.codecs of the last sidecar that said hello, or null before the first.
let helloCodecs = null
// The codecs `open` may ask for (PROTOCOL.md, video.codec).
const OPEN_CODECS = new Set(['H264', 'AV1'])
// webContents id -> the capture being started for it: { id, cancelled, engine }
const captures = new Map()

// The configured source: { file } for an Annex-B H264 file, { pattern: { width, height,
// fps } }, { screen: true } on Wayland or Windows, or null. PYLON_NATIVE_SHARE when it is
// set (`off` turns it off), else the setting, which means the screen
// (nativeShareSource.js). The one place that decides: the renderer is told the kind.
function configuredSource() {
  let setting = false
  try {
    setting = nativeShareSetting() === true
  } catch (err) {
    console.warn(
      '[mediaEngine] Could not read the native screen share setting:',
      err?.message ?? err
    )
  }
  return nativeShareSource({
    env: process.env.PYLON_NATIVE_SHARE,
    platform: process.platform,
    sessionType: process.env.XDG_SESSION_TYPE,
    setting,
    isAbsolute
  })
}

function nativeShareConfigured() {
  return configuredSource() != null
}

const isIntegerIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max

// What `open` sends as its source, from the configured one. For the screen the renderer's
// rate and maximum size (the share's picker) are taken, and nothing else from it.
function openSource(configured, requested) {
  if (configured.file) return { file: { path: configured.file, fps: FILE_FPS } }
  if (configured.pattern) {
    const { width, height, fps } = configured.pattern
    return { pattern: { width, height, fps } }
  }
  const fps = requested?.screen?.fps
  const maxWidth = requested?.screen?.max_width
  const maxHeight = requested?.screen?.max_height
  const inRange =
    isIntegerIn(fps, 1, 240) && isIntegerIn(maxWidth, 16, 4096) && isIntegerIn(maxHeight, 16, 4096)
  if (!inRange) throw new Error('open: the screen source is out of range')
  return { screen: { fps, max_width: maxWidth, max_height: maxHeight } }
}

// The body of `open`: the protocol's fields of the renderer's params and nothing more.
function openBody(params, source) {
  const e2ee = params?.e2ee
  if (!e2ee || typeof e2ee !== 'object') throw new Error('open: no e2ee')
  const transport = params?.transport ?? {}
  const codec = params?.video?.codec ?? 'H264'
  if (!OPEN_CODECS.has(codec)) throw new Error('open: the video codec is not H264 or AV1')
  return {
    router_rtp_capabilities: params?.router_rtp_capabilities,
    transport: {
      id: transport.id,
      ice_parameters: transport.ice_parameters,
      ice_candidates: transport.ice_candidates,
      dtls_parameters: transport.dtls_parameters
    },
    e2ee: {
      format: e2ee.format,
      epoch: e2ee.epoch,
      key: e2ee.key,
      kid: e2ee.kid,
      counter: e2ee.counter,
      source: { tag: e2ee.source?.tag, stream_key: e2ee.source?.stream_key ?? null }
    },
    source,
    video: {
      start_bitrate: params?.video?.start_bitrate,
      max_bitrate: params?.video?.max_bitrate,
      codec
    }
  }
}

// PYLON_MEDIA_HOST, else the workspace build under the app's root in
// development (pylon-media-host.exe on Windows). Packaged builds have none yet.
function hostBinary() {
  const override = process.env.PYLON_MEDIA_HOST?.trim()
  if (override) return override
  if (app.isPackaged) return null
  const name = isWindows ? 'pylon-media-host.exe' : 'pylon-media-host'
  return join(app.getAppPath(), 'native/media-engine/target/release', name)
}

// Whether the setting's row is shown: where the setting can work, and a sidecar binary is
// there (T3).
function settingShown() {
  if (
    !nativeShareSettingApplies({
      platform: process.platform,
      sessionType: process.env.XDG_SESSION_TYPE
    })
  ) {
    return false
  }
  const binary = hostBinary()
  return binary != null && existsSync(binary)
}

// What the renderer is told: available(), the codecs it decides with, the configured
// source's kind (and the pattern's shape, which its maximum bitrate is worked out for), and
// whether the setting's row is shown.
function status() {
  const source = configuredSource()
  return {
    available: available(),
    codecs: helloCodecs ? [...helloCodecs] : null,
    source: nativeShareSourceKind(source),
    pattern: source?.pattern ? { ...source.pattern } : null,
    settingShown: settingShown(),
    preview: devPreviewOverride()
  }
}

// PYLON_NATIVE_PREVIEW's size and rate for the preview, in development only (not packaged):
// { fps, max_width, max_height }, or null. Read at each status, so at each share.
function devPreviewOverride() {
  if (app.isPackaged) return null
  return previewOverride(process.env.PYLON_NATIVE_PREVIEW)
}

function available() {
  if (!nativeShareConfigured()) return false
  const binary = hostBinary()
  if (binary && existsSync(binary)) return true
  if (!unavailableLogged) {
    unavailableLogged = true
    console.warn(`[mediaEngine] Media engine unavailable: no sidecar at ${binary ?? '(none)'}`)
  }
  return false
}

function write(engine, message) {
  if (engine.gone || !engine.child.stdin.writable) return false
  engine.child.stdin.write(JSON.stringify(message) + '\n')
  return true
}

// Each event names its process, so a renderer can tell an old sidecar's last
// words from those of the one it just opened.
function sendEvent(engine, event) {
  if (!engine.sender.isDestroyed()) {
    engine.sender.send('mediaengine:event', { ...event, pid: engine.pid })
  }
}

function settleWaiter(engine, name, error, value) {
  const waiter = engine.waiting.get(name)
  if (!waiter) return
  engine.waiting.delete(name)
  if (error) waiter.reject(error)
  else waiter.resolve(value)
}

function failWaiters(engine, error) {
  for (const name of [...engine.waiting.keys()]) settleWaiter(engine, name, error)
}

function waitFor(engine, name) {
  return new Promise((resolve, reject) => engine.waiting.set(name, { resolve, reject }))
}

function onLine(engine, line) {
  if (!line.trim()) return
  let message
  try {
    message = JSON.parse(line)
  } catch {
    console.warn(`[mediaEngine ${engine.pid}] Unreadable sidecar line`)
    return
  }
  const [name] = Object.keys(message ?? {})
  const body = message?.[name] ?? {}
  if (ANSWERS.has(name)) {
    settleWaiter(engine, name, null, body)
    return
  }
  if (name === 'error' && body.fatal) {
    failWaiters(engine, new Error(body.message ?? 'media engine error'))
  }
  if (name === 'closed') failWaiters(engine, new Error(`media engine closed (${body.reason})`))
  if (EVENTS.has(name)) sendEvent(engine, { type: name, ...body })
}

function lineReader(onEach) {
  let buffer = ''
  return (chunk) => {
    buffer += chunk
    let end
    while ((end = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, end)
      buffer = buffer.slice(end + 1)
      onEach(line)
    }
  }
}

function startEngine(sender) {
  const binary = hostBinary()
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] })
  const engine = {
    child,
    pid: child.pid ?? null,
    sender,
    waiting: new Map(),
    gone: false,
    killTimer: null,
    exited: null,
    onDestroyed: null,
    onNavigation: null,
    onRendererGone: null
  }
  engine.exited = new Promise((resolve) => {
    const gone = (code, signal) => {
      if (engine.gone) return
      engine.gone = true
      clearTimeout(engine.killTimer)
      if (engines.get(sender.id) === engine) engines.delete(sender.id)
      if (!sender.isDestroyed()) {
        sender.off('destroyed', engine.onDestroyed)
        sender.off('did-start-navigation', engine.onNavigation)
        sender.off('render-process-gone', engine.onRendererGone)
      }
      failWaiters(engine, new Error(`media engine exited (${signal ?? code})`))
      console.log(`[mediaEngine ${engine.pid}] Sidecar exited (${signal ?? `status ${code}`})`)
      sendEvent(engine, { type: 'exit', code, signal })
      resolve()
    }
    child.on('exit', gone)
    child.on('error', (err) => {
      console.warn(`[mediaEngine ${engine.pid}] Sidecar failed: ${err.message}`)
      gone(null, null)
    })
  })
  child.stdout.setEncoding('utf8')
  child.stdout.on(
    'data',
    lineReader((line) => onLine(engine, line))
  )
  child.stderr.setEncoding('utf8')
  child.stderr.on(
    'data',
    lineReader((line) => {
      if (line.trim()) console.log(`[media-host ${engine.pid}] ${line}`)
    })
  )
  // A write after the sidecar went away must not take the main process down.
  child.stdin.on('error', () => {})
  engine.onDestroyed = () => void shutdown(engine)
  sender.once('destroyed', engine.onDestroyed)
  // The page that opened it can go while the webContents lives on: a reload or a navigation
  // of the main frame, or the renderer process crashing or being killed. Its share is gone
  // then, so is the sidecar (as index.js treats the session's owner).
  engine.onNavigation = (details) => {
    if (!details?.isMainFrame || details.isSameDocument) return
    console.log(`[mediaEngine ${engine.pid}] The page left (navigation), closing the sidecar`)
    void shutdown(engine)
  }
  engine.onRendererGone = (_event, details) => {
    console.log(
      `[mediaEngine ${engine.pid}] The renderer is gone (${details?.reason}), closing the sidecar`
    )
    void shutdown(engine)
  }
  sender.on('did-start-navigation', engine.onNavigation)
  sender.on('render-process-gone', engine.onRendererGone)
  engines.set(sender.id, engine)
  console.log(`[mediaEngine ${engine.pid}] Sidecar started for window ${sender.id}`)
  return engine
}

// Asks the sidecar to stop and closes its stdin. Killed if it hasn't exited
// KILL_AFTER_MS later. Resolves once it's gone.
function shutdown(engine) {
  engine.closing = true
  if (!engine.gone && engine.killTimer == null) {
    write(engine, { close: {} })
    engine.child.stdin.end()
    engine.killTimer = setTimeout(() => {
      if (engine.gone) return
      console.warn(`[mediaEngine ${engine.pid}] Sidecar did not exit, killing it`)
      engine.child.kill('SIGKILL')
    }, KILL_AFTER_MS)
  }
  return engine.exited
}

// Says hello to a new sidecar, within `timedOut`.
async function greet(engine, timedOut) {
  const hello = waitFor(engine, 'hello')
  write(engine, { hello: { protocol: PROTOCOL } })
  const greeting = await Promise.race([hello, timedOut])
  if (greeting?.protocol !== PROTOCOL) {
    throw new Error(`media engine speaks protocol ${greeting?.protocol}`)
  }
  const codecs = Array.isArray(greeting.codecs)
    ? greeting.codecs.filter((codec) => typeof codec === 'string')
    : []
  engine.codecs = codecs
  helloCodecs = codecs
}

// The window's sidecar, once one that was already shutting down is gone. A share restarted
// while the old sidecar exits waits for it instead of failing.
async function liveEngine(sender) {
  let existing = engines.get(sender.id)
  while (existing && !existing.gone && existing.closing) {
    await existing.exited
    existing = engines.get(sender.id)
  }
  return existing && !existing.gone ? existing : null
}

function deadline(message) {
  let timer = null
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), OPEN_TIMEOUT_MS)
  })
  timedOut.catch(() => {})
  return { timedOut, clear: () => clearTimeout(timer) }
}

// Starts a sidecar for a screen capture and waits, without a time limit, for
// capture_ready (on Wayland the person in the portal's dialog).
async function capture(sender, options = {}) {
  if (!configuredSource()?.screen) throw new Error('The media engine captures only for screen')
  const pending = { id: options?.id ?? null, cancelled: false, engine: null }
  captures.set(sender.id, pending)
  try {
    if (await liveEngine(sender)) throw new Error('A media engine is already open for this window')
    if (pending.cancelled) throw new Error('The screen capture was cancelled')
    if (!available()) throw new Error('The media engine is unavailable')
    // On Windows what is captured is the source main holds for this share (K3 of
    // .plans/native-media-engine-m7-6-client.md). Nothing to capture fails here.
    if (isWindows && !windowsCaptureTarget) throw new Error('No capture target on Windows')
    const target = isWindows ? windowsCaptureTarget().target : null
    pending.engine = startEngine(sender)
    return await captureWith(pending.engine, options, target)
  } finally {
    if (captures.get(sender.id) === pending) captures.delete(sender.id)
  }
}

// Closes the pending capture `id` of this window and its sidecar, if it is still pending.
function cancelCapture(sender, id) {
  const pending = captures.get(sender.id)
  if (!pending || pending.id !== id) return
  pending.cancelled = true
  if (pending.engine) {
    console.log(`[mediaEngine ${pending.engine.pid}] Screen capture cancelled by the share`)
    void shutdown(pending.engine)
  }
}

// `target`: on Windows, what to capture (null: the primary monitor). Unused elsewhere.
async function captureWith(engine, options, target) {
  const hello = deadline('media engine hello timed out')
  try {
    await greet(engine, hello.timedOut)
    hello.clear()
    const ready = waitFor(engine, 'capture_ready')
    const cancelled = waitFor(engine, 'capture_cancelled')
    const fps = Number(options?.maxFps)
    const maxFps = Number.isInteger(fps) && fps >= 1 && fps <= 240 ? fps : null
    if (isWindows) {
      // No restore token on Windows. No target is left out: the primary monitor.
      const screen = target ? { target, max_fps: maxFps } : { max_fps: maxFps }
      write(engine, { capture: { screen } })
    } else {
      write(engine, { capture: { screen: { restore_token: restoreToken, max_fps: maxFps } } })
    }
    const outcome = await Promise.race([
      ready.then((body) => ({ ready: body })),
      cancelled.then(() => ({ cancelled: true }))
    ])
    if (outcome.cancelled) {
      console.log(`[mediaEngine ${engine.pid}] Screen capture cancelled in the portal`)
      void shutdown(engine)
      return { cancelled: true }
    }
    const { restore_token: token, ...fields } = outcome.ready
    engine.captured = true
    if (isWindows) {
      console.log(
        `[mediaEngine ${engine.pid}] Screen capture ready: ${fields.width}x${fields.height} D3D11`
      )
    } else {
      restoreToken = token ?? null
      console.log(
        `[mediaEngine ${engine.pid}] Screen capture ready: ${fields.width}x${fields.height} ` +
          `${fields.format} ${fields.dmabuf ? 'DMA-BUF' : 'memory'}, restore token ${token ? 'kept' : 'none'}`
      )
    }
    return { ...fields, pid: engine.pid, codecs: [...engine.codecs] }
  } catch (err) {
    void shutdown(engine)
    throw new Error(err?.message ?? String(err))
  } finally {
    hello.clear()
    // The waiter that did not settle.
    engine.waiting.delete('capture_ready')
    engine.waiting.delete('capture_cancelled')
  }
}

async function open(sender, params) {
  const configured = configuredSource()
  if (!configured) throw new Error('The media engine is unavailable')
  const body = openBody(params, openSource(configured, params?.source))
  const existing = await liveEngine(sender)
  const captured = existing && existing.captured && !existing.openSent
  if (existing && !captured) throw new Error('A media engine is already open for this window')
  if (configured.screen && !captured) throw new Error('The screen was not captured')
  if (!captured && !available()) throw new Error('The media engine is unavailable')
  const engine = captured ? existing : startEngine(sender)
  engine.openSent = true
  const { timedOut, clear } = deadline('media engine open timed out')
  try {
    if (!captured) await greet(engine, timedOut)
    // Only a codec this sidecar said it has. Before the share is live a failure sends it to
    // Chromium.
    const codec = body.video.codec
    if (!engine.codecs?.includes(codec)) {
      throw new Error(
        `media engine cannot send ${codec} here, its hello lists ${(engine.codecs ?? []).join(', ') || 'none'}`
      )
    }
    if (!write(engine, { open: body })) throw new Error('media engine is gone')
    const opened = waitFor(engine, 'opened')
    const answer = await Promise.race([opened, timedOut])
    return { ...answer, pid: engine.pid }
  } catch (err) {
    void shutdown(engine)
    throw new Error(err?.message ?? String(err))
  } finally {
    clear()
  }
}

// The window's sidecar if it is the one with `pid`, else null.
function engineOf(sender, pid) {
  const engine = engines.get(sender.id)
  return engine && !engine.gone && pid != null && engine.pid === pid ? engine : null
}

// captureTarget: on Windows, () => { target } for the share being started, throwing
// when there is nothing it may capture (main/captureTarget.js). Unused elsewhere.
// nativeShareEnabled: () => whether the "Native screen share" setting is on.
export function setupMediaEngine({ captureTarget, nativeShareEnabled } = {}) {
  windowsCaptureTarget = captureTarget ?? null
  if (nativeShareEnabled) nativeShareSetting = nativeShareEnabled
  ipcMain.handle('mediaengine:available', () => status())
  ipcMain.handle('mediaengine:capture', (event, options) => capture(event.sender, options))
  ipcMain.handle('mediaengine:cancel-capture', (event, id) => cancelCapture(event.sender, id))
  ipcMain.handle('mediaengine:open', (event, params) => open(event.sender, params))
  ipcMain.handle('mediaengine:start', (event, pid) => {
    const engine = engineOf(event.sender, pid)
    return engine ? write(engine, { start: {} }) : false
  })
  ipcMain.handle('mediaengine:set-key', (event, pid, key) => {
    const engine = engineOf(event.sender, pid)
    if (!engine) return false
    return write(engine, { key: { format: key?.format, epoch: key?.epoch, key: key?.key } })
  })
  ipcMain.handle('mediaengine:preview', (event, pid, request) => {
    const engine = engineOf(event.sender, pid)
    const body = previewRequestBody(request)
    if (!engine || !body) return false
    return write(engine, { preview: body })
  })
  ipcMain.handle('mediaengine:close', async (event, pid) => {
    const engine = engineOf(event.sender, pid)
    if (engine) await shutdown(engine)
  })

  // Every sidecar goes with the app, each given its KILL_AFTER_MS to exit.
  app.on('before-quit', (event) => {
    const live = [...engines.values()].filter((engine) => !engine.gone)
    if (live.length === 0 || quitting) return
    quitting = true
    event.preventDefault()
    Promise.all(live.map(shutdown)).finally(() => app.quit())
  })
}
