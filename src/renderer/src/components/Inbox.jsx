import { useEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { menuPop, spring } from '../lib/motionPresets'
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
// `silent` (Do Not Disturb) suppresses the toast only — DMs are still recorded
// and still count toward the unread badge.
function Inbox({ notifications = [], onOpen, onClear, silent = false }) {
  const [open, setOpen] = useState(false)
  const [toast, setToast] = useState(null)
  const [unread, setUnread] = useState(0)
  const ref = useRef(null)
  const overlayAnim = useAnimationCategory('overlays')
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

    // The badge is bumped regardless of DND — only the interruption is silenced.
    if (!open) setUnread((n) => n + 1)
    if (silent) return

    setToast(newest)
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    toastTimerRef.current = setTimeout(() => setToast(null), TOAST_MS)
  }, [notifications, open, silent])

  useEffect(
    () => () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    },
    []
  )

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
      <button
        type="button"
        className="title-bar-btn notif-bell"
        onClick={toggle}
        title="Direct Messages"
      >
        <IconInbox size={16} />
        {unread > 0 && <span className="notif-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>

      <AnimatePresence>
        {/* `!silent` also retracts a toast already on screen if DND is switched
            on mid-display, rather than leaving it to time out. */}
        {toast && !open && !silent && (
          <motion.div
            className="notif-toast"
            key={toast.id}
            {...(overlayAnim
              ? {
                  initial: { opacity: 0, x: -12, scale: 0.9 },
                  animate: { opacity: 1, x: 0, scale: 1, transition: spring },
                  exit: { opacity: 0, transition: { duration: 0.18 } }
                }
              : { initial: false })}
          >
            {toast.message}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {open && (
          <motion.div className="notif-panel" {...menuPop(overlayAnim)}>
            <div className="notif-panel-header">
              <span>Inbox</span>
              {notifications.length > 0 && (
                <button
                  type="button"
                  className="notif-clear-btn"
                  onClick={() => onClear?.()}
                  title="Clear all"
                >
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
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default Inbox
