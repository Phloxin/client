// The whiteboard's network layer: `window.wbNet`, the one way main.js reaches the room, over the
// shared bridge and room layers. Actions go out one group at a time, an op too big for one action
// as `part`s and a final `op`; the cursor and previews go out as datagrams, spaced for the
// server's input gap.
/* global bridge, room */
;(() => {
  // An action's control body at most, the envelope and the longest wire id counted: a quarter
  // under the 4096 bytes the shell and the server take.
  const MAX_ACTION_BYTES = 3072
  const LONGEST_WIRE_ID = 4294967295
  // How many of a group's actions are posted ahead of their answers.
  const AHEAD = 16
  // A commit refused `rate_limited` is sent again, from its first part, this many times, each
  // after a pause long enough for the server's bucket (60 a second) to refill what it takes.
  const RETRIES = 3
  const RETRY_MS = 250
  const TOKEN_MS = 17
  // Datagrams: any two at least GAP_MS apart (the server drops one within 15 ms of the last),
  // previews at most 30 a second, the cursor at most 15.
  const GAP_MS = 25
  const PREVIEW_MS = 34
  const CURSOR_MS = 67
  const TAIL_POINTS = 48
  const MAX_DATAGRAM_BYTES = 900
  const SHARED_NAME = 'whiteboard.png'

  const encoder = new TextEncoder()
  const bytes = (value) => encoder.encode(JSON.stringify(value)).length
  const actionBytes = (data) => bytes({ t: 'action', id: LONGEST_WIRE_ID, data })
  const live = () => room.connected && !room.closed

  // The actions that carry `op`: the op alone when it fits; otherwise `d` in parts, the first
  // marked `first`, then the op with the rest of `d` and `cont`.
  function actionsFor(op) {
    const whole = { t: 'op', op }
    const d = op?.d
    if (!Array.isArray(d) || !d.every(Number.isInteger) || actionBytes(whole) <= MAX_ACTION_BYTES) {
      return [whole]
    }
    const len = (i) => String(d[i]).length
    // The op keeps as much of the end of `d` as it has room for.
    let cut = d.length
    let space = MAX_ACTION_BYTES - actionBytes({ t: 'op', op: { ...op, d: [] }, cont: true })
    for (; cut > 0; cut--) {
      const cost = len(cut - 1) + (cut < d.length ? 1 : 0)
      if (cost > space) break
      space -= cost
    }
    const partSpace = MAX_ACTION_BYTES - actionBytes({ t: 'part', d: [], first: true })
    const actions = []
    for (let start = 0; start < cut; ) {
      let end = start + 1
      for (let used = len(start); end < cut && used + 1 + len(end) <= partSpace; end++) {
        used += 1 + len(end)
      }
      const part = { t: 'part', d: d.slice(start, end) }
      if (!actions.length) part.first = true
      actions.push(part)
      start = end
    }
    actions.push({ t: 'op', op: { ...op, d: d.slice(cut) }, cont: true })
    return actions
  }

  const jobs = []
  let active = null

  function enqueue(actions, retry) {
    if (!live()) return Promise.reject('not_connected')
    return new Promise((resolve, reject) => {
      jobs.push({ actions, retry, tries: 0, run: null, timer: null, resolve, reject })
      next()
    })
  }

  function next() {
    if (active || !jobs.length) return
    active = jobs.shift()
    start(active)
  }

  // The group is answered once every action posted is: by the first refusal, after which nothing
  // more of it is posted, or by the last action's success.
  function start(job) {
    const run = {}
    job.run = run
    let sent = 0
    let answered = 0
    let reason = null
    const post = () => {
      while (reason == null && sent < job.actions.length && sent - answered < AHEAD) {
        bridge.action(job.actions[sent++]).then(
          () => answer(null),
          (why) => answer(String(why))
        )
      }
    }
    const answer = (why) => {
      if (job.run !== run) return
      answered++
      reason ??= why
      post()
      if (answered === sent && (reason != null || sent === job.actions.length)) done(job, reason)
    }
    post()
  }

  // A retry keeps the group's place, so nothing is sent before it.
  function done(job, reason) {
    job.run = null
    if (reason === 'rate_limited' && job.retry && job.tries < RETRIES) {
      job.tries++
      job.timer = setTimeout(
        () => {
          job.timer = null
          start(job)
        },
        RETRY_MS + job.actions.length * TOKEN_MS
      )
      return
    }
    active = null
    if (reason == null) job.resolve()
    else job.reject(reason)
    next()
  }

  // A dropped session answers nothing more. What it had in hand may land anyway; the next
  // snapshot shows it.
  function abandon() {
    const all = active ? [active, ...jobs] : jobs.slice()
    active = null
    jobs.length = 0
    for (const job of all) {
      job.run = null
      clearTimeout(job.timer)
      job.reject('not_connected')
    }
  }

  // The stroke's newest points, at most TAIL_POINTS, with `n` the index of the first.
  function strokeDatagram(s, style, pts) {
    const count = pts.length >> 1
    const { tool, color, size } = style
    for (let n = Math.max(0, count - TAIL_POINTS); ; n++) {
      const msg = { t: 'p', s, k: 's', tool, color, size, n, d: pts.slice(n * 2, count * 2) }
      if (n >= count - 1 || bytes(msg) < MAX_DATAGRAM_BYTES) return msg
    }
  }

  let lastAt = -Infinity
  let lastPreviewAt = -Infinity
  let lastCursorAt = -Infinity
  // The newest preview and cursor not sent yet, replaced by each call.
  let preview = null
  let cursorAt = null
  let previewing = false
  // What must go out in order: a stroke's last preview and its end.
  const queue = []
  let pumpTimer = null

  const headAt = () =>
    Math.max(lastAt + GAP_MS, queue[0].preview ? lastPreviewAt + PREVIEW_MS : -Infinity)

  function take(t) {
    if (queue.length) {
      if (t < headAt()) return null
      if (queue[0].preview) lastPreviewAt = t
      return queue.shift().msg
    }
    if (preview && t >= lastPreviewAt + PREVIEW_MS) {
      const msg = preview.msg()
      preview = null
      lastPreviewAt = t
      return msg
    }
    if (cursorAt && !previewing && t >= lastCursorAt + CURSOR_MS) {
      const msg = { t: 'c', x: cursorAt.x, y: cursorAt.y }
      cursorAt = null
      lastCursorAt = t
      return msg
    }
    return null
  }

  function nextAt() {
    if (queue.length) return headAt()
    const gap = lastAt + GAP_MS
    let at = Infinity
    if (preview) at = Math.max(gap, lastPreviewAt + PREVIEW_MS)
    if (cursorAt && !previewing) at = Math.min(at, Math.max(gap, lastCursorAt + CURSOR_MS))
    return at
  }

  function pump() {
    clearTimeout(pumpTimer)
    pumpTimer = null
    const t = performance.now()
    if (t >= lastAt + GAP_MS) {
      const msg = take(t)
      if (msg) {
        bridge.input(msg)
        lastAt = t
      }
    }
    const at = nextAt()
    if (at !== Infinity) pumpTimer = setTimeout(pump, Math.max(0, at - performance.now()))
  }

  const listeners = {}
  const emit = (event, value) => {
    for (const fn of listeners[event] ?? []) fn(value)
  }
  // Everyone seen in this room, in the order first seen.
  const seen = new Set()
  let lastView = null

  room.onRender(() => {
    for (const id of room.clients) seen.add(id)
    const view = room.view
    if (view && view !== lastView) {
      lastView = view
      emit('snapshot', view)
    }
    if (!live()) abandon()
    emit('people')
  })
  room.onDelta(({ data }) => emit('delta', data))
  bridge.onVolatile((m) => {
    if (!m || typeof m !== 'object' || m.from == null) return
    const from = String(m.from)
    if (m.t === 'c') emit('cursor', { from, x: m.x, y: m.y })
    else if (m.t === 'p') {
      const { s, k, tool, color, size, n, d } = m
      emit('preview', { from, s, k, tool, color, size, n, pts: d })
    } else if (m.t === 'e') emit('previewEnd', { from, s: m.s })
  })

  window.wbNet = {
    on(event, fn) {
      ;(listeners[event] ??= []).push(fn)
    },
    get you() {
      return room.you
    },
    get connected() {
      return live()
    },
    canShare: true,
    now: () => Date.now() + room.clockOffsetMs,
    people() {
      const here = new Set(room.clients)
      return [...seen].map((id) => ({ id, name: room.nameOf(id), present: here.has(id) }))
    },
    nameOf: (id) => room.nameOf(id),
    avatarEl: (id) => room.avatarEl(id),
    commit: (op) => enqueue(actionsFor(op), true),
    act: (action) => enqueue([action], false),
    cursor(x, y) {
      if (previewing) return
      cursorAt = { x, y }
      pump()
    },
    previewStroke(s, style, pts) {
      previewing = true
      cursorAt = null
      if (pts.length < 2) return
      preview = { s, msg: () => strokeDatagram(s, style, pts) }
      pump()
    },
    previewShape(s, style, x0, y0, x1, y1) {
      previewing = true
      cursorAt = null
      const { tool, color, size } = style
      const msg = { t: 'p', s, k: 'h', tool, color, size, n: 0, d: [x0, y0, x1, y1] }
      preview = { s, msg: () => msg }
      pump()
    },
    previewEnd(s) {
      previewing = false
      if (preview?.s === s) {
        queue.push({ msg: preview.msg(), preview: true })
        preview = null
      }
      queue.push({ msg: { t: 'e', s } })
      pump()
    },
    savePng: (bytes, name) => bridge.exportImage('save', name, bytes),
    sharePng: (bytes) => bridge.exportImage('share', SHARED_NAME, bytes)
  }
})()
