// The whiteboard's net layer (activities/ui/whiteboard/net.js), a plain bundle script, loaded
// through node:vm over stand-ins for the shared bridge and room layers and a clock the test moves.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { MAX_CONTROL_BODY, encodeAction } from './frames.js'

const code = readFileSync(new URL('../../activities/ui/whiteboard/net.js', import.meta.url), 'utf8')
const LONGEST_WIRE_ID = 2 ** 32 - 1
const ACTION_BUDGET = 3072
const MAX_VOLATILE = 1024
// Objects from the vm's realm, compared by value.
const plain = (v) => JSON.parse(JSON.stringify(v))
const flush = () => new Promise((resolve) => setImmediate(resolve))

function load({ clients = ['1', '2'] } = {}) {
  let now = 1000
  let timers = []
  let nextTimer = 1
  const actions = []
  const inputs = []
  const exports = []
  const events = []
  const renders = []
  let onDelta = null
  let onVolatile = null
  const room = {
    you: '1',
    clients,
    connected: true,
    closed: false,
    view: null,
    clockOffsetMs: 0,
    nameOf: (id) => ({ 1: 'Ada', 2: 'Bo' })[id] ?? 'Unknown',
    avatarEl: (id) => ({ avatar: id }),
    onRender: (fn) => renders.push(fn),
    onDelta: (fn) => (onDelta = fn)
  }
  const bridge = {
    action: (data) =>
      new Promise((resolve, reject) => actions.push({ data: plain(data), resolve, reject })),
    input: (msg) => inputs.push({ at: now, msg: plain(msg) }),
    onVolatile: (fn) => (onVolatile = fn),
    exportImage: (op, name, data) =>
      new Promise((resolve, reject) => exports.push({ op, name, data, resolve, reject }))
  }
  const context = {
    bridge,
    room,
    TextEncoder,
    Date,
    performance: { now: () => now },
    setTimeout: (fn, ms) => {
      const id = nextTimer++
      timers.push({ id, at: now + Math.max(0, ms), fn })
      return id
    },
    clearTimeout: (id) => {
      timers = timers.filter((t) => t.id !== id)
    }
  }
  context.window = context
  vm.createContext(context)
  vm.runInContext(code, context)
  const net = context.wbNet
  for (const name of ['snapshot', 'delta', 'cursor', 'preview', 'previewEnd', 'people']) {
    net.on(name, (value) => events.push(value === undefined ? [name] : [name, plain(value)]))
  }
  return {
    context,
    net,
    room,
    actions,
    inputs,
    exports,
    events,
    // Moves the clock, running each timer as it falls due.
    advance(ms) {
      const end = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at || a.id - b.id)[0]
        if (!due) break
        timers = timers.filter((t) => t !== due)
        now = due.at
        due.fn()
      }
      now = end
    },
    render: () => renders.forEach((fn) => fn()),
    delta: (data) => onDelta({ data, generation: 1 }),
    volatile: (data) => onVolatile(data)
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

// Answers every action as it is posted until the commit settles; the actions it took.
async function actionsOf(op) {
  const w = load()
  const done = watch(w.net.commit(op))
  for (let at = 0; done.state === 'pending'; ) {
    for (; at < w.actions.length; at++) w.actions[at].resolve()
    await flush()
  }
  assert.equal(done.state, 'resolved')
  return w.actions.map((a) => a.data)
}

const SMALL = { k: 'h', shape: 'rect', color: 0x1c7ed6, size: 5, d: [400, 400, 2400, 1600] }

// A stroke with width factors whose every delta is as long as a valid stroke's can be.
function longStroke(points) {
  const d = [-256, 4576, 255]
  for (let i = 1; i < points; i++) {
    const odd = i % 2 === 1
    d.push(odd ? 8192 : -8192, odd ? -4832 : 4832, odd ? -254 : 254)
  }
  return { k: 's', tool: 'brush', color: 0xffffff, size: 128, p: true, d }
}

// A fill near MAX_FILL_INTS: every row has 15 spans at four-digit x.
function bigFill() {
  const d = [0]
  for (let row = 0; row < 1056; row++) {
    d.push(15)
    for (let k = 0; k < 15; k++) d.push(1000 + k * 60, 30)
  }
  return { k: 'f', color: 0xabcdef, d }
}

