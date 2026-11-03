import { useEffect, useState } from 'react'
import { motion } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop } from '../lib/motionPresets'
import { IconPhone, IconPhoneOff } from '@tabler/icons-react'
import './IncomingCallOverlay.css'

// DM calls ringing us, one card per call with Answer and Decline. Closing it
// (Escape, the scrim) declines nothing; Main shows it again when a ring changes.
function IncomingCallOverlay({ calls, onAnswer, onDecline, onClose }) {
  const overlayAnim = useAnimationCategory('overlays')
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div className="ic-overlay" onClick={onClose}>
      <motion.div
        className="ic-modal"
        onClick={(e) => e.stopPropagation()}
        {...overlayPop(overlayAnim)}
      >
        {calls.map((call) => (
          <div key={call.channelId} className="ic-card">
            <span className="ic-avatar">
              {call.callerAvatar ? (
                <img src={call.callerAvatar} alt="" />
              ) : (
                (call.callerName?.[0] ?? '?').toUpperCase()
              )}
            </span>
            <div className="ic-info">
              <span className="ic-caller">{call.callerName}</span>
              <span className="ic-meta">
                {call.groupName ? `Calling ${call.groupName}` : 'Incoming call'} ·{' '}
                {Math.max(0, Math.ceil((call.deadline - now) / 1000))}s
              </span>
            </div>
            <div className="ic-actions">
              <button
                type="button"
                className="ic-btn decline"
                title="Decline"
                onClick={() => onDecline(call.channelId)}
              >
                <IconPhoneOff size={18} />
              </button>
              <button
                type="button"
                className="ic-btn answer"
                title="Answer"
                onClick={() => onAnswer(call.channelId)}
              >
                <IconPhone size={18} />
              </button>
            </div>
          </div>
        ))}
      </motion.div>
    </div>
  )
}

export default IncomingCallOverlay
