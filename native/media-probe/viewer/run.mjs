// Probe 2's driver (.plans/native-media-engine-probe2.md, D3). For each variant it starts the
// probe binary and a bare Electron viewer under Xvfb, relays the signalling between them,
// samples 5 s and 15 s after the consumer is resumed, and writes runs/<variant>/.
//
//   node run.mjs [plain] [encrypted] [wrong-key] [encoder] [screen] [--no-sei]
//
// `screen` (M5b T2) captures the real screen through the portal, so it waits up to five
// minutes for a person in the portal's dialog and is not in the default set. SCREEN_MAX
// (<w>x<h>, default 1920x1080), SCREEN_FPS (default 60) and SCREEN_TARGET (a Windows sidecar's
// capture target as JSON, then nobody is waited for) go to the probe. SAMPLE_SECONDS (default 10)
// is the time between the two samples.
//
// Needs ffmpeg (once, for the H264 file), Xvfb's DISPLAY, the client's nix shell (Electron via
// ELECTRON_OVERRIDE_DIST_PATH) and a built probe: PROBE_BIN, or
// $CARGO_TARGET_DIR/release/media-probe, or /tmp/media-probe-target/release/media-probe.
// The probe starts the pylon-media-host sidecar: PYLON_MEDIA_HOST, or the one beside the probe.
// --no-sei uses a copy of the file without SEI and writes runs/<variant>-nosei/.
//
// PROBE_CODEC=AV1 (AV1 step 2, Q11) sends AV1: the file variants play an IVF file of the same
// testsrc2 made by FFmpeg's libaom (made once, CPU only), `encoder` the pattern through the
// hardware encoder. The viewer's transform is told `video/AV1`, and runs go to
// runs/<variant>-av1/. The probe reads PROBE_CODEC itself.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'

const VIEWER = import.meta.dirname
const CLIENT = resolve(VIEWER, '../../..')
const { _electron: electron } = createRequire(join(CLIENT, 'e2e/package.json'))('playwright')
const { build } = await import('vite')

const VARIANTS = ['plain', 'encrypted', 'wrong-key', 'encoder', 'screen']
// The `encoder` variant (M5a D18): the pattern at 1920x1080 and 60 through the hardware encoder,
// encrypted as `encrypted`, so the numbers scale to 600 frames between the samples.
const SIZE = { encoder: [1920, 1080] }
const FRAMES = { encoder: 570 }
const STATIC_ROOT = 'media-probe static root'
const WRONG_ROOT = 'media-probe wrong root'
const VIEWER_ID = '1002'
const CODEC = process.env.PROBE_CODEC ?? 'H264'
if (CODEC !== 'H264' && CODEC !== 'AV1') throw new Error(`PROBE_CODEC=${CODEC}: expected H264 or AV1`)
const AV1 = CODEC === 'AV1'
const TRANSFORM = {
  role: 'recv',
  kind: 'video',
  codec: AV1 ? 'video/AV1' : 'video/H264',
  owner: '1001',
  source: { tag: 3, streamKey: 'probe-stream' }
}
const FIRST_SAMPLE_MS = 5_000
// SAMPLE_SECONDS sets the time between the samples (default 10, M7.5's gate runs 60).
const SECOND_SAMPLE_MS = FIRST_SAMPLE_MS + 1000 * Number(process.env.SAMPLE_SECONDS ?? 10)

const args = process.argv.slice(2)
const noSei = args.includes('--no-sei')
const variants = args.filter((a) => !a.startsWith('--'))
for (const v of variants) {
  if (!VARIANTS.includes(v)) throw new Error(`unknown variant ${v}, expected ${VARIANTS.join(', ')}`)
}
const run = variants.length ? variants : VARIANTS.filter((v) => v !== 'screen')

const PROBE_BIN =
  process.env.PROBE_BIN ??
  join(process.env.CARGO_TARGET_DIR ?? '/tmp/media-probe-target', 'release/media-probe')
