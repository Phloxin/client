// The export capability: the shell's exportImage.js (save outcomes, the share request and its
// limits) and the bundle's bridge.exportImage (activities/ui/shared/bridge.js, through node:vm).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { exportImage, savePng } from './exportImage.js'

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
const LIMITS = { attachment_bytes: 26214400, message_upload_bytes: 104857600 }
const SAVE = {
  type: 'export',
  op: 'save',
  id: 1,
  name: 'whiteboard-2026-11-24-0930.png',
  data: PNG
}
const SHARE = { type: 'export', op: 'share', id: 2, name: 'whiteboard.png', data: PNG }
const ROOM = { channelId: '42' }

function fakes(overrides = {}) {
  const calls = { save: [], fetch: [] }
  return {
    calls,
    savePng: async (args) => {
      calls.save.push(args)
      return { ok: true, filePath: '/home/x/a.png' }
    },
    authFetch: async (url, options) => {
      calls.fetch.push({ url, options })
      return new Response('{}', { status: 200 })
    },
    apiBase: () => 'https://pylon.test',
    getServerLimits: () => LIMITS,
    ...overrides
  }
}

test('save answers ok, canceled, or export_failed for anything else', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const ok = fakes({ getServerLimits: () => null })
  assert.deepEqual(await exportImage(SAVE, ROOM, ok), { ok: true })
  assert.deepEqual(ok.calls.save, [{ name: SAVE.name, data: PNG }])
  assert.equal(ok.calls.fetch.length, 0)
  const answer = async (savePng) => exportImage(SAVE, ROOM, fakes({ savePng }))
  assert.deepEqual(await answer(async () => ({ ok: false, canceled: true })), {
    ok: false,
    error: 'canceled'
  })
  for (const result of [{ ok: false, error: 'EACCES' }, { ok: false }, undefined, null]) {
    assert.deepEqual(await answer(async () => result), { ok: false, error: 'export_failed' })
  }
  assert.deepEqual(
    await answer(async () => {
      throw new Error('no handler for save-png')
    }),
    { ok: false, error: 'export_failed' }
  )
})

test('the default save goes through the save-png IPC when there is one', async (t) => {
  const invoked = []
  globalThis.window = {
    electron: {
      ipcRenderer: {
        invoke: async (channel, args) => {
          invoked.push([channel, args])
          return { ok: false, canceled: true }
        }
      }
    }
  }
  t.after(() => delete globalThis.window)
  assert.deepEqual(await savePng({ name: 'a.png', data: PNG }), { ok: false, canceled: true })
  assert.deepEqual(invoked, [['save-png', { name: 'a.png', data: PNG }]])
})

test('without the IPC, the default save clicks an anchor on an object URL', async (t) => {
  const anchor = {
    clicked: 0,
    removed: 0,
    click: () => anchor.clicked++,
    remove: () => anchor.removed++
  }
  const appended = []
  globalThis.document = { createElement: () => anchor, body: { append: (n) => appended.push(n) } }
  t.after(() => delete globalThis.document)
  let blob = null
  t.mock.method(URL, 'createObjectURL', (b) => {
    blob = b
    return 'blob:pylon/1'
  })
  const revoked = []
  t.mock.method(URL, 'revokeObjectURL', (url) => revoked.push(url))
  assert.deepEqual(await savePng({ name: 'a.png', data: PNG }), { ok: true })
  assert.equal(anchor.href, 'blob:pylon/1')
  assert.equal(anchor.download, 'a.png')
  assert.deepEqual([anchor.clicked, anchor.removed, appended.length], [1, 1, 1])
  assert.equal(blob.type, 'image/png')
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), PNG)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.deepEqual(revoked, ['blob:pylon/1'])
})

test('share posts one attachment, payload first, to the room channel', async () => {
  const f = fakes()
  assert.deepEqual(await exportImage(SHARE, ROOM, f), { ok: true })
  assert.equal(f.calls.save.length, 0)
  const [{ url, options }] = f.calls.fetch
  assert.equal(url, 'https://pylon.test/channels/42/messages')
  assert.equal(options.method, 'POST')
  const form = options.body
  assert.deepEqual([...form.keys()], ['payload_json', 'files[0]'])
  const payload = form.get('payload_json')
  assert.equal(payload.type, 'application/json')
  assert.deepEqual(JSON.parse(await payload.text()), {
    content: null,
    attachments: [{ ref: 0, filename: 'whiteboard.png', description: null }]
  })
  const file = form.get('files[0]')
  assert.equal(file.name, 'whiteboard.png')
  assert.equal(file.type, 'image/png')
  assert.deepEqual(new Uint8Array(await file.arrayBuffer()), PNG)
})

