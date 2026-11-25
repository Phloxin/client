/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { IconDeviceGamepad2 } from '@tabler/icons-react'
import { activityCapabilities, activitySrcdoc } from '../activities/ui'
import { bridgeClients, readUiMessage, themeValues } from '../lib/activities/bridge'
import { exportImage } from '../lib/activities/exportImage'
import ActivityPlayer from './ActivityPlayer'
import { ActivityPlaceholder } from './ActivityHostLayer'
import './ActivityView.css'

const CLOSE_REASONS = new Map([
  ['empty', 'Everyone left'],
  ['forced', 'The activity was ended'],
  ['shutdown', 'The server is restarting'],
  ['channel_deleted', 'The channel was deleted'],
  ['error', 'The activity stopped because of an error']
])
const MAX_AVATARS = 5
// What a tab shows for a room this client has no controller for.
const NO_SESSION = { status: 'closed', closeReason: null, clients: [], you: null, room: null }

function bannerText(state) {
  if (state.status === 'connecting') return 'Connecting'
  if (state.status === 'reconnecting') return 'Reconnecting'
  if (state.status === 'failed') return 'This server has no room endpoint configured'
  if (state.status === 'closed') return CLOSE_REASONS.get(state.closeReason) ?? 'The activity ended'
  return null
}

// Wires one mounted frame to the room's controller: waits for the bundle's `ready`, then sends
// init, the theme and the state log, and from then on passes state, clients, replies, the
// connection and the close through. Messages from anything but this frame are ignored. For a
// bundle with the `player` capability (`player` is the surface's handle, `bodyRef` what goes
// fullscreen) it also routes `player` and `fullscreen`, which any other bundle has dropped; for one
// whose `capabilities` include `export`, it saves or shares the bundle's picture.
function useBridge(
  frameRef,
  controller,
  roster,
  srcdoc,
  { player = null, bodyRef = null, capabilities } = {}
) {
  const rosterRef = useRef(roster)
  const postClientsRef = useRef(null)

  useEffect(() => {
    rosterRef.current = roster
    postClientsRef.current?.()
  }, [roster])

  useEffect(() => {
    const frame = frameRef.current
    if (!controller || !frame || !srcdoc) return
    const post = (message) => frame.contentWindow?.postMessage(message, '*')
    const clientsOf = (state) => bridgeClients(state.clients, rosterRef.current)
    let ready = false
    let inited = false
    let sentStatus = null
    // The room's clients last sent, as the bridge list, to skip repeats when only the roster's
    // identity changed.
    let sentClients = null

    const sendTheme = () => {
      const css = getComputedStyle(document.documentElement)
      post({ type: 'theme', vars: themeValues((name) => css.getPropertyValue(name)) })
    }
    const sendState = (frameData) =>
      post({
        type: 'state',
        kind: frameData.kind,
        generation: frameData.generation,
        data: frameData.payload
      })
    const sendClients = (state) => {
      const clients = clientsOf(state)
      const key = JSON.stringify(clients)
      if (key === sentClients) return
      sentClients = key
      post({ type: 'clients', clients })
    }
    // The connection and the close, as they change.
    const sendStatus = (state) => {
      if (state.status === sentStatus) return
      sentStatus = state.status
      if (state.status === 'joined' || state.status === 'reconnecting') {
        post({ type: 'connection', state: state.status })
      } else if (state.status === 'closed') {
        post({ type: 'closed', reason: state.closeReason })
      }
    }
    const sync = (state) => {
      if (!ready) return
      if (!inited) {
        // `you` is known once the session has joined at least once.
        if (state.you == null) return
        inited = true
        const clients = clientsOf(state)
        post({
          type: 'init',
          you: state.you,
          creator: state.creator,
          clients,
          clockOffsetMs: state.clockOffsetMs
        })
        sentClients = JSON.stringify(clients)
        sentStatus = null
        sendTheme()
        for (const f of controller.stateLog()) sendState(f)
        sendStatus(state)
        if (player) post({ type: 'player', ...player.current.readyEvent() })
        return
      }
      sendClients(state)
      sendStatus(state)
    }

    const view = controller.attach({
      onState: (f) => inited && sendState(f),
      onVolatile: (payload) => inited && post({ type: 'volatile', data: payload }),
      onReply: (reply) => post(reply)
    })
    const onMessage = (event) => {
      if (event.source !== frame.contentWindow) return
      const message = readUiMessage(event.data, capabilities)
      switch (message.type) {
        case 'ready':
          ready = true
          inited = false
          // A new bundle instance has said nothing yet about what leaving would cost.
          controller.setBusy(false)
          // Nor placed or loaded anything.
          player?.current.reset()
          sync(controller.state)
          return
        case 'action': {
          const result = controller.sendAction(view.viewId, message.id, message.data)
          if (result === 'not_connected' || result === 'too_large') {
            post({ type: 'rejected', id: message.id, reason: result })
          } else if (result === 'invalid') {
            console.warn('[Activity] Dropped an action whose data is not a JSON value')
          }
          return
        }
        case 'input':
          controller.sendInput(message.data)
          return
        case 'status':
          controller.setBusy(message.busy)
          return
        case 'player':
        case 'fullscreen':
          if (!player) {
            console.warn(
              `[Activity] Dropped ${message.type} from a bundle without the player capability`
            )
          } else if (message.type === 'player') {
            player.current.command(message)
          } else {
            setFullscreen(message.on)
          }
          return
        case 'export':
          if (message.refused) {
            console.warn('[Activity] Refused an export from the activity:', message.refused)
            post({ type: 'export', id: message.id, ok: false, error: 'export_failed' })
          } else {
            exportImage(message, { channelId: controller.state.room?.channel_id }).then((result) =>
              post({ type: 'export', id: message.id, ...result })
            )
          }
          return
        default:
          console.warn('[Activity] Dropped a message from the activity:', message.why)
      }
    }
    // The tab's body goes fullscreen, bundle frame and surface together.
    const setFullscreen = (on) => {
      const body = bodyRef?.current
      if (!body) return
      if (on && document.fullscreenElement !== body) {
        body.requestFullscreen().catch((err) => console.warn('[Activity] Fullscreen refused', err))
      } else if (!on && document.fullscreenElement === body) {
        document.exitFullscreen().catch(() => {})
      }
    }
    let sentFullscreen = false
    const onFullscreenChange = () => {
      const on =
        document.fullscreenElement != null && document.fullscreenElement === bodyRef?.current
      if (on === sentFullscreen) return
      sentFullscreen = on
      post({ type: 'fullscreen', on })
    }
    if (player) document.addEventListener('fullscreenchange', onFullscreenChange)
    window.addEventListener('message', onMessage)
    const unsubscribe = controller.subscribe(sync)
    postClientsRef.current = () => inited && sendClients(controller.state)
    // Themes switch data-theme on <html>; the font picker rewrites its inline style.
    const observer = new MutationObserver(() => inited && sendTheme())
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'style']
    })
    return () => {
      document.removeEventListener('fullscreenchange', onFullscreenChange)
      window.removeEventListener('message', onMessage)
      unsubscribe()
      view.detach()
      observer.disconnect()
      postClientsRef.current = null
    }
  }, [frameRef, controller, srcdoc, player, bodyRef, capabilities])
}