const H264 = join(VIEWER, 'testsrc2-720p30.h264')
const H264_NO_SEI = join(VIEWER, 'testsrc2-720p30-nosei.h264')
const IVF = join(VIEWER, 'testsrc2-720p30-av1.ivf')

// Inherited desktop-session variables would put Electron on the real Wayland display instead of
// Xvfb (the same list as e2e/lib/launch.mjs).
const DESKTOP_ENV = [
  'WAYLAND_DISPLAY',
  'NIXOS_OZONE_WL',
  'XDG_SESSION_TYPE',
  'XDG_BACKEND',
  'GDK_BACKEND',
  'QT_QPA_PLATFORM',
  'SDL_VIDEODRIVER',
  'CLUTTER_BACKEND',
  'MOZ_ENABLE_WAYLAND',
  'ELECTRON_OZONE_PLATFORM_HINT'
]

function baseEnv() {
  const env = { ...process.env }
  for (const key of DESKTOP_ENV) delete env[key]
  return env
}

// The nix shell's Electron, as e2e/lib/launch.mjs picks it.
function electronBinary() {
  const dist = process.env.ELECTRON_OVERRIDE_DIST_PATH
  if (dist) return join(dist, 'electron')
  return createRequire(join(CLIENT, 'package.json'))('electron')
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString()

// ─── Inputs ──────────────────────────────────────────────────────

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: 'inherit' })
}

// D6: testsrc2, 1280x720, 30 fps, 20 s, Baseline, GOP 30, no B-frames, one slice per frame,
// parameter sets at every key frame, about 2.5 Mbps, Annex-B. SEI is left as x264 writes it.
function makeH264() {
  if (!existsSync(H264)) {
    console.log(`making ${H264}`)
    ffmpeg([
      '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x720:rate=30:duration=20',
      '-c:v', 'libx264',
      '-profile:v', 'baseline',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-keyint_min', '30',
      '-sc_threshold', '0',
      '-bf', '0',
      '-b:v', '2500k',
      '-maxrate', '2500k',
      '-bufsize', '2500k',
      '-x264-params', 'slices=1:repeat-headers=1',
      '-f', 'h264',
      H264
    ])
  }
  if (noSei && !existsSync(H264_NO_SEI)) {
    console.log(`making ${H264_NO_SEI}`)
    ffmpeg(['-i', H264, '-c:v', 'copy', '-bsf:v', 'filter_units=remove_types=6', '-f', 'h264', H264_NO_SEI])
  }
  return noSei ? H264_NO_SEI : H264
}

// The AV1 counterpart of D6: testsrc2, 1280x720, 30 fps, 20 s, a key frame every 30 frames,
// about 2.5 Mbps, libaom in real-time mode with no look-ahead (so one shown frame per temporal
// unit and no hidden frames), IVF.
function makeIvf() {
  if (!existsSync(IVF)) {
    console.log(`making ${IVF}`)
    ffmpeg([
      '-f', 'lavfi',
      '-i', 'testsrc2=size=1280x720:rate=30:duration=20',
      '-c:v', 'libaom-av1',
      '-usage', 'realtime',
      '-cpu-used', '8',
      '-lag-in-frames', '0',
      '-pix_fmt', 'yuv420p',
      '-g', '30',
      '-keyint_min', '30',
      '-b:v', '2500k',
      '-maxrate', '2500k',
      '-bufsize', '2500k',
      '-f', 'ivf',
      IVF
    ])
  }
  return IVF
}

function newestMtime(paths) {
  let newest = 0
  for (const path of paths) {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      newest = Math.max(newest, newestMtime(readdirSync(path).map((name) => join(path, name))))
    } else {
      newest = Math.max(newest, stat.mtimeMs)
    }
  }
  return newest
}

