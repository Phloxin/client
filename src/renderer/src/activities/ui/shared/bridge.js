// The bundle's side of the activity bridge: one object, `bridge`, for the bundle's main.js. The
// shell posts init, state, volatile, clients, ok, rejected, theme, closed, connection and export;
// this decodes state and volatile payloads (JSON bytes), applies the theme, and keeps each action's
// promise until its ok has come and state at least that new has been seen, or until it is
// rejected, and each export's until the shell answers it. A sound it asks for gets no answer.
;(() => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  const pending = new Map()
  const exporting = new Map()
  let nextId = 1
  let nextExportId = 1
  let seenGeneration = -1
  let busy = false

  const post = (message) => parent.postMessage(message, '*')
  const noop = () => {}
  const applyTheme = (vars) => {
    const root = document.documentElement
    for (const [name, value] of Object.entries(vars || {})) root.style.setProperty(name, value)
    root.dataset.themed = ''
  }
  const handlers = {
    init: noop,
    state: noop,
    volatile: noop,
    clients: noop,
    theme: applyTheme,
    closed: noop,
    connection: noop
  }

  // Actions whose ok has come, now that state at `seenGeneration` is held.
  const settle = () => {
    for (const [id, p] of pending) {
      if (p.okGeneration != null && seenGeneration >= p.okGeneration) {
        pending.delete(id)
        p.resolve()
      }
    }
  }

  addEventListener('message', (event) => {
    if (event.source !== parent) return
    const m = event.data
    if (!m || typeof m !== 'object') return
    switch (m.type) {
      case 'init':
        handlers.init({
          you: m.you,
          creator: m.creator,
          clients: m.clients || [],
          clockOffsetMs: m.clockOffsetMs || 0
        })
        break
      case 'state': {
        seenGeneration = Math.max(seenGeneration, m.generation)
        let data
        try {
          data = JSON.parse(decoder.decode(m.data))
        } catch (err) {
          console.warn('[bridge] state payload is not JSON', err)
          settle()
          break
        }
        handlers.state({ kind: m.kind, generation: m.generation, data })
        settle()
        break
      }
      case 'volatile': {
        let data
        try {
          data = JSON.parse(decoder.decode(m.data))
        } catch {
          // A datagram that is not JSON is dropped.
          break
        }
        handlers.volatile(data)
        break
      }
      case 'clients':
        handlers.clients(m.clients || [])
        break
      case 'ok': {
        const p = pending.get(m.id)
        if (p) p.okGeneration = m.generation
        settle()
        break
      }
      case 'rejected': {
        const p = pending.get(m.id)
        if (!p) break
        pending.delete(m.id)
        p.reject(m.reason)
        break
      }
      case 'theme':
        handlers.theme(m.vars || {})
        break
      case 'closed':
        handlers.closed(m.reason)
        break
      case 'connection':
        handlers.connection(m.state)
        break
      case 'export': {
        const p = exporting.get(m.id)
        if (!p) break
        exporting.delete(m.id)
        if (m.ok === true) p.resolve()
        else p.reject(typeof m.error === 'string' ? m.error : 'export_failed')
        break
      }
      default:
        break
    }
  })

  const on = (name) => (fn) => {
    handlers[name] = typeof fn === 'function' ? fn : noop
  }

  window.bridge = {
    onInit: on('init'),
    onState: on('state'),
    // fn(data) for each datagram, its JSON decoded.
    onVolatile: on('volatile'),
    onClients: on('clients'),
    onTheme: on('theme'),
    onClosed: on('closed'),
    onConnection: on('connection'),
    applyTheme,
    // Sends an action. Resolves once it is applied in state this bundle holds, rejects with the
    // reason when it is refused.
    action(data) {
      const id = nextId
      nextId = nextId >= 4294967295 ? 1 : nextId + 1
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, okGeneration: null })
        post({ type: 'action', id, data })
      })
    },
    // Saves (op 'save') or shares to the room's channel (op 'share') a PNG the bundle made, for a
    // bundle with the export capability. Resolves when done, rejects with the shell's reason.
    exportImage(op, name, data) {
      const id = nextExportId
      nextExportId = nextExportId >= 4294967295 ? 1 : nextExportId + 1
      return new Promise((resolve, reject) => {
        exporting.set(id, { resolve, reject })
        post({ type: 'export', op, id, name, data })
      })
    },
    // Asks the shell to play one of its sounds, by a name in BUNDLE_SOUNDS
    // (lib/activities/bridge.js), for a bundle with the sound capability.
    sound(name) {
      post({ type: 'sound', name })
    },
    // Sends a value's JSON as an input datagram.
    input(value) {
      post({ type: 'input', data: encoder.encode(JSON.stringify(value)) })
    },
    // Whether leaving now would cost the viewer something.
    setBusy(value) {
      const next = !!value
      if (next === busy) return
      busy = next
      post({ type: 'status', busy })
    }
  }

  // After every parser-inserted script, so main.js has set its handlers before init arrives.
  addEventListener('DOMContentLoaded', () => post({ type: 'ready' }))
})()
