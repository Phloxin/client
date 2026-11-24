/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import { activityCapabilities, activitySrcdoc } from '../activities/ui'
import { activitySessions } from '../lib/activities/sessionStore'
import { ActivityBody } from './ActivityView'
import './ActivityHostLayer.css'

// A pane renders only its active tab, so the body of an activity whose bundle has the
// `player` capability (its frame, surface and banner) lives here, mounted once at the app root, one per room with a controller, until the controller
// is gone. The tab renders an ActivityPlaceholder; the body is laid over it while it is on
// screen, and otherwise keeps its last size, hidden and taking no input, and keeps playing.

const hosted = (activityId) =>
  activitySrcdoc(activityId) != null && activityCapabilities(activityId).includes('player')

// Room id -> the placeholder element on screen; room id -> whether its player plays with sound.
const placeholders = new Map()
const audible = new Map()
const listeners = new Set()
let version = 0
const changed = () => {
  version++
  for (const fn of listeners) fn()
}
const store = {
  subscribe(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  getVersion: () => version
}

// The tab's side, where the body is laid while the tab is shown.
export function ActivityPlaceholder({ roomId }) {
  const ref = useRef(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (roomId == null || !el) return
    placeholders.set(roomId, el)
    changed()
    return () => {
      if (placeholders.get(roomId) !== el) return
      placeholders.delete(roomId)
      changed()
    }
  }, [roomId])
  return <div className="activity-body-slot" ref={ref} />
}

// While shown, the placeholder is also measured this often, so a move with no resize is
// followed.
const MEASURE_EVERY_MS = 500

const sameRect = (a, b) =>
  !!a && !!b && a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

// One room's body, laid over its placeholder while there is one. `layout` is the tab layout,
// so its changes measure again.
function HostedBody({ controller, roster, layout }) {
  const roomId = controller.roomId
  useSyncExternalStore(store.subscribe, store.getVersion)
  const placeholder = placeholders.get(roomId) ?? null
  const [rect, setRect] = useState(null)

  useLayoutEffect(() => {
    if (!placeholder) return
    const measure = () => {
      const r = placeholder.getBoundingClientRect()
      const next = { x: r.left, y: r.top, width: r.width, height: r.height }
      setRect((prev) => (sameRect(prev, next) ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(placeholder)
    window.addEventListener('resize', measure)
    const timer = setInterval(measure, MEASURE_EVERY_MS)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
      clearInterval(timer)
    }
  }, [placeholder, layout])

  useEffect(
    () => () => {
      if (audible.delete(roomId)) changed()
    },
    [roomId]
  )
  const onAudible = (on) => {
    if (audible.get(roomId) === on) return
    audible.set(roomId, on)
    changed()
  }

  const shown = placeholder != null && rect != null
  const style = rect ? { left: rect.x, top: rect.y, width: rect.width, height: rect.height } : {}
  return (
    <div
      className={`activity-host-body${shown ? '' : ' hidden'}`}
      style={style}
      data-room-id={roomId}
      aria-hidden={shown ? undefined : true}
    >
      <ActivityBody
        controller={controller}
        activityId={controller.state.room?.activity_id}
        roster={roster}
        onAudible={onAudible}
      />
    </div>
  )
}

// The layer: above pane content (z-index 5; nothing that draws over a pane is below 10) and
// below every menu, popover, dialog, toast and drag overlay. `onSpeakers(roomIds)`: the rooms
// whose player plays with sound while their tab is not shown, as that changes.
function ActivityHostLayer({ roster, layout, onSpeakers }) {
  useSyncExternalStore(activitySessions.subscribe, activitySessions.getVersion)
  const storeVersion = useSyncExternalStore(store.subscribe, store.getVersion)
  const controllers = activitySessions
    .roomIds()
    .map((id) => activitySessions.get(id))
    .filter((c) => c && hosted(c.state.room?.activity_id))

  const sentRef = useRef('')
  useEffect(() => {
    const speakers = [...audible]
      .filter(([id, on]) => on && !placeholders.has(id))
      .map(([id]) => id)
    const key = speakers.sort().join(',')
    if (key === sentRef.current) return
    sentRef.current = key
    onSpeakers?.(new Set(speakers))
  }, [storeVersion, onSpeakers])

  return (
    <div className="activity-host-layer">
      {controllers.map((c) => (
        <HostedBody key={c.roomId} controller={c} roster={roster} layout={layout} />
      ))}
    </div>
  )
}

export default ActivityHostLayer
