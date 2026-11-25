import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeControl } from './frames.js'
import {
  JOIN_TIMEOUT_MS,
  certificateHashes,
  createSessionStore,
  reconnectDelay,
  sessionUrl
} from './sessionStore.js'

// A store on fakes: manual timers, sessions that record what they were sent, and a ticket queue.
function harness() {
  let clock = 1_000_000
  const timers = new Map()
  let nextTimer = 1
  const sessions = []
  const tickets = []
  const ticketCalls = []
  const deps = {
    now: () => clock,
    setTimer: (fn, ms) => {
      const id = nextTimer++
      timers.set(id, { fn, at: clock + ms })
      return id
    },
    clearTimer: (id) => timers.delete(id),
    openSession: (url, ticket, handlers, certHashes) => {
      const s = {
        url,
        ticket,
        handlers,
        certHashes,
        sent: [],
        datagrams: [],
        left: false,
        closed: false
      }
      s.send = (frame) => s.sent.push(decodeControl(frame.subarray(4)))
      s.sendDatagram = (payload) => s.datagrams.push(payload)
      s.leave = () => (s.left = true)
      s.close = () => (s.closed = true)
      sessions.push(s)
      return s
    },
    fetchTicket: (roomId) => {
      ticketCalls.push(roomId)
      const next = tickets.shift() ?? {
        ticket: 't-next',
        url: 'https://rooms.example:9876/rooms/r1'
      }
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
    }
  }
  const store = createSessionStore(deps)
  // Runs every timer due within `ms`, in order, letting promises settle between them.
  const advance = async (ms) => {
    const until = clock + ms
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, t]) => t.at <= until)
        .sort((a, b) => a[1].at - b[1].at)
      if (!due.length) break
      const [id, t] = due[0]
      timers.delete(id)
      clock = t.at
      t.fn()
      await flush()
    }
    clock = until
  }
  return {
    store,
    sessions,
    tickets,
    ticketCalls,
    timers,
    advance,
    deps,
    last: () => sessions.at(-1)
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))
const room = (id = 'r1', extra = {}) => ({
  id,
  channel_id: 'c1',
  activity_id: 'tic_tac_toe',
  creator: 'u1',
  clients: [],
  opened_at: 1,
  ...extra
})
const firstTicket = { ticket: 't0', url: 'https://rooms.example:9876/rooms/r1', ttl_ms: 30000 }
const joined = (s, extra = {}) =>
  s.handlers.onControl({
    t: 'joined',
    you: 'u2',
    creator: 'u1',
    clients: ['u1', 'u2'],
    now_ms: 1_000_500,
    ...extra
  })
const err = (code) => Object.assign(new Error(code), { code })
const hashOf = (byte) => ({ algorithm: 'sha-256', value: new Uint8Array(32).fill(byte) })

test('the session URL is the ticket url with v=1, through searchParams', () => {
  assert.equal(sessionUrl('https://h:9876/rooms/abc'), 'https://h:9876/rooms/abc?v=1')
  assert.equal(sessionUrl('https://h:9876/rooms/abc?v=7&x=1'), 'https://h:9876/rooms/abc?v=1&x=1')
  assert.throws(() => sessionUrl('not a url'))
})

test('certificate hashes decode 64 hex characters to sha-256 bytes and skip anything else', () => {
  for (const list of [undefined, null, 'ab'.repeat(32), {}]) {
    assert.deepEqual(certificateHashes(list), [])
  }
  const known = Uint8Array.from({ length: 32 }, (_, i) => (i % 2 ? 0xff : 0x00))
  const [one] = certificateHashes(['00ff'.repeat(16)])
  assert.equal(one.algorithm, 'sha-256')
  assert.ok(one.value instanceof Uint8Array)
  assert.deepEqual(one.value, known)
  assert.deepEqual(certificateHashes(['00FF'.repeat(16)]), [{ algorithm: 'sha-256', value: known }])
  assert.deepEqual(
    certificateHashes([
      'ab'.repeat(32),
      'a'.repeat(63),
      'cd'.repeat(31) + 'cg',
      7,
      'ef'.repeat(32)
    ]),
    [hashOf(0xab), hashOf(0xef)]
  )
  assert.deepEqual(certificateHashes(['01'.repeat(32), '02'.repeat(32), '03'.repeat(32)]), [
    hashOf(0x01),
    hashOf(0x02),
    hashOf(0x03)
  ])
})

