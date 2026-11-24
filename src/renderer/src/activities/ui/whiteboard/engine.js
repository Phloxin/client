// The whiteboard's drawing engine: what an op looks like. Everything here draws from op data
// alone, with no clock and no unseeded randomness, so every client gets the same picture. It
// also holds the papers and patterns, the flood fill behind the bucket, the stroke being drawn
// (painted piece by piece with the same geometry as the finished op) and the PNG export.
/* global wbStamps */
;(() => {
  const W = 1920
  const H = 1080
  const Q = 4
  const MAX_POINTS = 4096
  const MAX_FILL_INTS = 32768
  const MAX_ROW_SPANS = 512
  const TAU = Math.PI * 2
  // Text is set in one fixed stack on every client, never the theme's font.
  const FONT = 'Arial, "Liberation Sans", Helvetica, sans-serif'
  const TEXT_WEIGHT = 600
  const LINE_HEIGHT = 1.25
  // The first baseline under the top of the text box, in font sizes.
  const BASELINE = 0.97
  // How far two premultiplied channels may differ and still be the area the bucket floods.
  const FLOOD_TOLERANCE = 40

  // `smooth` strokes run through the midpoints of their points; `erase` and `spray` follow the
  // points themselves. A translucent or grained tool is painted whole and then laid on the ink.
  const TOOLS = {
    pen: { kind: 'smooth', alpha: 1, grain: false },
    brush: { kind: 'smooth', alpha: 1, grain: false },
    pencil: { kind: 'smooth', alpha: 0.86, grain: true },
    marker: { kind: 'smooth', alpha: 0.5, grain: false },
    spray: { kind: 'spray', alpha: 1, grain: false },
    eraser: { kind: 'erase', alpha: 1, grain: false }
  }
  const toolOf = (ident) => (Object.hasOwn(TOOLS, ident) ? TOOLS[ident] : TOOLS.pen)
  const SHAPES = ['line', 'arrow', 'rect', 'ellipse', 'triangle', 'star']

  const css = (color) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  // A stroke point's width from its factor, 128 being the tool's size.
  const widthOf = (size, factor) => Math.max(0.6, (size * factor) / 128)

  function makeCanvas(w = W, h = H) {
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    return canvas
  }

  // Where a translucent or grained stroke is painted whole before it goes on the ink: the
  // smallest of a few canvases that holds the stroke's box, since drawing from a canvas copies
  // all of it. Cleared, and set so the caller still draws in board px.
  const SCRATCH_SIDES = [256, 512, 1024]
  const scratches = new Map()
  function scratchFor(box) {
    const side = SCRATCH_SIDES.find((s) => box.w <= s && box.h <= s) ?? 0
    if (!scratches.has(side)) scratches.set(side, makeCanvas(side || W, side || H).getContext('2d'))
    const s = scratches.get(side)
    s.setTransform(1, 0, 0, 1, 0, 0)
    s.clearRect(0, 0, box.w, box.h)
    s.translate(-box.x, -box.y)
    return s
  }
  let measureCtx = null

  function mulberry(seed) {
    let a = seed >>> 0
    return () => {
      a = (a + 0x6d2b79f5) >>> 0
      let t = a
      t = Math.imul(t ^ (t >>> 15), t | 1)
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
  }

  // The pencil's grain: the same speckle on every client, punched out of the stroke.
  let grainPattern = null
  function grain() {
    if (grainPattern) return grainPattern
    const size = 96
    const tile = makeCanvas(size, size)
    const ctx = tile.getContext('2d')
    const image = ctx.createImageData(size, size)
    const rand = mulberry(0x9e3779b9)
    for (let i = 0; i < size * size; i++) image.data[i * 4 + 3] = rand() < 0.2 ? 255 : 0
    ctx.putImageData(image, 0, 0)
    grainPattern = ctx.createPattern(tile, 'repeat')
    return grainPattern
  }
  function punchGrain(ctx, box) {
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = grain()
    ctx.fillRect(box.x, box.y, box.w, box.h)
    ctx.restore()
  }

  const geometries = new WeakMap()

  // A stroke op's points in px and widths, or null when its data is not a stroke.
  function geometry(op) {
    if (geometries.has(op)) return geometries.get(op)
    const g = decodeStroke(op)
    geometries.set(op, g)
    return g
  }

  function decodeStroke(op) {
    const d = op.d
    const stride = op.p ? 3 : 2
    if (!Array.isArray(d) || d.length < stride || d.length % stride) return null
    const n = d.length / stride
    const x = new Float32Array(n)
    const y = new Float32Array(n)
    const w = op.p ? new Float32Array(n) : null
    let ax = 0
    let ay = 0
    let af = 0
    for (let i = 0, j = 0; i < n; i++) {
      ax += d[j++]
      ay += d[j++]
      x[i] = ax / Q
      y[i] = ay / Q
      if (w) {
        af += d[j++]
        w[i] = widthOf(op.size, af)
      }
    }
    return { n, x, y, w }
  }

  // The box around points [from, to) grown by `pad`, cut to the board, or null when it is off it.
  function boxOf(g, from, to, pad) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (let i = Math.max(0, from); i < to; i++) {
      if (g.x[i] < x0) x0 = g.x[i]
      if (g.x[i] > x1) x1 = g.x[i]
      if (g.y[i] < y0) y0 = g.y[i]
      if (g.y[i] > y1) y1 = g.y[i]
    }
    x0 = Math.max(0, Math.floor(x0 - pad))
    y0 = Math.max(0, Math.floor(y0 - pad))
    x1 = Math.min(W, Math.ceil(x1 + pad))
    y1 = Math.min(H, Math.ceil(y1 + pad))
    return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
  }
  // Half the widest a stroke can be (a width factor tops out at twice the size), and a little.
  const padOf = (g, size) => (g.w ? size : size / 2) + 2

  const midX = (g, i) => (g.x[i] + g.x[i + 1]) / 2
  const midY = (g, i) => (g.y[i] + g.y[i + 1]) / 2

  // A smooth stroke of points 0..last is `last + 1` pieces: a line from the first point to the
  // first midpoint, a curve from midpoint to midpoint around each point between, and a line from
  // the last midpoint to the last point. Each piece depends on three points at most, which is
  // what lets a stroke in progress be painted as it grows.
  function tracePieces(ctx, g, from, to, last) {
    if (from === 0) ctx.moveTo(g.x[0], g.y[0])
    else ctx.moveTo(midX(g, from - 1), midY(g, from - 1))
    for (let i = from; i < to; i++) {
      if (i === 0) ctx.lineTo(midX(g, 0), midY(g, 0))
      else if (i === last) ctx.lineTo(g.x[last], g.y[last])
      else ctx.quadraticCurveTo(g.x[i], g.y[i], midX(g, i), midY(g, i))
    }
  }

  // A round-ended segment whose width runs from r0 to r1. Every subpath here turns the same way,
  // so a stroke built from these fills as their union.
  function capsule(ctx, x0, y0, r0, x1, y1, r1) {
    ctx.moveTo(x1 + r1, y1)
    ctx.arc(x1, y1, r1, 0, TAU)
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy)
    if (len < 0.01) return
    const nx = -dy / len
    const ny = dx / len
    ctx.moveTo(x0 - nx * r0, y0 - ny * r0)
    ctx.lineTo(x1 - nx * r1, y1 - ny * r1)
    ctx.lineTo(x1 + nx * r1, y1 + ny * r1)
    ctx.lineTo(x0 + nx * r0, y0 + ny * r0)
    // Left open: a fill closes it anyway, and closePath gets slower with every subpath a path
    // already has when the context is translated (measured in Chromium).
  }

  // The same pieces for a stroke whose width changes along it, as capsules.
  function tracePiecesWide(ctx, g, from, to, last) {
    const midW = (i) => (g.w[i] + g.w[i + 1]) / 4
    if (from === 0) {
      ctx.moveTo(g.x[0] + g.w[0] / 2, g.y[0])
      ctx.arc(g.x[0], g.y[0], g.w[0] / 2, 0, TAU)
    }
    for (let i = from; i < to; i++) {
      if (i === 0) {
        capsule(ctx, g.x[0], g.y[0], g.w[0] / 2, midX(g, 0), midY(g, 0), midW(0))
      } else if (i === last) {
        const a = last - 1
        capsule(ctx, midX(g, a), midY(g, a), midW(a), g.x[last], g.y[last], g.w[last] / 2)
      } else {
        const ax = midX(g, i - 1)
        const ay = midY(g, i - 1)
        const ar = midW(i - 1)
        const bx = midX(g, i)
        const by = midY(g, i)
        const br = midW(i)
        const cx = g.x[i]
        const cy = g.y[i]
        const cr = g.w[i] / 2
        const reach = Math.hypot(cx - ax, cy - ay) + Math.hypot(bx - cx, by - cy)
        const steps = clamp(Math.ceil(reach / 5), 1, 8)
        let px = ax
        let py = ay
        let pr = ar
        for (let s = 1; s <= steps; s++) {
          const t = s / steps
          const u = 1 - t
          const k0 = u * u
          const k1 = 2 * u * t
          const k2 = t * t
          const x = k0 * ax + k1 * cx + k2 * bx
          const y = k0 * ay + k1 * cy + k2 * by
          const r = k0 * ar + k1 * cr + k2 * br
          capsule(ctx, px, py, pr, x, y, r)
          px = x
          py = y
          pr = r
        }
      }
    }
  }

  // Paints pieces [from, to) of a smooth stroke in solid `color`.
  function paintPieces(ctx, g, size, color, from, to, last) {
    ctx.beginPath()
    if (g.w) {
      tracePiecesWide(ctx, g, from, to, last)
      ctx.fillStyle = color
      ctx.fill()
    } else {
      tracePieces(ctx, g, from, to, last)
      ctx.strokeStyle = color
      ctx.lineWidth = size
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
  }

  function paintDot(ctx, g, size, color) {
    ctx.beginPath()
    ctx.arc(g.x[0], g.y[0], (g.w ? g.w[0] : size) / 2, 0, TAU)
    ctx.fillStyle = color
    ctx.fill()
  }

  function paintSmooth(ctx, g, size, color) {
    if (g.n === 1) paintDot(ctx, g, size, color)
    else paintPieces(ctx, g, size, color, 0, g.n, g.n - 1)
  }

  // The eraser's line through points [from, to], straight from point to point.
  function paintErase(ctx, g, size, from, to) {
    ctx.save()
    ctx.globalCompositeOperation = 'destination-out'
    ctx.fillStyle = ctx.strokeStyle = '#000'
    ctx.beginPath()
    if (to === from) {
      ctx.arc(g.x[from], g.y[from], size / 2, 0, TAU)
      ctx.fill()
    } else {
      ctx.moveTo(g.x[from], g.y[from])
      for (let i = from + 1; i <= to; i++) ctx.lineTo(g.x[i], g.y[i])
      ctx.lineWidth = size
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.stroke()
    }
    ctx.restore()
  }

  // The spray's walk along a stroke: where it has got to, and the generator its dots come from,
  // seeded by the stroke's own first point.
  const sprayStart = (g, op) => ({
    rand: mulberry(
      Math.imul(Math.round(g.x[0] * Q) + 1, 73856093) ^
        Math.imul(Math.round(g.y[0] * Q) + 1, 19349663) ^
        Math.imul(op.size + 1, 83492791) ^
        op.color
    ),
    next: 0,
    carry: 0,
    begun: false
  })

  // Paints the spray's dots along segments up to point `to`, moving `walk` on.
  function paintSpray(ctx, g, size, color, walk, to) {
    const radius = size / 2
    const step = Math.max(1.5, size * 0.1)
    const perStep = Math.max(3, Math.round(size * 0.3))
    const { rand } = walk
    const puff = (x, y, dots) => {
      for (let k = 0; k < dots; k++) {
        const r = radius * rand() ** 0.6
        const a = TAU * rand()
        const s = 1.2 + rand() * 1.4
        ctx.fillRect(x + r * Math.cos(a) - s / 2, y + r * Math.sin(a) - s / 2, s, s)
      }
    }
    ctx.fillStyle = color
    if (!walk.begun) {
      walk.begun = true
      puff(g.x[0], g.y[0], perStep * 3)
    }
    for (; walk.next < to; walk.next++) {
      const i = walk.next
      const dx = g.x[i + 1] - g.x[i]
      const dy = g.y[i + 1] - g.y[i]
      const len = Math.hypot(dx, dy)
      if (len === 0) continue
      let at = walk.carry
      for (; at <= len; at += step)
        puff(g.x[i] + (dx * at) / len, g.y[i] + (dy * at) / len, perStep)
      walk.carry = at - len
    }
  }

  function drawStroke(ctx, op) {
    const g = geometry(op)
    if (!g) return
    const tool = toolOf(op.tool)
    const color = css(op.color)
    if (tool.kind === 'erase') return paintErase(ctx, g, op.size, 0, g.n - 1)
    if (tool.kind === 'spray') return paintSpray(ctx, g, op.size, color, sprayStart(g, op), g.n - 1)
    if (tool.alpha === 1 && !tool.grain) return paintSmooth(ctx, g, op.size, color)
    const box = boxOf(g, 0, g.n, padOf(g, op.size))
    if (!box) return
    const s = scratchFor(box)
    paintSmooth(s, g, op.size, color)
    if (tool.grain) punchGrain(s, box)
    ctx.save()
    ctx.globalAlpha = tool.alpha
    ctx.drawImage(s.canvas, 0, 0, box.w, box.h, box.x, box.y, box.w, box.h)
    ctx.restore()
  }

  function drawFill(ctx, op) {
    const d = op.d
    if (!Array.isArray(d) || d.length < 4) return
    ctx.beginPath()
    let y = d[0]
    for (let j = 1; j < d.length; y++) {
      const count = d[j++]
      for (let k = 0; k < count; k++, j += 2) ctx.rect(d[j], y, d[j + 1], 1)
    }
    ctx.fillStyle = css(op.color)
    ctx.fill()
  }

  // Traces a shape between two corners. 'open' for one that is only ever stroked, 'closed' for
  // one that can be filled, null for a shape this client does not know.
  function traceShape(ctx, shape, x0, y0, x1, y1) {
    const left = Math.min(x0, x1)
    const top = Math.min(y0, y1)
    const w = Math.abs(x1 - x0)
    const h = Math.abs(y1 - y0)
    const cx = left + w / 2
    const cy = top + h / 2
    switch (shape) {
      case 'line':
        ctx.moveTo(x0, y0)
        ctx.lineTo(x1, y1)
        return 'open'
      case 'rect':
        ctx.rect(left, top, w, h)
        return 'closed'
      case 'ellipse':
        ctx.ellipse(cx, cy, w / 2, h / 2, 0, 0, TAU)
        return 'closed'
      // The triangle and the star point towards the corner the drag began at, so a mirrored
      // copy comes out mirrored.
      case 'triangle':
        ctx.moveTo(cx, y0)
        ctx.lineTo(left + w, y1)
        ctx.lineTo(left, y1)
        ctx.closePath()
        return 'closed'
      case 'star':
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? 0.42 : 1
          const a = (Math.PI * i) / 5 - Math.PI / 2
          const px = cx + (w / 2) * r * Math.cos(a)
          const py = cy + (y1 < y0 ? -1 : 1) * (h / 2) * r * Math.sin(a)
          if (i) ctx.lineTo(px, py)
          else ctx.moveTo(px, py)
        }
        ctx.closePath()
        return 'closed'
      default:
        return null
    }
  }

  function drawArrow(ctx, x0, y0, x1, y1, size) {
    const len = Math.hypot(x1 - x0, y1 - y0)
    if (len < 0.5) return
    const ux = (x1 - x0) / len
    const uy = (y1 - y0) / len
    const head = Math.min(Math.max(12, size * 4), len)
    const half = head * 0.48
    const bx = x1 - ux * head
    const by = y1 - uy * head
    ctx.beginPath()
    ctx.moveTo(x0, y0)
    ctx.lineTo(x1 - ux * head * 0.8, y1 - uy * head * 0.8)
    ctx.lineWidth = size
    ctx.stroke()
    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(bx - uy * half, by + ux * half)
    ctx.lineTo(bx + uy * half, by - ux * half)
    ctx.closePath()
    ctx.fill()
    ctx.lineWidth = Math.max(1, size * 0.5)
    ctx.stroke()
  }

  // A shape from its fields, also used for the shape being dragged out.
  function paintShape(ctx, shape, color, size, fill, x0, y0, x1, y1) {
    ctx.save()
    ctx.strokeStyle = ctx.fillStyle = css(color)
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = size
    if (shape === 'arrow') {
      drawArrow(ctx, x0, y0, x1, y1, size)
    } else {
      ctx.beginPath()
      const kind = traceShape(ctx, shape, x0, y0, x1, y1)
      if (kind === 'closed' && fill) ctx.fill()
      if (kind) ctx.stroke()
    }
    ctx.restore()
  }

  function drawShape(ctx, op) {
    const d = op.d
    if (!Array.isArray(d) || d.length !== 4) return
    paintShape(ctx, op.shape, op.color, op.size, !!op.fill, d[0] / Q, d[1] / Q, d[2] / Q, d[3] / Q)
  }

  const fontOf = (size) => `${TEXT_WEIGHT} ${size}px ${FONT}`

  // The width in px of the text's widest line as this client sets it.
  function textWidth(text, size) {
    const s = (measureCtx ??= makeCanvas(1, 1).getContext('2d'))
    s.font = fontOf(size)
    let widest = 0
    for (const line of String(text).split('\n'))
      widest = Math.max(widest, s.measureText(line).width)
    return widest
  }

  // Text is squeezed or stretched sideways so its widest line is as wide as it was for its
  // author, whatever this client's fonts measure.
  function drawText(ctx, op) {
    const d = op.d
    if (!Array.isArray(d) || d.length !== 3 || typeof op.text !== 'string') return
    const lines = op.text.split('\n')
    const mine = textWidth(op.text, op.size)
    const fit = mine > 0 ? clamp(d[2] / Q / mine, 0.5, 2) : 1
    ctx.save()
    ctx.translate(d[0] / Q, d[1] / Q)
    ctx.scale(fit, 1)
    ctx.font = fontOf(op.size)
    ctx.textBaseline = 'alphabetic'
    ctx.fillStyle = css(op.color)
    lines.forEach((line, i) => ctx.fillText(line, 0, op.size * (BASELINE + i * LINE_HEIGHT)))
    ctx.restore()
  }

  function drawStamp(ctx, op) {
    const d = op.d
    if (!Array.isArray(d) || d.length !== 3) return
    wbStamps.draw(ctx, op.stamp, d[0] / Q, d[1] / Q, op.size, d[2], css(op.color))
  }

  const bounds = new WeakMap()

  // A box that holds everything the op draws, cut to the board: { x, y, w, h }, or null for an
  // op that draws nothing on it. Never smaller than the mark, so ink outside it is not the op's.
  function boundsOf(op) {
    if (!bounds.has(op)) bounds.set(op, measure(op))
    return bounds.get(op)
  }

  function boxAround(x0, y0, x1, y1, pad) {
    const left = Math.max(0, Math.floor(Math.min(x0, x1) - pad))
    const top = Math.max(0, Math.floor(Math.min(y0, y1) - pad))
    const right = Math.min(W, Math.ceil(Math.max(x0, x1) + pad))
    const bottom = Math.min(H, Math.ceil(Math.max(y0, y1) + pad))
    return right > left && bottom > top
      ? { x: left, y: top, w: right - left, h: bottom - top }
      : null
  }

  function measure(op) {
    const d = op?.d
    if (!Array.isArray(d)) return null
    switch (op.k) {
      case 's': {
        const g = geometry(op)
        return g ? boxOf(g, 0, g.n, padOf(g, op.size)) : null
      }
      case 'f': {
        let left = W
        let right = 0
        let y = d[0]
        for (let j = 1; j < d.length; y++) {
          const count = d[j++]
          for (let k = 0; k < count; k++, j += 2) {
            left = Math.min(left, d[j])
            right = Math.max(right, d[j] + d[j + 1])
          }
        }
        return boxAround(left, d[0], right, y, 0)
      }
      // An arrow's head reaches four sizes back from its tip.
      case 'h':
        return boxAround(d[0] / Q, d[1] / Q, d[2] / Q, d[3] / Q, Math.max(14, op.size * 2.5) + 2)
      case 't': {
        const lines = String(op.text).split('\n').length
        const wide = Math.max(d[2] / Q, textWidth(op.text, op.size) * 2)
        const x = d[0] / Q
        const y = d[1] / Q
        return boxAround(x, y, x + wide, y + lines * op.size * LINE_HEIGHT, op.size * 0.5)
      }
      case 'm':
        return boxAround(d[0] / Q, d[1] / Q, d[0] / Q, d[1] / Q, op.size * 0.8 + 4)
      default:
        return null
    }
  }

  // Draws one op on a board-sized context. An op of a kind this client does not know, or one
  // whose data does not hold together, is skipped.
  function drawOp(ctx, op) {
    if (!op || typeof op.color !== 'number') return
    switch (op.k) {
      case 's':
        return drawStroke(ctx, op)
      case 'f':
        return drawFill(ctx, op)
      case 'h':
        return drawShape(ctx, op)
      case 't':
        return drawText(ctx, op)
      case 'm':
        return drawStamp(ctx, op)
      default:
        return undefined
    }
  }

  // A stroke as it grows. Points arrive in q units; `paint` puts what has become final on the
  // ink being shown, and `paintTail` redraws the end that the next point will still reshape, on
  // a canvas of its own. `factors` says the stroke carries a width factor per point.
  function liveStroke({ tool, color, size }, factors) {
    const kind = toolOf(tool)
    const fill = css(color)
    const qx = []
    const qy = []
    const qf = factors ? [] : null
    const g = {
      n: 0,
      x: new Float32Array(MAX_POINTS),
      y: new Float32Array(MAX_POINTS),
      w: factors ? new Float32Array(MAX_POINTS) : null
    }
    const op = { size, color }
    let painted = 0
    let walk = null
    let tailBox = null

    return {
      tool,
      get count() {
        return g.n
      },
      get full() {
        return g.n >= MAX_POINTS
      },
      lastX: () => qx[g.n - 1],
      lastY: () => qy[g.n - 1],
      lastFactor: () => (qf ? qf[g.n - 1] : 128),
      // Thins the stroke's end over its last few points, as a brush lifting off does.
      taper(points) {
        if (!qf) return
        const from = Math.max(1, g.n - points)
        for (let i = from; i < g.n; i++) {
          const k = (g.n - 1 - i) / points
          qf[i] = clamp(Math.round(qf[i] * (0.3 + 0.7 * k)), 1, 255)
          g.w[i] = widthOf(size, qf[i])
        }
      },
      add(x, y, factor = 128) {
        const i = g.n
        qx.push(x)
        qy.push(y)
        g.x[i] = x / Q
        g.y[i] = y / Q
        if (qf) {
          const f = clamp(Math.round(factor), 1, 255)
          qf.push(f)
          g.w[i] = widthOf(size, f)
        }
        g.n = i + 1
      },
      // `again` repaints from the first point, for ink that was redrawn underneath.
      paint(ctx, again = false) {
        if (again) {
          painted = 0
          walk = null
        }
        const last = g.n - 1
        if (kind.kind === 'erase') {
          if (painted === 0 || last > painted - 1)
            paintErase(ctx, g, size, Math.max(0, painted - 1), last)
          painted = g.n
        } else if (kind.kind === 'spray') {
          walk ??= sprayStart(g, op)
          paintSpray(ctx, g, size, fill, walk, last)
        } else if (last > painted) {
          paintPieces(ctx, g, size, fill, painted, last, Infinity)
          if (kind.grain) {
            const box = boxOf(g, painted - 1, g.n, padOf(g, size))
            if (box) punchGrain(ctx, box)
          }
          painted = last
        }
      },
      // Apart from paintTail, so strokes drawn together (the mirror's) can all clear before any
      // of them paints.
      clearTail(ctx) {
        if (tailBox) ctx.clearRect(tailBox.x, tailBox.y, tailBox.w, tailBox.h)
        tailBox = null
      },
      paintTail(ctx) {
        if (kind.kind !== 'smooth') return
        const last = g.n - 1
        tailBox = boxOf(g, last - 1, g.n, padOf(g, size))
        if (!tailBox) return
        if (last === 0) paintDot(ctx, g, size, fill)
        else paintPieces(ctx, g, size, fill, last, g.n, last)
        if (kind.grain) punchGrain(ctx, tailBox)
      },
      // The op to commit, its points as the wire has them: the first absolute, the rest deltas.
      op() {
        const d = []
        for (let i = 0; i < g.n; i++) {
          d.push(qx[i] - (i ? qx[i - 1] : 0), qy[i] - (i ? qy[i - 1] : 0))
          if (qf) d.push(qf[i] - (i ? qf[i - 1] : 0))
        }
        return qf ? { k: 's', tool, color, size, p: true, d } : { k: 's', tool, color, size, d }
      }
    }
  }

  const PAPERS = {
    white: { label: 'White', color: '#ffffff', dark: false },
    cream: { label: 'Cream', color: '#f8f1de', dark: false },
    blush: { label: 'Blush', color: '#fbe8e6', dark: false },
    mint: { label: 'Mint', color: '#e4f3e8', dark: false },
    sky: { label: 'Sky', color: '#e3eefb', dark: false },
    kraft: { label: 'Kraft', color: '#d6bb93', dark: false },
    slate: { label: 'Slate', color: '#3a434f', dark: true },
    chalk: { label: 'Chalkboard', color: '#213f37', dark: true },
    navy: { label: 'Blueprint', color: '#1b417c', dark: true },
    black: { label: 'Black', color: '#141619', dark: true }
  }
  const PATTERN_LABELS = {
    plain: 'Plain',
    dots: 'Dots',
    grid: 'Grid',
    lines: 'Lines',
    graph: 'Graph',
    iso: 'Isometric',
    cross: 'Crosses'
  }
  const paperOf = (ident) => (Object.hasOwn(PAPERS, ident) ? ident : 'white')
  const patternOf = (ident) => (Object.hasOwn(PATTERN_LABELS, ident) ? ident : 'plain')

  function rule(ctx, step, vertical, horizontal) {
    ctx.beginPath()
    if (vertical) {
      for (let x = step; x < W; x += step) {
        ctx.moveTo(x, 0)
        ctx.lineTo(x, H)
      }
    }
    if (horizontal) {
      for (let y = step; y < H; y += step) {
        ctx.moveTo(0, y)
        ctx.lineTo(W, y)
      }
    }
    ctx.stroke()
  }

  // Paints the paper and its pattern over the board, in board px.
  function drawPaper(ctx, bg) {
    const paper = PAPERS[paperOf(bg?.paper)]
    const pattern = patternOf(bg?.pattern)
    ctx.save()
    ctx.fillStyle = paper.color
    ctx.fillRect(0, 0, W, H)
    const tint = paper.dark ? '255, 255, 255' : '32, 52, 84'
    const ink = (alpha) => `rgba(${tint}, ${alpha})`
    ctx.strokeStyle = ctx.fillStyle = ink(0.17)
    ctx.lineWidth = 1.5
    switch (pattern) {
      case 'dots':
        ctx.fillStyle = ink(0.3)
        ctx.beginPath()
        for (let y = 40; y < H; y += 40) {
          for (let x = 40; x < W; x += 40) {
            ctx.moveTo(x + 2.2, y)
            ctx.arc(x, y, 2.2, 0, TAU)
          }
        }
        ctx.fill()
        break
      case 'grid':
        rule(ctx, 40, true, true)
        break
      case 'lines':
        rule(ctx, 40, false, true)
        break
      case 'graph':
        ctx.strokeStyle = ink(0.1)
        ctx.lineWidth = 1
        rule(ctx, 24, true, true)
        ctx.strokeStyle = ink(0.22)
        ctx.lineWidth = 1.5
        rule(ctx, 120, true, true)
        break
      case 'iso': {
        // Uprights 48 px apart, and both slopes of 30 degrees meeting on them.
        const step = 48
        const rise = step * Math.tan(Math.PI / 6)
        const fall = (W / step) * rise
        ctx.beginPath()
        ctx.rect(0, 0, W, H)
        ctx.clip()
        ctx.beginPath()
        for (let x = step; x < W; x += step) {
          ctx.moveTo(x, 0)
          ctx.lineTo(x, H)
        }
        for (let y = -Math.ceil(fall / (rise * 2)) * rise * 2; y < H + fall; y += rise * 2) {
          ctx.moveTo(0, y)
          ctx.lineTo(W, y + fall)
          ctx.moveTo(0, y)
          ctx.lineTo(W, y - fall)
        }
        ctx.stroke()
        break
      }
      case 'cross':
        ctx.strokeStyle = ink(0.3)
        ctx.lineCap = 'round'
        ctx.beginPath()
        for (let y = 60; y < H; y += 60) {
          for (let x = 60; x < W; x += 60) {
            ctx.moveTo(x - 5, y)
            ctx.lineTo(x + 5, y)
            ctx.moveTo(x, y - 5)
            ctx.lineTo(x, y + 5)
          }
        }
        ctx.stroke()
        break
      default:
        break
    }
    ctx.restore()
  }

  // Floods the ink in `image` (board-sized ImageData) from px x, y: every pixel joined to the
  // click that is within tolerance of the one clicked, grown by one px into anything not solid
  // so the fill tucks under antialiased edges. { d } in the fill op's form, { same: true } when
  // the area already is `color`, or { tooDetailed: true } when it does not fit a fill op.
  function flood(image, x, y, color) {
    const data = image.data
    const at = (y * W + x) * 4
    const ta = data[at + 3]
    const tr = (data[at] * ta) / 255
    const tg = (data[at + 1] * ta) / 255
    const tb = (data[at + 2] * ta) / 255
    if (ta === 255 && ((data[at] << 16) | (data[at + 1] << 8) | data[at + 2]) === color) {
      return { same: true }
    }
    const matches = (p) => {
      const i = p * 4
      const a = data[i + 3]
      if (Math.abs(a - ta) > FLOOD_TOLERANCE) return false
      if (a === 0) return true
      const k = a / 255
      return (
        Math.abs(data[i] * k - tr) <= FLOOD_TOLERANCE &&
        Math.abs(data[i + 1] * k - tg) <= FLOOD_TOLERANCE &&
        Math.abs(data[i + 2] * k - tb) <= FLOOD_TOLERANCE
      )
    }

    const mask = new Uint8Array(W * H)
    const stack = [x, y]
    while (stack.length) {
      const sy = stack.pop()
      const sx = stack.pop()
      let p = sy * W + sx
      if (mask[p] || !matches(p)) continue
      let left = sx
      while (left > 0 && !mask[p - 1] && matches(p - 1)) {
        left--
        p--
      }
      let right = left
      const row = sy * W
      for (let q = row + left; right < W && !mask[q] && matches(q); q++, right++) mask[q] = 1
      for (const ny of [sy - 1, sy + 1]) {
        if (ny < 0 || ny >= H) continue
        let open = false
        for (let nx = left, q = ny * W + left; nx < right; nx++, q++) {
          const free = !mask[q] && matches(q)
          if (free && !open) stack.push(nx, ny)
          open = free
        }
      }
    }

    const grown = mask.slice()
    const reach = (p) => {
      if (!mask[p] && data[p * 4 + 3] < 250) grown[p] = 1
    }
    for (let py = 0, p = 0; py < H; py++) {
      for (let px = 0; px < W; px++, p++) {
        if (!mask[p]) continue
        if (px > 0) reach(p - 1)
        if (px < W - 1) reach(p + 1)
        if (py > 0) reach(p - W)
        if (py < H - 1) reach(p + W)
      }
    }

    const d = []
    let first = -1
    let rowsHeld = 0
    for (let py = 0; py < H; py++) {
      const spans = []
      const row = py * W
      for (let px = 0; px < W; px++) {
        if (!grown[row + px]) continue
        const start = px
        while (px < W && grown[row + px]) px++
        spans.push(start, px - start)
      }
      if (!spans.length && first < 0) continue
      if (first < 0) {
        first = py
        d.push(py)
      }
      if (spans.length / 2 > MAX_ROW_SPANS) return { tooDetailed: true }
      d.push(spans.length / 2, ...spans)
      if (spans.length) rowsHeld = d.length
      if (d.length > MAX_FILL_INTS + H) return { tooDetailed: true }
    }
    // Rows after the last one with a span say nothing.
    d.length = rowsHeld
    return d.length > MAX_FILL_INTS ? { tooDetailed: true } : { d }
  }

  // The board as PNG bytes: the paper and pattern, unless `transparent`, under the ink.
  function exportPng(ink, bg, transparent) {
    const canvas = makeCanvas()
    const ctx = canvas.getContext('2d')
    if (!transparent) drawPaper(ctx, bg)
    ctx.drawImage(ink, 0, 0)
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) return reject(new Error('The picture could not be made'))
        blob.arrayBuffer().then((buffer) => resolve(new Uint8Array(buffer)), reject)
      }, 'image/png')
    })
  }

  window.wbEngine = {
    W,
    H,
    Q,
    MAX_POINTS,
    FONT,
    TEXT_WEIGHT,
    LINE_HEIGHT,
    TOOLS,
    SHAPES,
    PAPERS,
    PATTERN_LABELS,
    css,
    toolOf,
    paperOf,
    patternOf,
    makeCanvas,
    geometry,
    boundsOf,
    drawOp,
    paintShape,
    textWidth,
    liveStroke,
    drawPaper,
    flood,
    exportPng
  }
})()
