// The board as this client holds it: the op log in order, the ink canvas the log adds up to, and
// the room state that rides with it (host, locks, background, prompt, ink used). The ink may lag
// the log: ops are drawn in slices, so a large snapshot or a long rebuild never holds the frame,
// and an undo or a wipe goes back to the nearest kept checkpoint instead of the blank board.
/* global wbEngine */
;(() => {
  const { W, H, makeCanvas, drawOp, boundsOf } = wbEngine
  const CHECKPOINT_EVERY = 96
  const MAX_CHECKPOINTS = 6
  // Work done at once when something changes, and per slice after that. A rebuild after an undo
  // may hold the frame longer than a load does: it is one beat, and most end inside it.
  const LOAD_FIRST_MS = 24
  const REBUILD_FIRST_MS = 90
  const SLICE_MS = 12
  // Marks taken out are redrawn inside their own box when the box is under this share of the
  // board and under this many marks touch it; past either, the board is rebuilt in slices.
  const PATCH_MAX_AREA = 0.3
  const PATCH_MAX_OPS = 500
  const PATCH_MARGIN = 8
  const overlaps = (a, b) =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h

  function createBoard() {
    const ink = makeCanvas()
    const ctx = ink.getContext('2d')
    let log = []
    // The ink holds log[0, drawn).
    let drawn = 0
    // { at, canvas }: the ink as it was with the first `at` ops, oldest first.
    let checkpoints = []
    let spare = null
    let top = 0
    let timer = null
    // A job that did not fit its first slice. A load shows the ink as it fills in; a rebuild
    // keeps the old picture up until it is whole again.
    let busy = false
    let showPartial = false
    const inkListeners = []
    const progressListeners = []
    const state = {
      ready: false,
      host: null,
      locked: new Set(),
      lockAll: false,
      bg: { paper: 'white', pattern: 'plain' },
      prompt: null,
      used: 0,
      max: 3 * 1024 * 1024
    }

    const emitInk = () => inkListeners.forEach((fn) => fn())
    const emitProgress = (value) => progressListeners.forEach((fn) => fn(value))

    function release(checkpoint) {
      if (spare) checkpoint.canvas.width = 0
      else spare = checkpoint.canvas
    }

    // Past the limit, the older checkpoint that leaves the smallest gap behind goes; the newest
    // two always stay, since an undo is nearly always of something recent.
    function keepCheckpoint() {
      const canvas = spare ?? makeCanvas()
      spare = null
      const c = canvas.getContext('2d')
      c.globalCompositeOperation = 'copy'
      c.drawImage(ink, 0, 0)
      checkpoints.push({ at: drawn, canvas })
      if (checkpoints.length <= MAX_CHECKPOINTS) return
      let drop = 0
      let smallest = Infinity
      for (let i = 0; i < checkpoints.length - 2; i++) {
        const gap = checkpoints[i + 1].at - (i ? checkpoints[i - 1].at : 0)
        if (gap < smallest) {
          smallest = gap
          drop = i
        }
      }
      release(checkpoints.splice(drop, 1)[0])
    }

    function pump(budget) {
      timer = null
      const start = performance.now()
      for (let n = 1; drawn < log.length; n++) {
        drawOp(ctx, log[drawn])
        drawn++
        if (drawn % CHECKPOINT_EVERY === 0) keepCheckpoint()
        if (n % 8 === 0 && performance.now() - start > budget) break
      }
      if (drawn < log.length) {
        busy = true
        emitProgress({ done: drawn, total: log.length })
        if (showPartial) emitInk()
        timer = setTimeout(pump, 0, SLICE_MS)
        return
      }
      if (busy) emitProgress(null)
      busy = false
      showPartial = false
      emitInk()
    }

    const run = (budget = REBUILD_FIRST_MS) => {
      if (timer === null) pump(budget)
    }

    // Takes the ink back to before log[index] changed.
    function rewind(index) {
      if (index >= drawn) return
      while (checkpoints.length && checkpoints.at(-1).at > index) release(checkpoints.pop())
      const from = checkpoints.at(-1)
      if (from) {
        ctx.save()
        ctx.globalCompositeOperation = 'copy'
        ctx.drawImage(from.canvas, 0, 0)
        ctx.restore()
      } else {
        ctx.clearRect(0, 0, W, H)
      }
      drawn = from ? from.at : 0
    }

    // The box around ops that were taken out, or null when it cannot be known.
    function boxOfAll(ops) {
      let x0 = W
      let y0 = H
      let x1 = 0
      let y1 = 0
      for (const op of ops) {
        const b = boundsOf(op)
        if (!b) continue
        x0 = Math.min(x0, b.x)
        y0 = Math.min(y0, b.y)
        x1 = Math.max(x1, b.x + b.w)
        y1 = Math.max(y1, b.y + b.h)
      }
      return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
    }

    // The ink without `removed`, the first of which sat at log[index]. Nothing outside the box
    // they covered can have changed, so when that box is small only the marks touching it are
    // drawn again, inside it; this is what keeps an undo quick however many marks came after.
    function takeOut(index, removed, wasSettled) {
      const box = boxOfAll(removed)
      while (checkpoints.length && checkpoints.at(-1).at > index) release(checkpoints.pop())
      const from = checkpoints.at(-1)
      const start = from ? from.at : 0
      let touching = null
      if (wasSettled && box && box.w * box.h <= W * H * PATCH_MAX_AREA) {
        touching = []
        for (let i = start; i < log.length && touching.length <= PATCH_MAX_OPS; i++) {
          const b = boundsOf(log[i])
          if (b && overlaps(b, box)) touching.push(log[i])
        }
      }
      if (!box && wasSettled) {
        drawn = log.length
        return emitInk()
      }
      if (!touching || touching.length > PATCH_MAX_OPS) {
        rewind(index)
        return run()
      }
      // Drawn on a canvas of its own, a margin wider than the box, and only the box copied
      // back: a shape cut by a canvas's edge is antialiased a little differently there, and
      // the margin keeps that out of the ink.
      const part = makeCanvas(box.w + PATCH_MARGIN * 2, box.h + PATCH_MARGIN * 2).getContext('2d')
      part.translate(PATCH_MARGIN - box.x, PATCH_MARGIN - box.y)
      if (from) part.drawImage(from.canvas, 0, 0)
      for (const op of touching) drawOp(part, op)
      ctx.clearRect(box.x, box.y, box.w, box.h)
      ctx.drawImage(
        part.canvas,
        PATCH_MARGIN,
        PATCH_MARGIN,
        box.w,
        box.h,
        box.x,
        box.y,
        box.w,
        box.h
      )
      drawn = log.length
      emitInk()
    }

    function blank() {
      log = []
      drawn = 0
      checkpoints.forEach(release)
      checkpoints = []
      ctx.clearRect(0, 0, W, H)
    }

    function indexOf(id) {
      let lo = 0
      let hi = log.length - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        if (log[mid].i === id) return mid
        if (log[mid].i < id) lo = mid + 1
        else hi = mid - 1
      }
      return -1
    }

    const isOp = (op) => op && typeof op === 'object' && Number.isInteger(op.i)

    function setLocks(from) {
      state.host = from.host == null ? null : String(from.host)
      state.locked = new Set((from.locked ?? []).map(String))
      state.lockAll = !!from.lock_all
    }

    // Replaces everything held with the snapshot.
    function load(snapshot) {
      blank()
      log = (Array.isArray(snapshot.ops) ? snapshot.ops : []).filter(isOp)
      top = Math.max(snapshot.top ?? 0, log.length ? log.at(-1).i : 0)
      setLocks(snapshot)
      state.bg = { paper: snapshot.bg?.paper, pattern: snapshot.bg?.pattern }
      state.prompt = snapshot.prompt ?? null
      state.used = snapshot.used ?? 0
      state.max = snapshot.max ?? state.max
      state.ready = true
      showPartial = true
      if (timer !== null) clearTimeout(timer)
      timer = null
      run(LOAD_FIRST_MS)
    }

    // Applies one delta. Returns the ops it took out of the log, oldest first.
    function apply(delta) {
      if (typeof delta.used === 'number') state.used = delta.used
      switch (delta.t) {
        case 'ops':
          for (const op of delta.ops ?? []) {
            if (!isOp(op) || op.i <= top) continue
            top = op.i
            log.push(op)
          }
          run()
          return []
        case 'undo': {
          const index = indexOf(delta.i)
          if (index < 0) return []
          const settled = drawn === log.length
          const removed = log.splice(index, 1)
          takeOut(index, removed, settled)
          return removed
        }
        case 'wipe': {
          const who = String(delta.c)
          const first = log.findIndex((op) => String(op.c) === who)
          if (first < 0) return []
          const settled = drawn === log.length
          const removed = log.filter((op) => String(op.c) === who)
          log = log.filter((op) => String(op.c) !== who)
          takeOut(first, removed, settled)
          return removed
        }
        case 'clear': {
          const removed = log
          blank()
          if (timer !== null) clearTimeout(timer)
          timer = null
          if (busy) emitProgress(null)
          busy = false
          emitInk()
          return removed
        }
        case 'locks':
          setLocks(delta)
          return []
        case 'bg':
          state.bg = { paper: delta.paper, pattern: delta.pattern }
          return []
        case 'prompt':
          state.prompt = delta.prompt ?? null
          return []
        default:
          return []
      }
    }

    return {
      ink,
      state,
      load,
      apply,
      get log() {
        return log
      },
      // Whether the ink holds every op in the log.
      get settled() {
        return drawn === log.length
      },
      has: (id) => indexOf(id) >= 0,
      // The ink's pixels, for the bucket and the eyedropper.
      pixels: (x = 0, y = 0, w = W, h = H) => ctx.getImageData(x, y, w, h),
      // fn() when the ink has changed and is fit to show.
      onInk: (fn) => inkListeners.push(fn),
      // fn({ done, total }) while a long job runs, fn(null) when it ends.
      onProgress: (fn) => progressListeners.push(fn)
    }
  }

  window.wbBoard = { createBoard }
})()
