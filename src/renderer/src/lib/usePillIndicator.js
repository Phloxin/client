import { useCallback, useLayoutEffect, useRef, useState } from 'react'

// Slide timing for the moving pill. Eased so it accelerates out and settles in.
const TRANSITION =
  'transform 0.24s cubic-bezier(0.4, 0, 0.2, 1), width 0.24s cubic-bezier(0.4, 0, 0.2, 1), height 0.2s ease'

// Drives a sliding "pill" indicator across a segmented tab bar. Attach the
// returned ref to the bar, render a single indicator element with the returned
// style, and mark the active button with [data-active="true"]. The indicator
// then tracks the active button's position/size and animates between tabs —
// which plain background swaps can't do, and which works with variable-width
// tabs (unlike a fixed translateX-per-index trick).
//
// Pass the value that identifies the active tab so the pill re-measures when it
// changes; it also re-measures on mount and whenever the bar resizes.
export function usePillIndicator(activeKey) {
  const barRef = useRef(null)
  const roRef = useRef(null)
  const [rect, setRect] = useState(null)
  // Suppressed for the first placement so the pill doesn't slide in from the
  // corner on mount; armed one frame later so real tab changes animate.
  const [armed, setArmed] = useState(false)

  const measure = useCallback(() => {
    const bar = barRef.current
    if (!bar) return
    const active = bar.querySelector('[data-active="true"]')
    if (!active) {
      setRect(null)
      return
    }
    setRect({
      left: active.offsetLeft,
      top: active.offsetTop,
      width: active.offsetWidth,
      height: active.offsetHeight,
    })
  }, [])

  // Callback ref: measure on mount and keep in sync with bar resizes. Cleans up
  // the observer when the bar unmounts (node === null).
  const setBarRef = useCallback(
    (node) => {
      if (roRef.current) {
        roRef.current.disconnect()
        roRef.current = null
      }
      barRef.current = node
      if (!node) return
      measure()
      const ro = new ResizeObserver(() => measure())
      ro.observe(node)
      roRef.current = ro
    },
    [measure]
  )

  // Re-measure when the active tab changes (before paint, so no flicker).
  useLayoutEffect(() => {
    measure()
  }, [activeKey, measure])

  useLayoutEffect(() => {
    if (!rect || armed) return
    const id = requestAnimationFrame(() => setArmed(true))
    return () => cancelAnimationFrame(id)
  }, [rect, armed])

  const indicatorStyle = rect
    ? {
        transform: `translate(${rect.left}px, ${rect.top}px)`,
        width: rect.width,
        height: rect.height,
        opacity: 1,
        transition: armed ? TRANSITION : 'none',
      }
    : { opacity: 0 }

  return { barRef: setBarRef, indicatorStyle }
}
