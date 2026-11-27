import { useEffect, useState, useSyncExternalStore } from 'react'

// The stream view's "Debug Information" toggle (the stream right-click menu)
// and the stats poll behind its overlay.
//
// The toggle is one localStorage flag rather than an appearance setting so the
// main window and the pop-out agree on it live: a change in either reaches the
// other through the `storage` event, and this window's own subscribers hear it
// directly (the event never fires in the window that wrote).

const STORAGE_KEY = 'streamDebugInfo'
const listeners = new Set()

function readFlag() {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1'
  } catch {
    return false
  }
}

function subscribeFlag(listener) {
  listeners.add(listener)
  const onStorage = (e) => {
    if (e.key === STORAGE_KEY || e.key === null) listener()
  }
  window.addEventListener('storage', onStorage)
  return () => {
    listeners.delete(listener)
    window.removeEventListener('storage', onStorage)
  }
}

export function setStreamDebugInfo(on) {
  try {
    if (on) localStorage.setItem(STORAGE_KEY, '1')
    else localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Storage blocked: the toggle just doesn't stick.
  }
  for (const listener of listeners) listener()
}

export function useStreamDebugInfoEnabled() {
  return useSyncExternalStore(subscribeFlag, readFlag, () => false)
}

// The latest video rows by producer id, held outside React state so a tick
// re-renders only the overlays (each subscribes to its own row), never the
// whole stream view.
function createSampleStore() {
  let rows = new Map()
  const subs = new Set()
  return {
    set(next) {
      rows = next
      for (const sub of subs) sub()
    },
    get: (producerId) => rows.get(producerId) ?? null,
    subscribe(sub) {
      subs.add(sub)
      return () => subs.delete(sub)
    }
  }
}

// Polls per-stream stats once a second while `enabled`, with `start` (the
// soup's startStreamDebugStats, or the opener's when this is the pop-out, which
// has no media of its own). Returns a store for useStreamDebugRow. The poll also
// stops on pagehide: a pop-out closed with its window may never unmount, and the
// opener's interval would otherwise keep calling into it.
export function useStreamDebugPoll(enabled, start) {
  const [store] = useState(createSampleStore)
  useEffect(() => {
    if (!enabled || typeof start !== 'function') return undefined
    let stop = start(({ streams }) => {
      const next = new Map()
      for (const row of streams ?? []) {
        if (row.kind === 'video' && row.producerId != null) next.set(row.producerId, row)
      }
      store.set(next)
    }, 1000)
    const end = () => {
      stop?.()
      stop = null
    }
    window.addEventListener('pagehide', end)
    return () => {
      window.removeEventListener('pagehide', end)
      end()
      store.set(new Map())
    }
  }, [enabled, start, store])
  return store
}

export function useStreamDebugRow(store, producerId) {
  return useSyncExternalStore(store.subscribe, () => store.get(producerId))
}
