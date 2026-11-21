// One controller per room this client is in, outside React so switching tabs or moving one
// between panes keeps the session. A controller owns the room session, reconnects one that drops while its room
// is listed, and keeps what a view needs to catch up: status, you, creator, clients, the clock
// offset, the close reason and the state log (the last snapshot and every delta after it).
//
// Status: 'connecting' until the first `joined`, 'joined', 'reconnecting' after a drop, 'closed'
// once the room is over (`closeReason` is the server's reason, null when it was not given), and
// 'failed' when it cannot be joined at all (`failure` says why).

import { ROOMS_PROTOCOL_VERSION } from '../serverConfig.js'
import { roomTicket } from './api.js'
import { actionFrame } from './bridge.js'
import { openRoomSession } from './roomSession.js'

export const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000]
// A connect attempt that has not reached `joined` by then counts as a drop.
export const JOIN_TIMEOUT_MS = 10_000
const MAX_WIRE_ID = 2 ** 32 - 1

export const reconnectDelay = (attempt) =>
  RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)]

// The session URL: the ticket's `url` with the protocol version.
export function sessionUrl(url) {
  const u = new URL(url)
  u.searchParams.set('v', String(ROOMS_PROTOCOL_VERSION))
  return u.toString()
}

const OVER = new Set(['closed', 'failed'])

function createController(room, deps, onChange) {
  const roomId = room.id
  let state = {
    roomId,
    room,
    status: 'connecting',
    you: null,
    creator: null,
    clients: [],
    clockOffsetMs: 0,
    closeReason: null,
    failure: null,
    busy: false,
    joinedOnce: false
  }
  let log = []
  let session = null
  let attempt = 0
  let retryTimer = null
  let joinTimer = null
  // Whether the room has been seen in the room list. The list can lag the open response, so a
  // room not seen yet is not taken as gone.
  let seenListed = false
  let listed = false
  let disposed = false
  let nextWireId = 1
  let nextViewId = 1
  // Wire action id -> the view and the id its bundle chose.
  const pending = new Map()
  const views = new Map()
  const listeners = new Set()

  const set = (patch) => {
    state = { ...state, ...patch }
    for (const fn of listeners) fn(state)
    onChange()
  }
  const toView = (viewId, method, value) => views.get(viewId)?.[method]?.(value)
  const toViews = (method, value) => {
    for (const view of views.values()) view[method]?.(value)
  }
  const clearTimers = () => {
    deps.clearTimer(retryTimer)
    deps.clearTimer(joinTimer)
    retryTimer = joinTimer = null
  }
  // In-flight actions will get no reply from a session that is gone.
  const rejectPending = () => {
    for (const [, { viewId, uiId }] of pending) {
      toView(viewId, 'onReply', { type: 'rejected', id: uiId, reason: 'not_connected' })
    }
    pending.clear()
  }

  const finish = (patch) => {
    clearTimers()
    rejectPending()
    set(patch)
  }
  const fail = (failure) => {
    session?.close()
    session = null
    finish({ status: 'failed', failure })
  }
  // The room is gone. A session in the room stays, so a `closed` frame can still say why.
  const gone = () => {
    if (OVER.has(state.status)) return
    if (!session?.joined) {
      session?.close()
      session = null
    }
    finish({ status: 'closed', closeReason: null })
  }

  const drop = () => {
    session?.close()
    session = null
    clearTimers()
    rejectPending()
    if (disposed || OVER.has(state.status)) return
    if (seenListed && !listed) return gone()
    set({ status: 'reconnecting' })
    retryTimer = deps.setTimer(retry, reconnectDelay(attempt++))
  }

  const retry = () => {
    retryTimer = null
    if (disposed || OVER.has(state.status)) return
    if (seenListed && !listed) return gone()
    deps.fetchTicket(roomId).then(
      (ticket) => {
        if (!disposed && !OVER.has(state.status)) connect(ticket)
      },
      (error) => {
        if (disposed || OVER.has(state.status)) return
        if (error?.code === 'room_not_found') gone()
        else drop()
      }
    )
  }

  const connect = (ticket) => {
    if (!ticket?.url) return fail('no_endpoint')
    let url
    try {
      url = sessionUrl(ticket.url)
    } catch {
      return fail('no_endpoint')
    }
    const token = {}
    const current = () => session?.token === token
    const handlers = {
      onControl: (message) => current() && control(message),
      onState: (frame) => {
        if (!current()) return
        log = frame.kind === 'snapshot' ? [frame] : [...log, frame]
        toViews('onState', frame)
      },
      onVolatile: (payload) => current() && toViews('onVolatile', payload),
      onEnd: () => {
        if (!current()) return
        session = null
        drop()
      }
    }
    session = { token, ...deps.openSession(url, ticket.ticket, handlers) }
    deps.clearTimer(joinTimer)
    joinTimer = deps.setTimer(() => {
      joinTimer = null
      if (current() && state.status !== 'joined') drop()
    }, JOIN_TIMEOUT_MS)
  }

  const control = (message) => {
    switch (message.t) {
      case 'joined':
        deps.clearTimer(joinTimer)
        joinTimer = null
        attempt = 0
        session.joined = true
        set({
          status: 'joined',
          you: String(message.you),
          creator: String(message.creator),
          clients: (message.clients || []).map(String),
          clockOffsetMs: Number(message.now_ms) - deps.now(),
          joinedOnce: true
        })
        return
      case 'ok':
      case 'rejected': {
        const target = pending.get(message.id)
        if (!target) return
        pending.delete(message.id)
        const reply =
          message.t === 'ok'
            ? { type: 'ok', id: target.uiId, generation: message.generation }
            : { type: 'rejected', id: target.uiId, reason: String(message.reason) }
        toView(target.viewId, 'onReply', reply)
        return
      }
      case 'clients':
        set({ clients: (message.clients || []).map(String) })
        return
      case 'closed':
        // A room already taken as gone keeps its place, but learns why. There is nothing to leave.
        session.joined = false
        if (state.status === 'failed') return
        finish({ status: 'closed', closeReason: String(message.reason) })
        return
      default:
        return
    }
  }

  return {
    roomId,
    get state() {
      return state
    },
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    // A view's handlers: onState(frame), onVolatile(payload), onReply(ok or rejected, with the
    // bundle's own id). Returns the view's id and its detach.
    attach(handlers) {
      const viewId = nextViewId++
      views.set(viewId, handlers)
      return {
        viewId,
        detach: () => {
          views.delete(viewId)
          for (const [wireId, p] of pending) if (p.viewId === viewId) pending.delete(wireId)
        }
      }
    },
    stateLog: () => [...log],
    // 'sent', 'not_connected', 'too_large', or 'invalid' for data that is not a JSON value.
    sendAction(viewId, uiId, data) {
      if (state.status !== 'joined' || !session) return 'not_connected'
      const wireId = nextWireId
      const built = actionFrame(wireId, data)
      if (!built) return 'invalid'
      if (built.tooLarge) return 'too_large'
      nextWireId = wireId >= MAX_WIRE_ID ? 1 : wireId + 1
      pending.set(wireId, { viewId, uiId })
      session.send(built.frame)
      return 'sent'
    },
    sendInput(payload) {
      if (state.status !== 'joined' || !session) return false
      session.sendDatagram(payload)
      return true
    },
    setBusy(busy) {
      if (busy !== state.busy) set({ busy })
    },
    // The room as the room list has it now, or null when it is not in the list.
    syncRoom(listedRoom) {
      listed = !!listedRoom
      if (listedRoom) {
        seenListed = true
        if (listedRoom !== state.room) set({ room: listedRoom })
      } else if (seenListed) {
        gone()
      }
    },
    start(ticket) {
      connect(ticket)
    },
    // Leaves (when the session is in the room) and closes for good.
    dispose() {
      if (disposed) return
      disposed = true
      clearTimers()
      pending.clear()
      views.clear()
      if (session) {
        if (session.joined) session.leave()
        else session.close()
      }
      session = null
      listeners.clear()
    }
  }
}