const bodyOf = (data) => encodeAction(LONGEST_WIRE_ID, data).body

test('net.js defines one global', () => {
  const w = load()
  const own = ['bridge', 'room', 'TextEncoder', 'Date', 'performance', 'setTimeout']
  assert.deepEqual(
    Object.keys(w.context).filter((k) => ![...own, 'clearTimeout', 'window'].includes(k)),
    ['wbNet']
  )
})

test('an op that fits one action goes alone, with no cont', async () => {
  assert.deepEqual(await actionsOf(SMALL), [{ t: 'op', op: SMALL }])
  const text = { k: 't', color: 0, size: 256, text: '\u{1F3A8}'.repeat(280), d: [0, 0, 7680] }
  const [only, ...rest] = await actionsOf(text)
  assert.deepEqual(rest, [])
  assert.deepEqual(only, { t: 'op', op: text })
  assert.ok(bodyOf(only) <= ACTION_BUDGET)
})

for (const [name, op] of [
  ['a 4096-point stroke with width factors', longStroke(4096)],
  ['a fill of 32737 ints', bigFill()]
]) {
  test(`${name} goes as parts and a final op, each under the budget, d intact`, async () => {
    const sent = await actionsOf(op)
    assert.ok(sent.length > 10, String(sent.length))
    const last = sent.at(-1)
    const parts = sent.slice(0, -1)
    assert.deepEqual(Object.keys(last), ['t', 'op', 'cont'])
    assert.equal(last.t, 'op')
    assert.equal(last.cont, true)
    assert.deepEqual({ ...last.op, d: op.d }, op)
    assert.deepEqual(parts[0], { t: 'part', d: parts[0].d, first: true })
    for (const part of parts.slice(1)) assert.deepEqual(Object.keys(part), ['t', 'd'])
    assert.deepEqual([...parts.flatMap((p) => p.d), ...last.op.d], op.d)
    for (const data of sent) {
      assert.ok(bodyOf(data) <= ACTION_BUDGET, String(bodyOf(data)))
      assert.ok(bodyOf(data) < MAX_CONTROL_BODY)
    }
    // Filled to within one int and the first part's flag of the budget.
    for (const part of parts.slice(0, -1)) assert.ok(bodyOf(part) > ACTION_BUDGET - 24)
  })
}

test('an op whose d is not all integers goes whole, for the room to refuse', async () => {
  const odd = { k: 's', tool: 'pen', color: 0, size: 5, d: Array(3000).fill(1.5) }
  assert.deepEqual(await actionsOf(odd), [{ t: 'op', op: odd }])
})

test('groups go one at a time in call order, at most 16 actions ahead of their answers', async () => {
  const w = load()
  const big = watch(w.net.commit(longStroke(4096)))
  const small = watch(w.net.commit(SMALL))
  const undo = watch(w.net.act({ t: 'undo' }))
  assert.equal(w.actions.length, 16)
  w.actions[0].resolve()
  await flush()
  assert.equal(w.actions.length, 17)
  for (let at = 1; big.state === 'pending'; ) {
    for (; at < w.actions.length; at++) w.actions[at].resolve()
    await flush()
  }
  const smallAt = w.actions.length - 1
  assert.deepEqual(w.actions[smallAt].data, { t: 'op', op: SMALL })
  assert.ok(w.actions.slice(0, smallAt).every((a) => a.data.t === 'part' || a.data.op?.k === 's'))
  await flush()
  assert.equal(w.actions.length, smallAt + 1)
  assert.equal(small.state, 'pending')
  w.actions.at(-1).resolve()
  await flush()
  assert.equal(small.state, 'resolved')
  assert.deepEqual(w.actions.at(-1).data, { t: 'undo' })
  w.actions.at(-1).reject('nothing_to_undo')
  await flush()
  assert.deepEqual(undo, { state: 'rejected', reason: 'nothing_to_undo' })
})

