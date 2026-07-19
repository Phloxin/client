import { useLayoutEffect, useState } from 'react'

// Gap kept between a menu and the window edge.
const MARGIN = 8

// Right-click menus are position:fixed and anchored at the cursor, so one opened
// near the right/bottom edge runs off the window. Measure the menu after layout
// and pull it back in: flip to the other side of the cursor when the menu fits
// there (what native menus do), otherwise clamp to the edge.
//
// Returns the style object to spread onto the menu. The measuring pass renders
// hidden at the raw cursor point; useLayoutEffect resolves the real position
// before the browser paints, so the wrong spot is never visible.
export function useMenuPosition(ref, pos) {
  const [placed, setPlaced] = useState(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!pos || !el) {
      setPlaced(null)
      return
    }
    const { offsetWidth: w, offsetHeight: h } = el
    const fit = (start, size, cursor, limit) => {
      // Flipped position is only usable if it doesn't then overflow the near edge.
      if (start + size <= limit - MARGIN) return start
      const flipped = cursor - size
      return flipped >= MARGIN ? flipped : Math.max(MARGIN, limit - size - MARGIN)
    }
    setPlaced({
      left: fit(pos.x, w, pos.x, window.innerWidth),
      top: fit(pos.y, h, pos.y, window.innerHeight)
    })
  }, [pos, ref])

  return placed ?? { left: pos?.x, top: pos?.y, visibility: 'hidden' }
}
