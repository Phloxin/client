import { useEffect } from 'react'
import './Toast.css'
import { IconAlertTriangle } from '@tabler/icons-react'

// Transient error banner that drops down from the center of the title bar for
// partial failures (bad requests, permission denials, failed fetches) — as
// opposed to ErrorBoundary, which takes over the whole app on a hard crash.
// Click anywhere on it to dismiss; it also auto-dismisses after a few seconds.
function Toast({ message, onDismiss }) {
  useEffect(() => {
    if (!message) return
    const t = setTimeout(onDismiss, 6000)
    return () => clearTimeout(t)
  }, [message, onDismiss])

  if (!message) return null

  return (
    <button type="button" className="toast" onClick={onDismiss} role="alert" title="Dismiss">
      <IconAlertTriangle size={16} stroke={2} className="toast-icon" />
      <span className="toast-text">{message}</span>
    </button>
  )
}

export default Toast