test('a refused part stops the rest and fails the commit with the first reason', async () => {
  const w = load()
  const big = watch(w.net.commit(longStroke(4096)))
  assert.equal(w.actions.length, 16)
  w.actions[1].reject('too_large')
  w.actions[5].reject('view_only')
  await flush()
  for (const a of w.actions.slice(2)) a.reject('too_large')
  await flush()
  assert.equal(big.state, 'pending', 'until everything posted is answered')
  w.actions[0].resolve()
  await flush()
  assert.deepEqual(big, { state: 'rejected', reason: 'too_large' })
  assert.equal(w.actions.length, 16)
  w.net.commit(longStroke(1000))
  assert.deepEqual(Object.keys(w.actions[16].data), ['t', 'd', 'first'])
})

test('a commit refused rate_limited goes again from its first part after a pause', async () => {
  const w = load()
  const big = watch(w.net.commit(longStroke(2000)))
  const behind = watch(w.net.commit(SMALL))
  const first = w.actions.length
  const pause = 250 + first * 17
  w.actions[0].reject('rate_limited')
  for (const a of w.actions.slice(1)) a.reject('rate_limited')
  await flush()
  w.advance(pause - 1)
  assert.equal(w.actions.length, first)
  w.advance(1)
  assert.equal(w.actions.length, first * 2)
  assert.deepEqual(
    w.actions.slice(first).map((a) => a.data),
    w.actions.slice(0, first).map((a) => a.data)
  )
  for (const a of w.actions.slice(first)) a.resolve()
  await flush()
  assert.equal(big.state, 'resolved')
  assert.deepEqual(w.actions.at(-1).data, { t: 'op', op: SMALL })
  assert.equal(behind.state, 'pending')
})

test('a commit is retried three times, then the UI hears rate_limited; act is not retried', async () => {
  const w = load()
  const op = watch(w.net.commit(SMALL))
  for (let n = 0; n < 4; n++) {
    assert.equal(w.actions.length, n + 1)
    w.actions[n].reject('rate_limited')
    await flush()
    w.advance(267)
  }
  assert.equal(w.actions.length, 4)
  assert.deepEqual(op, { state: 'rejected', reason: 'rate_limited' })
  const undo = watch(w.net.act({ t: 'undo' }))
  w.actions[4].reject('rate_limited')
  await flush()
  assert.deepEqual(undo, { state: 'rejected', reason: 'rate_limited' })
  w.advance(5000)
  assert.equal(w.actions.length, 5)
})

test('a drop refuses what is in hand and queued, and every call until the room is back', async () => {
  const w = load()
  const sent = watch(w.net.commit(SMALL))
  const queued = watch(w.net.act({ t: 'clear' }))
  w.room.connected = false
  w.render()
  await flush()
  assert.equal(w.net.connected, false)
  assert.deepEqual(sent, { state: 'rejected', reason: 'not_connected' })
  assert.deepEqual(queued, { state: 'rejected', reason: 'not_connected' })
  // The bridge settles the action later, on the next snapshot: nothing follows from it.
  w.actions[0].resolve()
  await flush()
  const late = watch(w.net.commit(SMALL))
  await flush()
  assert.deepEqual(late, { state: 'rejected', reason: 'not_connected' })
  assert.equal(w.actions.length, 1)
  w.room.connected = true
  w.render()
  assert.equal(w.net.connected, true)
  w.net.commit(SMALL)
  assert.equal(w.actions.length, 2)
})

test('a drop during a retry pause refuses the commit, and the retry never goes', async () => {
  const w = load()
  const op = watch(w.net.commit(SMALL))
  w.actions[0].reject('rate_limited')
  await flush()
  w.room.connected = false
  w.render()
  await flush()
  assert.deepEqual(op, { state: 'rejected', reason: 'not_connected' })
  w.room.connected = true
  w.render()
  w.advance(1000)
  assert.equal(w.actions.length, 1)
})

test('a closed room refuses what is in hand and reads as not connected', async () => {
  const w = load()
  const op = watch(w.net.commit(SMALL))
  w.room.closed = true
  w.render()
  await flush()
  assert.deepEqual(op, { state: 'rejected', reason: 'not_connected' })
  assert.equal(w.net.connected, false)
})

