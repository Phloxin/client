import { useState } from 'react'
import { motion } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop } from '../lib/motionPresets'
import './BanListMenu.css'
import { IconBan, IconSearch, IconUserCheck, IconX } from '@tabler/icons-react'

const formatExpiry = (expiresAt) =>
  expiresAt == null
    ? 'Permanent'
    : `Until ${new Date(expiresAt).toLocaleString([], {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      })}`

// 'Ban List' popup, opened from the server header's right-click menu. Lists the
// server's bans (BanApiObject[] = { reason, expires_at, user }, avatars already
// resolved) and lets moderators lift them. Only reachable with BAN_MEMBERS; the
// server stays authoritative on the unban itself.
function BanListMenu({ bans = [], onUnban, onClose }) {
  const [query, setQuery] = useState('')
  // User ids with an unban request in flight, so their button can't be
  // double-fired. The row itself disappears once the ban list refreshes.
  const [pending, setPending] = useState(() => new Set())
  const overlayAnim = useAnimationCategory('overlays')

  const q = query.trim().toLowerCase()
  const shown = q
    ? bans.filter(
        (b) => b.user.name?.toLowerCase().includes(q) || b.reason?.toLowerCase().includes(q)
      )
    : bans

  const unban = async (userId) => {
    setPending((prev) => new Set(prev).add(userId))
    try {
      await onUnban?.(userId)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(userId)
        return next
      })
    }
  }

  return (
    <div className="bl-overlay" onClick={onClose}>
      <motion.div
        className="bl-modal"
        onClick={(e) => e.stopPropagation()}
        {...overlayPop(overlayAnim)}
      >
        <div className="bl-header">
          <span className="bl-title">
            Ban List
            {bans.length > 0 && <span className="bl-count">{bans.length}</span>}
          </span>
          <button type="button" className="bl-close" onClick={onClose} title="Close">
            <IconX size={16} />
          </button>
        </div>
        {bans.length > 0 && (
          <div className="bl-search">
            <IconSearch size={15} />
            <input
              value={query}
              placeholder="Search by name or reason"
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        )}
        <div className="bl-body">
          {bans.length === 0 ? (
            <div className="bl-empty">
              <IconBan size={22} />
              No banned users
            </div>
          ) : shown.length === 0 ? (
            <div className="bl-empty">No matches</div>
          ) : (
            shown.map((b) => (
              <div key={b.user.id} className="bl-row">
                <span className="bl-avatar">
                  {b.user.avatar ? (
                    <img src={b.user.avatar} alt="" />
                  ) : (
                    (b.user.name?.[0] ?? '?').toUpperCase()
                  )}
                </span>
                <div className="bl-info">
                  <span className="bl-name">{b.user.name}</span>
                  <span className="bl-meta">
                    {formatExpiry(b.expires_at)}
                    {b.reason && <> · {b.reason}</>}
                  </span>
                </div>
                <button
                  type="button"
                  className="bl-unban"
                  onClick={() => unban(b.user.id)}
                  disabled={pending.has(b.user.id)}
                  title={`Unban ${b.user.name}`}
                >
                  <IconUserCheck size={15} />
                  Unban
                </button>
              </div>
            ))
          )}
        </div>
      </motion.div>
    </div>
  )
}

export default BanListMenu