async function buildPage() {
  const built = join(VIEWER, 'dist', 'index.html')
  const inputs = [
    join(VIEWER, 'index.html'),
    join(VIEWER, 'page.js'),
    join(CLIENT, 'src/renderer/src/lib/e2ee/worker.js'),
    join(CLIENT, 'src/renderer/src/lib/e2ee/pkg'),
    join(CLIENT, 'node_modules/mediasoup-client/package.json')
  ]
  if (existsSync(built) && statSync(built).mtimeMs >= newestMtime(inputs)) return
  console.log('building the viewer page')
  await build({
    configFile: false,
    root: VIEWER,
    base: './',
    logLevel: 'warn',
    build: { outDir: join(VIEWER, 'dist'), emptyOutDir: true, target: 'esnext', minify: false },
    // The E2EE worker imports its WASM glue as an ES module (electron.vite.config.mjs).
    worker: { format: 'es' }
  })
}

// ─── The probe ───────────────────────────────────────────────────

function startProbe(variant, h264, dir) {
  const child = spawn(PROBE_BIN, ['viewer', '--variant', variant, AV1 ? '--ivf' : '--h264', h264], {
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const log = createWriteStream(join(dir, 'probe.log'))
  child.stderr.on('data', (d) => log.write(d))
  const exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })))

  const waiting = []
  const early = []
  createInterface({ input: child.stdout }).on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      log.write(`[driver] not JSON on stdout: ${line}\n`)
      return
    }
    const key = Object.keys(message)[0]
    const at = waiting.findIndex((w) => w.key === key || key === 'error')
    if (at < 0) return early.push(message)
    const [waiter] = waiting.splice(at, 1)
    clearTimeout(waiter.timer)
    if (key === 'error') waiter.reject(new Error(`probe: ${message.error}`))
    else waiter.resolve(message[key])
  })

  function next(key, timeoutMs = 30_000) {
    const at = early.findIndex((m) => key in m || 'error' in m)
    if (at >= 0) {
      const [message] = early.splice(at, 1)
      if ('error' in message) return Promise.reject(new Error(`probe: ${message.error}`))
      return Promise.resolve(message[key])
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiting.findIndex((w) => w.timer === timer)
        if (i >= 0) waiting.splice(i, 1)
        reject(new Error(`no ${key} from the probe within ${timeoutMs} ms`))
      }, timeoutMs)
      waiting.push({ key, resolve, reject, timer })
    })
  }

  function ask(message, key) {
    child.stdin.write(JSON.stringify(message) + '\n')
    return next(key)
  }

  async function stop() {
    if (child.exitCode == null && child.signalCode == null) {
      try {
        child.stdin.write(JSON.stringify({ stop: true }) + '\n')
        child.stdin.end()
      } catch {
        // Already gone.
      }
      const result = await Promise.race([exited, sleep(15_000).then(() => null)])
      if (!result) child.kill('SIGKILL')
    }
    const result = await exited
    await new Promise((r) => log.end(r))
    return result
  }

  return { child, next, ask, stop }
}

// ─── The viewer ──────────────────────────────────────────────────

function descendants(pid) {
  let out = []
  try {
    const children = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .map(Number)
    for (const child of children) out = out.concat(child, descendants(child))
  } catch {
    // pgrep exits 1 when there are none.
  }
  return out
}