test('a session opens with the decoded hashes of its ticket', () => {
  const h = harness()
  h.store.join(room(), { ...firstTicket, cert_hashes: ['ab'.repeat(32), 'cd'.repeat(32)] })
  assert.deepEqual(h.last().certHashes, [hashOf(0xab), hashOf(0xcd)])
})

test('a ticket without hashes opens a session with none', () => {
  const h = harness()
  h.store.join(room(), firstTicket)
  assert.deepEqual(h.last().certHashes, [])
})

test('a reconnect uses the hashes of the new ticket, not the first one', async () => {
  const h = harness()
  h.store.join(room(), { ...firstTicket, cert_hashes: ['ab'.repeat(32), 'cd'.repeat(32)] })
  h.store.syncRooms([room()])
  joined(h.last())
  h.tickets.push({
    ticket: 't1',
    url: 'https://rooms.example:9876/rooms/r1',
    cert_hashes: ['cd'.repeat(32), 'ef'.repeat(32)],
    ttl_ms: 30000
  })
  h.last().handlers.onEnd(null)
  await h.advance(1000)
  assert.equal(h.sessions.length, 2)
  assert.equal(h.last().ticket, 't1')
  assert.deepEqual(h.last().certHashes, [hashOf(0xcd), hashOf(0xef)])
})

test('reconnect delays are 1, 2, 4, then 8 seconds each time', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(reconnectDelay), [1000, 2000, 4000, 8000, 8000, 8000])
})

test('join opens one session with the given ticket and joins it', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  assert.equal(h.sessions.length, 1)
  assert.equal(h.last().url, 'https://rooms.example:9876/rooms/r1?v=1')
  assert.equal(h.last().ticket, 't0')
  assert.equal(c.state.status, 'connecting')
  joined(h.last())
  assert.equal(c.state.status, 'joined')
  assert.equal(c.state.you, 'u2')
  assert.equal(c.state.creator, 'u1')
  assert.deepEqual(c.state.clients, ['u1', 'u2'])
  assert.equal(c.state.clockOffsetMs, 500)
  // A second join of the same room keeps the one session.
  assert.equal(h.store.join(room(), firstTicket), c)
  assert.equal(h.sessions.length, 1)
})

test('a ticket without url fails and does not retry', async () => {
  const h = harness()
  const c = h.store.join(room(), { ticket: 't0', ttl_ms: 30000 })
  assert.equal(c.state.status, 'failed')
  assert.equal(c.state.failure, 'no_endpoint')
  assert.equal(h.sessions.length, 0)
  await h.advance(60_000)
  assert.equal(h.ticketCalls.length, 0)
})

test('the state log is the last snapshot and the deltas after it', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  const s = h.last()
  const frame = (kind, generation) => ({ kind, generation, payload: new Uint8Array([generation]) })
  s.handlers.onState(frame('snapshot', 1))
  joined(s)
  s.handlers.onState(frame('delta', 2))
  s.handlers.onState(frame('delta', 3))
  assert.deepEqual(
    c.stateLog().map((f) => f.generation),
    [1, 2, 3]
  )
  s.handlers.onState(frame('snapshot', 4))
  s.handlers.onState(frame('delta', 5))
  assert.deepEqual(
    c.stateLog().map((f) => f.generation),
    [4, 5]
  )
})

test('views get state, volatile and only their own replies, under their own ids', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  joined(h.last())
  const a = { state: [], replies: [], volatile: [] }
  const b = { state: [], replies: [], volatile: [] }
  const handlers = (v) => ({
    onState: (f) => v.state.push(f.generation),
    onVolatile: (p) => v.volatile.push(p[0]),
    onReply: (r) => v.replies.push(r)
  })
  const va = c.attach(handlers(a))
  const vb = c.attach(handlers(b))
  assert.equal(c.sendAction(va.viewId, 1, { type: 'sit' }), 'sent')
  assert.equal(c.sendAction(vb.viewId, 1, { type: 'place', cell: 4 }), 'sent')
  const [first, second] = h.last().sent
  assert.deepEqual(first, { t: 'action', id: 1, data: { type: 'sit' } })
  assert.deepEqual(second, { t: 'action', id: 2, data: { type: 'place', cell: 4 } })
  h.last().handlers.onControl({ t: 'rejected', id: 2, reason: 'not_your_turn' })
  h.last().handlers.onControl({ t: 'ok', id: 1, generation: 7 })
  h.last().handlers.onControl({ t: 'ok', id: 1, generation: 7 })
  assert.deepEqual(a.replies, [{ type: 'ok', id: 1, generation: 7 }])
  assert.deepEqual(b.replies, [{ type: 'rejected', id: 1, reason: 'not_your_turn' }])
  h.last().handlers.onState({ kind: 'snapshot', generation: 7, payload: new Uint8Array() })
  h.last().handlers.onVolatile(new Uint8Array([9]))
  assert.deepEqual(a.state, [7])
  assert.deepEqual(b.volatile, [9])
  // A detached view gets nothing more.
  vb.detach()
  h.last().handlers.onState({ kind: 'delta', generation: 8, payload: new Uint8Array() })
  assert.deepEqual(b.state, [7])
})

