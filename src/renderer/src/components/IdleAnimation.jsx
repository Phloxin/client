import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/animation'
import './IdleAnimation.css'

// ASCII pylon tower broadcasting into the disconnected chat area. A lattice
// tower stands on a "Pylon" wordmark above the caption and its tip sends out
// radio waves in bursts of three rings that expand across the whole area and
// fade with distance. The grid is sized to the container (measured cell ×
// ResizeObserver); waves dim as they pass behind the caption (wordmark
// included) and never cross the tower's silhouette. The <pre> is updated
// imperatively so there's no per-tick React render.
const TICK_MS = 70
const GAP = 2 // cells around the caption over which waves fade back in
const HOLE_DIM = 0.6 // wave opacity factor behind the caption itself

// Tower art: antenna + beacon on a zig-zag lattice mast that flares into a
// braced base. The 'o' on row 0 is the emitter; every row is centered on it.
const TOWER = [
  '          o',
  '          |',
  '          |',
  '         _|_',
  '         |\\|',
  '         |/|',
  '         |\\|',
  '         |/|',
  '         |\\|',
  '         |/|',
  '        /___\\',
  '       /\\   /\\',
  '      /  \\ /  \\',
  '     /    X    \\',
  '    /    / \\    \\',
  '   /    /   \\    \\',
  '  /____/_____\\____\\'
]
const TOWER_MID = TOWER[0].indexOf('o')

// Wordmark under the tower, rendered at the top of the caption in a smaller
// font than the wave grid, so it sits inside the caption's dimmed patch.
const LOGO = [
  '██████╗ ██╗   ██╗██╗      ██████╗ ███╗   ██╗',
  '██╔══██╗╚██╗ ██╔╝██║     ██╔═══██╗████╗  ██║',
  '██████╔╝ ╚████╔╝ ██║     ██║   ██║██╔██╗ ██║',
  '██╔═══╝   ╚██╔╝  ██║     ██║   ██║██║╚██╗██║',
  '██║        ██║   ███████╗╚██████╔╝██║ ╚████║',
  '╚═╝        ╚═╝   ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝'
].join('\n')

const RINGS_PER_BURST = 3
const RING_GAP_MS = 420 // between rings within a burst
const BURST_PERIOD_MS = 3200 // between the first rings of consecutive bursts
const SPEED = 0.2 // px per ms a ring's radius grows
const FLASH_MS = 180 // tip shows '*' this long after each ring leaves

// Ring glyph by the cell's angle around the emitter (pixel space, y down),
// eight 45° sectors starting at "right": the char follows the ring's tangent.
const RING_CHARS = [')', '/', '-', '\\', '(', '/', '-', '\\']

function ringChar(dx, dy) {
  const a = Math.atan2(dy, dx) // -π..π, 0 = right, π/2 = down
  return RING_CHARS[Math.round(a / (Math.PI / 4)) & 7]
}

const lit = (ch, op) => `<span style="opacity:${op}">${ch}</span>`

// Wave factory. Returns step(t) → innerHTML for the <pre>, t in ms since start.
// `hole` is the caption's cell rect (wordmark included); the tower stands on
// top of it, centered.
function makeWaves(cols, rows, charW, lineH, hole) {
  const baseRow = hole.y0 - 1
  const topRow = baseRow - (TOWER.length - 1)
  const left = Math.floor((hole.x0 + hole.x1) / 2) - TOWER_MID
  const tipX = left + TOWER_MID

  // Tower cells by index, spaces inside the silhouette included so waves don't
  // show through the lattice.
  const tower = new Map()
  TOWER.forEach((line, i) => {
    const y = topRow + i
    if (y < 0 || y >= rows) return
    for (let j = line.search(/\S/); j < line.length; j++) {
      const x = left + j
      if (x >= 0 && x < cols) tower.set(y * cols + x, line[j])
    }
  })

  // Emitter center in px; the farthest corner sets how far a ring travels.
  const ex = (tipX + 0.5) * charW
  const ey = (topRow + 0.5) * lineH
  const W = cols * charW
  const H = rows * lineH
  const rMax = Math.max(
    Math.hypot(ex, ey),
    Math.hypot(W - ex, ey),
    Math.hypot(ex, H - ey),
    Math.hypot(W - ex, H - ey)
  )
  const lifeMs = rMax / SPEED + RING_GAP_MS * RINGS_PER_BURST

  // Wave opacity factor at a cell: HOLE_DIM behind the caption, ramping back
  // to 1 across the GAP band so the dimmed patch has no hard edge.
  const dim = (x, y) => {
    if (x < hole.x0 || x >= hole.x1 || y < hole.y0 || y >= hole.y1) return 1
    const out = Math.max(
      hole.x0 + GAP - x,
      x - (hole.x1 - 1 - GAP),
      hole.y0 + GAP - y,
      y - (hole.y1 - 1 - GAP),
      0
    )
    return HOLE_DIM + ((1 - HOLE_DIM) * out) / (GAP + 1)
  }

  // Radii of every ring alive at time t.
  function radii(t) {
    const out = []
    for (let k = Math.floor(t / BURST_PERIOD_MS); k >= 0; k--) {
      const start = k * BURST_PERIOD_MS
      if (t - start > lifeMs) break
      for (let i = 0; i < RINGS_PER_BURST; i++) {
        const r = (t - start - i * RING_GAP_MS) * SPEED
        if (r >= 0 && r < rMax) out.push(r)
      }
    }
    return out
  }

  // Whether a ring has just left the tip, for the emitter flash.
  function flashing(t) {
    const into = t % BURST_PERIOD_MS
    return into < RINGS_PER_BURST * RING_GAP_MS && into % RING_GAP_MS < FLASH_MS
  }

  return (t) => {
    const rs = radii(t)
    let html = ''
    for (let y = 0; y < rows; y++) {
      const py = (y + 0.5) * lineH - ey
      for (let x = 0; x < cols; x++) {
        const tc = tower.get(y * cols + x)
        if (tc !== undefined) {
          if (y === topRow && x === tipX) html += flashing(t) ? lit('*', 1) : lit('o', 0.85)
          else html += tc === ' ' ? ' ' : lit(tc, 0.85)
          continue
        }
        if (rs.length === 0) {
          html += ' '
          continue
        }
        const px = (x + 0.5) * charW - ex
        const d = Math.hypot(px, py)
        // Half the cell's extent along the radial direction, so rings stay one
        // cell thick whether they cross columns (narrow) or rows (tall).
        const half = d > 0 ? (0.5 * (Math.abs(px) * charW + Math.abs(py) * lineH)) / d : charW
        const r = rs.find((r) => Math.abs(d - r) <= half)
        const op = r === undefined ? 0 : Math.pow(1 - r / rMax, 1.3) * 0.9 * dim(x, y)
        html += op < 0.04 ? ' ' : lit(ringChar(px, py), op.toFixed(2))
      }
      if (y < rows - 1) html += '\n'
    }
    return html
  }
}

