import { useEffect, useRef, useState } from 'react'
import './NotificationBell.css'
import { IconBell, IconTrash } from '@tabler/icons-react'

// How long the bounce-out toast stays on screen (matches the CSS animation).
const TOAST_MS = 4000

const formatTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// Notification center pinned to the left of the title bar. Shows a bell with an
// unread badge; clicking it opens a dropdown listing recent notifications. When
// a new notification arrives it also bounces a transient toast out to the right
// of the bell. `notifications` is newest-first and owned by the parent.
function NotificationBell({ notifications = [], onClear }) {
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [unread, setUnread] = useState(0)
  // Bumped on each click to remount (and so replay) the bell-jingle animation;
  // starts at 0 so the bell doesn't jingle on first mount.
  const [jingle, setJingle] = useState(0)
  const ref = useRef(null)
  // Id of the newest notification we've already reacted to, so we only toast
  // (and bump the unread count) on genuinely new ones.
  const lastIdRef = useRef(notifications[0]?.id ?? null)
  const toastTimerRef = useRef(null)

  // React to a newly-arrived notification: bounce a toast and, if the panel is
  // closed, increment the unread badge.
  useEffect(() => {
    const newest = notifications[0]
    const newestId = newest?.id ?? null
    if (newestId === lastIdRef.current) return
    lastIdRef.current = newestId
    if (!newest) return

    setToast(newest)
    setJingle((c) => c + 1) // ring the bell when a new notification arrives
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
    if (!open) setUnread((n) => n + 1)
  }, [notifications, open])

  useEffect(() => () => { if (toastTimerRef.current) clearTimeout(toastTimerRef.current) }, [])

  // Close the dropdown on an outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const toggle = () => {
    setToast(null)
    setJingle((c) => c + 1)
    setOpen((o) => {
      if (!o) setUnread(0) // opening clears the unread badge
      return !o
    })
  }

  return (
    <div className="notif-center" ref={ref}>
      <button type="button" className="title-bar-btn notif-bell" onClick={toggle} title="Notifications">
        <IconBell
          size={16}
          key={jingle}
          className={jingle > 0 ? 'notif-bell-icon jingle' : 'notif-bell-icon'}
        />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {toast && !open && (
        <div className="notif-toast" key={toast.id}>
          {toast.message}
        </div>
      )}

      <div className={`notif-panel${open ? ' open' : ''}`} aria-hidden={!open}>
          <div className="notif-panel-header">
            <span>Notifications</span>
            {notifications.length > 0 && (
              <button type="button" className="notif-clear-btn" onClick={() => onClear?.()} title="Clear all">
                <IconTrash size={14} />
                Clear all
              </button>
            )}
          </div>
          {notifications.length === 0 ? (
            <div className="notif-empty">Nothing yet</div>
          ) : (
            <div className="notif-list">
              {notifications.map((n) => (
                <div className="notif-item" key={n.id}>
                  <span className="notif-item-msg">{n.message}</span>
                  <span className="notif-item-time">{formatTime(n.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
    </div>
  )
}

export default NotificationBell