async function startViewer(dir) {
  const userData = await mkdtemp(join(tmpdir(), 'media-probe-viewer-'))
  const log = createWriteStream(join(dir, 'console.log'))
  const pageErrors = []
  const write = (source, text) => {
    for (const line of String(text).split('\n')) {
      if (line.trim()) log.write(`${stamp()} [${source}] ${line}\n`)
    }
  }

  const app = await electron.launch({
    executablePath: electronBinary(),
    args: [join(VIEWER, 'main.cjs'), '--no-sandbox', `--user-data-dir=${userData}`],
    env: baseEnv(),
    timeout: 60_000
  })
  const pid = app.process().pid
  app.process().stdout.on('data', (d) => write('main', d))
  app.process().stderr.on('data', (d) => write('main', d))

  const page = await app.firstWindow({ timeout: 60_000 })
  page.on('console', (msg) => write(`console.${msg.type()}`, msg.text()))
  page.on('pageerror', (err) => {
    pageErrors.push(String(err?.stack ?? err))
    write('pageerror', err?.stack ?? err)
  })
  // The worker's console messages arrive on the page's console event as well.
  page.on('worker', (w) => write('driver', `worker started: ${w.url()}`))
  await page.waitForLoadState('load')
  await page.waitForFunction(() => window.viewer != null, null, { timeout: 30_000 })

  async function close() {
    const tree = [pid, ...descendants(pid)]
    const closed = app.close().then(
      () => true,
      () => false
    )
    await Promise.race([closed, sleep(15_000)])
    for (const p of tree.reverse()) {
      try {
        process.kill(p, 'SIGKILL')
      } catch {
        // Exited with the app.
      }
    }
    await new Promise((r) => log.end(r))
    await rm(userData, { recursive: true, force: true })
  }

  return { app, page, pageErrors, write, close }
}

// ─── Judging (D10) ───────────────────────────────────────────────

// The encoded size for a capture under a limit, as the encoder works it out: scaled down to
// fit, never up, even sides (pylon-media's output_size).
function outputSize(width, height, maxWidth, maxHeight) {
  const even = (v) => Math.max(v & ~1, 2)
  if (width <= maxWidth && height <= maxHeight) return [even(width), even(height)]
  const scale = Math.min(maxWidth / width, maxHeight / height)
  return [even(Math.round(width * scale)), even(Math.round(height * scale))]
}

// T2: the real screen. The frame numbers scale to what went to the encoder between the samples
// (the sidecar's capture_frames_taken, Fable's answer of 2026-11-11), with what the compositor
// delivered recorded beside it.
function judgeScreen(first, second, pageErrors) {
  const a = first.viewer.inbound ?? {}
  const b = second.viewer.inbound ?? {}
  const ta = first.viewer.transform ?? {}
  const tb = second.viewer.transform ?? {}
  const n = (v) => v ?? 0
  const criteria = []
  const add = (name, pass, value) => criteria.push({ name, pass, value })
  const ea = first.probe.engine.last ?? {}
  const eb = second.probe.engine.last ?? {}
  const delivered = n(eb.capture_frames_delivered) - n(ea.capture_frames_delivered)
  const taken = n(eb.capture_frames_taken) - n(ea.capture_frames_taken)
  const decoded = n(b.framesDecoded) - n(a.framesDecoded)
  add('framesDecoded grows by at least 90 % of the frames the encoder took between the samples', decoded >= 0.9 * taken && taken > 0, {
    at5s: a.framesDecoded,
    at15s: b.framesDecoded,
    decoded,
    delivered,
    taken,
    sidecarSampleMs: [ea.ms_since_open, eb.ms_since_open]
  })
  const ready = second.probe.engine.captureReady ?? {}
  const [maxW, maxH] = (process.env.SCREEN_MAX ?? '1920x1080').split('x').map(Number)
  const [width, height] = outputSize(n(ready.width), n(ready.height), maxW, maxH)
  add(`frame is the capture's ${ready.width}x${ready.height} fitted to ${maxW}x${maxH}: ${width} by ${height}`, b.frameWidth === width && b.frameHeight === height, {
    frameWidth: b.frameWidth,
    frameHeight: b.frameHeight,
    captureChanged: second.probe.engine.captureChanged
  })
  add('keyFramesDecoded at least 1 at 5 s', n(a.keyFramesDecoded) >= 1, a.keyFramesDecoded)
  add('freezeCount does not grow between the samples', n(b.freezeCount) - n(a.freezeCount) === 0, {
    at5s: a.freezeCount,
    at15s: b.freezeCount
  })
  const passed = n(tb.passed) - n(ta.passed)
  add("worker's passed grows as framesDecoded does", passed >= decoded, { at5s: ta.passed, at15s: tb.passed, delta: passed })
  add("worker's drops are empty", tb.drops != null && Object.keys(tb.drops).length === 0, tb.drops)
  add('packetsLost is 0', b.packetsLost === 0, b.packetsLost)
  add('no page error', pageErrors.length === 0, pageErrors)
  return criteria
}

