import { useLayoutEffect, useRef, useState } from 'react'

// Equal when entries line up by key, status, and item reference. Lets us skip a
// redundant setState that would otherwise loop on every parent render.
function sameEntries(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].key !== b[i].key || a[i].status !== b[i].status || a[i].item !== b[i].item) {
      return false
    }
  }
  return true
}

// True when the OS prefers reduced motion.
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

// Track a keyed list, tagging newly-arrived entries 'entering' (everything else
// 'present') so they can play an enter animation. Returns ordered
// `{ key, item, status }` in live source order. Removals take effect immediately
// — there's no exit phase, so callers that want something to animate away should
// not rely on this hook to keep it mounted. When disabled it's a pass-through
// that tags everything 'present'.
export function useAnimatedPresence(items, getKey, { enabled = true } = {}) {
  const [rendered, setRendered] = useState(() =>
    items.map((item) => ({ key: getKey(item), item, status: 'present' }))
  )
  const renderedRef = useRef(rendered)

  useLayoutEffect(() => {
    // A key already on screen stays 'present'; a brand-new key is 'entering'.
    // When disabled, skip the entering tag and mirror the live list verbatim.
    const prevKeys = enabled ? new Set(renderedRef.current.map((r) => r.key)) : null
    const next = items.map((item) => {
      const key = getKey(item)
      return { key, item, status: prevKeys && !prevKeys.has(key) ? 'entering' : 'present' }
    })

    if (sameEntries(next, renderedRef.current)) return
    renderedRef.current = next
    setRendered(next)
  }, [items, enabled])

  return rendered
}

// FLIP reorder: slide each `data-flip-key` element in `containerRef` from its
// previous position to its new one (via the Web Animations API, which leaves CSS
// enter/leave keyframes alone). Trigger by passing the order signal in `deps`.
export function useFlip(
  containerRef,
  deps,
  { selector = '[data-flip-key]', enabled = true, duration = 260 } = {}
) {
  const prevRects = useRef(new Map())

  useLayoutEffect(() => {
    const container = containerRef.current
    if (!container) return

    const allowMotion = enabled && !prefersReducedMotion()
    const map = new Map()

    container.querySelectorAll(selector).forEach((node) => {
      const key = node.getAttribute('data-flip-key')
      const rect = node.getBoundingClientRect()
      const old = prevRects.current.get(key)
      map.set(key, rect)

      if (!allowMotion || !old) return
      const dx = old.left - rect.left
      const dy = old.top - rect.top
      if (dx || dy) {
        node.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
          { duration, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' }
        )
      }
    })

    prevRects.current = map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}