// A controller's state, for a view; NO_SESSION without one.
function useSessionState(controller) {
  const subscribe = useCallback(
    (fn) => (controller ? controller.subscribe(fn) : () => {}),
    [controller]
  )
  return useSyncExternalStore(subscribe, () => controller?.state ?? NO_SESSION)
}

// The activity's body: its frame, the video surface for a `player` bundle, and a banner over
// them while connecting or once the room is over. In the tab, or in the host layer.
// `onAudible(bool)`: whether its player is playing with sound.
export function ActivityBody({ controller, activityId, roster, onAudible }) {
  const frameRef = useRef(null)
  const bodyRef = useRef(null)
  const playerRef = useRef(null)
  const state = useSessionState(controller)
  const srcdoc = activitySrcdoc(activityId)
  const capabilities = activityCapabilities(activityId)
  const hasPlayer = srcdoc != null && capabilities.includes('player')
  useBridge(frameRef, controller, roster, srcdoc, {
    ...(hasPlayer ? { player: playerRef, bodyRef } : {}),
    capabilities
  })
  const postPlayerEvent = useCallback(
    (event) => frameRef.current?.contentWindow?.postMessage({ type: 'player', ...event }, '*'),
    []
  )
  const over = state.status === 'closed' || state.status === 'failed'
  const banner = bannerText(state)
  return (
    <div className="activity-body" ref={bodyRef}>
      {hasPlayer && (
        <ActivityPlayer
          ref={playerRef}
          active={!over}
          onEvent={postPlayerEvent}
          onAudible={onAudible}
        />
      )}
      {srcdoc ? (
        <iframe
          ref={frameRef}
          className={hasPlayer ? 'activity-frame activity-frame-clear' : 'activity-frame'}
          sandbox="allow-scripts"
          srcDoc={srcdoc}
        />
      ) : (
        <div className="activity-empty">This client has no UI for this activity</div>
      )}
      {banner && (
        <div className="activity-banner-layer">
          <div className="activity-banner" role="status">
            {banner}
          </div>
        </div>
      )}
    </div>
  )
}