export default function IdleAnimation({ connecting = false, hasBookmarks = false }) {
  // Cycle 0..3 trailing dots while connecting for a simple "…" animation.
  const [dots, setDots] = useState(0)
  useEffect(() => {
    if (!connecting) return
    const id = setInterval(() => setDots((d) => (d + 1) % 4), 400)
    return () => clearInterval(id)
  }, [connecting])

  const rootRef = useRef(null)
  const preRef = useRef(null)
  const capRef = useRef(null)

  useEffect(() => {
    const root = rootRef.current
    const pre = preRef.current
    if (!root || !pre) return

    // Measure one monospace cell in the pre's font.
    const probe = document.createElement('span')
    probe.textContent = '0'.repeat(20)
    probe.style.visibility = 'hidden'
    pre.appendChild(probe)
    const box = probe.getBoundingClientRect()
    const charW = box.width / 20
    const lineH = box.height
    pre.removeChild(probe)

    // Reduced motion: one still frame with a full burst in flight.
    const reduced = prefersReducedMotion()
    const t0 = performance.now()
    const now = () => (reduced ? RING_GAP_MS * RINGS_PER_BURST + 600 : performance.now() - t0)

    let step = () => ''
    const build = () => {
      // The ResizeObserver can fire once more as the container collapses during
      // unmount, after React has nulled capRef — bail rather than deref null.
      if (!capRef.current) return
      const r = root.getBoundingClientRect()
      const cols = Math.max(8, Math.floor(r.width / charW))
      const rows = Math.max(6, Math.floor(r.height / lineH))
      // Caption rect → grid cells, expanded by GAP, clamped to the grid.
      const cap = capRef.current.getBoundingClientRect()
      const hole = {
        x0: Math.max(0, Math.floor((cap.left - r.left) / charW) - GAP),
        x1: Math.min(cols, Math.ceil((cap.right - r.left) / charW) + GAP),
        y0: Math.max(0, Math.floor((cap.top - r.top) / lineH) - GAP),
        y1: Math.min(rows, Math.ceil((cap.bottom - r.top) / lineH) + GAP)
      }
      step = makeWaves(cols, rows, charW, lineH, hole)
      pre.innerHTML = step(now())
    }

    build()
    const ro = new ResizeObserver(build)
    ro.observe(root)
    if (reduced) return () => ro.disconnect()

    const id = setInterval(() => {
      pre.innerHTML = step(now())
    }, TICK_MS)
    return () => {
      clearInterval(id)
      ro.disconnect()
    }
  }, [])

  return (
    <div className="idle-animation" ref={rootRef}>
      <pre className="idle-waves" aria-hidden="true" ref={preRef} />
      <div className="idle-caption" ref={capRef}>
        <pre className="idle-logo" aria-hidden="true">
          {LOGO}
        </pre>
        {connecting ? (
          <>
            <p className="disconnected-title">Connecting{'.'.repeat(dots)}</p>
            <p className="disconnected-subtitle">Reaching the server.</p>
          </>
        ) : (
          <>
            <p className="disconnected-title">No Server Currently Connected</p>
            <p className="disconnected-subtitle">
              {hasBookmarks
                ? 'Pick a server from your bookmarks to connect.'
                : 'Add a server to your bookmarks to connect.'}
            </p>
          </>
        )}
      </div>
    </div>
  )
}
