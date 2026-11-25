// Whiteboard: a board several people draw on at once. This is the interface: the stage with its
// zoom and pan, the tools and what a pointer does with each, the viewer's own marks shown at once
// over the ink until the room confirms them, other people's cursors and strokes in progress, and
// the panels (colour, size, people and locks, background, prompt, save, timelapse). The room is
// reached only through wbNet (net.js); what a mark looks like is engine.js's business.
/* global wbNet, wbIcons, wbStamps, wbEngine, wbBoard, wbWidgets */
;(() => {
  const $ = (id) => document.getElementById(id)
  const E = wbEngine
  const { W, H, Q } = E
  const { icon } = wbIcons
  const { el, button, iconButton, toggle, setToggle, tip, openPop, closePop, toast, hex } =
    wbWidgets
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

  // How far off the board a point may lie, in px. The wire allows 64.
  const MARGIN = 60
  const NARROW_UNDER = 560
  const TINY_UNDER = 440
  const MAX_SCALE = 8
  const MAX_RECENTS = 6
  const MAX_TEXT_LINES = 10
  const MAX_PROMPT_CHARS = 80
  const INK_WARN = 0.85
  const INK_FULL = 0.985
  // Another person's stroke in progress is dropped when it has not moved for this long, since
  // the message that ends it can be lost; one that ended waits this long for its op.
  const PREVIEW_STALE_MS = 2000
  const PREVIEW_ENDED_MS = 600
  const LASER_MS = 1100
  const CURSOR_IDLE_MS = 4000
  const DRAWING_MS = 900
  const PROMPT_SECS = [30, 60, 120, 300]

  const REASONS = {
    view_only: 'The board is locked for you right now',
    not_host: 'Only the host can do that',
    board_full: 'The board is full. Undo some marks, or ask the host to clear it',
    too_large: 'That mark is too big to send',
    bad_op: 'The board did not take that mark',
    nothing_to_undo: 'Nothing to undo',
    rate_limited: 'Too many marks at once. Slow down a little',
    prompt_active: 'A prompt is already running',
    bad_prompt: 'That prompt cannot be used',
    bad_target: 'That person cannot be locked',
    not_allowed: 'Only the host or whoever started the prompt can stop it',
    no_prompt: 'There is no prompt to stop',
    bad_bg: 'That background is not available',
    not_connected: 'Not connected',
    bad_action: 'The room did not understand that'
  }

  const PALETTE = [
    0x1b1f24, 0x495057, 0x868e96, 0xced4da, 0xffffff, 0x7a4b2a, 0xe03131, 0xf76707, 0xfcc419,
    0xffa8a8, 0xe64980, 0xae3ec9, 0x2f9e44, 0x94d82d, 0x12b886, 0x15aabf, 0x1c7ed6, 0x4c3fd1,
    0xffd8a8, 0xffec99, 0xb2f2bb, 0xa5d8ff, 0xd0bfff, 0xfcc2d7
  ]
  // A colour per person, by their id, each dark enough to carry white text.
  const PERSON_COLORS = [
    '#e5484d',
    '#f76b15',
    '#b8860b',
    '#3d9a50',
    '#0e9888',
    '#0b84d8',
    '#6e56cf',
    '#c2359a',
    '#8d6e4d',
    '#5b6ee1'
  ]

  // `size` names the size the tool draws with, shared by the shapes; `stroke` tools draw
  // strokes; `always` tools work on a locked board.
  const TOOLS = {
    pen: { label: 'Pen', key: 'P', icon: 'pen', size: 'pen', stroke: true },
    pencil: { label: 'Pencil', key: 'N', icon: 'pencil', size: 'pencil', stroke: true },
    marker: { label: 'Marker', key: 'M', icon: 'marker', size: 'marker', stroke: true },
    brush: { label: 'Brush', key: 'B', icon: 'brush', size: 'brush', stroke: true },
    spray: { label: 'Spray', key: 'A', icon: 'spray', size: 'spray', stroke: true },
    eraser: { label: 'Eraser', key: 'E', icon: 'eraser', size: 'eraser', stroke: true },
    bucket: { label: 'Fill', key: 'G', icon: 'bucket' },
    shape: { label: 'Shapes', key: 'U', icon: 'shapes', size: 'shape', more: true },
    text: { label: 'Text', key: 'T', icon: 'text', size: 'text' },
    stamp: { label: 'Stamps', key: 'S', icon: 'stamp', size: 'stamp', more: true },
    laser: { label: 'Laser pointer', short: 'Laser', key: 'K', icon: 'laser', size: 'laser' },
    eyedropper: { label: 'Pick a colour', short: 'Picker', key: 'I', icon: 'eyedropper' },
    hand: { label: 'Move the board', short: 'Move', key: 'H', icon: 'hand', always: true }
  }
  const DOCK_ORDER = Object.keys(TOOLS)
  // Which tools keep their place in the dock as it narrows, first to last.
  const KEEP_ORDER = [
    'pen',
    'pencil',
    'marker',
    'eraser',
    'bucket',
    'shape',
    'text',
    'stamp',
    'brush',
    'spray',
    'hand',
    'laser',
    'eyedropper'
  ]
  const SHAPE_LABELS = {
    line: 'Line',
    arrow: 'Arrow',
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    triangle: 'Triangle',
    star: 'Star'
  }
  const SHAPE_KEYS = { line: 'L', arrow: 'W', rect: 'R', ellipse: 'O' }
  const SIZE_RANGES = { text: [8, 256], stamp: [16, 512], laser: [2, 32] }
  const MIRRORS = {
    off: { label: 'Off', icon: 'mirror-off', flips: [[false, false]] },
    vertical: {
      label: 'Left and right',
      icon: 'mirror-v',
      flips: [
        [false, false],
        [true, false]
      ]
    },
    horizontal: {
      label: 'Top and bottom',
      icon: 'mirror-h',
      flips: [
        [false, false],
        [false, true]
      ]
    },
    four: {
      label: 'Four ways',
      icon: 'mirror-4',
      flips: [
        [false, false],
        [true, false],
        [false, true],
        [true, true]
      ]
    }
  }

  const app = $('app')
  const stage = $('stage')
  const boardEl = $('board')
  const liveWrap = $('live-wrap')
  const ring = $('ring')
  const paperCtx = $('paper').getContext('2d')
  const viewCtx = $('view').getContext('2d')
  const liveCtx = $('live').getContext('2d')
  const tailCtx = $('tail').getContext('2d')
  const fxCtx = $('fx').getContext('2d')

  const board = wbBoard.createBoard()
  const S = board.state

  let tool = 'pen'
  let toolBefore = 'pen'
  let shape = 'rect'
  let shapeFill = false
  let stamp = 'star'
  let color = PALETTE[0]
  let mirror = 'off'
  let transparentSave = false
  let promptSecs = 60
  const recents = []
  const sizes = {
    pen: 5,
    pencil: 4,
    marker: 24,
    brush: 14,
    spray: 48,
    eraser: 36,
    shape: 5,
    text: 44,
    stamp: 140,
    laser: 6
  }

  // Board px to stage px: stage = view + board * scale. `fit` keeps the whole board in view as
  // the pane changes.
  const view = { scale: 1, x: 0, y: 0, fit: true }
  let viewTween = null
  let spaceDown = false
  let gesture = null
  let pinch = null
  const touches = new Map()
  // The viewer's ops the room has not confirmed yet, drawn over the ink: { op, group }.
  const pending = []
  const inFlight = new Set()
  // Undo works a group at a time (a mirrored stroke is several ops): { ids } of ops in the log.
  const undoStack = []
  const redoStack = []
  let undoing = null
  // Marks in the log per client id.
  const marks = new Map()
  const drawingUntil = new Map()
  let presentIds = new Set()
  let boardFull = false
  let wasNearlyFull = false
  let wasAbleToDraw = null
  let hostBefore = null
  let editing = null
  let previewSeq = 0
  // Refreshes the open popover from state, when it has something that changes.
  let popRefresh = null
  let popCleanup = null
  let hover = null

  const you = () => String(wbNet.you)
  const isHost = () => S.host != null && S.host === you()
  const live = () => wbNet.connected && S.ready
  const lockedOut = (id) => id !== S.host && (S.lockAll || S.locked.has(id))
  const canDraw = () => live() && !lockedOut(you())
  const sizeKey = () => TOOLS[tool].size ?? null
  const sizeRange = (key) => SIZE_RANGES[key] ?? [1, 128]
  const personColor = (id) => {
    let h = 0
    for (const ch of String(id)) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0
    return PERSON_COLORS[h % PERSON_COLORS.length]
  }
  const firstName = (id) => wbNet.nameOf(id).split(/\s+/)[0]
  // Everyone seen in the room, their ids as the strings ops and locks carry.
  const roster = () => wbNet.people().map((p) => ({ ...p, id: String(p.id) }))
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`
  // Text as the room takes it: a tab becomes a space and the other control characters it refuses
  // go, `\n` staying when `lines`.
  const roomText = (text, lines) =>
    [...text.replaceAll('\t', ' ')]
      .filter((c) => {
        const code = c.codePointAt(0)
        return (lines && c === '\n') || !(code < 0x20 || (code >= 0x7f && code <= 0x9f))
      })
      .join('')

  let dockHeight = 46
  const bannerStacked = () => !$('banner').hidden && app.classList.contains('stacked')

  function fitView() {
    const top = 58 + (bannerStacked() ? 52 : 0)
    const bottom = dockHeight + 24
    const availW = innerWidth - 24
    const availH = innerHeight - top - bottom
    const scale = clamp(Math.min(availW / W, availH / H), 0.05, MAX_SCALE)
    return {
      scale,
      x: (innerWidth - W * scale) / 2,
      y: top + Math.max(0, availH - H * scale) / 2
    }
  }

  function applyView() {
    boardEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
    app.style.setProperty('--wb-scale', view.scale)
    ui.zoomLevel.textContent = `${Math.round((view.scale / fitView().scale) * 100)}%`
    placeText()
    placeRing()
    needFrame()
  }

  // Keeps some of the board in the pane however it was dragged.
  function boundView(v) {
    const keep = 80
    v.x = clamp(v.x, keep - W * v.scale, innerWidth - keep)
    v.y = clamp(v.y, keep - H * v.scale, innerHeight - keep)
    return v
  }

  function setView(next, { fit = false, animate = false } = {}) {
    view.fit = fit
    const to = fit ? next : boundView(next)
    if (animate && !reducedMotion.matches) {
      viewTween = { from: { ...view }, to, start: performance.now() }
      needFrame()
      return
    }
    viewTween = null
    Object.assign(view, to)
    applyView()
  }

  function stepView(now) {
    if (!viewTween) return false
    const k = clamp((now - viewTween.start) / 180, 0, 1)
    const e = 1 - (1 - k) ** 3
    const { from, to } = viewTween
    // Scale eases in the log, so each step of the zoom looks the same size.
    view.scale = from.scale * (to.scale / from.scale) ** e
    view.x = from.x + (to.x - from.x) * e
    view.y = from.y + (to.y - from.y) * e
    if (k === 1) viewTween = null
    applyView()
    return k < 1
  }

  // Zooms by `factor` keeping the board point under stage px sx, sy where it is.
  function zoomAt(factor, sx = innerWidth / 2, sy = innerHeight / 2, animate = false) {
    const base = viewTween ? viewTween.to : view
    const min = fitView().scale * 0.5
    const scale = clamp(base.scale * factor, min, MAX_SCALE)
    const k = scale / base.scale
    setView({ scale, x: sx - (sx - base.x) * k, y: sy - (sy - base.y) * k }, { animate })
  }
  const zoomFit = (animate = true) => setView(fitView(), { fit: true, animate })

  const toBoard = (event) => ({
    x: (event.clientX - view.x) / view.scale,
    y: (event.clientY - view.y) / view.scale
  })
  const onBoard = (p) => p.x >= 0 && p.y >= 0 && p.x < W && p.y < H

  // The canvas shown is the room's ink with the viewer's unconfirmed ops drawn over it, and the
  // eraser stroke in progress, which can only be shown by taking ink away.
  function recompose() {
    viewCtx.globalCompositeOperation = 'copy'
    viewCtx.drawImage(board.ink, 0, 0)
    viewCtx.globalCompositeOperation = 'source-over'
    for (const entry of pending) E.drawOp(viewCtx, entry.op)
    if (gesture?.kind === 'stroke' && gesture.erase) {
      for (const { live } of gesture.lives) live.paint(viewCtx, true)
    }
  }

  function clearLive() {
    liveCtx.clearRect(0, 0, W, H)
    tailCtx.clearRect(0, 0, W, H)
    liveWrap.style.opacity = ''
  }

  function paintPaper() {
    E.drawPaper(paperCtx, S.bg)
  }

  function rejected(reason) {
    if (reason === 'board_full') boardFull = true
    toast(Object.hasOwn(REASONS, reason) ? REASONS[reason] : String(reason), 'error')
    refresh()
  }

  function settle(entry) {
    const at = pending.indexOf(entry)
    if (at >= 0) {
      pending.splice(at, 1)
      recompose()
    }
    refreshBars()
  }

  // Sends ops as one undo step, or as more of the step `group` already is. Each shows over the
  // ink until the room has answered for it.
  function commitOps(ops, { redo = false, group = { ids: [] } } = {}) {
    if (!ops.length) return
    if (!redo) redoStack.length = 0
    for (const op of ops) {
      const entry = { op, group }
      pending.push(entry)
      const answer = wbNet.commit(op).then(
        () => settle(entry),
        (reason) => {
          settle(entry)
          rejected(reason)
        }
      )
      inFlight.add(answer)
      answer.then(() => inFlight.delete(answer))
    }
    if (typeof ops[0].color === 'number' && ops[0].tool !== 'eraser') remember(ops[0].color)
    recompose()
    refreshBars()
  }

  // Resolves once the room has answered for every op sent. An undo or a flood right behind a
  // mark waits for this, so it acts on a board that has the mark.
  async function answered() {
    while (inFlight.size) await Promise.all([...inFlight])
  }

  // An op of the viewer's own arrived: it is the oldest one still waiting, since the room takes
  // a client's ops in the order they were sent.
  function landed(op) {
    const entry = pending.shift()
    if (!entry) return
    entry.group.ids.push(op.i)
    if (!undoStack.includes(entry.group)) undoStack.push(entry.group)
    if (undoStack.length > 300) undoStack.shift()
  }

  const strip = (op) => {
    const rest = { ...op }
    delete rest.i
    delete rest.c
    return rest
  }

  async function undo() {
    if (undoing || !canDraw() || lapse.open) return
    undoing = { removed: [] }
    refreshBars()
    await answered()
    let group
    while ((group = undoStack.at(-1)) && !group.ids.some(board.has)) undoStack.pop()
    if (!group && !marks.get(you())) {
      undoing = null
      refreshBars()
      return toast(REASONS.nothing_to_undo)
    }
    // Marks from before this session have no group; they go one at a time.
    const count = group ? group.ids.filter(board.has).length : 1
    try {
      for (let n = 0; n < count; n++) await wbNet.act({ t: 'undo' })
      if (group) undoStack.pop()
    } catch (reason) {
      rejected(reason)
    }
    if (undoing.removed.length) redoStack.push(undoing.removed.map(strip))
    undoing = null
    refreshBars()
  }

  function redo() {
    if (undoing || !canDraw() || lapse.open || !redoStack.length) return
    commitOps(redoStack.pop(), { redo: true })
  }

  function remember(used) {
    const at = recents.indexOf(used)
    if (at >= 0) recents.splice(at, 1)
    recents.unshift(used)
    recents.length = Math.min(recents.length, MAX_RECENTS)
  }

  function setTool(next) {
    if (!Object.hasOwn(TOOLS, next)) return
    endText(true)
    cancelGesture()
    if (next !== tool) toolBefore = tool
    tool = next
    clearLive()
    refresh()
    placeRing()
  }

  function setColor(next) {
    color = next & 0xffffff
    if (tool === 'eraser' || tool === 'hand' || tool === 'eyedropper') setTool('pen')
    if (editing) styleText()
    refresh()
  }

  function setSize(key, value) {
    const [lo, hi] = sizeRange(key)
    sizes[key] = clamp(Math.round(value), lo, hi)
    if (editing) styleText()
    refreshDock()
    placeRing()
    popRefresh?.()
  }

  function stepSize(direction) {
    const key = sizeKey()
    if (!key) return
    const now = sizes[key]
    setSize(key, direction > 0 ? Math.max(now + 1, now * 1.2) : Math.min(now - 1, now / 1.2))
  }

  function cycleMirror() {
    const modes = Object.keys(MIRRORS)
    mirror = modes[(modes.indexOf(mirror) + 1) % modes.length]
    refresh()
  }

  const flipX = (x) => W * Q - x
  const flipY = (y) => H * Q - y
  const flipsNow = () => MIRRORS[mirror].flips

  // Points are kept at least this far apart, in board px: a little over two px on screen.
  const pointGap = () => clamp(2.2 / view.scale, 0.6, 5)

  function strokeBegin(event, p) {
    const style = { tool, color: tool === 'eraser' ? 0 : color, size: sizes[TOOLS[tool].size] }
    const pressured = tool === 'pen' || tool === 'brush'
    gesture = {
      kind: 'stroke',
      pointer: event.pointerId,
      style,
      pressured,
      erase: tool === 'eraser',
      lives: flipsNow().map((flip) => ({ flip, live: E.liveStroke(style, pressured) })),
      // One undo step, however many ops the stroke turns out to be.
      group: { ids: [] },
      s: ++previewSeq & 0xffff,
      pts: [],
      // The smoothed pointer, the last point kept, and the width factor as it drifts.
      sx: p.x,
      sy: p.y,
      ax: p.x,
      ay: p.y,
      at: event.timeStamp,
      factor: tool === 'brush' ? 50 : 110
    }
    liveWrap.style.opacity = E.toolOf(tool).alpha
    keepPoint(p.x, p.y, gesture.factor)
  }

  // The width factor for the next point: the pen's pressure when the device reports one,
  // otherwise from speed, a slow line being a thick one.
  function nextFactor(g, event, dist) {
    const brush = g.style.tool === 'brush'
    let wide
    if (event.pointerType === 'pen' && event.pressure > 0) {
      wide = brush ? 0.2 + event.pressure * 1.7 : 0.5 + event.pressure
    } else {
      const speed = (dist * view.scale) / Math.max(1, event.timeStamp - g.at)
      const k = clamp(speed / 2.4, 0, 1)
      wide = brush ? 1.75 - k * 1.45 : 1.2 - k * 0.55
    }
    g.factor += (wide * 128 - g.factor) * 0.3
    return g.factor
  }

  function paintLives(g) {
    if (g.erase) {
      for (const { live } of g.lives) live.paint(viewCtx)
      return
    }
    for (const { live } of g.lives) live.clearTail(tailCtx)
    for (const { live } of g.lives) {
      live.paint(liveCtx)
      live.paintTail(tailCtx)
    }
  }

  function keepPoint(x, y, factor) {
    const g = gesture
    const qx = Math.round(clamp(x, -MARGIN, W + MARGIN) * Q)
    const qy = Math.round(clamp(y, -MARGIN, H + MARGIN) * Q)
    const first = g.lives[0].live
    if (first.count && first.lastX() === qx && first.lastY() === qy) return
    for (const { flip, live } of g.lives)
      live.add(flip[0] ? flipX(qx) : qx, flip[1] ? flipY(qy) : qy, factor)
    g.pts.push(qx, qy)
    g.ax = x
    g.ay = y
    paintLives(g)
    if (first.full) rollOver(g)
  }

  // A stroke at the most points an op may hold is committed and carried on from its last point.
  function rollOver(g) {
    const ops = g.lives.map(({ live }) => live.op())
    wbNet.previewEnd(g.s)
    g.s = ++previewSeq & 0xffff
    g.pts = g.pts.slice(-2)
    g.lives = g.lives.map(({ flip, live }) => {
      const next = E.liveStroke(g.style, g.pressured)
      next.add(live.lastX(), live.lastY(), live.lastFactor())
      return { flip, live: next }
    })
    // What was painted so far is now a waiting op, drawn with the ink.
    liveCtx.clearRect(0, 0, W, H)
    tailCtx.clearRect(0, 0, W, H)
    commitOps(ops, { group: g.group })
    paintLives(g)
  }

  function strokeMove(event) {
    const g = gesture
    const samples = event.getCoalescedEvents?.() ?? []
    for (const sample of samples.length ? samples : [event]) {
      const p = toBoard(sample)
      g.sx += (p.x - g.sx) * 0.65
      g.sy += (p.y - g.sy) * 0.65
      const dist = Math.hypot(g.sx - g.ax, g.sy - g.ay)
      if (dist < pointGap()) continue
      const factor = nextFactor(g, sample, dist)
      g.at = sample.timeStamp
      keepPoint(g.sx, g.sy, factor)
    }
    wbNet.previewStroke(g.s, g.style, g.pts)
  }

  function strokeEnd(event) {
    const g = gesture
    const p = toBoard(event)
    if (Math.hypot(p.x - g.ax, p.y - g.ay) > 0.3) keepPoint(p.x, p.y, g.factor)
    if (g.style.tool === 'brush') for (const { live } of g.lives) live.taper(5)
    const ops = g.lives.map(({ live }) => live.op())
    gesture = null
    wbNet.previewEnd(g.s)
    clearLive()
    commitOps(ops, { group: g.group })
  }

  function shapeBegin(event, p) {
    gesture = {
      kind: 'shape',
      pointer: event.pointerId,
      style: { tool: shape, color, size: sizes.shape },
      fill: shapeFill,
      s: ++previewSeq & 0xffff,
      x0: p.x,
      y0: p.y,
      x1: p.x,
      y1: p.y
    }
  }

  const SNAP = Math.PI / 12

  function shapeMove(event) {
    const g = gesture
    const p = toBoard(event)
    let dx = p.x - g.x0
    let dy = p.y - g.y0
    if (event.shiftKey) {
      if (g.style.tool === 'line' || g.style.tool === 'arrow') {
        // Shift holds a line to steps of 15 degrees.
        const angle = Math.round(Math.atan2(dy, dx) / SNAP) * SNAP
        const len = Math.hypot(dx, dy)
        dx = Math.cos(angle) * len
        dy = Math.sin(angle) * len
      } else {
        // And any other shape to equal sides.
        const side = Math.max(Math.abs(dx), Math.abs(dy))
        dx = Math.sign(dx || 1) * side
        dy = Math.sign(dy || 1) * side
      }
    }
    g.x1 = clamp(g.x0 + dx, -MARGIN, W + MARGIN)
    g.y1 = clamp(g.y0 + dy, -MARGIN, H + MARGIN)
    liveCtx.clearRect(0, 0, W, H)
    for (const d of shapeCorners(g)) {
      E.paintShape(
        liveCtx,
        g.style.tool,
        g.style.color,
        g.style.size,
        g.fill,
        d[0] / Q,
        d[1] / Q,
        d[2] / Q,
        d[3] / Q
      )
    }
    const [d] = shapeCorners(g)
    wbNet.previewShape(g.s, g.style, d[0], d[1], d[2], d[3])
  }

  // The shape's corners in q units, once per mirror image.
  function shapeCorners(g) {
    const q = [g.x0, g.y0, g.x1, g.y1].map((v) => Math.round(v * Q))
    return flipsNow().map(([fx, fy]) => [
      fx ? flipX(q[0]) : q[0],
      fy ? flipY(q[1]) : q[1],
      fx ? flipX(q[2]) : q[2],
      fy ? flipY(q[3]) : q[3]
    ])
  }

  function shapeEnd() {
    const g = gesture
    gesture = null
    wbNet.previewEnd(g.s)
    clearLive()
    if (Math.hypot(g.x1 - g.x0, g.y1 - g.y0) * view.scale < 3) return
    commitOps(
      shapeCorners(g).map((d) => {
        const op = { k: 'h', shape: g.style.tool, color: g.style.color, size: g.style.size, d }
        if (g.fill) op.fill = true
        return op
      })
    )
  }

  // A stamp's copies: where each mirror image sits and how it is turned.
  function stampCopies(x, y, rot) {
    const qx = Math.round(clamp(x, -MARGIN, W + MARGIN) * Q)
    const qy = Math.round(clamp(y, -MARGIN, H + MARGIN) * Q)
    return flipsNow().map(([fx, fy]) => {
      let turned = rot
      if (fx) turned = 360 - turned
      if (fy) turned = 180 - turned
      return [fx ? flipX(qx) : qx, fy ? flipY(qy) : qy, ((Math.round(turned) % 360) + 360) % 360]
    })
  }

  function paintStamps(x, y, rot, alpha) {
    liveCtx.clearRect(0, 0, W, H)
    liveWrap.style.opacity = alpha
    for (const d of stampCopies(x, y, rot)) {
      wbStamps.draw(liveCtx, stamp, d[0] / Q, d[1] / Q, sizes.stamp, d[2], E.css(color))
    }
  }

  function stampBegin(event, p) {
    gesture = {
      kind: 'stamp',
      pointer: event.pointerId,
      x: p.x,
      y: p.y,
      rot: 0,
      sx: event.clientX,
      sy: event.clientY
    }
    paintStamps(p.x, p.y, 0, 1)
  }

  // Dragging away from where the stamp was put down turns it, the top following the pointer.
  function stampMove(event) {
    const g = gesture
    const dx = event.clientX - g.sx
    const dy = event.clientY - g.sy
    if (Math.hypot(dx, dy) < 12) g.rot = 0
    else {
      const angle = (Math.atan2(dx, -dy) * 180) / Math.PI
      g.rot = event.shiftKey ? Math.round(angle / 15) * 15 : angle
    }
    paintStamps(g.x, g.y, g.rot, 1)
  }

  function stampEnd() {
    const g = gesture
    gesture = null
    clearLive()
    commitOps(
      stampCopies(g.x, g.y, g.rot).map((d) => ({ k: 'm', stamp, color, size: sizes.stamp, d }))
    )
  }

  async function bucketAt(p) {
    if (!onBoard(p)) return
    // The flood reads the room's ink, so the viewer's own marks have to be in it first.
    await answered()
    for (let waits = 0; !board.settled && waits < 100; waits++) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    if (!canDraw()) return
    const result = E.flood(board.pixels(), Math.floor(p.x), Math.floor(p.y), color)
    if (result.same) return
    if (result.tooDetailed) return toast('That area is too detailed to fill', 'error')
    commitOps([{ k: 'f', color, d: result.d }])
  }

  // The colour seen at a board point: the ink over the paper.
  function colorAt(p) {
    if (!onBoard(p)) return null
    const [r, g, b, a] = board.pixels(Math.floor(p.x), Math.floor(p.y), 1, 1).data
    const paper = parseInt(E.PAPERS[E.paperOf(S.bg.paper)].color.slice(1), 16)
    const k = a / 255
    const mix = (ink, shift) => Math.round(ink * k + ((paper >> shift) & 255) * (1 - k))
    return (mix(r, 16) << 16) | (mix(g, 8) << 8) | mix(b, 0)
  }

  function laserBegin(event, p) {
    const s = ++previewSeq & 0xffff
    const style = { tool: 'laser', color, size: sizes.laser }
    gesture = { kind: 'laser', pointer: event.pointerId, s, style, pts: [], key: `me:${s}` }
    laserMove(event, p)
  }

  // The viewer's own trail is kept with everyone else's, and fades the same way.
  function laserMove(event, at) {
    const g = gesture
    let trail = previews.get(g.key)
    if (!trail) {
      trail = { from: you(), k: 's', ...g.style, pts: [], times: [], at: 0, ended: false }
      previews.set(g.key, trail)
    }
    const p = at ?? toBoard(event)
    const x = clamp(p.x, -MARGIN, W + MARGIN)
    const y = clamp(p.y, -MARGIN, H + MARGIN)
    const now = performance.now()
    trail.pts.push(x, y)
    trail.times.push(now)
    trail.at = now
    g.pts.push(Math.round(x * Q), Math.round(y * Q))
    wbNet.previewStroke(g.s, g.style, g.pts)
    needFrame()
  }

  function laserEnd() {
    const trail = previews.get(gesture.key)
    if (trail) trail.ended = true
    wbNet.previewEnd(gesture.s)
    gesture = null
  }

  const textInput = $('text-input')

  function styleText() {
    if (!editing) return
    const size = sizes.text
    const lines = textInput.value.split('\n')
    textInput.style.font = `${E.TEXT_WEIGHT} ${size}px ${E.FONT}`
    textInput.style.lineHeight = E.LINE_HEIGHT
    textInput.style.color = E.css(color)
    textInput.style.caretColor = E.css(color)
    textInput.style.width = `${Math.max(size * 0.6, E.textWidth(textInput.value, size) + size * 0.3)}px`
    textInput.style.height = `${lines.length * size * E.LINE_HEIGHT}px`
    placeText()
  }

  function placeText() {
    if (!editing) return
    $('text-edit').style.transform =
      `translate(${view.x + editing.x * view.scale}px, ${view.y + editing.y * view.scale}px) scale(${view.scale})`
  }

  function beginText(p) {
    const size = sizes.text
    editing = {
      x: clamp(p.x, 0, W - size),
      y: clamp(p.y - (size * E.LINE_HEIGHT) / 2, 0, H - size * E.LINE_HEIGHT)
    }
    textInput.value = ''
    $('text-edit').hidden = false
    styleText()
    textInput.focus()
  }

  // Closes the text being typed, committing it when `keep` and there is something to keep.
  function endText(keep) {
    if (!editing) return
    const at = editing
    editing = null
    $('text-edit').hidden = true
    const text = roomText(textInput.value, true).trim()
    textInput.value = ''
    if (!keep || !text || !canDraw()) return
    const size = sizes.text
    const width = clamp(Math.round(E.textWidth(text, size) * Q), 1, W * Q)
    commitOps([
      { k: 't', color, size, text, d: [Math.round(at.x * Q), Math.round(at.y * Q), width] }
    ])
  }

  textInput.addEventListener('input', () => {
    const lines = textInput.value.split('\n')
    if (lines.length > MAX_TEXT_LINES) textInput.value = lines.slice(0, MAX_TEXT_LINES).join('\n')
    styleText()
  })
  textInput.addEventListener('keydown', (event) => {
    event.stopPropagation()
    if (event.key === 'Escape') endText(false)
    else if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      endText(true)
    } else if (event.key === 'Enter' && textInput.value.split('\n').length >= MAX_TEXT_LINES) {
      event.preventDefault()
    }
  })
  textInput.addEventListener('blur', () => endText(true))
  $('text-edit').addEventListener('pointerdown', (event) => event.stopPropagation())

  function cancelGesture() {
    const g = gesture
    if (!g) return
    gesture = null
    if (g.kind === 'stroke' || g.kind === 'shape') wbNet.previewEnd(g.s)
    if (g.kind === 'laser') {
      const trail = previews.get(g.key)
      if (trail) trail.ended = true
      wbNet.previewEnd(g.s)
    }
    clearLive()
    if (g.kind === 'stroke' && g.erase) recompose()
    setCursor()
  }

  function nudgeNote() {
    const note = $('note')
    if (note.hidden) return
    note.classList.remove('nudge')
    void note.offsetWidth
    note.classList.add('nudge')
  }

  function panBegin(event) {
    gesture = {
      kind: 'pan',
      pointer: event.pointerId,
      sx: event.clientX,
      sy: event.clientY,
      x: view.x,
      y: view.y
    }
    setCursor()
  }

  const touchSpan = () => {
    const [a, b] = [...touches.values()]
    return { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 }
  }

  stage.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.text-edit')) return
    if (editing) {
      endText(true)
      return
    }
    if (event.pointerType === 'touch') {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (touches.size === 2) {
        // A second finger turns the gesture into a pinch; what the first began is let go.
        cancelGesture()
        pinch = { ...touchSpan(), view: { ...view } }
        return
      }
      if (touches.size > 2 || pinch) return
    }
    if (gesture) return
    const p = toBoard(event)
    const panning =
      event.button === 1 || (event.button === 0 && (spaceDown || tool === 'hand' || lapse.open))
    if (panning) {
      event.preventDefault()
      stage.setPointerCapture(event.pointerId)
      return panBegin(event)
    }
    if (event.button !== 0) return
    if (!canDraw()) return nudgeNote()
    stage.setPointerCapture(event.pointerId)
    if (TOOLS[tool].stroke) strokeBegin(event, p)
    else if (tool === 'shape') shapeBegin(event, p)
    else if (tool === 'stamp') stampBegin(event, p)
    else if (tool === 'laser') laserBegin(event, p)
    else if (tool === 'bucket') bucketAt(p)
    // Text starts when the press is let go: started now, the press would take the focus back.
    else if (tool === 'text') gesture = { kind: 'text', pointer: event.pointerId, p }
    else if (tool === 'eyedropper') {
      const picked = colorAt(p)
      if (picked != null) {
        setColor(picked)
        setTool(toolBefore === 'eyedropper' ? 'pen' : toolBefore)
      }
    }
    placeRing()
  })

  stage.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch' && touches.has(event.pointerId)) {
      touches.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pinch && touches.size === 2) {
        const now = touchSpan()
        const scale = clamp(pinch.view.scale * (now.d / pinch.d), fitView().scale * 0.5, MAX_SCALE)
        const k = scale / pinch.view.scale
        setView({
          scale,
          x: now.cx - (pinch.cx - pinch.view.x) * k,
          y: now.cy - (pinch.cy - pinch.view.y) * k
        })
        return
      }
    }
    hover = event.pointerType === 'touch' ? null : { x: event.clientX, y: event.clientY }
    const g = gesture
    if (!g || g.pointer !== event.pointerId) {
      if (!g) hoverMove(event)
      placeRing()
      return
    }
    if (g.kind === 'pan') {
      setView({ scale: view.scale, x: g.x + event.clientX - g.sx, y: g.y + event.clientY - g.sy })
    } else if (g.kind === 'stroke') strokeMove(event)
    else if (g.kind === 'shape') shapeMove(event)
    else if (g.kind === 'stamp') stampMove(event)
    else if (g.kind === 'laser') laserMove(event)
    placeRing()
  })

  // What a pointer does over the board with nothing pressed: the room sees the cursor, the
  // stamp shows where it would land, the eyedropper shows what it would pick.
  function hoverMove(event) {
    if (event.pointerType === 'touch') return
    const p = toBoard(event)
    if (canDraw())
      wbNet.cursor(
        Math.round(clamp(p.x, -MARGIN, W + MARGIN) * Q),
        Math.round(clamp(p.y, -MARGIN, H + MARGIN) * Q)
      )
    if (tool === 'stamp' && canDraw() && !lapse.open) paintStamps(p.x, p.y, 0, 0.45)
    if (tool === 'eyedropper') {
      const seen = colorAt(p)
      ring.style.setProperty('--wb-swatch', seen == null ? 'transparent' : hex(seen))
    }
  }

  function pointerDone(event, cancelled) {
    if (event.pointerType === 'touch') {
      touches.delete(event.pointerId)
      if (touches.size < 2) pinch = null
    }
    const g = gesture
    if (!g || g.pointer !== event.pointerId) return
    if (cancelled) return cancelGesture()
    if (g.kind === 'pan') gesture = null
    else if (g.kind === 'stroke') strokeEnd(event)
    else if (g.kind === 'shape') shapeEnd()
    else if (g.kind === 'stamp') stampEnd()
    else if (g.kind === 'laser') laserEnd()
    else if (g.kind === 'text') {
      gesture = null
      beginText(g.p)
    }
    setCursor()
    placeRing()
  }
  stage.addEventListener('pointerup', (event) => pointerDone(event, false))
  stage.addEventListener('pointercancel', (event) => pointerDone(event, true))
  stage.addEventListener('pointerleave', () => {
    hover = null
    if (!gesture && tool === 'stamp') clearLive()
    placeRing()
  })
  stage.addEventListener('contextmenu', (event) => event.preventDefault())
  stage.addEventListener(
    'wheel',
    (event) => {
      event.preventDefault()
      const unit = event.deltaMode === 1 ? 32 : 1
      if (event.ctrlKey || event.metaKey) {
        zoomAt(Math.exp(-event.deltaY * unit * 0.0022), event.clientX, event.clientY)
      } else {
        setView({
          scale: view.scale,
          x: view.x - event.deltaX * unit,
          y: view.y - event.deltaY * unit
        })
      }
    },
    { passive: false }
  )

  function setCursor() {
    let cursor = ''
    if (gesture?.kind === 'pan') cursor = 'grabbing'
    else if (spaceDown || tool === 'hand' || lapse.open) cursor = 'grab'
    else if (!canDraw()) cursor = 'blocked'
    else if (tool === 'text') cursor = 'text'
    else if (ringSize() >= 6) cursor = 'none'
    stage.dataset.cursor = cursor
  }

  // The footprint ring's width on screen, 0 for a tool without one.
  function ringSize() {
    if (!canDraw() || lapse.open || spaceDown || gesture?.kind === 'pan') return 0
    if (TOOLS[tool].stroke || tool === 'laser') return sizes[TOOLS[tool].size] * view.scale
    return 0
  }

  function placeRing() {
    setCursor()
    const size = ringSize()
    const dropper = tool === 'eyedropper' && canDraw() && !spaceDown && !lapse.open
    if (!hover || (size < 6 && !dropper)) {
      ring.hidden = true
      return
    }
    ring.hidden = false
    ring.classList.toggle('dropper', dropper)
    if (dropper) {
      ring.style.width = ring.style.height = ''
      ring.style.transform = `translate(${hover.x}px, ${hover.y}px)`
    } else {
      ring.style.width = ring.style.height = `${size}px`
      ring.style.transform = `translate(${hover.x - size / 2}px, ${hover.y - size / 2}px)`
    }
  }

  const cursors = new Map()
  // `${from}:${s}` -> { from, k, tool, color, size, pts (px, flat), times (lasers), at, ended }
  const previews = new Map()

  function cursorFor(id) {
    let c = cursors.get(id)
    if (c) return c
    const NS = 'http://www.w3.org/2000/svg'
    const arrow = document.createElementNS(NS, 'svg')
    arrow.setAttribute('viewBox', '0 0 16 16')
    const path = document.createElementNS(NS, 'path')
    path.setAttribute('d', 'M2 1.5l11 5.2l-4.7 1.4l-1.6 4.9z')
    arrow.append(path)
    const node = el('div', 'cursor idle', arrow, el('span', 'cursor-name', wbNet.nameOf(id)))
    node.style.setProperty('--wb-person', personColor(id))
    $('cursors').append(node)
    c = { node, x: 0, y: 0, tx: 0, ty: 0, at: -Infinity, placed: false }
    cursors.set(id, c)
    return c
  }

  function moveCursor(id, x, y) {
    if (id === you()) return
    const c = cursorFor(id)
    c.tx = x
    c.ty = y
    if (!c.placed) {
      c.x = x
      c.y = y
      c.placed = true
    }
    c.at = performance.now()
    needFrame()
  }

  // Cursors glide to where they were last reported and fade when they stop being reported.
  function stepCursors(now, dt) {
    let moving = false
    const k = reducedMotion.matches ? 1 : 1 - Math.exp(-dt / 55)
    for (const [id, c] of cursors) {
      c.x += (c.tx - c.x) * k
      c.y += (c.ty - c.y) * k
      const idle = now - c.at > CURSOR_IDLE_MS || !presentIds.has(id) || lockedOut(id)
      c.node.classList.toggle('idle', idle)
      c.node.style.transform = `translate(${view.x + c.x * view.scale}px, ${view.y + c.y * view.scale}px)`
      if (!idle) moving = true
    }
    return moving
  }

  function markDrawing(id) {
    const was = drawingUntil.get(id) > performance.now()
    drawingUntil.set(id, performance.now() + DRAWING_MS)
    if (!was) popRefresh?.()
  }

  function onPreview(p) {
    const from = String(p.from)
    if (from === you() || !Array.isArray(p.pts) || p.pts.length < 2) return
    const key = `${from}:${p.s}`
    let pv = previews.get(key)
    if (!pv) {
      pv = { from, k: p.k, pts: [], times: [], ended: false }
      previews.set(key, pv)
    }
    const now = performance.now()
    Object.assign(pv, { tool: p.tool, color: p.color, size: p.size, at: now, ended: false })
    if (p.k === 'h') {
      pv.pts = p.pts.slice(0, 4).map((v) => v / Q)
    } else {
      // `n` is where this tail starts in the whole stroke; what came before it stands.
      const start = Math.min(pv.pts.length, Math.max(0, p.n | 0) * 2)
      pv.pts.length = start
      pv.times.length = start / 2
      for (let j = 0; j + 1 < p.pts.length; j += 2) {
        pv.pts.push(p.pts[j] / Q, p.pts[j + 1] / Q)
        pv.times.push(now)
      }
    }
    moveCursor(from, pv.pts.at(-2), pv.pts.at(-1))
    markDrawing(from)
    needFrame()
  }

  function onPreviewEnd({ from, s }) {
    const pv = previews.get(`${from}:${s}`)
    if (!pv) return
    pv.ended = true
    pv.at = performance.now()
  }

  // A committed op from someone takes their stroke in progress with it: every one that has
  // ended, or the oldest when the end never came.
  function dropPreviews(from) {
    const theirs = [...previews].filter(([, pv]) => pv.from === from && pv.tool !== 'laser')
    const ended = theirs.filter(([, pv]) => pv.ended)
    for (const [key] of ended.length ? ended : theirs.slice(0, 1)) previews.delete(key)
    needFrame()
  }

  function tracePreview(pts) {
    fxCtx.beginPath()
    fxCtx.moveTo(pts[0], pts[1])
    if (pts.length === 2) fxCtx.lineTo(pts[0] + 0.01, pts[1])
    for (let j = 2; j < pts.length - 2; j += 2) {
      fxCtx.quadraticCurveTo(
        pts[j],
        pts[j + 1],
        (pts[j] + pts[j + 2]) / 2,
        (pts[j + 1] + pts[j + 3]) / 2
      )
    }
    if (pts.length > 2) fxCtx.lineTo(pts.at(-2), pts.at(-1))
  }

  function paintLaser(pv, now) {
    const { pts, times } = pv
    // Flat ends: each piece of the trail has its own fade, and round ends would show as beads
    // where two overlap.
    fxCtx.lineCap = 'butt'
    const css = E.css(pv.color)
    for (let i = 1; i < times.length; i++) {
      const left = 1 - (now - times[i]) / LASER_MS
      if (left <= 0) continue
      const j = i * 2
      for (const [width, style, alpha] of [
        [pv.size * 2.2, css, 0.28],
        [pv.size, css, 0.9],
        [pv.size * 0.4, '#fff', 0.9]
      ]) {
        fxCtx.beginPath()
        fxCtx.moveTo(pts[j - 2], pts[j - 1])
        fxCtx.lineTo(pts[j], pts[j + 1])
        fxCtx.lineWidth = width * (0.5 + left * 0.5)
        fxCtx.strokeStyle = style
        fxCtx.globalAlpha = alpha * left
        fxCtx.stroke()
      }
    }
    const fresh = times.length && 1 - (now - times.at(-1)) / LASER_MS
    if (fresh > 0) {
      fxCtx.globalAlpha = fresh
      fxCtx.fillStyle = css
      fxCtx.beginPath()
      fxCtx.arc(pts.at(-2), pts.at(-1), pv.size * 0.9, 0, Math.PI * 2)
      fxCtx.fill()
      fxCtx.fillStyle = '#fff'
      fxCtx.beginPath()
      fxCtx.arc(pts.at(-2), pts.at(-1), pv.size * 0.4, 0, Math.PI * 2)
      fxCtx.fill()
    }
    fxCtx.globalAlpha = 1
  }

  let fxDirty = false

  // Redraws the layer of strokes in progress and lasers, dropping the ones that are over.
  function stepPreviews(now) {
    for (const [key, pv] of previews) {
      const quiet = now - pv.at
      const over =
        pv.tool === 'laser'
          ? quiet > LASER_MS
          : quiet > (pv.ended ? PREVIEW_ENDED_MS : PREVIEW_STALE_MS)
      if (over) previews.delete(key)
    }
    if (!previews.size && !fxDirty) return false
    fxCtx.clearRect(0, 0, W, H)
    fxDirty = previews.size > 0
    for (const pv of previews.values()) {
      if (pv.tool === 'laser') {
        paintLaser(pv, now)
      } else if (pv.k === 'h') {
        E.paintShape(
          fxCtx,
          pv.tool,
          pv.color,
          pv.size,
          false,
          pv.pts[0],
          pv.pts[1],
          pv.pts[2],
          pv.pts[3]
        )
      } else {
        const erase = pv.tool === 'eraser'
        fxCtx.save()
        tracePreview(pv.pts)
        fxCtx.lineCap = fxCtx.lineJoin = 'round'
        fxCtx.lineWidth = pv.size
        fxCtx.strokeStyle = erase ? '#808890' : E.css(pv.color)
        fxCtx.globalAlpha = erase ? 0.3 : pv.tool === 'spray' ? 0.3 : E.toolOf(pv.tool).alpha
        fxCtx.stroke()
        fxCtx.restore()
      }
    }
    return previews.size > 0
  }

  let raf = 0
  let lastFrame = 0

  function needFrame() {
    if (!raf) raf = requestAnimationFrame(frame)
  }

  function frame(now) {
    raf = 0
    const dt = Math.min(100, now - (lastFrame || now))
    lastFrame = now
    const more = [stepView(now), stepCursors(now, dt), stepPreviews(now), stepLapse(dt)]
    if (more.some(Boolean)) needFrame()
    else lastFrame = 0
  }

  const toolButtons = {}
  const ui = {}

  function buildChrome() {
    ui.undo = iconButton('undo', 'Undo', undo, 'Ctrl Z')
    ui.redo = iconButton('redo', 'Redo', redo, 'Ctrl Shift Z')
    ui.mirror = iconButton('mirror-off', 'Mirror', () => openMirror(), 'V')
    ui.ink = button('icon-btn ink-btn', null, () => openInk(), 'Ink')
    const NS = 'http://www.w3.org/2000/svg'
    const gauge = document.createElementNS(NS, 'svg')
    gauge.setAttribute('viewBox', '0 0 24 24')
    gauge.classList.add('gauge')
    for (const name of ['gauge-track', 'gauge-fill']) {
      const circle = document.createElementNS(NS, 'circle')
      circle.setAttribute('cx', 12)
      circle.setAttribute('cy', 12)
      circle.setAttribute('r', 10)
      circle.setAttribute('pathLength', 100)
      circle.setAttribute('stroke-dasharray', 100)
      circle.classList.add(name)
      gauge.append(circle)
    }
    ui.gauge = gauge.lastChild
    ui.ink.append(gauge, icon('droplet'))
    $('bar-left').append(ui.undo, ui.redo, el('span', 'sep'), ui.mirror, ui.ink)

    ui.zoomLevel = button('icon-btn zoom-level', null, () => zoomFit(), 'Fit the board', '0')
    ui.people = button('icon-btn people-btn', null, () => openPeople(), 'People')
    ui.save = iconButton('save', 'Save or share', () => openSave(), 'Ctrl S')
    ui.menu = iconButton('dots', 'More', () => openMenu())
    $('bar-right').append(
      el(
        'span',
        'zoom-group',
        iconButton('minus', 'Zoom out', () => zoomAt(1 / 1.3, undefined, undefined, true), '-'),
        ui.zoomLevel,
        iconButton('plus', 'Zoom in', () => zoomAt(1.3, undefined, undefined, true), '+'),
        el('span', 'sep')
      ),
      ui.people,
      ui.save,
      ui.menu
    )

    ui.color = button('icon-btn chip-color', el('span'), () => openColor(), 'Colour')
    ui.size = button('icon-btn chip-size', el('span'), () => openSize(), 'Size', ['[', ']'])
    $('dock').append(ui.color, ui.size, el('span', 'sep'))
    for (const id of DOCK_ORDER) {
      const def = TOOLS[id]
      const b = button(
        `icon-btn tool${def.more ? ' has-more' : ''}${def.always ? ' always' : ''}`,
        icon(def.icon),
        () => pickTool(id, b),
        def.label,
        def.key
      )
      toolButtons[id] = b
      $('dock').append(b)
    }
    ui.more = button('icon-btn tool has-more', icon('dots'), () => openTools(), 'More tools')
    $('dock').append(ui.more)
    $('guides').append(el('i', 'axis-v'), el('i', 'axis-h'))
  }

  // A tool with a choice behind it opens the choice when it is pressed.
  function pickTool(id, anchor) {
    setTool(id)
    if (id === 'shape') openShapes(anchor)
    else if (id === 'stamp') openStamps(anchor)
    else closePop()
  }

  let dockShown = ''

  // As many tools as the pane has room for stay in the dock; the rest go behind "more".
  function layoutDock() {
    // The pane, less the dock's margins, padding and border, the two chips and the separator;
    // a button and its gap take 36 px.
    const slots = Math.floor((innerWidth - 101) / 36)
    const all = slots >= DOCK_ORDER.length
    const shown = new Set(all ? DOCK_ORDER : KEEP_ORDER.slice(0, Math.max(1, slots - 1)))
    for (const id of DOCK_ORDER) toolButtons[id].hidden = !shown.has(id)
    ui.more.hidden = all
    dockShown = [...shown].join()
    dockHeight = $('dock').offsetHeight || dockHeight
    app.style.setProperty('--wb-dock-h', `${dockHeight}px`)
  }
  const inDock = (id) => !toolButtons[id].hidden

  function setIcon(host, name) {
    if (host.dataset.icon === name) return
    host.dataset.icon = name
    host.querySelector(':scope > .icon:not(.gauge)')?.remove()
    host.append(icon(name))
  }

  function refreshDock() {
    const able = canDraw()
    $('dock').classList.toggle('locked', !able)
    for (const id of DOCK_ORDER) {
      const b = toolButtons[id]
      b.classList.toggle('active', tool === id)
      b.setAttribute('aria-pressed', tool === id)
    }
    setIcon(toolButtons.shape, shape)
    tip(toolButtons.shape, `Shapes: ${SHAPE_LABELS[shape].toLowerCase()}`, TOOLS.shape.key)
    const hidden = !inDock(tool)
    ui.more.classList.toggle('active', hidden)
    setIcon(ui.more, hidden ? (tool === 'shape' ? shape : TOOLS[tool].icon) : 'dots')
    ui.color.style.setProperty('--wb-swatch', hex(color))
    const key = sizeKey()
    ui.size.disabled = !key
    const [lo, hi] = sizeRange(key)
    const dot = key ? 4 + 16 * Math.sqrt((sizes[key] - lo) / (hi - lo)) : 6
    ui.size.style.setProperty('--wb-dot', `${dot}px`)
    $('guides').dataset.mirror = able ? mirror : 'off'
  }

  function refreshBars() {
    const able = canDraw()
    const mine = marks.get(you()) > 0
    ui.undo.disabled = !able || !!undoing || !(mine || undoStack.length)
    ui.redo.disabled = !able || !!undoing || !redoStack.length
    setIcon(ui.mirror, MIRRORS[mirror].icon)
    ui.mirror.classList.toggle('on', mirror !== 'off')
    tip(
      ui.mirror,
      mirror === 'off' ? 'Mirror' : `Mirror: ${MIRRORS[mirror].label.toLowerCase()}`,
      'V'
    )
    const used = S.max ? clamp(S.used / S.max, 0, 1) : 0
    ui.gauge.setAttribute('stroke-dashoffset', 100 - used * 100)
    ui.ink.classList.toggle('warn', used >= INK_WARN)
    ui.ink.classList.toggle('full', inkFull())
    tip(ui.ink, `Ink: ${Math.round(used * 100)}% used`)

    const here = roster().filter((p) => p.present)
    const key = here.map((p) => p.id).join()
    if (ui.people.dataset.key !== key) {
      ui.people.dataset.key = key
      const faces = el('span', 'faces')
      for (const p of here.slice(0, 3)) faces.append(wbNet.avatarEl(p.id))
      ui.people.replaceChildren(faces, el('span', 'people-count', String(here.length)))
    }
    tip(ui.people, plural(here.length, 'person here', 'people here'))
  }

  const inkFull = () => boardFull || (S.max > 0 && S.used / S.max >= INK_FULL)

  // The line over the stage that says why drawing is off, or that the ink has run out.
  function refreshNote() {
    const note = $('note')
    let kind = ''
    let content = null
    if (S.ready && !wbNet.connected) {
      kind = 'offline'
      content = [
        icon('offline'),
        el('b', null, 'Not connected'),
        el('span', null, 'Drawing is paused')
      ]
    } else if (S.ready && lockedOut(you())) {
      kind = 'locked'
      const host = S.host && presentIds.has(S.host) ? firstName(S.host) : 'The host'
      content = [
        icon('lock'),
        el('b', null, 'View only'),
        el('span', null, S.lockAll ? `${host} locked the board` : `${host} locked your pen`)
      ]
    } else if (S.ready && inkFull()) {
      kind = 'full'
      content = [
        icon('droplet'),
        el('b', null, 'The board is full'),
        el('span', null, 'Undo some marks')
      ]
    }
    const key = content ? `${kind}:${content[2].textContent}` : ''
    if (note.dataset.key !== key) {
      note.dataset.key = key
      note.className = `note ${kind}`
      note.replaceChildren(...(content ?? []))
      note.hidden = !kind
    }
    app.classList.toggle('offline', kind === 'offline')
  }

  // Says so when the viewer's own standing changes: locked, unlocked, made host.
  function announce() {
    if (!S.ready) return
    const able = !lockedOut(you())
    if (wasAbleToDraw !== null && able !== wasAbleToDraw) {
      if (able) toast('You can draw again', 'ok', 'lock-open')
      else {
        endText(false)
        cancelGesture()
        toast(S.lockAll ? 'The board was locked' : 'Your pen was locked', 'info', 'lock')
      }
    }
    wasAbleToDraw = able
    if (hostBefore !== null && S.host !== hostBefore && isHost())
      toast('You are the host now', 'ok', 'crown')
    hostBefore = S.host
  }

  function refresh() {
    presentIds = new Set(
      roster()
        .filter((p) => p.present)
        .map((p) => p.id)
    )
    if (S.used / S.max < INK_FULL - 0.01) boardFull = false
    const nearlyFull = S.ready && S.used / S.max >= INK_WARN
    if (nearlyFull && !wasNearlyFull && !inkFull())
      toast('The board is nearly full', 'info', 'droplet')
    wasNearlyFull = nearlyFull
    refreshDock()
    refreshBars()
    refreshNote()
    refreshBanner()
    popRefresh?.()
    placeRing()
    needFrame()
  }

  // Opens a popover whose builder returns the function that refreshes it from state.
  function pop(id, anchor, className, build) {
    return openPop(
      id,
      anchor,
      (card) => {
        popRefresh = build(card) ?? null
      },
      {
        className,
        onClose() {
          popRefresh = null
          popCleanup?.()
          popCleanup = null
        }
      }
    )
  }

  const title = (text, aside) => el('p', 'pop-title', el('span', null, text), aside)
  const label = (text) => el('span', 'label', text)

  function openColor() {
    pop('color', ui.color, 'color', (card) => {
      const picker = wbWidgets.colorPicker((picked) => {
        color = picked
        if (tool === 'eraser' || tool === 'hand' || tool === 'eyedropper') setTool('pen')
        if (editing) styleText()
        refreshDock()
        mark()
      })
      const swatch = (c) => {
        const b = button('swatch', null, () => {
          setColor(c)
          closePop()
        })
        b.style.setProperty('--wb-swatch', hex(c))
        b.setAttribute('aria-label', hex(c))
        b.dataset.color = c
        return b
      }
      const palette = el('div', 'grid', ...PALETTE.map(swatch))
      const recent = el('div', 'grid recents')
      const recentLabel = label('Recent')
      card.append(palette, recentLabel, recent, picker.el)
      let shown = null
      function mark() {
        for (const b of card.querySelectorAll('.swatch'))
          b.classList.toggle('on', Number(b.dataset.color) === color)
        picker.set(color)
      }
      const update = () => {
        const key = recents.join()
        if (key !== shown) {
          shown = key
          recent.replaceChildren(...recents.map(swatch))
          recentLabel.hidden = recent.hidden = !recents.length
        }
        mark()
      }
      update()
      return update
    })
  }

  function openSize() {
    const key = sizeKey()
    if (!key) return
    pop('size', ui.size, 'size', (card) => {
      const [lo, hi] = sizeRange(key)
      const dot = el('span', 'size-dot')
      const value = el('small')
      const range = el('input', 'range')
      range.type = 'range'
      range.min = 0
      range.max = 1000
      range.setAttribute('aria-label', 'Size')
      // The slider runs on a curve, so the small sizes have most of its travel.
      const toSize = (v) => lo + (hi - lo) * (v / 1000) ** 2
      const toSlider = (size) => Math.round(1000 * Math.sqrt((size - lo) / (hi - lo)))
      range.addEventListener('input', () => setSize(key, toSize(Number(range.value))))
      const presets = el('div', 'presets')
      for (const k of [0.04, 0.12, 0.25, 0.45, 0.7]) {
        const size = Math.round(lo + (hi - lo) * k)
        const b = button('icon-btn preset', el('span'), () => setSize(key, size), `${size} px`)
        b.style.setProperty('--wb-dot', `${4 + k * 26}px`)
        presets.append(b)
      }
      card.append(
        title(key === 'text' ? 'Text size' : 'Size', value),
        el('div', 'size-stage', dot),
        range,
        presets
      )
      const update = () => {
        const size = sizes[key]
        value.textContent = `${size} px`
        if (document.activeElement !== range) range.value = toSlider(size)
        // As large as it will be on screen at this zoom.
        dot.style.setProperty('--wb-dot', `${Math.max(1, size * view.scale)}px`)
        dot.style.setProperty('--wb-swatch', hex(color))
        dot.style.setProperty('--wb-dot-alpha', TOOLS[tool].stroke ? E.toolOf(tool).alpha : 1)
        dot.classList.toggle('outline', tool === 'eraser')
      }
      update()
      return update
    })
  }

  function openShapes(anchor) {
    pop('shapes', anchor ?? toolButtons.shape, 'shapes', (card) => {
      const grid = el('div', 'grid')
      const tiles = {}
      for (const id of E.SHAPES) {
        tiles[id] = button(
          'tile',
          icon(id),
          () => {
            shape = id
            setTool('shape')
          },
          SHAPE_LABELS[id],
          SHAPE_KEYS[id]
        )
        grid.append(tiles[id])
      }
      const filled = toggle('Filled', (on) => {
        shapeFill = on
        refresh()
      })
      card.append(grid, el('div', 'line', el('span', null, 'Filled'), filled))
      const update = () => {
        for (const id of E.SHAPES) tiles[id].classList.toggle('on', shape === id)
        setToggle(filled, shapeFill)
        filled.disabled = shape === 'line' || shape === 'arrow'
      }
      update()
      return update
    })
  }

  function openStamps(anchor) {
    pop('stamps', anchor ?? toolButtons.stamp, 'stamps', (card) => {
      const grid = el('div', 'grid')
      const tiles = {}
      for (const id of wbStamps.list) {
        tiles[id] = button(
          'tile',
          wbStamps.svg(id),
          () => {
            stamp = id
            setTool('stamp')
            closePop()
          },
          wbStamps.label(id)
        )
        grid.append(tiles[id])
      }
      card.append(grid, el('p', 'hint', 'Press to stamp. Drag to turn it.'))
      const update = () => {
        for (const id of wbStamps.list) tiles[id].classList.toggle('on', stamp === id)
      }
      update()
      return update
    })
  }

  function openTools() {
    pop('tools', ui.more, 'tools', (card) => {
      const grid = el('div', 'grid')
      grid.style.setProperty('--wb-cols', 4)
      const tiles = {}
      for (const id of DOCK_ORDER.filter((t) => !inDock(t))) {
        const def = TOOLS[id]
        tiles[id] = button('tile labelled', icon(def.icon), () => {
          closePop()
          pickTool(id, ui.more)
        })
        tiles[id].append(el('span', null, def.short ?? def.label))
        tiles[id].setAttribute('aria-label', def.label)
        tiles[id].disabled = !canDraw() && !def.always
        grid.append(tiles[id])
      }
      card.append(grid)
      const update = () => {
        for (const [id, b] of Object.entries(tiles)) b.classList.toggle('on', tool === id)
      }
      update()
      return update
    })
  }

  function openMirror() {
    pop('mirror', ui.mirror, 'mirror', (card) => {
      const seg = el('div', 'seg')
      const buttons = {}
      for (const [id, def] of Object.entries(MIRRORS)) {
        buttons[id] = button(
          null,
          icon(def.icon),
          () => {
            mirror = id
            refresh()
          },
          def.label
        )
        seg.append(buttons[id])
      }
      const hint = el('p', 'hint')
      card.append(title('Mirror'), seg, hint)
      const update = () => {
        for (const id of Object.keys(MIRRORS)) buttons[id].classList.toggle('on', mirror === id)
        hint.textContent =
          mirror === 'off'
            ? 'Marks are drawn once.'
            : `Each mark is drawn ${MIRRORS[mirror].flips.length} times: ${MIRRORS[mirror].label.toLowerCase()}.`
      }
      update()
      return update
    })
  }

  const megabytes = (bytes) =>
    bytes < 104858 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1048576).toFixed(1)} MB`

  function openInk() {
    pop('ink', ui.ink, 'ink', (card) => {
      const percent = el('small')
      const fill = el('span')
      const meter = el('div', 'meter', fill)
      const detail = el('p', 'hint')
      const advice = el('p', 'hint')
      card.append(title('Ink', percent), meter, detail, advice)
      const update = () => {
        const used = S.max ? clamp(S.used / S.max, 0, 1) : 0
        percent.textContent = `${Math.round(used * 100)}%`
        fill.style.transform = `scaleX(${used})`
        meter.classList.toggle('warn', used >= INK_WARN)
        detail.textContent = `${megabytes(S.used)} of ${megabytes(S.max)} used by ${plural(board.log.length, 'mark', 'marks')}.`
        advice.textContent = inkFull()
          ? 'The board is full. Undo some marks, or ask the host to clear it.'
          : used >= INK_WARN
            ? 'The board is nearly full. Long, detailed strokes and fills use the most.'
            : 'Every mark uses a little ink. Undoing a mark gives its ink back.'
      }
      update()
      return update
    })
  }

  // The question asked before something that cannot be taken back.
  const confirmBox = (question, verb, yes, no) =>
    el(
      'div',
      'confirm',
      el('p', null, question),
      el('div', null, button('btn', 'Cancel', no), button('btn danger', verb, yes))
    )

  const act = (action) => wbNet.act(action).catch(rejected)

  function openPeople() {
    // Who is being asked about, so a refresh does not put the question away.
    let asking = null
    pop('people', ui.people, 'people', (card) => {
      const count = el('small')
      const lockAll = toggle('Lock everyone', (on) => act({ t: 'lock_all', on }))
      const lockLine = el('div', 'line', el('span', null, 'Lock everyone'), lockAll)
      const list = el('ul', 'people-list')
      card.append(title('People', count), lockLine, list)
      let shown = ''
      const update = () => {
        const now = performance.now()
        const host = isHost()
        const people = roster()
        const rank = (p) => (p.id === S.host ? 0 : p.id === you() ? 1 : p.present ? 2 : 3)
        people.sort((a, b) => rank(a) - rank(b))
        count.textContent = `${people.filter((p) => p.present).length} here`
        lockLine.hidden = !host
        setToggle(lockAll, S.lockAll)
        lockAll.disabled = !live()
        const rows = people.map((p) => ({
          ...p,
          host: p.id === S.host,
          locked: lockedOut(p.id),
          pinned: S.locked.has(p.id),
          drawing: drawingUntil.get(p.id) > now,
          marks: marks.get(p.id) ?? 0
        }))
        const key = JSON.stringify([rows, host, live(), asking])
        if (key === shown) return
        shown = key
        list.replaceChildren(
          ...rows.map((p) => {
            const avatar = wbNet.avatarEl(p.id)
            const name = el(
              'span',
              'person-name',
              el('b', null, p.name),
              p.id === you() ? el('span', 'hint', '(you)') : null,
              p.host ? icon('crown') : null
            )
            let sub
            if (p.drawing)
              sub = el(
                'span',
                'person-sub',
                el('span', 'drawing', el('i'), el('i'), el('i')),
                'Drawing'
              )
            else if (p.locked) sub = el('span', 'person-sub', icon('lock'), 'View only')
            else if (!p.present) sub = el('span', 'person-sub', 'Left the room')
            else
              sub = el(
                'span',
                'person-sub',
                p.host ? 'Host · ' : '',
                p.marks ? plural(p.marks, 'mark', 'marks') : 'No marks yet'
              )
            const row = el(
              'li',
              `person${p.present ? '' : ' away'}${p.locked ? ' locked' : ''}`,
              avatar,
              el('span', 'person-text', name, sub)
            )
            row.style.setProperty('--wb-person', personColor(p.id))
            if (host && p.id !== you()) {
              const lock = iconButton(
                p.pinned ? 'lock' : 'lock-open',
                p.pinned ? `Unlock ${p.name}` : `Lock ${p.name}`,
                () => act({ t: 'lock', client: p.id, on: !p.pinned })
              )
              lock.classList.toggle('locking', p.pinned)
              lock.disabled = !live() || (!p.pinned && !p.present)
              const wipe = iconButton('wipe', `Erase ${p.name}'s marks`, () => {
                asking = p.id
                update()
              })
              wipe.disabled = !live() || !p.marks
              row.append(lock, wipe)
            }
            if (asking !== p.id) return row
            const answer = (yes) => () => {
              asking = null
              if (yes) act({ t: 'wipe', client: p.id })
              update()
            }
            const question = `Erase all ${plural(p.marks, 'mark', 'marks')} by ${p.name}?`
            return el('li', null, confirmBox(question, 'Erase', answer(true), answer(false)))
          })
        )
        wbWidgets.placePop()
      }
      update()
      // Who is drawing changes with no event to say so.
      const timer = setInterval(update, 400)
      popCleanup = () => clearInterval(timer)
      return update
    })
  }

  function fileName() {
    const d = new Date()
    const two = (n) => String(n).padStart(2, '0')
    return `whiteboard-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}.png`
  }

  function openSave() {
    pop('save', ui.save, 'save', (card) => {
      const preview = E.makeCanvas(480, 270)
      preview.className = 'save-preview'
      const clear = toggle('Transparent background', (on) => {
        transparentSave = on
        update()
      })
      let busy = false
      const run = async (share) => {
        if (busy) return
        busy = true
        update()
        try {
          const bytes = await E.exportPng(board.ink, S.bg, transparentSave)
          if (share) await wbNet.sharePng(bytes)
          else await wbNet.savePng(bytes, fileName())
          toast(share ? 'Shared to the chat' : 'Saved', 'ok')
          closePop()
        } catch (reason) {
          if (reason !== 'canceled')
            toast(
              Object.hasOwn(REASONS, reason)
                ? REASONS[reason]
                : share
                  ? 'The picture could not be shared'
                  : 'The picture could not be saved',
              'error'
            )
        }
        busy = false
        update()
      }
      const save = button('btn primary wide', null, () => run(false))
      save.append(icon('save'), 'Save as PNG')
      const share = button('btn wide', null, () => run(true))
      share.append(icon('share'), 'Share to chat')
      card.append(
        preview,
        el('div', 'line', el('span', null, 'Transparent background'), clear),
        save,
        share
      )
      function update() {
        const ctx = preview.getContext('2d')
        ctx.setTransform(0.25, 0, 0, 0.25, 0, 0)
        ctx.clearRect(0, 0, W, H)
        if (!transparentSave) E.drawPaper(ctx, S.bg)
        ctx.drawImage(board.ink, 0, 0)
        setToggle(clear, transparentSave)
        save.disabled = share.disabled = busy
        share.hidden = !wbNet.canShare
      }
      update()
      return update
    })
  }

  function openMenu() {
    pop('menu', ui.menu, 'menu tight', (card) => {
      const row = (name, text, run, extra) => {
        const b = button('row-btn', icon(name), run)
        b.append(el('span', null, text))
        if (extra) b.append(el('em', null, extra))
        return b
      }
      const prompt = row('prompt', 'Drawing prompt', () => openPrompt())
      const lapseRow = row('timelapse', 'Timelapse', () => openLapse())
      const paper = row('paper', 'Background', () => openPaper())
      const clear = row('trash', 'Clear the board', () => {
        const box = confirmBox(
          'Clear the whole board for everyone? This cannot be undone.',
          'Clear',
          () => {
            closePop()
            act({ t: 'clear' })
          },
          () => box.replaceWith(clear)
        )
        clear.replaceWith(box)
      })
      clear.classList.add('danger')
      const zoomRow = el(
        'div',
        'seg zoom-row',
        button(null, icon('minus'), () => zoomAt(1 / 1.3, undefined, undefined, true), 'Zoom out'),
        button(null, 'Fit', () => zoomFit(), 'Fit the board'),
        button(null, icon('plus'), () => zoomAt(1.3, undefined, undefined, true), 'Zoom in')
      )
      card.append(prompt, lapseRow, el('hr'), paper, clear, zoomRow)
      const update = () => {
        const host = isHost()
        prompt.disabled = !canDraw()
        lapseRow.disabled = !board.log.length
        paper.disabled = clear.disabled = !host || !live()
        clear.disabled ||= !board.log.length
        for (const b of [paper, clear]) {
          b.querySelector('em')?.remove()
          if (!host) b.append(el('em', null, 'Host'))
        }
        zoomRow.hidden = !app.classList.contains('narrow')
      }
      update()
      return update
    })
  }

  function openPaper() {
    pop('paper', ui.menu, 'paper', (card) => {
      const tile = (bg, name, run) => {
        const canvas = E.makeCanvas(132, 99)
        const ctx = canvas.getContext('2d')
        ctx.setTransform(0.55, 0, 0, 0.55, 0, 0)
        E.drawPaper(ctx, bg)
        return button('tile sheet-tile', canvas, run, name)
      }
      const papers = el('div', 'grid')
      papers.style.setProperty('--wb-cols', 5)
      const patterns = el('div', 'grid')
      patterns.style.setProperty('--wb-cols', 4)
      card.append(label('Paper'), papers, label('Pattern'), patterns)
      let shown = ''
      const update = () => {
        const paper = E.paperOf(S.bg.paper)
        const pattern = E.patternOf(S.bg.pattern)
        if (`${paper}.${pattern}` === shown) return
        shown = `${paper}.${pattern}`
        papers.replaceChildren(
          ...Object.entries(E.PAPERS).map(([id, def]) => {
            const b = tile({ paper: id, pattern: 'plain' }, def.label, () =>
              act({ t: 'bg', paper: id, pattern })
            )
            b.classList.toggle('on', id === paper)
            return b
          })
        )
        patterns.replaceChildren(
          ...Object.entries(E.PATTERN_LABELS).map(([id, name]) => {
            const b = tile({ paper, pattern: id }, name, () => act({ t: 'bg', paper, pattern: id }))
            b.classList.toggle('on', id === pattern)
            return b
          })
        )
      }
      update()
      return update
    })
  }

  const clock = (ms) => {
    const s = Math.max(0, Math.ceil(ms / 1000))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  }
  const promptRunning = () => S.prompt && !S.prompt.over
  const mayStopPrompt = () => S.prompt && (isHost() || String(S.prompt.by) === you())

  function openPrompt() {
    pop('prompt', ui.menu, 'prompt', (card) => {
      const field = el('input', 'field')
      field.type = 'text'
      field.maxLength = MAX_PROMPT_CHARS
      field.placeholder = 'Leave empty for a surprise'
      field.setAttribute('aria-label', 'What to draw')
      field.addEventListener('keydown', (event) => {
        event.stopPropagation()
        if (event.key === 'Enter') start.click()
        if (event.key === 'Escape') closePop()
      })
      field.addEventListener('input', () => update())
      const seg = el('div', 'seg')
      const times = {}
      for (const secs of PROMPT_SECS) {
        times[secs] = button(null, secs < 60 ? `${secs} s` : `${secs / 60} min`, () => {
          promptSecs = secs
          update()
        })
        seg.append(times[secs])
      }
      const start = button('btn primary wide', null, () => {
        const text = roomText(field.value, false).trim()
        closePop()
        act(text ? { t: 'prompt', secs: promptSecs, text } : { t: 'prompt', secs: promptSecs })
      })
      const running = el('p', 'hint')
      const stop = button('btn wide', 'Stop the prompt', () => {
        closePop()
        act({ t: 'prompt_stop' })
      })
      const setup = el('div', 'picker', field, seg, start)
      card.append(
        title('Drawing prompt'),
        el('p', 'hint', 'Everyone gets the same thing to draw, against the clock.'),
        setup,
        running,
        stop
      )
      function update() {
        const on = promptRunning()
        setup.hidden = on
        running.hidden = stop.hidden = !on
        if (on) running.textContent = `Now drawing: ${S.prompt.text}`
        stop.hidden ||= !mayStopPrompt()
        for (const secs of PROMPT_SECS) times[secs].classList.toggle('on', secs === promptSecs)
        start.replaceChildren(
          icon(field.value.trim() ? 'prompt' : 'dice'),
          field.value.trim() ? 'Start' : 'Surprise us'
        )
        start.disabled = !canDraw()
      }
      update()
      return update
    })
    if (wbWidgets.popId === 'prompt' && !promptRunning())
      wbWidgets.popCard.querySelector('.field')?.focus()
  }

  let bannerFor = null
  let bannerTimer = null

  function refreshBanner() {
    const banner = $('banner')
    const p = S.prompt
    const key = p ? `${p.started_ms}:${p.over}` : null
    if (key !== bannerFor) {
      bannerFor = key
      clearInterval(bannerTimer)
      bannerTimer = null
      const was = banner.hidden
      banner.hidden = !p
      if (p) {
        const by = wbNet.nameOf(p.by) === 'Unknown' ? 'Someone' : firstName(p.by)
        banner.className = `banner${p.over ? ' over' : ''}`
        const parts = [
          icon(p.over ? 'sparkles' : 'prompt'),
          el(
            'span',
            'banner-text',
            el('small', null, p.over ? "Time's up" : `${by} says draw`),
            el('b', null, p.text)
          )
        ]
        if (!p.over) {
          const stop = iconButton('x', 'Stop the prompt', () => act({ t: 'prompt_stop' }))
          stop.hidden = !mayStopPrompt()
          parts.push(el('span', 'banner-time'), stop, el('span', 'banner-fill'))
          bannerTimer = setInterval(tickBanner, 250)
        }
        banner.replaceChildren(...parts)
      }
      app.classList.toggle('bannered', !!p)
      layoutBanner()
      if (was !== banner.hidden && view.fit) zoomFit(false)
    }
    tickBanner()
  }

  function tickBanner() {
    const p = S.prompt
    if (!p || p.over) return
    const banner = $('banner')
    const left = p.ends_ms - wbNet.now()
    const total = Math.max(1, p.ends_ms - p.started_ms)
    banner.querySelector('.banner-time').textContent = clock(left)
    banner.querySelector('.banner-fill').style.transform = `scaleX(${clamp(left / total, 0, 1)})`
    banner.classList.toggle('ending', left <= 10000)
  }

  // The banner sits between the top bars when there is room, under them when there is not.
  function layoutBanner() {
    const left = $('bar-left').offsetWidth + 20
    const right = $('bar-right').offsetWidth + 20
    const stacked = innerWidth - left - right < 280
    app.classList.toggle('stacked', stacked)
    $('banner').style.left = stacked ? '' : `${left}px`
    $('banner').style.right = stacked ? '' : `${right}px`
  }

  const lapse = {
    open: false,
    ops: [],
    ends: [],
    total: 0,
    pos: 0,
    rate: 1,
    speed: 1,
    playing: false
  }
  const LAPSE_SPEEDS = [1, 2, 4, 0.5]

  // How long an op takes to appear, in the timelapse's own units: a stroke by its points.
  const lapseUnits = (op) =>
    op.k === 's' && Array.isArray(op.d)
      ? Math.max(2, Math.ceil(op.d.length / (op.p ? 3 : 2) / 6))
      : 6

  function openLapse() {
    if (lapse.open || !board.log.length) return
    closePop()
    endText(true)
    cancelGesture()
    let total = 0
    lapse.ops = board.log.slice()
    lapse.ends = lapse.ops.map((op) => (total += lapseUnits(op)))
    lapse.total = total
    // The whole replay takes between 4 and 30 seconds at its first speed.
    lapse.rate = total / clamp(total * 0.012, 4, 30)
    lapse.pos = 0
    lapse.speed = 1
    lapse.playing = true
    lapse.open = true
    lapse.canvas = E.makeCanvas()
    lapse.canvas.className = 'layer'
    lapse.ctx = lapse.canvas.getContext('2d')
    lapse.done = E.makeCanvas().getContext('2d')
    lapse.doneCount = 0
    lapse.shown = ''
    $('view').after(lapse.canvas)
    app.classList.add('lapsing')

    const range = el('input', 'range')
    range.type = 'range'
    range.min = 0
    range.max = 1000
    range.value = 0
    range.setAttribute('aria-label', 'Position')
    range.addEventListener('input', () => {
      lapse.playing = false
      lapse.pos = (Number(range.value) / 1000) * lapse.total
      refreshLapse()
      needFrame()
    })
    lapse.range = range
    lapse.play = iconButton(
      'pause',
      'Pause',
      () => {
        if (!lapse.playing && lapse.pos >= lapse.total) lapse.pos = 0
        lapse.playing = !lapse.playing
        refreshLapse()
        needFrame()
      },
      'Space'
    )
    lapse.count = el('span', 'lapse-count')
    lapse.speedBtn = button(
      'icon-btn lapse-speed',
      '1x',
      () => {
        lapse.speed = LAPSE_SPEEDS[(LAPSE_SPEEDS.indexOf(lapse.speed) + 1) % LAPSE_SPEEDS.length]
        refreshLapse()
      },
      'Speed'
    )
    $('lapse').replaceChildren(
      lapse.play,
      range,
      lapse.count,
      lapse.speedBtn,
      iconButton('x', 'Close the timelapse', closeLapse, 'Esc')
    )
    $('lapse').hidden = false
    refreshLapse()
    placeRing()
    needFrame()
  }

  function closeLapse() {
    if (!lapse.open) return
    lapse.open = false
    lapse.playing = false
    lapse.canvas.remove()
    lapse.canvas = lapse.ctx = lapse.done = null
    lapse.ops = []
    $('lapse').hidden = true
    app.classList.remove('lapsing')
    placeRing()
  }

  function refreshLapse() {
    const playing = lapse.playing
    const name = playing ? 'pause' : 'play'
    if (lapse.play.dataset.icon !== name) {
      lapse.play.dataset.icon = name
      lapse.play.replaceChildren(icon(name))
    }
    tip(lapse.play, playing ? 'Pause' : lapse.pos >= lapse.total ? 'Play again' : 'Play', 'Space')
    lapse.speedBtn.textContent = `${lapse.speed}x`
  }

  // The op the position falls in: every op before it is whole.
  function lapseIndex() {
    let lo = 0
    let hi = lapse.ends.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lapse.ends[mid] <= lapse.pos) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  function stepLapse(dt) {
    if (!lapse.open) return false
    if (lapse.playing) {
      lapse.pos = Math.min(lapse.total, lapse.pos + (lapse.rate * lapse.speed * dt) / 1000)
      if (lapse.pos >= lapse.total) {
        lapse.playing = false
        refreshLapse()
      }
    }
    const at = lapseIndex()
    if (lapse.doneCount > at) {
      lapse.done.clearRect(0, 0, W, H)
      lapse.doneCount = 0
    }
    // Catching up after a jump is spread over frames.
    const start = performance.now()
    while (lapse.doneCount < at && performance.now() - start < 10) {
      E.drawOp(lapse.done, lapse.ops[lapse.doneCount++])
    }
    const behind = lapse.doneCount < at
    const op = behind ? null : lapse.ops[at]
    let part = null
    if (op?.k === 's' && Array.isArray(op.d)) {
      const stride = op.p ? 3 : 2
      const before = at ? lapse.ends[at - 1] : 0
      const share = (lapse.pos - before) / (lapse.ends[at] - before)
      const points = Math.max(1, Math.ceil((op.d.length / stride) * share))
      part = { ...op, d: op.d.slice(0, points * stride) }
    } else if (op) {
      part = op
    }
    const shown = `${lapse.doneCount}:${part ? part.d.length : 0}`
    if (shown !== lapse.shown) {
      lapse.shown = shown
      lapse.ctx.globalCompositeOperation = 'copy'
      lapse.ctx.drawImage(lapse.done.canvas, 0, 0)
      lapse.ctx.globalCompositeOperation = 'source-over'
      if (part) E.drawOp(lapse.ctx, part)
    }
    if (document.activeElement !== lapse.range || lapse.playing)
      lapse.range.value = Math.round((lapse.pos / lapse.total) * 1000)
    lapse.count.textContent = `${Math.min(lapse.ops.length, at + (part ? 1 : 0))} / ${lapse.ops.length}`
    return lapse.playing || behind
  }

  function recount() {
    marks.clear()
    for (const op of board.log) marks.set(String(op.c), (marks.get(String(op.c)) ?? 0) + 1)
  }

  // A cleared board: what was on it is swept off rather than vanishing.
  function sweepAway() {
    if (reducedMotion.matches || !board.log.length) return
    const ghost = E.makeCanvas()
    ghost.getContext('2d').drawImage($('view'), 0, 0)
    ghost.className = 'layer ghost'
    $('view').after(ghost)
    const sweep = $('sweep')
    sweep.hidden = false
    setTimeout(() => {
      ghost.remove()
      sweep.hidden = true
    }, 600)
  }

  wbNet.on('snapshot', (snapshot) => {
    const first = !S.ready
    board.load(snapshot)
    if (board.settled) $('loading').hidden = true
    recount()
    paintPaper()
    announce()
    refresh()
    if (first) zoomFit(false)
  })

  wbNet.on('delta', (delta) => {
    if (delta.t === 'clear') sweepAway()
    if (delta.t === 'ops') {
      for (const op of delta.ops ?? []) {
        const from = String(op.c)
        if (from === you()) landed(op)
        else {
          dropPreviews(from)
          markDrawing(from)
        }
      }
    }
    const removed = board.apply(delta)
    if (delta.t === 'ops' || removed.length) recount()
    if (delta.t === 'undo' && undoing && String(removed[0]?.c) === you())
      undoing.removed.unshift(removed[0])
    if (delta.t === 'bg') {
      const paper = $('paper')
      paper.classList.add('changing')
      setTimeout(
        () => {
          paintPaper()
          paper.classList.remove('changing')
        },
        reducedMotion.matches ? 0 : 130
      )
    }
    if (delta.t === 'locks') announce()
    refresh()
  })

  wbNet.on('cursor', ({ from, x, y }) => moveCursor(String(from), x / Q, y / Q))
  wbNet.on('preview', onPreview)
  wbNet.on('previewEnd', onPreviewEnd)
  wbNet.on('people', () => {
    if (!wbNet.connected) {
      endText(false)
      cancelGesture()
    }
    refresh()
  })

  board.onInk(recompose)
  // The loading line shows only for a job that lasts: most rebuilds are over before it would.
  let loadingTimer = null
  board.onProgress((progress) => {
    if (!progress) {
      clearTimeout(loadingTimer)
      loadingTimer = null
      $('loading').hidden = true
      return
    }
    $('loading-text').textContent = 'Loading the board'
    $('loading-fill').style.transform = `scaleX(${progress.done / progress.total})`
    if ($('loading').hidden) loadingTimer ??= setTimeout(() => ($('loading').hidden = false), 180)
  })

  const typing = (target) =>
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement

  addEventListener('keydown', (event) => {
    if (typing(event.target) && event.target.type !== 'range') return
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key
    if (event.ctrlKey || event.metaKey) {
      if (key === 'z') event.shiftKey ? redo() : undo()
      else if (key === 'y') redo()
      else if (key === 's') openSave()
      else if (key === '=' || key === '+') zoomAt(1.3, undefined, undefined, true)
      else if (key === '-') zoomAt(1 / 1.3, undefined, undefined, true)
      else if (key === '0') zoomFit()
      else return
      event.preventDefault()
      return
    }
    if (event.altKey) return
    if (key === 'Escape') {
      if (wbWidgets.popId) closePop()
      else if (gesture) cancelGesture()
      else if (lapse.open) closeLapse()
      return
    }
    if (key === ' ') {
      event.preventDefault()
      if (lapse.open) {
        if (!event.repeat) lapse.play.click()
        return
      }
      spaceDown = true
      placeRing()
      return
    }
    if (event.repeat && key !== '[' && key !== ']') return
    if (key === '[') stepSize(-1)
    else if (key === ']') stepSize(1)
    else if (key === '=' || key === '+') zoomAt(1.3, undefined, undefined, true)
    else if (key === '-') zoomAt(1 / 1.3, undefined, undefined, true)
    else if (key === '0') zoomFit()
    else if (key === 'v') cycleMirror()
    else if (lapse.open) return
    else {
      const shapeId = Object.keys(SHAPE_KEYS).find((id) => SHAPE_KEYS[id].toLowerCase() === key)
      const toolId = DOCK_ORDER.find((id) => TOOLS[id].key.toLowerCase() === key)
      if (shapeId) {
        shape = shapeId
        setTool('shape')
      } else if (toolId && (canDraw() || TOOLS[toolId].always)) {
        closePop()
        setTool(toolId)
      }
    }
  })
  addEventListener('keyup', (event) => {
    if (event.key !== ' ') return
    spaceDown = false
    placeRing()
  })
  addEventListener('blur', () => {
    spaceDown = false
    cancelGesture()
    hover = null
    placeRing()
  })

  function layout() {
    app.classList.toggle('narrow', innerWidth < NARROW_UNDER)
    app.classList.toggle('tiny', innerWidth < TINY_UNDER)
    const before = dockShown
    layoutDock()
    layoutBanner()
    if (before !== dockShown) refreshDock()
    if (view.fit) setView(fitView(), { fit: true })
    else setView({ ...view })
  }

  buildChrome()
  app.hidden = false
  layout()
  refresh()
  addEventListener('resize', layout)
  new ResizeObserver(layout).observe(app)
})()