test('snapshots and deltas pass through in order, each snapshot once', () => {
  const w = load()
  w.render()
  const v1 = { v: 1, top: 0, ops: [] }
  const v2 = { v: 1, top: 1, ops: [{ i: 1, c: '2', k: 'h' }] }
  w.room.view = v1
  w.render()
  w.render()
  w.delta({ t: 'ops', used: 40, ops: [{ i: 1, c: '2', k: 'h' }] })
  w.delta({ t: 'undo', i: 1, used: 0 })
  w.room.view = v2
  w.render()
  assert.deepEqual(
    w.events.filter(([name]) => name !== 'people'),
    [
      ['snapshot', v1],
      ['delta', { t: 'ops', used: 40, ops: [{ i: 1, c: '2', k: 'h' }] }],
      ['delta', { t: 'undo', i: 1, used: 0 }],
      ['snapshot', v2]
    ]
  )
  assert.equal(w.events.filter(([name]) => name === 'people').length, 4)
})

test('people keeps everyone seen, says who is here, and names them through the room', () => {
  const w = load({ clients: ['1', '2'] })
  w.render()
  w.room.clients = ['1', '3']
  w.render()
  assert.deepEqual(plain(w.net.people()), [
    { id: '1', name: 'Ada', present: true },
    { id: '2', name: 'Bo', present: false },
    { id: '3', name: 'Unknown', present: true }
  ])
  assert.equal(w.net.you, '1')
  assert.equal(w.net.nameOf('2'), 'Bo')
  assert.deepEqual(plain(w.net.avatarEl('2')), { avatar: '2' })
  w.room.clockOffsetMs = 5000
  const at = w.net.now() - Date.now()
  assert.ok(at >= 4990 && at <= 5000, String(at))
})

test('save and share go through bridge.exportImage, sharing as whiteboard.png', async () => {
  const w = load()
  assert.equal(w.net.canShare, true)
  const bytes = new Uint8Array(8)
  const saved = watch(w.net.savePng(bytes, 'whiteboard-2026-11-24-0930.png'))
  const shared = watch(w.net.sharePng(bytes))
  assert.deepEqual(
    w.exports.map((e) => [e.op, e.name, e.data === bytes]),
    [
      ['save', 'whiteboard-2026-11-24-0930.png', true],
      ['share', 'whiteboard.png', true]
    ]
  )
  w.exports[0].reject('canceled')
  w.exports[1].resolve()
  await flush()
  assert.deepEqual(saved, { state: 'rejected', reason: 'canceled' })
  assert.equal(shared.state, 'resolved')
})

test('relayed inputs come out as cursor, preview and previewEnd', () => {
  const w = load()
  w.volatile({ t: 'c', x: 40, y: -80, from: '2' })
  w.volatile({ t: 'p', s: 7, k: 's', tool: 'pen', color: 1, size: 5, n: 12, d: [1, 2], from: '2' })
  w.volatile({
    t: 'p',
    s: 8,
    k: 'h',
    tool: 'rect',
    color: 1,
    size: 5,
    n: 0,
    d: [1, 2, 3, 4],
    from: 3
  })
  w.volatile({ t: 'e', s: 7, from: '2' })
  w.volatile({ t: 'c', x: 1, y: 1 })
  w.volatile({ t: 'zz', from: '2' })
  w.volatile(null)
  assert.deepEqual(w.events, [
    ['cursor', { from: '2', x: 40, y: -80 }],
    ['preview', { from: '2', s: 7, k: 's', tool: 'pen', color: 1, size: 5, n: 12, pts: [1, 2] }],
    [
      'preview',
      { from: '3', s: 8, k: 'h', tool: 'rect', color: 1, size: 5, n: 0, pts: [1, 2, 3, 4] }
    ],
    ['previewEnd', { from: '2', s: 7 }]
  ])
})

test('a stroke preview sends the newest 48 points or fewer, absolute, n the first index', () => {
  const style = { tool: 'pen', color: 1, size: 5 }
  const w = load()
  const pts = []
  for (let i = 0; i < 10; i++) pts.push(i * 10, i * 5)
  w.net.previewStroke(3, style, pts)
  assert.deepEqual(w.inputs[0].msg, { t: 'p', s: 3, k: 's', ...style, n: 0, d: pts.slice() })
  for (let i = 10; i < 100; i++) pts.push(i * 10, i * 5)
  w.advance(34)
  w.net.previewStroke(3, style, pts)
  assert.deepEqual(w.inputs[1].msg, { t: 'p', s: 3, k: 's', ...style, n: 52, d: pts.slice(104) })
  w.advance(34)
  w.net.previewShape(4, { tool: 'rect', color: 2, size: 6 }, 0, 1, 2, 3)
  assert.deepEqual(w.inputs[2].msg, {
    t: 'p',
    s: 4,
    k: 'h',
    tool: 'rect',
    color: 2,
    size: 6,
    n: 0,
    d: [0, 1, 2, 3]
  })
})

