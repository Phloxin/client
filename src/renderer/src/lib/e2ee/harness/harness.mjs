// The E2EE worker against the voice node's real delivery service, with no browser. pylon-sfu's
// ignored `js_worker_harness` test runs the node's GroupState and starts this script:
//
//   npm run build:e2ee
//   E2EE_JS_HARNESS=$PWD/src/renderer/src/lib/e2ee/harness/harness.mjs \
//     cargo test -p pylon-sfu js_worker -- --ignored --nocapture      (in server/backend)
//
// It runs copies of worker.js through joins and a leave, and checks that every member ends up
// in the same epoch with the same call code and roster. JSON lines on stdin/stdout:
//   in:  { params: GroupParams }, then { to: member, event: GroupEvent }
//   out: { from: member, request: GroupRequest }, { left: member }, { fatal }, { done }
// Frames aren't exercised: there's no RTCRtpScriptTransform in Node.
import { Worker } from 'node:worker_threads'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import readline from 'node:readline'

const N = 4
const out = (message) => process.stdout.write(JSON.stringify(message) + '\n')
const log = (...args) => process.stderr.write(`[harness] ${args.join(' ')}\n`)

// worker.js imports its WASM the Vite way; point a copy at the built package instead.
const pkg = fileURLToPath(new URL('../pkg/', import.meta.url))
const source = (await readFile(new URL('../worker.js', import.meta.url), 'utf8'))
  .replace("from './pkg/pylon_e2ee.js'", `from '${pathToFileURL(join(pkg, 'pylon_e2ee.js'))}'`)
  .replace(
    "import wasmUrl from './pkg/pylon_e2ee_bg.wasm?url'",
    `const wasmUrl = await (await import('node:fs/promises')).readFile(${JSON.stringify(join(pkg, 'pylon_e2ee_bg.wasm'))})`
  )
const copy = join(await mkdtemp(join(tmpdir(), 'pylon-e2ee-')), 'worker.mjs')
await writeFile(copy, source)

const workers = []
const status = []
const keyPackages = []
let params = null
// Member 3's first key package dies with its socket.
let lose = 3

for (let i = 0; i < N; i++) {
  const worker = new Worker(new URL('./shim.mjs', import.meta.url), {
    workerData: { worker: pathToFileURL(copy).href }
  })
  worker.on('message', (m) => {
    if (m.type === 'request' && m.request.KeyPackage) {
      keyPackages[i] = (keyPackages[i] ?? 0) + 1
      if (i === lose) {
        lose = null
        return
      }
    }
    if (m.type === 'request') out({ from: i, request: m.request })
    else if (m.type === 'status') status[i] = m
    else if (m.type === 'fatal') out({ fatal: i, reason: m.reason })
  })
  worker.on('error', (err) => {
    log(`worker ${i} error`, err.stack ?? err)
    process.exit(1)
  })
  worker.postMessage({ type: 'config', mode: 'mls', root: null, selfId: String(100 + i) })
  workers.push(worker)
}

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line)
  if (message.params) params = message.params
  else if (message.to != null)
    workers[message.to].postMessage({ type: 'group', event: message.event })
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what, check, ms = 20_000) {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) {
      log(`timed out waiting for ${what}:`, JSON.stringify(status))
      process.exit(1)
    }
    await sleep(20)
  }
}

const ready = (i) => status[i]?.status === 'ready' && status[i].mediaReady
const agreed = (members) =>
  members.every(
    (i) =>
      ready(i) &&
      status[i].epoch === status[members[0]].epoch &&
      status[i].callCode === status[members[0]].callCode &&
      status[i].roster.length === members.length
  )

await until('params', () => params != null)
for (let i = 0; i < 3; i++) {
  workers[i].postMessage({ type: 'join', params, move: false })
  await until(`member ${i} ready`, () => ready(i))
  log(`member ${i} ready at epoch ${status[i].epoch}`)
}
await until('everyone agreeing', () => agreed([0, 1, 2]))
const joined = status.map(({ epoch, callCode, roster }) => ({ epoch, callCode, roster }))
log('all joined:', JSON.stringify(joined[0]))

// Member 3 joins, loses its key package with the socket, and resumes.
workers[3].postMessage({ type: 'join', params, move: false })
await until('member 3 key package lost', () => keyPackages[3] === 1 && lose == null)
workers[3].postMessage({ type: 'suspend' })
workers[3].postMessage({ type: 'resume' })
await until('member 3 resending its key package', () => keyPackages[3] === 2)
await until('member 3 ready', () => ready(3))
await until('all four agreeing', () => agreed([0, 1, 2, 3]))
log('member 3 joined after the resume:', JSON.stringify(status[3]))

// Member 1 leaves voice.
const epoch = status[0].epoch
workers[1].postMessage({ type: 'leave' })
out({ left: 1 })
await until('the leave committed', () => agreed([0, 2, 3]) && status[0].epoch === epoch + 1)
log('after the leave:', JSON.stringify(status[0]))

out({ done: { joined, after: [status[0], status[2], status[3]] } })
for (const worker of workers) worker.terminate()
process.exit(0)
