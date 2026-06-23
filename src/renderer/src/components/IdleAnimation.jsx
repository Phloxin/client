import { useEffect, useRef } from 'react'
import { prefersReducedMotion } from '../lib/animation'
import './IdleAnimation.css'

// A tiny bouncing-ball-in-a-box to fill the disconnected screen. Deliberately
// simple: a ball with ±1 velocity that reflects off the walls, redrawn on a
// timer. The <pre> is updated imperatively so there's no per-tick React render.
const W = 42 // interior width (columns)
const H = 12 // interior height (rows)
const TICK_MS = 90

// Draw the bordered box with the ball at interior cell (bx, by).
function frame(bx, by) {
  const edge = '+' + '-'.repeat(W) + '+'
  let s = edge + '\n'
  for (let y = 0; y < H; y++) {
    let row = '|'
    for (let x = 0; x < W; x++) row += x === bx && y === by ? 'O' : ' '
    s += row + '|\n'
  }
  return s + edge
}

export default function IdleAnimation() {
  const preRef = useRef(null)

  useEffect(() => {
    const pre = preRef.current
    if (!pre) return

    let bx = 4
    let by = 3
    let dx = 1
    let dy = 1
    pre.textContent = frame(bx, by)

    // Reduced motion: leave the single static frame, don't animate.
    if (prefersReducedMotion()) return

    const id = setInterval(() => {
      if (bx + dx < 0 || bx + dx >= W) dx = -dx
      if (by + dy < 0 || by + dy >= H) dy = -dy
      bx += dx
      by += dy
      pre.textContent = frame(bx, by)
    }, TICK_MS)
    return () => clearInterval(id)
  }, [])

  return <pre className="idle-animation" aria-hidden="true" ref={preRef} />
}
