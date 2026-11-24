// The whiteboard's stamps: one-colour vector marks drawn for this bundle on a 100 unit box, as
// SVG path data. `fill` paths are filled (even-odd, so a path may carry holes), `stroke` paths are
// stroked `sw` units wide with round ends. The same data draws a stamp on a canvas and in the
// picker.
;(() => {
  const NS = 'http://www.w3.org/2000/svg'
  const BOX = 100

  const circle = (cx, cy, r) =>
    `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0Z`
  const round = (v) => Math.round(v * 100) / 100
  // A closed polygon whose corners alternate between two radii around the box's centre.
  function burst(points, outer, inner, cy = 50) {
    const out = []
    for (let i = 0; i < points * 2; i++) {
      const r = i % 2 ? inner : outer
      const a = (Math.PI * i) / points - Math.PI / 2
      out.push(`${round(50 + r * Math.cos(a))} ${round(cy + r * Math.sin(a))}`)
    }
    return `M${out.join('L')}Z`
  }
  const around = (count, radius, r) =>
    Array.from({ length: count }, (_, i) => {
      const a = (2 * Math.PI * i) / count - Math.PI / 2
      return circle(round(50 + radius * Math.cos(a)), round(50 + radius * Math.sin(a)), r)
    })
  const rays = (count, from, to) =>
    Array.from({ length: count }, (_, i) => {
      const a = (2 * Math.PI * i) / count
      const c = Math.cos(a)
      const s = Math.sin(a)
      return `M${round(50 + from * c)} ${round(50 + from * s)}L${round(50 + to * c)} ${round(50 + to * s)}`
    })

  // `soft` rounds a filled stamp's corners with a stroke of that width in the same colour.
  const STAMPS = {
    star: { label: 'Star', fill: [burst(5, 44, 19, 53)], soft: 6 },
    heart: {
      label: 'Heart',
      fill: [
        'M50 88C24 68 8 52 8 34C8 19 19 9 31 9C40 9 47 14 50 22C53 14 60 9 69 9C81 9 92 19 92 34C92 52 76 68 50 88Z'
      ],
      soft: 4
    },
    check: { label: 'Check', stroke: ['M16 54L39 77L84 24'], sw: 15 },
    cross: { label: 'Cross', stroke: ['M23 23L77 77', 'M77 23L23 77'], sw: 15 },
    smile: {
      label: 'Smile',
      fill: [circle(35, 40, 6), circle(65, 40, 6)],
      stroke: [circle(50, 50, 40), 'M31 58Q50 78 69 58'],
      sw: 8
    },
    bolt: { label: 'Bolt', fill: ['M59 6L19 56H45L39 94L81 42H55Z'], soft: 5 },
    sun: { label: 'Sun', fill: [circle(50, 50, 19)], stroke: rays(8, 30, 43), sw: 8 },
    moon: { label: 'Moon', fill: ['M63 10A42 42 0 1 0 90 62A34 34 0 0 1 63 10Z'], soft: 4 },
    cloud: {
      label: 'Cloud',
      fill: ['M27 78A19 19 0 0 1 24 40A25 25 0 0 1 71 33A22.5 22.5 0 0 1 75 78Z'],
      soft: 4
    },
    flower: { label: 'Flower', fill: [...around(6, 28, 13), circle(50, 50, 10)] },
    crown: { label: 'Crown', fill: ['M14 78L9 30L31 47L50 19L69 47L91 30L86 78Z'], soft: 6 },
    burst: { label: 'Burst', fill: [burst(12, 46, 33)], soft: 3 },
    arrow: { label: 'Arrow', fill: ['M10 39H54V19L92 50L54 81V61H10Z'], soft: 5 },
    speech: {
      label: 'Speech bubble',
      stroke: [
        'M22 16H78A12 12 0 0 1 90 28V56A12 12 0 0 1 78 68H50L31 86V68H22A12 12 0 0 1 10 56V28A12 12 0 0 1 22 16Z'
      ],
      sw: 8
    },
    pin: {
      label: 'Pin',
      fill: [`M50 93C50 93 20 60 20 38A30 30 0 1 1 80 38C80 60 50 93 50 93Z${circle(50, 38, 11)}`],
      soft: 3
    },
    note: {
      label: 'Note',
      fill: [circle(30, 76, 13), circle(72, 66, 13)],
      stroke: ['M39 76V24L81 14V66', 'M39 36L81 26'],
      sw: 8
    },
    question: {
      label: 'Question',
      fill: [circle(50, 84, 8)],
      stroke: ['M32 34C32 12 68 12 68 34C68 48 50 48 50 64'],
      sw: 13
    },
    bang: { label: 'Exclamation', fill: [circle(50, 84, 8)], stroke: ['M50 14V58'], sw: 15 }
  }

  const paths = new Map()
  const path2d = (d) => {
    if (!paths.has(d)) paths.set(d, new Path2D(d))
    return paths.get(d)
  }

  // Draws stamp `ident` centred on x, y, `size` px across, turned `rot` degrees. False when the
  // ident is not one of this client's stamps.
  function draw(ctx, ident, x, y, size, rot, color) {
    if (!Object.hasOwn(STAMPS, ident)) return false
    const stamp = STAMPS[ident]
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate((rot * Math.PI) / 180)
    ctx.scale(size / BOX, size / BOX)
    ctx.translate(-BOX / 2, -BOX / 2)
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    for (const d of stamp.fill ?? []) {
      ctx.fill(path2d(d), 'evenodd')
      if (stamp.soft) {
        ctx.lineWidth = stamp.soft
        ctx.stroke(path2d(d))
      }
    }
    ctx.lineWidth = stamp.sw ?? 0
    for (const d of stamp.stroke ?? []) ctx.stroke(path2d(d))
    ctx.restore()
    return true
  }

  // The stamp as an <svg> in currentColor, for the picker.
  function svg(ident) {
    const stamp = STAMPS[ident]
    const el = document.createElementNS(NS, 'svg')
    el.setAttribute('viewBox', `-4 -4 ${BOX + 8} ${BOX + 8}`)
    el.setAttribute('aria-hidden', 'true')
    el.classList.add('stamp-art')
    const add = (d, attrs) => {
      const p = document.createElementNS(NS, 'path')
      p.setAttribute('d', d)
      for (const [k, v] of Object.entries(attrs)) p.setAttribute(k, v)
      el.appendChild(p)
    }
    const line = { 'stroke-linecap': 'round', 'stroke-linejoin': 'round', stroke: 'currentColor' }
    for (const d of stamp?.fill ?? []) {
      add(d, {
        fill: 'currentColor',
        'fill-rule': 'evenodd',
        ...(stamp.soft ? { ...line, 'stroke-width': stamp.soft } : {})
      })
    }
    for (const d of stamp?.stroke ?? []) add(d, { fill: 'none', ...line, 'stroke-width': stamp.sw })
    return el
  }

  window.wbStamps = {
    list: Object.keys(STAMPS),
    label: (ident) => STAMPS[ident]?.label ?? ident,
    has: (ident) => Object.hasOwn(STAMPS, ident),
    draw,
    svg
  }
})()