function judge(variant, first, second, colours, pageErrors) {
  if (variant === 'screen') return judgeScreen(first, second, pageErrors)
  const a = first.viewer.inbound ?? {}
  const b = second.viewer.inbound ?? {}
  const ta = first.viewer.transform ?? {}
  const tb = second.viewer.transform ?? {}
  const n = (v) => v ?? 0
  const criteria = []
  const add = (name, pass, value) => criteria.push({ name, pass, value })

  const frames = FRAMES[variant] ?? 270
  const [width, height] = SIZE[variant] ?? [1280, 720]
  if (variant !== 'wrong-key') {
    const decoded = n(b.framesDecoded) - n(a.framesDecoded)
    add(`framesDecoded grows by at least ${frames} between the samples`, decoded >= frames, {
      at5s: a.framesDecoded,
      at15s: b.framesDecoded,
      delta: decoded
    })
    add('keyFramesDecoded at least 1 at 5 s', n(a.keyFramesDecoded) >= 1, a.keyFramesDecoded)
    add(`frame is ${width} by ${height}`, b.frameWidth === width && b.frameHeight === height, {
      frameWidth: b.frameWidth,
      frameHeight: b.frameHeight
    })
    const freezes = n(b.freezeCount) - n(a.freezeCount)
    add('freezeCount does not grow between the samples', freezes === 0, {
      at5s: a.freezeCount,
      at15s: b.freezeCount
    })
    const dropped = n(b.framesDropped) - n(a.framesDropped)
    add('framesDropped grows by at most 5', dropped <= 5, {
      at5s: a.framesDropped,
      at15s: b.framesDropped,
      delta: dropped
    })
    add('packetsLost is 0', b.packetsLost === 0, b.packetsLost)
    add('grid has at least 8 distinct colours', colours.distinct >= 8, colours)
    add('no page error', pageErrors.length === 0, pageErrors)
  }
  if (variant === 'encrypted' || variant === 'encoder') {
    const passed = n(tb.passed) - n(ta.passed)
    add(`worker's passed grows by at least ${frames}`, passed >= frames, {
      at5s: ta.passed,
      at15s: tb.passed,
      delta: passed
    })
    add("worker's drops are empty", tb.drops != null && Object.keys(tb.drops).length === 0, tb.drops)
  }
  if (variant === 'wrong-key') {
    add("worker's passed is 0", tb.passed === 0, tb.passed)
    add("worker's drops are not empty", tb.drops != null && Object.keys(tb.drops).length > 0, tb.drops)
    add('framesDecoded is 0', n(b.framesDecoded) === 0, b.framesDecoded)
  }
  return criteria
}

// ─── One variant ─────────────────────────────────────────────────

