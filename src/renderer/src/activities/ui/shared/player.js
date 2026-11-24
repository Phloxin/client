// The player layer, for a bundle the shell gives the `player` capability: the shell hosts the
// video under the bundle's frame, and this asks it to place, load and drive it, and passes on
// what it reports.
// Loaded after room.js.
;(() => {
  const noop = () => {}
  const handlers = { ready: noop, status: noop, error: noop, fullscreen: noop }
  // describe ids -> the promise's resolve.
  const describing = new Map()
  let nextId = 1

  const post = (message) => parent.postMessage(message, '*')
  const op = (fields) => post({ type: 'player', ...fields })
  const px = (v) => Math.max(0, Math.round(v))

  addEventListener('message', (event) => {
    if (event.source !== parent) return
    const m = event.data
    if (!m || typeof m !== 'object') return
    if (m.type === 'fullscreen') {
      handlers.fullscreen(!!m.on)
      return
    }
    if (m.type !== 'player') return
    switch (m.event) {
      case 'ready':
        handlers.ready({ volume: m.volume, muted: !!m.muted })
        break
      case 'status':
        handlers.status({
          state: m.state,
          positionMs: m.positionMs,
          durationMs: m.durationMs,
          title: m.title ?? null,
          rate: m.rate
        })
        break
      case 'error':
        handlers.error(m.code)
        break
      case 'described': {
        const resolve = describing.get(m.id)
        if (!resolve) break
        describing.delete(m.id)
        resolve({ title: m.title ?? null, playable: m.playable !== false })
        break
      }
      default:
        break
    }
  })

  const on = (name) => (fn) => {
    handlers[name] = typeof fn === 'function' ? fn : noop
  }

  window.player = {
    onReady: on('ready'),
    onStatus: on('status'),
    onError: on('error'),
    onFullscreen: on('fullscreen'),
    // Where the video sits, in CSS px of this frame's viewport; null hides it.
    place(rect) {
      op({
        op: 'place',
        rect: rect
          ? { x: px(rect.x), y: px(rect.y), width: px(rect.width), height: px(rect.height) }
          : null
      })
    },
    load(videoId, startMs, play) {
      op({ op: 'load', videoId, startMs: px(startMs), play: !!play })
    },
    play: () => op({ op: 'play' }),
    pause: () => op({ op: 'pause' }),
    seek: (positionMs) => op({ op: 'seek', positionMs: px(positionMs) }),
    unload: () => op({ op: 'unload' }),
    // volume 0 to 100.
    setVolume: (volume, muted) =>
      op({ op: 'volume', volume: Math.min(100, Math.max(0, Math.round(volume))), muted: !!muted }),
    // The speed as the server's percentage.
    setRate: (rate) => op({ op: 'rate', rate }),
    // Resolves with { title, playable }.
    describe(videoId) {
      const id = nextId
      nextId = nextId >= 4294967295 ? 1 : nextId + 1
      return new Promise((resolve) => {
        describing.set(id, resolve)
        op({ op: 'describe', id, videoId })
      })
    },
    setFullscreen: (on) => post({ type: 'fullscreen', on: !!on })
  }
})()