test('actions while not joined, oversized or not JSON are refused locally', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  const v = c.attach({})
  assert.equal(c.sendAction(v.viewId, 1, { type: 'sit' }), 'not_connected')
  joined(h.last())
  assert.equal(c.sendAction(v.viewId, 2, 'x'.repeat(5000)), 'too_large')
  assert.equal(c.sendAction(v.viewId, 3, 1n), 'invalid')
  assert.equal(h.last().sent.length, 0)
  assert.equal(c.sendInput(new Uint8Array([1])), true)
  assert.equal(h.last().datagrams.length, 1)
})

test('a drop rejects in-flight actions and reconnects with a new ticket after 1 s', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  const replies = []
  const v = c.attach({ onReply: (r) => replies.push(r) })
  c.sendAction(v.viewId, 5, { type: 'sit' })
  h.last().handlers.onEnd(new Error('gone'))
  assert.equal(c.state.status, 'reconnecting')
  assert.deepEqual(replies, [{ type: 'rejected', id: 5, reason: 'not_connected' }])
  await h.advance(999)
  assert.equal(h.ticketCalls.length, 0)
  await h.advance(1)
  assert.deepEqual(h.ticketCalls, ['r1'])
  assert.equal(h.sessions.length, 2)
  assert.equal(h.last().ticket, 't-next')
  joined(h.last())
  assert.equal(c.state.status, 'joined')
})

test('reconnects back off 1, 2, 4, 8, 8 s and reset after a join', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  const gaps = []
  for (let i = 0; i < 5; i++) {
    h.last().handlers.onEnd(null)
    const before = h.ticketCalls.length
    let waited = 0
    while (h.ticketCalls.length === before) {
      await h.advance(500)
      waited += 500
    }
    gaps.push(waited)
  }
  assert.deepEqual(gaps, [1000, 2000, 4000, 8000, 8000])
  joined(h.last())
  h.last().handlers.onEnd(null)
  await h.advance(1000)
  assert.equal(h.ticketCalls.length, 6)
  assert.equal(c.state.status, 'reconnecting')
})

test('an attempt that does not reach joined in 10 s counts as a drop', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  await h.advance(JOIN_TIMEOUT_MS - 1)
  assert.equal(c.state.status, 'connecting')
  await h.advance(1)
  assert.equal(h.sessions[0].closed, true)
  assert.equal(c.state.status, 'reconnecting')
  await h.advance(1000)
  assert.equal(h.sessions.length, 2)
})

test('a ticket error retries, and room_not_found ends the room', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  h.tickets.push(err('unavailable'), err('room_not_found'))
  h.last().handlers.onEnd(null)
  await h.advance(1000)
  assert.equal(c.state.status, 'reconnecting')
  await h.advance(2000)
  assert.equal(c.state.status, 'closed')
  assert.equal(c.state.closeReason, null)
  await h.advance(60_000)
  assert.equal(h.ticketCalls.length, 2)
})

test('the closed frame ends the room with its reason and stops reconnecting', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  const replies = []
  const v = c.attach({ onReply: (r) => replies.push(r) })
  c.sendAction(v.viewId, 1, { type: 'sit' })
  h.last().handlers.onControl({ t: 'closed', reason: 'forced' })
  assert.equal(c.state.status, 'closed')
  assert.equal(c.state.closeReason, 'forced')
  assert.deepEqual(replies, [{ type: 'rejected', id: 1, reason: 'not_connected' }])
  // A release before the server has closed the session closes it, with nothing to leave.
  const s = h.last()
  h.store.release('r1')
  assert.equal(s.left, false)
  assert.equal(s.closed, true)
  s.handlers.onEnd(null)
  await h.advance(60_000)
  assert.equal(h.ticketCalls.length, 0)
  assert.equal(c.state.status, 'closed')
})

