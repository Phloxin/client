import { useEffect, useRef, useState } from 'react'
import './NotificationBell.css'
import { IconInbox, IconTrash } from '@tabler/icons-react'

// How long the bounce-out toast stays on screen (matches the CSS animation).
const TOAST_MS = 4000

const formatTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

// DM inbox pinned in the title bar. Mirrors NotificationBell (and reuses its
// styling) but its entries are clickable: clicking one opens that DM via
// `onOpen`. `notifications` is newest-first, deduped per DM channel, and owned by
// the parent.
function Inbox({ notifications = [], onOpen, onClear }) {
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [unread, setUnread] = useState(0)
  const ref = useRef(null)
  // Id of the newest notification we've already reacted to, so we only toast
  // (and bump the unread count) on genuinely new ones.
  const lastIdRef = useRef(notifications[0]?.id ?? null)
  const toastTimerRef = useRef(null)

  // React to a newly-arrived DM: bounce a toast and, if the panel is closed,
  // increment the unread badge.
  useEffect(() => {
    const newest = notifications[0]
    const newestId = newest?.id ?? null
    if (newestId === lastIdRef.current) return
    lastIdRef.current = newestId
    if (!newest) return

    setToast(newest)
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
    setOpen((o) => {
      if (!o) setUnread(0) // opening clears the unread badge
      return !o
    })
  }

  const handleOpen = (n) => {
    setOpen(false)
    setUnread(0)
    onOpen?.(n)
  }

  return (
    <div className="notif-center" ref={ref}>
      <button type="button" className="title-bar-btn notif-bell" onClick={toggle} title="Direct messages">
        <IconInbox size={16} />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      {toast && !open && (
        <div className="notif-toast" key={toast.id}>
          {toast.message}
        </div>
      )}

      <div className={`notif-panel${open ? ' open' : ''}`} aria-hidden={!open}>
        <div className="notif-panel-header">
          <span>Inbox</span>
          {notifications.length > 0 && (
            <button type="button" className="notif-clear-btn" onClick={() => onClear?.()} title="Clear all">
              <IconTrash size={14} />
              Clear all
            </button>
          )}
        </div>
        {notifications.length === 0 ? (
          <div className="notif-empty">No new messages</div>
        ) : (
          <div className="notif-list">
            {notifications.map((n) => (
              <button
                type="button"
                className="notif-item clickable"
                key={n.id}
                onClick={() => handleOpen(n)}
              >
                <span className="notif-item-msg">{n.message}</span>
                <span className="notif-item-time">{formatTime(n.timestamp)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export default Inbox
