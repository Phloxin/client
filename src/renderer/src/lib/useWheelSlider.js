import { useCallback, useEffect, useRef } from 'react'

// Scroll wheel over a volume slider nudges the slider instead of scrolling
// whatever list it happens to sit in (the sidebar, the context menu, the video
// grid). React's onWheel is attached passively at the root, so preventDefault
// there is ignored — the listener has to be native and non-passive, hence the
// ref + useEffect rather than a plain JSX prop.
//
// Returns a callback ref to attach to an <input type="range">; the input's own
// min/max/value attributes drive the math, so the hook only needs the change
// handler. That handler is called with a `{ target: { value } }` shape so an
// existing range onChange works unmodified. A callback ref rather than
// useRef+useEffect so sliders that mount late (a context menu opening) still
// get wired up.
export function useWheelSlider(onChange, step = 5) {
  const latest = useRef(onChange)
  const detach = useRef(null)
  useEffect(() => {
    latest.current = onChange
  })

  return useCallback(
    (el) => {
      detach.current?.()
      detach.current = null
      if (!el) return
      const onWheel = (e) => {
        e.preventDefault()
        const current = Number(el.value)
        const next = nextWheelValue(current, e.deltaY, step, Number(el.min), Number(el.max))
        if (next !== current) latest.current?.({ target: { value: next } })
      }
      el.addEventListener('wheel', onWheel, { passive: false })
      detach.current = () => el.removeEventListener('wheel', onWheel)
    },
    [step]
  )
}

// Wheel up (negative deltaY) raises the value. Snapped to the step grid so a
// slider left on an odd value from dragging lands back on round numbers.
export function nextWheelValue(current, deltaY, step, min, max) {
  if (!deltaY) return current
  const dir = deltaY < 0 ? 1 : -1
  const snapped = dir > 0 ? Math.floor(current / step) : Math.ceil(current / step)
  return Math.min(max, Math.max(min, (snapped + dir) * step))
}
