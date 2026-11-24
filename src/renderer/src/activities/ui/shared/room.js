// The layer every activity bundle uses, seats or not: who the viewer is, every client seen and
// the ones connected now, the clock offset, the connection, the one pending action, the notice line and the latest
// snapshot. It subscribes to the bridge itself; the layers above and the bundle redraw from
// onRender, and a bundle that takes deltas applies them in onDelta.
/* global bridge */
;(() => {
  const NOTICE_MS = 3000
  // Reason -> text for a rejected action; a reason with no text shows as itself.
  const texts = { not_connected: 'Not connected' }
  // Every client seen in this room, since a seated client between sessions is not in `clients`.
  const known = new Map()
  // The ids of the clients connected now, from init and clients.
  let clients = []
  const renders = []
  // The bundle's delta hook; without one, deltas are dropped.
  let onDelta = null
  let you = null
  let creator = null
  // Server time minus local time, from init.
  let clockOffsetMs = 0
  let view = null
  let connected = true
  let closed = false
  let pending = false
  let noticeTimer = null

  const render = () => {
    for (const fn of renders) fn()
  }
  const remember = (clients) => {
    for (const c of clients || []) known.set(String(c.id), { name: c.name, avatar: c.avatar })
  }
  const canAct = () => connected && !closed && !pending

  function showNotice(text) {
    const el = document.getElementById('notice')
    if (!el) return
    clearTimeout(noticeTimer)
    el.textContent = text
    noticeTimer = setTimeout(() => (el.textContent = ''), NOTICE_MS)
  }

  bridge.onInit((init) => {
    you = init.you
    creator = init.creator
    clockOffsetMs = init.clockOffsetMs
    remember(init.clients)
    clients = (init.clients || []).map((c) => String(c.id))
    render()
  })
  bridge.onClients((list) => {
    remember(list)
    clients = (list || []).map((c) => String(c.id))
    render()
  })
  // `view` is the latest snapshot only. Deltas go to the bundle's hook, in the order they came.
  bridge.onState(({ kind, generation, data }) => {
    if (kind === 'delta') {
      onDelta?.({ data, generation })
      return
    }
    if (kind !== 'snapshot') return
    view = data
    render()
  })
  bridge.onConnection((state) => {
    connected = state === 'joined'
    render()
  })
  bridge.onClosed(() => {
    closed = true
    render()
  })

  window.room = {
    get you() {
      return you
    },
    get creator() {
      return creator
    },
    get clockOffsetMs() {
      return clockOffsetMs
    },
    // The ids of the clients connected now.
    get clients() {
      return [...clients]
    },
    get view() {
      return view
    },
    get connected() {
      return connected
    },
    get closed() {
      return closed
    },
    canAct,
    // Sends an action and takes no other until it is applied or refused.
    send(action) {
      if (!canAct()) return
      pending = true
      render()
      bridge
        .action(action)
        .catch((reason) =>
          showNotice(Object.hasOwn(texts, reason) ? texts[reason] : String(reason))
        )
        .finally(() => {
          pending = false
          render()
        })
    },
    nameOf: (clientId) => known.get(String(clientId))?.name || 'Unknown',
    // The client's avatar URL, or null.
    avatarOf: (clientId) => known.get(String(clientId))?.avatar || null,
    // The client's avatar, or the first letter of their name when there is none or it fails.
    avatarEl(clientId) {
      const el = document.createElement('span')
      el.className = 'avatar'
      const client = known.get(String(clientId))
      const letter = (client?.name || 'Unknown').charAt(0).toUpperCase()
      if (client?.avatar) {
        const img = document.createElement('img')
        img.alt = ''
        img.src = client.avatar
        img.addEventListener('error', () => el.replaceChildren(letter))
        el.appendChild(img)
      } else {
        el.textContent = letter
      }
      return el
    },
    rejections(map) {
      Object.assign(texts, map)
    },
    onRender(fn) {
      renders.push(fn)
    },
    // fn({ data, generation }) for each delta frame, data decoded. One hook; a later call
    // replaces it.
    onDelta(fn) {
      onDelta = typeof fn === 'function' ? fn : null
    }
  }
})()
