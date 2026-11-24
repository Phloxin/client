import { useEffect, useState } from 'react'
import { shouldPauseSelfPreview } from './selfPreviewPlayback'

// This window's focus and visibility, as the self preview's pause reads them:
// { windowFocused, documentVisible }.
export function readPreviewWindow() {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return { windowFocused: true, documentVisible: true }
  }
  const documentVisible =
    document.visibilityState == null
      ? document.hidden !== true
      : document.visibilityState === 'visible'
  const windowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return { windowFocused, documentVisible }
}

const sameWindow = (a, b) =>
  a.windowFocused === b.windowFocused && a.documentVisible === b.documentVisible

// readPreviewWindow(), kept current on focus, blur and visibility changes.
export function usePreviewWindow() {
  const [state, setState] = useState(readPreviewWindow)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
    const update = () => {
      const next = readPreviewWindow()
      setState((prev) => (sameWindow(prev, next) ? prev : next))
    }
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return state
}

// Whether this window's self preview is paused (it lost focus or visibility).
export function useSelfPreviewPaused() {
  return shouldPauseSelfPreview(usePreviewWindow())
}
