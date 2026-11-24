// Watch Together's sync and link parser (activities/ui/watch_together/sync.js), a plain bundle
// script, loaded through node:vm as the bundle frame would run it; and the shell's add from a chat
// embed (watchTogether.js).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

import { JOIN_WAIT_MS, NO_ROOM_TEXT, addVideo } from './watchTogether.js'

const code = readFileSync(
  new URL('../../activities/ui/watch_together/sync.js', import.meta.url),
  'utf8'
)
const context = { URL }
context.window = context
vm.createContext(context)
vm.runInContext(code, context)
const sync = context.watchSync
// Objects from the vm's realm, compared by value.
const plain = (v) => JSON.parse(JSON.stringify(v))

test('sync.js defines one global', () => {
  assert.deepEqual(
    Object.keys(context).filter((k) => !['URL', 'window'].includes(k)),
    ['watchSync']
  )
})

test('the video id from each kind of link', () => {
  const id = 'M7lc1UVf-VE'
  for (const link of [
    `https://www.youtube.com/watch?v=${id}`,
    `https://youtube.com/watch?v=${id}&t=42s`,
    `https://m.youtube.com/watch?feature=share&v=${id}`,
    `https://music.youtube.com/watch?v=${id}&list=RD`,
    `http://www.youtube.com/watch?v=${id}`,
    `https://youtu.be/${id}`,
    `https://youtu.be/${id}?si=abc&t=10`,
    `https://www.youtube.com/shorts/${id}`,
    `https://www.youtube.com/embed/${id}?autoplay=1`,
    `https://www.youtube.com/live/${id}?feature=share`,
    `https://www.youtube-nocookie.com/embed/${id}`.replace('-nocookie', ''),
    `www.youtube.com/watch?v=${id}`,
    `youtu.be/${id}`,
    `  ${id}  `,
    id
  ]) {
    assert.equal(sync.parseVideoLink(link), id, link)
  }
})

test('anything else is not a YouTube link', () => {
  for (const link of [
    '',
    null,
    'hello',
    'M7lc1UVf-V',
    'M7lc1UVf-VEE',
    'https://www.youtube.com/watch?v=M7lc1UVf-V',
    'https://www.youtube.com/watch?v=M7lc1UVf+VE',
    'https://www.youtube.com/watch',
    'https://www.youtube.com/channel/M7lc1UVf-VE',
    'https://www.youtube-nocookie.com/embed/M7lc1UVf-VE',
    'https://youtube.com.example.com/watch?v=M7lc1UVf-VE',
    'https://notyoutube.com/watch?v=M7lc1UVf-VE',
    'https://vimeo.com/M7lc1UVf-VE',
    'ftp://youtu.be/M7lc1UVf-VE',
    'javascript:alert(1)'
  ]) {
    assert.equal(sync.parseVideoLink(link), null, String(link))
  }
})

const entry = (id, videoId = 'M7lc1UVf-VE') => ({ id, video_id: videoId, title: '', added_by: '1' })
const playing = (o = {}) => ({
  entry: entry(1),
  playing: true,
  position_ms: 0,
  at_ms: 10_000,
  rate: 100,
  ...o
})

test('the target position, playing, paused, in the lead-in and at a rate', () => {
  const cur = playing({ position_ms: 5000, at_ms: 10_000 })
  assert.equal(sync.targetMs(cur, 12_000), 7000)
  assert.equal(sync.targetMs(cur, 8000), 5000)
  assert.equal(sync.targetMs({ ...cur, playing: false }, 99_000), 5000)
  assert.equal(sync.targetMs({ ...cur, rate: 200 }, 12_000), 9000)
  assert.equal(sync.targetMs({ ...cur, rate: 50 }, 12_000), 6000)
  assert.equal(sync.targetMs({ ...cur, rate: undefined }, 12_000), 7000)
  assert.equal(sync.targetMs(null, 0), 0)
})

