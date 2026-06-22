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

// Track a keyed list so removed entries linger (status 'leaving') long enough to
// animate out, and new entries are tagged 'entering'. Returns ordered
// `{ key, item, status }`. When disabled it's a pass-through with instant removal.
export function useAnimatedPresence(items, getKey, { duration = 240, enabled = true } = {}) {
  const [rendered, setRendered] = useState(() =>
    items.map((item) => ({ key: getKey(item), item, status: 'present' }))
  )
  const renderedRef = useRef(rendered)
  const timersRef = useRef(new Map())

  useLayoutEffect(() => {
    // Disabled: drop any pending exit timers and mirror the live list verbatim.
    if (!enabled) {
      for (const t of timersRef.current.values()) clearTimeout(t)
      timersRef.current.clear()
      const next = items.map((item) => ({ key: getKey(item), item, status: 'present' }))
      if (sameEntries(next, renderedRef.current)) return
      renderedRef.current = next
      setRendered(next)
      return
    }

    const prev = renderedRef.current
    const prevMap = new Map(prev.map((r) => [r.key, r]))
    const nextKeys = new Set(items.map(getKey))

    // A key that reappeared cancels its scheduled removal.
    for (const [key, t] of timersRef.current) {
      if (nextKeys.has(key)) {
        clearTimeout(t)
        timersRef.current.delete(key)
      }
    }

    // Live items in source order. Anything not previously 'present' is entering.
    const result = items.map((item) => {
      const key = getKey(item)
      const existing = prevMap.get(key)
      return {
        key,
        item,
        status: existing && existing.status !== 'leaving' ? 'present' : 'entering'
      }
    })

    // Re-insert departed entries as 'leaving', anchored after their old neighbour.
    prev.forEach((r, idx) => {
      if (nextKeys.has(r.key)) return
      let insertAt = result.length
      for (let j = idx - 1; j >= 0; j--) {
        const at = result.findIndex((x) => x.key === prev[j].key)
        if (at !== -1) {
          insertAt = at + 1
          break
        }
      }
      result.splice(insertAt, 0, { key: r.key, item: r.item, status: 'leaving' })

      if (!timersRef.current.has(r.key)) {
        const timer = setTimeout(() => {
          timersRef.current.delete(r.key)
          renderedRef.current = renderedRef.current.filter((x) => x.key !== r.key)
          setRendered(renderedRef.current)
        }, duration)
        timersRef.current.set(r.key, timer)
      }
    })

    if (sameEntries(result, renderedRef.current)) return
    renderedRef.current = result
    setRendered(result)
  }, [items, enabled])

  useLayoutEffect(
    () => () => {
      for (const t of timersRef.current.values()) clearTimeout(t)
      timersRef.current.clear()
    },
    []
  )

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
