// The driver of probe 3's Chromium baseline (.plans/native-media-engine-m5a-encoder.md, D26).
// Starts `media-probe chrome` and a bare Electron sender under Xvfb, relays the signalling, and
// sends the page's statistics to the probe once a second until the probe is done.
//
//   node sender.mjs [--cuts] [--light] --out <dir>
//
// Needs Xvfb's DISPLAY, the client's nix shell and a built probe: PROBE_BIN.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { join, resolve } from 'node:path'

const VIEWER = import.meta.dirname
const CLIENT = resolve(VIEWER, '../../..')
const { _electron: electron } = createRequire(join(CLIENT, 'e2e/package.json'))('playwright')
const { build } = await import('vite')

const args = process.argv.slice(2)
const cuts = args.includes('--cuts')
const light = args.includes('--light')
const out = resolve(args[args.indexOf('--out') + 1])
mkdirSync(out, { recursive: true })
const PROBE_BIN = process.env.PROBE_BIN
if (!PROBE_BIN) throw new Error('set PROBE_BIN')
if (!process.env.DISPLAY) throw new Error('no DISPLAY, run under xvfb-run')

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
const env = { ...process.env }
for (const key of DESKTOP_ENV) delete env[key]
const electronBinary = process.env.ELECTRON_OVERRIDE_DIST_PATH
  ? join(process.env.ELECTRON_OVERRIDE_DIST_PATH, 'electron')
  : createRequire(join(CLIENT, 'package.json'))('electron')

await build({
  configFile: false,
  root: VIEWER,
  base: './',
  logLevel: 'warn',
  build: {
    outDir: join(VIEWER, 'dist-sender'),
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    rollupOptions: { input: join(VIEWER, 'sender.html') }
  }
})

const probe = spawn(PROBE_BIN, ['chrome', '--out', out], { stdio: ['pipe', 'pipe', 'pipe'] })
const probeLog = createWriteStream(join(out, 'probe.log'))
probe.stderr.on('data', (d) => probeLog.write(d))
const exited = new Promise((r) => probe.on('exit', (code) => r(code)))
const waiting = []
let done = false
createInterface({ input: probe.stdout }).on('line', (line) => {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    return
  }
  const key = Object.keys(message)[0]
  if (key === 'done') done = true
  const at = waiting.findIndex((w) => w.key === key || key === 'error')
  if (at < 0) return
  const [waiter] = waiting.splice(at, 1)
  if (key === 'error') waiter.reject(new Error(message.error))
  else waiter.resolve(message[key])
})
const next = (key) => new Promise((resolve, reject) => waiting.push({ key, resolve, reject }))
const ask = (message, key) => {
  const reply = next(key)
  probe.stdin.write(JSON.stringify(message) + '\n')
  return reply
}

const routing = await next('routing')
const userData = await mkdtemp(join(tmpdir(), 'media-probe-sender-'))
const console_ = createWriteStream(join(out, 'console.log'))
const app = await electron.launch({
  executablePath: electronBinary,
  args: [join(VIEWER, 'main-sender.cjs'), '--no-sandbox', `--user-data-dir=${userData}`],
  env,
  timeout: 60_000
})
const pid = app.process().pid
const page = await app.firstWindow({ timeout: 60_000 })
page.on('console', (m) => console_.write(`${new Date().toISOString()} ${m.text()}\n`))
page.on('pageerror', (e) => console_.write(`pageerror ${e?.stack ?? e}\n`))
await page.waitForLoadState('load')
await page.waitForFunction(() => window.sender != null, null, { timeout: 30_000 })
await page.exposeFunction('probeConnect', async (dtlsParameters) => {
  await ask({ connect: { dtlsParameters } }, 'connected')
  return true
})
await page.exposeFunction('probeProduce', async (rtpParameters) => {
  const produced = await ask({ produce: { kind: 'video', rtpParameters } }, 'produced')
  return produced.id
})
const setup = await page.evaluate((arg) => window.sender.setup(arg), { routing, cuts, light })
console.log(`sender: ${JSON.stringify(setup)}, cuts ${cuts}, light ${light}`)

while (!done && probe.exitCode == null) {
  await new Promise((r) => setTimeout(r, 1000))
  if (done) break
  const stats = await page.evaluate(() => window.sender.sample())
  probe.stdin.write(JSON.stringify({ stats }) + '\n')
}

const tree = [pid]
try {
  tree.push(...execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number))
} catch {
  // None.
}
await Promise.race([app.close().catch(() => {}), new Promise((r) => setTimeout(r, 15_000))])
for (const p of tree) {
  try {
    process.kill(p, 'SIGKILL')
  } catch {
    // Gone.
  }
}
probe.stdin.end()
const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r(null), 15_000))])
if (code == null) probe.kill('SIGKILL')
await rm(userData, { recursive: true, force: true })
console.log(`probe exit ${code}, results in ${out}`)