test('the lead-in and its countdown', () => {
  const cur = playing({ at_ms: 10_000 })
  assert.equal(sync.inLeadIn(cur, 7000), true)
  assert.deepEqual(
    [7000, 7001, 8000, 8001, 9000, 9001, 9999].map((t) => sync.leadInSeconds(cur, t)),
    [3, 3, 2, 2, 1, 1, 1]
  )
  assert.equal(sync.inLeadIn(cur, 10_000), false)
  assert.equal(sync.leadInSeconds(cur, 10_000), 0)
  assert.equal(sync.inLeadIn({ ...cur, playing: false }, 7000), false)
})

test('the player position is extrapolated only while it plays', () => {
  const s = { state: 'playing', positionMs: 1000, rate: 100 }
  assert.equal(sync.playerMs(s, 500, 1500), 2000)
  assert.equal(sync.playerMs({ ...s, rate: 150 }, 500, 1500), 2500)
  assert.equal(sync.playerMs({ ...s, state: 'paused' }, 500, 1500), 1000)
  assert.equal(sync.playerMs(null, 0, 0), 0)
})

// A driver: the room's current entry, the server clock (here the same as local time) and the
// player's last status.
function driver(current) {
  let mem = sync.initialMemory()
  const d = {
    current,
    status: null,
    statusAt: 0,
    tick(local, extra = {}) {
      const out = sync.reconcile(mem, {
        current: d.current,
        now: local,
        local,
        ready: true,
        status: d.status,
        statusAt: d.statusAt,
        ...extra
      })
      mem = out.mem
      return plain(out.commands)
    },
    report(local, state, positionMs, more = {}) {
      d.status = { state, positionMs, durationMs: 1_343_661, title: 't', rate: 100, ...more }
      d.statusAt = local
      return d.tick(local)
    },
    error(code, local = 0) {
      const out = sync.onPlayerError(mem, code, { current: d.current, now: local, local })
      mem = out.mem
      return plain(out.commands)
    },
    retry() {
      mem = sync.retry(mem)
    },
    get mem() {
      return plain(mem)
    }
  }
  return d
}

test('nothing happens until the player is ready', () => {
  const out = sync.reconcile(sync.initialMemory(), {
    current: playing(),
    now: 0,
    local: 0,
    ready: false,
    status: null,
    statusAt: 0
  })
  assert.deepEqual(plain(out.commands), [])
})

test('nothing current unloads what is loaded, once', () => {
  const d = driver(null)
  assert.deepEqual(d.tick(0), [])
  d.current = playing({ at_ms: 0 })
  d.tick(1000)
  d.current = null
  assert.deepEqual(d.tick(2000), [{ op: 'unload' }])
  assert.deepEqual(d.tick(3000), [])
})

test('a new entry loads at the target, playing unless in the lead-in or paused', () => {
  // In the lead-in: at 0, paused.
  assert.deepEqual(driver(playing({ at_ms: 10_000 })).tick(7000), [
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 0, play: false }
  ])
  // Joined late: at the target, playing.
  assert.deepEqual(driver(playing({ position_ms: 1000, at_ms: 10_000 })).tick(70_000), [
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 61_000, play: true }
  ])
  // Paused.
  assert.deepEqual(driver(playing({ playing: false, position_ms: 42_000 })).tick(70_000), [
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 42_000, play: false }
  ])
  // The next entry loads in its turn.
  const d = driver(playing({ at_ms: 0 }))
  d.tick(1000)
  d.current = playing({ entry: entry(2, 'a_b-c_d-e_f'), at_ms: 5000 })
  assert.deepEqual(d.tick(3000), [{ op: 'load', videoId: 'a_b-c_d-e_f', startMs: 0, play: false }])
})

test('held paused at 0 through the lead-in, played when it ends', () => {
  const d = driver(playing({ at_ms: 10_000 }))
  d.tick(7000)
  assert.deepEqual(d.report(7500, 'cued', 0), [])
  assert.deepEqual(d.report(8000, 'playing', 100), [{ op: 'pause' }])
  assert.deepEqual(d.report(8100, 'paused', 120), [])
  assert.deepEqual(d.tick(10_000), [{ op: 'play' }])
})

