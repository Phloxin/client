import { useEffect, useRef, useState } from 'react'
import { prefersReducedMotion } from '../lib/animation'
import './IdleAnimation.css'

// Doom-style fire that fills the disconnected chat area, echoing Omarchy's
// terminal screensavers. The grid is sized to the container (measured cell ×
// ResizeObserver) and a centered hole is carved around the caption so flames
// frame the text without ever touching it. The <pre> is updated imperatively
// so there's no per-tick React render.
const TICK_MS = 110
const SHADE = ' .:-=+*#%@' // dark → light ramp
const GAP = 2 // empty cells kept around the caption

// Brightness 0..1 for a SHADE char, so paint() can give the flames depth.
function levelOf(ch) {
  return SHADE.indexOf(ch) / (SHADE.length - 1)
}

// Wrap each lit cell in a span whose opacity tracks its brightness; blanks and
// newlines pass through. Set via innerHTML.
function paint(text) {
  let html = ''
  for (const ch of text) {
    if (ch === '\n' || ch === ' ') html += ch
    else html += `<span style="opacity:${levelOf(ch).toFixed(2)}">${ch}</span>`
  }
  return html
}

// Fire factory: seed the bottom row hot, propagate upward with cooling, and
// zero out the caption hole each frame so flames never cross it.
function makeFire(cols, rows, holeRef) {
  const heat = Array.from({ length: rows }, () => Array(cols).fill(0))
  return () => {
    for (let x = 0; x < cols; x++) heat[rows - 1][x] = Math.random()
    for (let y = 0; y < rows - 1; y++) {
      const b = heat[y + 1]
      const row = heat[y]
      for (let x = 0; x < cols; x++) {
        const v = (b[x] + b[(x - 1 + cols) % cols] + b[(x + 1) % cols] + row[x]) / 4 - 0.02
        row[x] = v < 0 ? 0 : v
      }
    }
    const hole = holeRef.current
    let s = ''
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        if (hole && x >= hole.x0 && x < hole.x1 && y >= hole.y0 && y < hole.y1) {
          heat[y][x] = 0
          s += ' '
        } else {
          s += SHADE[Math.floor(heat[y][x] * (SHADE.length - 1))]
        }
      }
      if (y < rows - 1) s += '\n'
    }
    return s
  }
}

export default function IdleAnimation({ connecting = false }) {
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
  const holeRef = useRef(null)

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

    let step = () => ''
    const build = () => {
      const r = root.getBoundingClientRect()
      const cols = Math.max(8, Math.floor(r.width / charW))
      const rows = Math.max(6, Math.floor(r.height / lineH))
      // Caption rect → grid cells, expanded by GAP, clamped to the grid.
      const cap = capRef.current.getBoundingClientRect()
      holeRef.current = {
        x0: Math.max(0, Math.floor((cap.left - r.left) / charW) - GAP),
        x1: Math.min(cols, Math.ceil((cap.right - r.left) / charW) + GAP),
        y0: Math.max(0, Math.floor((cap.top - r.top) / lineH) - GAP),
        y1: Math.min(rows, Math.ceil((cap.bottom - r.top) / lineH) + GAP)
      }
      step = makeFire(cols, rows, holeRef)
      pre.innerHTML = paint(step())
    }

    build()
    // Reduced motion: leave the static first frame, don't animate.
    if (prefersReducedMotion()) return

    const ro = new ResizeObserver(build)
    ro.observe(root)
    const id = setInterval(() => {
      pre.innerHTML = paint(step())
    }, TICK_MS)
    return () => {
      clearInterval(id)
      ro.disconnect()
    }
  }, [])

  return (
    <div className="idle-animation" ref={rootRef}>
      <pre className="idle-fire" aria-hidden="true" ref={preRef} />
      <div className="idle-caption" ref={capRef}>
        {connecting ? (
          <>
            <p className="disconnected-title">Connecting{'.'.repeat(dots)}</p>
            <p className="disconnected-subtitle">Reaching the server.</p>
          </>
        ) : (
          <>
            <p className="disconnected-title">No Server Connected</p>
            <p className="disconnected-subtitle">
              Pick a server from the <strong>Connect</strong> menu to get started.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