export function createSessionStore(deps) {
  const controllers = new Map()
  const listeners = new Set()
  let rooms = []
  let version = 0
  const changed = () => {
    version++
    for (const fn of listeners) fn()
  }
  const listedRoom = (roomId) => rooms.find((r) => r.id === roomId) ?? null

  return {
    get: (roomId) => controllers.get(roomId) ?? null,
    roomIds: () => [...controllers.keys()],
    // Starts a session for `room` with the ticket from opening it or from a ticket request. A room
    // that already has one keeps it.
    join(room, ticket) {
      const existing = controllers.get(room.id)
      if (existing) return existing
      const controller = createController(listedRoom(room.id) ?? room, deps, changed)
      controllers.set(room.id, controller)
      controller.syncRoom(listedRoom(room.id))
      controller.start(ticket)
      changed()
      return controller
    },
    // The room's last tab is gone: leave and close.
    release(roomId) {
      const controller = controllers.get(roomId)
      if (!controller) return
      controllers.delete(roomId)
      controller.dispose()
      changed()
    },
    // The room list changed: rooms no longer in it are over.
    syncRooms(list) {
      rooms = list
      for (const controller of controllers.values())
        controller.syncRoom(listedRoom(controller.roomId))
    },
    // For useSyncExternalStore: a number that moves on every change of any controller.
    subscribe(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    getVersion: () => version
  }
}

// The running client's sessions.
export const activitySessions = createSessionStore({
  openSession: openRoomSession,
  fetchTicket: roomTicket,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (timer) => clearTimeout(timer),
  now: () => Date.now()
})
