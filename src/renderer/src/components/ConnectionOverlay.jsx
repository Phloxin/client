import { useState, useEffect } from 'react'
import './ConnectionOverlay.css'

// A radar-style "searching for signal" animation rendered as monospace ASCII:
// concentric rings pulse outward from a central node, two at a time so the
// sweep feels continuous. Generated per-frame so the grid always stays aligned.
const ART_W = 31
const ART_H = 11
const RING_PERIOD = 9 // ticks for a ring to travel from center to edge

function ReconnectAnimation() {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 130)
    return () => clearInterval(id)
  }, [])

  const cx = (ART_W - 1) / 2
  const cy = (ART_H - 1) / 2
  // Two expanding rings, offset by half a period for a steady pulse.
  const r1 = frame % RING_PERIOD
  const r2 = (frame + RING_PERIOD / 2) % RING_PERIOD

  const rows = []
  for (let y = 0; y < ART_H; y++) {
    let row = ''
    for (let x = 0; x < ART_W; x++) {
      if (x === cx && y === cy) {
        row += '◉'
        continue
      }
      // Characters are ~twice as tall as wide; squash x so rings read round.
      const dx = (x - cx) / 2
      const dy = y - cy
      const dist = Math.sqrt(dx * dx + dy * dy)
      const onRing = Math.abs(dist - r1) < 0.42 || Math.abs(dist - r2) < 0.42
      row += onRing && dist > 0.6 ? '·' : ' '
    }
    rows.push(row)
  }

  // Single-line child so JSX can't inject whitespace nodes that would offset the
  // grid (the <pre> preserves all whitespace).
  return (
    <pre className="connection-overlay-art" aria-hidden="true">
      {rows.join('\n')}
    </pre>
  )
}

// Full-app overlay shown while the events socket is down and retrying. Opaque
// (var(--color-background)) so it fully hides the stale app behind it.
function ConnectionOverlay({ onAbort }) {
  return (
    <div className="connection-overlay" role="alertdialog" aria-live="assertive">
      <div className="connection-overlay-inner">
        <h1 className="connection-overlay-title">Connection Dropped</h1>
        <p className="connection-overlay-subtitle">Attempting to reconnect…</p>
        <ReconnectAnimation />
        <button type="button" className="connection-overlay-abort" onClick={onAbort}>
          Abort
        </button>
      </div>
    </div>
  )
}

export default ConnectionOverlay