test('the room plays and pauses the player', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(1000)
  assert.deepEqual(d.report(1500, 'paused', 1500), [{ op: 'play' }])
  assert.deepEqual(d.report(1600, 'cued', 1600), [{ op: 'play' }])
  d.current = playing({ playing: false, position_ms: 2000, at_ms: 2000 })
  assert.deepEqual(d.report(2100, 'playing', 2000), [{ op: 'pause' }])
  assert.deepEqual(d.report(2200, 'paused', 2050), [])
})

test('drift over 1500 ms playing or 500 ms paused is sought, at most every 2 s', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  assert.deepEqual(d.report(1000, 'playing', 1000), [])
  assert.deepEqual(d.report(10_000, 'playing', 8500), [])
  assert.deepEqual(d.report(11_000, 'playing', 9400), [{ op: 'seek', positionMs: 11_000 }])
  assert.deepEqual(d.report(12_000, 'playing', 6000), [])
  assert.deepEqual(d.report(13_000, 'playing', 7000), [{ op: 'seek', positionMs: 13_000 }])

  const p = driver(playing({ playing: false, position_ms: 30_000, at_ms: 0 }))
  p.tick(0)
  assert.deepEqual(p.report(1000, 'paused', 30_400), [])
  assert.deepEqual(p.report(4000, 'paused', 30_600), [{ op: 'seek', positionMs: 30_000 }])
})

test('no corrective seek while loading, or buffering under 8 s', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  d.report(1000, 'playing', 1000)
  assert.deepEqual(d.report(20_000, 'loading', 0), [])
  assert.deepEqual(d.report(21_000, 'buffering', 5000), [])
  assert.deepEqual(d.report(28_000, 'buffering', 5000), [])
  assert.deepEqual(d.tick(29_000), [{ op: 'seek', positionMs: 29_000 }])
})

test('a load that has not settled in 8 s is loaded again, and the fourth try stalls', () => {
  const d = driver(playing({ at_ms: 0 }))
  assert.equal(d.tick(0)[0].op, 'load')
  d.report(1000, 'buffering', 0)
  assert.deepEqual(d.tick(7999), [])
  for (const t of [8000, 16_000, 24_000]) {
    assert.deepEqual(
      d.tick(t),
      [{ op: 'load', videoId: 'M7lc1UVf-VE', startMs: t, play: true }],
      String(t)
    )
  }
  assert.deepEqual(d.tick(32_000), [])
  assert.equal(d.mem.stalled, true)
  assert.equal(d.mem.reloads, 3)
  assert.deepEqual(d.tick(40_000), [])
  // Retry: loads again with a fresh count.
  d.retry()
  assert.deepEqual(d.tick(41_000), [
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 41_000, play: true }
  ])
  assert.equal(d.mem.stalled, false)
  assert.equal(d.mem.reloads, 0)
})

test('a load that settles near the target is not loaded again', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  d.report(2000, 'playing', 1200)
  assert.equal(d.mem.pending, null)
  assert.deepEqual(d.tick(9000), [])
  // A seek that does not land is followed up the same way.
  d.report(10_000, 'playing', 4000)
  assert.equal(d.mem.pending != null, true)
  d.report(12_000, 'buffering', 10_000)
  assert.deepEqual(d.tick(18_000), [
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 18_000, play: true }
  ])
})

test('corrective seeks that do not settle do not hold the reload back', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  d.report(1000, 'playing', 1000)
  // Stuck buffering from 20 s: after 8 s of it, a seek every 2 s, none landing.
  d.report(20_000, 'buffering', 5000)
  assert.deepEqual(d.tick(28_000), [{ op: 'seek', positionMs: 28_000 }])
  assert.deepEqual(d.tick(30_000), [{ op: 'seek', positionMs: 30_000 }])
  assert.deepEqual(d.tick(32_000), [{ op: 'seek', positionMs: 32_000 }])
  assert.deepEqual(d.tick(34_000), [{ op: 'seek', positionMs: 34_000 }])
  // 8 s after the first of them: loaded again.
  assert.deepEqual(d.tick(36_000), [
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 36_000, play: true }
  ])
  assert.equal(d.mem.reloads, 1)
})