async function runVariant(variant, h264) {
  const dir = join(VIEWER, 'runs', `${variant}${noSei ? '-nosei' : ''}${AV1 ? '-av1' : ''}`)
  await rm(dir, { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  const result = { variant, h264, startedAt: stamp(), samples: [], criteria: [], error: null }
  let probe = null
  let viewer = null

  try {
    probe = startProbe(variant, h264, dir)
    // The screen variant waits for the portal's dialog first.
    const routing = await probe.next('routing', variant === 'screen' ? 330_000 : 30_000)

    viewer = await startViewer(dir)
    const { page } = viewer
    await page.exposeFunction('probeConnect', async (dtlsParameters) => {
      await probe.ask({ connect: { dtlsParameters } }, 'connected')
      return true
    })

    const e2ee =
      variant === 'plain'
        ? { mode: 'passthrough', root: STATIC_ROOT, selfId: VIEWER_ID }
        : { mode: 'static', root: variant === 'wrong-key' ? WRONG_ROOT : STATIC_ROOT, selfId: VIEWER_ID }
    result.workerConfig = e2ee
    const setup = await page.evaluate((arg) => window.viewer.setup(arg), { routing, e2ee })
    result.handler = setup.handler

    const consumer = await probe.ask({ consume: { rtpCapabilities: setup.rtpCapabilities } }, 'consumer')
    // What the node gives the viewer, header extensions included (recorded, not judged).
    result.consumerRtpParameters = consumer.rtpParameters
    result.consumer = await page.evaluate(([parameters, transform]) => window.viewer.consume(parameters, transform), [
      consumer,
      TRANSFORM
    ])
    await probe.ask({ resume: true }, 'resumed')
    const resumed = Date.now()

    const sample = async (label) => {
      const [fromViewer, fromProbe] = await Promise.all([
        page.evaluate(() => window.viewer.sample()),
        probe.ask({ stats: true }, 'stats')
      ])
      return { label, msAfterResume: Date.now() - resumed, viewer: fromViewer, probe: fromProbe }
    }

    await sleep(resumed + FIRST_SAMPLE_MS - Date.now())
    const first = await sample('5s')
    result.samples.push(first)
    await sleep(resumed + SECOND_SAMPLE_MS - Date.now())
    const second = await sample('15s')
    result.samples.push(second)
    const colours = await page.evaluate(() => window.viewer.colours())
    result.colours = colours
    await page.locator('#video').screenshot({ path: join(dir, 'video.png') })

    result.criteria = judge(variant, first, second, colours, viewer.pageErrors)
    result.recorded = {
      keyFrameRequests: second.probe.engine.keyFrameRequests,
      producerScore: second.probe.producerScore,
      consumerScore: second.probe.consumerScore,
      consumerStats: second.probe.consumer,
      decoderImplementation: second.viewer.inbound?.decoderImplementation ?? null,
      sidecarStats: second.probe.engine.last
    }
  } catch (err) {
    result.error = String(err?.stack ?? err)
    console.error(`${variant}: ${result.error}`)
  } finally {
    if (viewer) {
      result.pageErrors = viewer.pageErrors
      await viewer.close()
    }
    if (probe) result.probeExit = await probe.stop()
  }

  result.pass = result.error == null && result.criteria.length > 0 && result.criteria.every((c) => c.pass)
  await writeFile(join(dir, 'result.json'), JSON.stringify(result, null, 2) + '\n')
  return result
}

// ─── Main ────────────────────────────────────────────────────────

if (!existsSync(PROBE_BIN)) {
  throw new Error(`no probe binary at ${PROBE_BIN}, build it or set PROBE_BIN`)
}
const SIDECAR = process.env.PYLON_MEDIA_HOST ?? join(dirname(PROBE_BIN), 'pylon-media-host')
if (!existsSync(SIDECAR)) {
  throw new Error(`no sidecar at ${SIDECAR}, build native/media-engine into the probe's target dir or set PYLON_MEDIA_HOST`)
}
if (!process.env.DISPLAY) throw new Error('no DISPLAY, run under xvfb-run')

const h264 = AV1 ? makeIvf() : makeH264()
await buildPage()

let allPass = true
for (const variant of run) {
  console.log(`\n=== ${variant}${noSei ? ' (no SEI)' : ''}${AV1 ? ' (AV1)' : ''}`)
  const result = await runVariant(variant, h264)
  for (const c of result.criteria) {
    console.log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}: ${JSON.stringify(c.value)}`)
  }
  if (result.error) console.log(`ERROR ${result.error.split('\n')[0]}`)
  console.log(`${variant}: ${result.pass ? 'PASS' : 'FAIL'}`)
  allPass &&= result.pass
}
process.exit(allPass ? 0 : 1)