test('share checks the server limits first, then needs a channel and a yes from the server', async (t) => {
  t.mock.method(console, 'warn', () => {})
  const run = async (overrides, room = ROOM) => {
    const f = fakes(overrides)
    return { answer: await exportImage(SHARE, room, f), fetched: f.calls.fetch.length }
  }
  assert.deepEqual(await run({ getServerLimits: () => null }), {
    answer: { ok: false, error: 'not_connected' },
    fetched: 0
  })
  for (const limits of [
    { ...LIMITS, attachment_bytes: PNG.length - 1 },
    { ...LIMITS, message_upload_bytes: PNG.length - 1 }
  ]) {
    assert.deepEqual(await run({ getServerLimits: () => limits }), {
      answer: { ok: false, error: 'export_too_large' },
      fetched: 0
    })
  }
  const exact = { attachment_bytes: PNG.length, message_upload_bytes: PNG.length }
  assert.deepEqual((await run({ getServerLimits: () => exact })).answer, { ok: true })
  assert.deepEqual(await run({}, { channelId: undefined }), {
    answer: { ok: false, error: 'export_failed' },
    fetched: 0
  })
  const refused = new Response(JSON.stringify({ code: 'missing_permissions', message: 'No' }), {
    status: 403
  })
  assert.deepEqual((await run({ authFetch: async () => refused })).answer, {
    ok: false,
    error: 'export_failed'
  })
  const dropped = async () => {
    throw new TypeError('fetch failed')
  }
  assert.deepEqual((await run({ authFetch: dropped })).answer, {
    ok: false,
    error: 'export_failed'
  })
})

const bridgeCode = readFileSync(
  new URL('../../activities/ui/shared/bridge.js', import.meta.url),
  'utf8'
)

function loadBridge() {
  const posted = []
  let onMessage = null
  const parent = { postMessage: (m) => posted.push(m) }
  const context = {
    parent,
    TextDecoder,
    TextEncoder,
    addEventListener: (type, fn) => {
      if (type === 'message') onMessage = fn
    }
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(bridgeCode, context)
  return {
    bridge: context.bridge,
    posted,
    reply: (data, source = parent) => onMessage({ source, data })
  }
}

const watch = (promise) => {
  const out = { state: 'pending', reason: undefined }
  promise.then(
    () => (out.state = 'resolved'),
    (reason) => Object.assign(out, { state: 'rejected', reason })
  )
  return out
}

test('bridge.exportImage posts the export and settles on the shell answer for its id', async () => {
  const b = loadBridge()
  const saved = watch(b.bridge.exportImage('save', 'a.png', PNG))
  const shared = watch(b.bridge.exportImage('share', 'whiteboard.png', PNG))
  const lost = watch(b.bridge.exportImage('save', 'b.png', PNG))
  assert.deepEqual(
    b.posted.map((m) => [m.type, m.op, m.id, m.name, m.data === PNG]),
    [
      ['export', 'save', 1, 'a.png', true],
      ['export', 'share', 2, 'whiteboard.png', true],
      ['export', 'save', 3, 'b.png', true]
    ]
  )
  b.reply({ type: 'export', id: 2, ok: false, error: 'export_too_large' })
  b.reply({ type: 'export', id: 1, ok: true }, {})
  b.reply({ type: 'export', id: 9, ok: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(shared, { state: 'rejected', reason: 'export_too_large' })
  assert.equal(saved.state, 'pending', 'an answer from anything but the parent is ignored')
  b.reply({ type: 'export', id: 1, ok: true })
  b.reply({ type: 'export', id: 1, ok: false, error: 'canceled' })
  b.reply({ type: 'export', id: 3, ok: false })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(saved.state, 'resolved')
  assert.deepEqual(lost, { state: 'rejected', reason: 'export_failed' })
})