test('ended while the room plays is sent once per entry', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  assert.deepEqual(d.report(5000, 'ended', 1_343_661), [{ action: { type: 'ended', entry_id: 1 } }])
  assert.deepEqual(d.report(5250, 'ended', 1_343_661), [])
  assert.deepEqual(d.tick(6000), [])
  const p = driver(playing({ playing: false, at_ms: 0 }))
  p.tick(0)
  assert.deepEqual(p.report(5000, 'ended', 1_343_661), [])
})

test('an error is reported unplayable once and nothing retries it', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  assert.deepEqual(d.error(150), [{ action: { type: 'unplayable', entry_id: 1 } }])
  assert.deepEqual(d.error(150), [])
  assert.equal(d.mem.error, 150)
  assert.deepEqual(d.report(1000, 'paused', 0), [])
  assert.deepEqual(d.tick(20_000), [])
  // The room moves on: the next entry loads with no error.
  d.current = playing({ entry: entry(2), at_ms: 30_000 })
  assert.equal(d.tick(27_000)[0].op, 'load')
  assert.equal(d.mem.error, null)
})

test('error 5 is loaded again while the reloads last, then shown and reported', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  for (const [i, t] of [1000, 2000, 3000].entries()) {
    assert.deepEqual(
      d.error(5, t),
      [{ op: 'load', videoId: 'M7lc1UVf-VE', startMs: t, play: true }],
      String(t)
    )
    assert.equal(d.mem.reloads, i + 1)
    assert.equal(d.mem.error, null)
  }
  assert.deepEqual(d.error(5, 4000), [{ action: { type: 'unplayable', entry_id: 1 } }])
  assert.equal(d.mem.error, 5)
  assert.deepEqual(d.tick(5000), [])
})

test('error 5 shares the count with the reloads, and a reload that plays shows nothing', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  d.report(1000, 'buffering', 0)
  assert.equal(d.tick(8000)[0].op, 'load')
  assert.equal(d.tick(16_000)[0].op, 'load')
  assert.equal(d.mem.reloads, 2)
  assert.equal(d.error(5, 17_000)[0].op, 'load')
  assert.equal(d.mem.reloads, 3)
  assert.deepEqual(d.error(5, 18_000), [{ action: { type: 'unplayable', entry_id: 1 } }])
  // One error 5, then the reload plays: no error, nothing reported.
  const p = driver(playing({ at_ms: 0 }))
  p.tick(0)
  assert.equal(p.error(5, 1000)[0].op, 'load')
  assert.deepEqual(p.report(2000, 'playing', 2000), [])
  assert.equal(p.mem.error, null)
  assert.equal(p.mem.pending, null)
})

test('errors other than 5 stay final at once', () => {
  for (const code of [2, 100, 101, 150, 152]) {
    const d = driver(playing({ at_ms: 0 }))
    d.tick(0)
    assert.deepEqual(
      d.error(code, 1000),
      [{ action: { type: 'unplayable', entry_id: 1 } }],
      String(code)
    )
    assert.equal(d.mem.error, code)
  }
})

test('no duration after 5 s of playing is live, with no drift correction', () => {
  const d = driver(playing({ at_ms: 0 }))
  d.tick(0)
  d.report(1000, 'playing', 1000, { durationMs: 0 })
  d.report(5000, 'playing', 5000, { durationMs: 0 })
  assert.equal(d.mem.live, false)
  d.report(6000, 'playing', 6000, { durationMs: 0 })
  assert.equal(d.mem.live, true)
  assert.deepEqual(d.report(20_000, 'playing', 9000, { durationMs: 0 }), [])
})

test('the room rate is set when the player differs, asked again after 2 s', () => {
  const d = driver(playing({ at_ms: 0, rate: 150 }))
  d.tick(0)
  assert.deepEqual(d.report(1000, 'playing', 1000), [{ op: 'rate', rate: 150 }])
  assert.deepEqual(d.report(1500, 'playing', 1600), [])
  assert.deepEqual(d.report(3100, 'playing', 3900), [{ op: 'rate', rate: 150 }])
  assert.deepEqual(d.report(3400, 'playing', 4300, { rate: 150 }), [])
})

