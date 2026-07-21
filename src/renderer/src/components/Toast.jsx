import { useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { toastSlide } from '../lib/motionPresets'
import './Toast.css'
import { IconAlertTriangle, IconCircleCheck } from '@tabler/icons-react'

// Transient banner that drops down from the center of the title bar. The
// default 'error' variant reports partial failures (bad requests, permission
// denials, failed fetches) — as opposed to ErrorBoundary, which takes over the
// whole app on a hard crash. The 'success' variant confirms completed actions.
// Click anywhere on it to dismiss; it also auto-dismisses after a few seconds.
function Toast({ toast, onDismiss }) {
  const overlayAnim = useAnimationCategory('overlays')
  const message = toast?.message
  const variant = toast?.variant ?? 'error'

  // Depend on the toast object, not just the message string, so re-firing the
  // same message (e.g. a repeated "talking while muted" warning) restarts the
  // auto-dismiss timer and keeps the banner up instead of hiding after the first.
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [toast, message, onDismiss])

  return (
    <AnimatePresence>
      {message && (
        <motion.button
          type="button"
          className={`toast ${variant}`}
          onClick={onDismiss}
          role={variant === 'error' ? 'alert' : 'status'}
          title="Dismiss"
          {...toastSlide(overlayAnim)}
        >
          {variant === 'success' ? (
            <IconCircleCheck size={16} stroke={2} className="toast-icon" />
          ) : (
            <IconAlertTriangle size={16} stroke={2} className="toast-icon" />
          )}
          <span className="toast-text">{message}</span>
        </motion.button>
      )}
    </AnimatePresence>
  )
}

export default Toast