test('a room gone from the list ends it, and a closed frame after that still gives the reason', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  h.store.syncRooms([])
  assert.equal(c.state.status, 'closed')
  assert.equal(c.state.closeReason, null)
  // The session is left open for the closed frame.
  assert.equal(h.last().closed, false)
  h.last().handlers.onControl({ t: 'closed', reason: 'channel_deleted' })
  assert.equal(c.state.closeReason, 'channel_deleted')
})

test('a room gone from the list while reconnecting ends it without another attempt', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  h.last().handlers.onEnd(null)
  h.store.syncRooms([])
  assert.equal(c.state.status, 'closed')
  await h.advance(60_000)
  assert.equal(h.ticketCalls.length, 0)
})

test('a room not yet in the list is not taken as gone', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room('other')])
  assert.equal(c.state.status, 'connecting')
  joined(h.last())
  h.store.syncRooms([room('other'), room('r1', { clients: ['u1', 'u2'] })])
  assert.deepEqual(c.state.room.clients, ['u1', 'u2'])
  h.store.syncRooms([room('other')])
  assert.equal(c.state.status, 'closed')
})

test('the room list known before a join counts at once', () => {
  const h = harness()
  h.store.syncRooms([room('r1', { clients: ['u1'] })])
  const c = h.store.join(room(), firstTicket)
  assert.deepEqual(c.state.room.clients, ['u1'])
  h.store.syncRooms([])
  assert.equal(c.state.status, 'closed')
})

test('clients frames update the clients, and busy is kept on the controller', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  joined(h.last())
  const seen = []
  c.subscribe((s) => seen.push(s.clients.join()))
  h.last().handlers.onControl({ t: 'clients', clients: ['u1', 'u2', 'u3'] })
  assert.deepEqual(c.state.clients, ['u1', 'u2', 'u3'])
  c.setBusy(true)
  assert.equal(c.state.busy, true)
  assert.deepEqual(seen, ['u1,u2,u3', 'u1,u2,u3'])
  h.last().handlers.onControl({ t: 'mystery' })
  assert.equal(c.state.status, 'joined')
})

test('release leaves a joined session, closes any other, and stops everything', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  let changes = 0
  h.store.subscribe(() => changes++)
  h.store.release('r1')
  assert.equal(h.last().left, true)
  assert.equal(h.store.get('r1'), null)
  assert.ok(changes >= 1)
  // A session still connecting is closed rather than left.
  const d = h.store.join(room('r2'), { ...firstTicket, url: 'https://rooms.example:9876/rooms/r2' })
  h.store.release('r2')
  assert.equal(h.last().closed, true)
  assert.equal(h.last().left, false)
  // A late end or ticket after release does nothing.
  h.last().handlers.onEnd(null)
  await h.advance(60_000)
  assert.equal(h.ticketCalls.length, 0)
  assert.equal(d.state.status, 'connecting')
  assert.equal(c.state.status, 'joined')
})

test('release after the room is taken as gone still leaves a session in the room', () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  joined(h.last())
  h.store.syncRooms([])
  assert.equal(c.state.status, 'closed')
  h.store.release('r1')
  assert.equal(h.last().left, true)
  // One that never reached the room is closed instead.
  h.store.syncRooms([room('r2')])
  h.store.join(room('r2'), { ...firstTicket, url: 'https://rooms.example:9876/rooms/r2' })
  h.store.syncRooms([])
  h.store.release('r2')
  assert.equal(h.last().left, false)
  assert.equal(h.last().closed, true)
})

test('stale callbacks from an earlier session are ignored', async () => {
  const h = harness()
  const c = h.store.join(room(), firstTicket)
  h.store.syncRooms([room()])
  const old = h.last()
  joined(old)
  old.handlers.onEnd(null)
  await h.advance(1000)
  const fresh = h.last()
  assert.notEqual(fresh, old)
  old.handlers.onControl({ t: 'closed', reason: 'empty' })
  old.handlers.onState({ kind: 'snapshot', generation: 99, payload: new Uint8Array() })
  assert.equal(c.state.status, 'reconnecting')
  assert.deepEqual(c.stateLog(), [])
  joined(fresh)
  assert.equal(c.state.status, 'joined')
})