// The activity tab: who is in the room and the controls to leave or end it, and the activity's
// body, or for a body the host layer keeps, the place it is laid over. `canEnd`: the viewer
// created the room or moderates its channel; End activity shows until the room is over.
function ActivityView({
  controller,
  activityId,
  activityName,
  channelName,
  roster,
  onLeave,
  canEnd = false,
  onEnd
}) {
  const [confirmingEnd, setConfirmingEnd] = useState(false)
  const state = useSessionState(controller)
  // A player bundle's body lives in the host layer, laid over the placeholder, so
  // it keeps playing while this tab is not shown.
  const hosted =
    controller != null &&
    activitySrcdoc(activityId) != null &&
    activityCapabilities(activityId).includes('player')
  const cancelEnd = useCallback(() => setConfirmingEnd(false), [])

  const over = state.status === 'closed' || state.status === 'failed'
  const showEnd = canEnd && !over
  const clients = state.clients.map((id) => {
    const c = roster.find((r) => String(r.id) === String(id))
    return { id, name: c?.name || 'Unknown', avatar: c?.avatar || null }
  })
  const extra = clients.length - MAX_AVATARS

  return (
    <div className="activity-view">
      <header className="activity-header">
        <IconDeviceGamepad2 size={18} stroke={2} className="activity-header-icon" />
        <div className="activity-heading">
          <span className="activity-name">{activityName}</span>
          <span className="activity-channel">{channelName}</span>
        </div>
        <div className="activity-clients">
          {clients.slice(0, MAX_AVATARS).map((c) => (
            <span key={c.id} className="activity-avatar" title={c.name}>
              {c.avatar ? <img src={c.avatar} alt="" /> : c.name.charAt(0).toUpperCase()}
            </span>
          ))}
          {extra > 0 && <span className="activity-avatar activity-avatar-more">+{extra}</span>}
        </div>
        {showEnd && (
          <button
            type="button"
            className="activity-btn danger"
            onClick={() => setConfirmingEnd(true)}
          >
            End activity
          </button>
        )}
        <button type="button" className="activity-btn" onClick={onLeave}>
          Leave
        </button>
      </header>
      {hosted ? (
        <ActivityPlaceholder roomId={controller.roomId} />
      ) : (
        <ActivityBody controller={controller} activityId={activityId} roster={roster} />
      )}
      {confirmingEnd && showEnd && (
        <ActivityDialog
          heading="End activity"
          body={`This ends ${activityName} for everyone in it.`}
          confirmLabel="End activity"
          onCancel={cancelEnd}
          onConfirm={() => {
            setConfirmingEnd(false)
            onEnd?.()
          }}
        />
      )}
    </div>
  )
}

// A confirmation over the whole window: Cancel, or the danger action. Escape and a click outside
// cancel.
function ActivityDialog({ heading, body, confirmLabel, onCancel, onConfirm }) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onCancel()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onCancel])
  return (
    <div className="activity-dialog-overlay" onClick={onCancel} role="presentation">
      <div
        className="activity-dialog"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="activity-dialog-body">
          {heading && <div className="activity-dialog-heading">{heading}</div>}
          {body}
        </div>
        <div className="activity-dialog-footer">
          <button type="button" className="activity-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="activity-btn danger" onClick={onConfirm} autoFocus>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// Asks before closing a room's last tab would forfeit the viewer's round.
export function ActivityLeaveDialog({ onCancel, onLeave }) {
  return (
    <ActivityDialog
      body="Leaving forfeits the round"
      confirmLabel="Leave"
      onCancel={onCancel}
      onConfirm={onLeave}
    />
  )
}

export default ActivityView