// A controller as sessionStore.js gives it, for addVideo: state, subscribe, attach, sendAction.
function fakeController(status, sendResult = 'sent') {
  const listeners = new Set()
  const views = new Map()
  const sent = []
  let nextView = 1
  const c = {
    state: { status },
    sent,
    views,
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    attach(handlers) {
      const viewId = nextView++
      views.set(viewId, handlers)
      return { viewId, detach: () => views.delete(viewId) }
    },
    sendAction(viewId, uiId, data) {
      sent.push({ viewId, uiId, data })
      return sendResult
    },
    set(next) {
      c.state = { ...c.state, status: next }
      for (const fn of [...listeners]) fn(c.state)
    },
    reply(reply) {
      for (const v of [...views.values()]) v.onReply?.(reply)
    },
    listenerCount: () => listeners.size
  }
  return c
}
function fakeTimers() {
  const timers = new Map()
  let next = 1
  return {
    setTimer: (fn, ms) => {
      timers.set(next, { fn, ms })
      return next++
    },
    clearTimer: (id) => timers.delete(id),
    fire: () => {
      for (const [id, t] of [...timers]) {
        timers.delete(id)
        t.fn()
      }
    },
    pending: () => [...timers.values()].map((t) => t.ms)
  }
}

test('in a joined room the add goes at once, the title cut to 120 characters', async () => {
  const c = fakeController('joined')
  const title = '\u{1F3AC}'.repeat(130)
  const done = addVideo(c, 'M7lc1UVf-VE', title, fakeTimers())
  assert.equal(c.sent.length, 1)
  assert.equal(c.sent[0].data.type, 'add')
  assert.equal(c.sent[0].data.video_id, 'M7lc1UVf-VE')
  assert.equal([...c.sent[0].data.title].length, 120)
  c.reply({ type: 'ok', id: 1, generation: 4 })
  assert.equal(await done, null)
  assert.equal(c.views.size, 0)
})

test('an add with no title sends an empty one', async () => {
  const c = fakeController('joined')
  const done = addVideo(c, 'M7lc1UVf-VE', undefined, fakeTimers())
  assert.equal(c.sent[0].data.title, '')
  c.reply({ type: 'ok', id: 1, generation: 1 })
  assert.equal(await done, null)
})

test('it waits for joined, up to 10 s', async () => {
  const c = fakeController('connecting')
  const timers = fakeTimers()
  const done = addVideo(c, 'M7lc1UVf-VE', 't', timers)
  assert.deepEqual(timers.pending(), [JOIN_WAIT_MS])
  assert.equal(c.sent.length, 0)
  c.set('joined')
  assert.equal(c.sent.length, 1)
  assert.deepEqual(timers.pending(), [])
  assert.equal(c.listenerCount(), 0)
  c.reply({ type: 'rejected', id: 1, reason: 'queue_full' })
  assert.equal(await done, 'The queue is full')
  assert.equal(c.views.size, 0)
})

test("no joined in time is Couldn't reach the room, and nothing is sent", async () => {
  const c = fakeController('connecting')
  const timers = fakeTimers()
  const done = addVideo(c, 'M7lc1UVf-VE', 't', timers)
  timers.fire()
  assert.equal(await done, NO_ROOM_TEXT)
  assert.equal(NO_ROOM_TEXT, "Couldn't reach the room")
  assert.equal(c.views.size, 0)
  assert.equal(c.listenerCount(), 0)
  c.set('joined')
  assert.equal(c.sent.length, 0)
})

test('the rejection texts, and anything else as the reason', async () => {
  for (const [reason, text] of [
    ['adding_locked', 'Only the leader can add videos'],
    ['queue_full', 'The queue is full'],
    ['too_many_queued', 'You have 10 videos queued already'],
    ['bad_video', 'bad_video'],
    ['not_connected', 'not_connected']
  ]) {
    const c = fakeController('joined')
    const done = addVideo(c, 'M7lc1UVf-VE', 't', fakeTimers())
    c.reply({ type: 'rejected', id: 1, reason })
    assert.equal(await done, text, reason)
  }
  const refused = fakeController('joined', 'not_connected')
  assert.equal(await addVideo(refused, 'M7lc1UVf-VE', 't', fakeTimers()), 'not_connected')
  assert.equal(refused.views.size, 0)
})