test('the longest stroke preview is under 900 bytes, and relayed with from under 1024', () => {
  const w = load()
  const pts = []
  for (let i = 0; i < 4096; i++) pts.push(-256, i % 2 ? 7936 : -256)
  w.net.previewStroke(65535, { tool: 'abcdefghijklmnop', color: 0xffffff, size: 128 }, pts)
  const msg = w.inputs[0].msg
  assert.equal(msg.d.length, 96)
  assert.equal(msg.n, 4048)
  const bytes = new TextEncoder().encode(JSON.stringify(msg)).length
  assert.ok(bytes < 900, String(bytes))
  const relayed = JSON.stringify({ ...msg, from: '9223372036854775807' })
  assert.ok(relayed.length <= MAX_VOLATILE, String(relayed.length))
})

test('a stroke preview cut down to fit when its fields are long', () => {
  const w = load()
  const pts = []
  for (let i = 0; i < 48; i++) pts.push(-256, -256)
  w.net.previewStroke(1, { tool: 'x'.repeat(600), color: 0, size: 1 }, pts)
  const msg = w.inputs[0].msg
  assert.ok(new TextEncoder().encode(JSON.stringify(msg)).length < 900)
  assert.ok(msg.d.length < 96 && msg.d.length > 0)
  assert.equal(msg.n, 48 - msg.d.length / 2)
})

test('datagrams are paced: 25 ms apart, previews 30 a second, cursor 15 and not mid-stroke', () => {
  const w = load()
  const style = { tool: 'pen', color: 1, size: 5 }
  for (let t = 0; t < 300; t += 8) {
    w.net.cursor(t, t)
    w.advance(8)
  }
  const pts = []
  for (let t = 0; t < 500; t += 8) {
    pts.push(t, t + 1)
    w.net.previewStroke(9, style, pts)
    w.net.cursor(t, t)
    w.advance(8)
  }
  pts.push(999, 998)
  w.net.previewStroke(9, style, pts)
  w.net.previewEnd(9)
  for (let t = 0; t < 300; t += 8) {
    w.net.cursor(t, t)
    w.advance(8)
  }
  w.advance(500)
  const at = (kind) => w.inputs.filter((i) => i.msg.t === kind).map((i) => i.at)
  const gaps = (times) => times.slice(1).map((t, n) => t - times[n])
  assert.ok(Math.min(...gaps(w.inputs.map((i) => i.at))) >= 25)
  assert.ok(Math.min(...gaps(at('p'))) >= 34)
  assert.ok(Math.min(...gaps(at('c'))) >= 67)
  assert.ok(at('p').length >= 14, String(at('p').length))
  const kinds = w.inputs.map((i) => i.msg.t).join('')
  assert.match(kinds, /^c+p+ec+$/)
  const end = w.inputs.findIndex((i) => i.msg.t === 'e')
  assert.deepEqual(w.inputs[end].msg, { t: 'e', s: 9 })
  assert.deepEqual(w.inputs[end - 1].msg.d.slice(-2), [999, 998])
})

test('an end right after a preview waits its turn, and goes before the next stroke', () => {
  const w = load()
  const style = { tool: 'pen', color: 1, size: 5 }
  w.net.previewStroke(1, style, [0, 0, 4, 4])
  w.advance(1)
  w.net.previewEnd(1)
  w.net.previewStroke(2, style, [8, 8, 12, 12])
  w.advance(200)
  assert.deepEqual(
    w.inputs.map((i) => [i.at, i.msg.t, i.msg.s]),
    [
      [1000, 'p', 1],
      [1025, 'e', 1],
      [1050, 'p', 2]
    ]
  )
})
