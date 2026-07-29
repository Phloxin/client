import { useLayoutEffect, useRef } from 'react'
import { IconActivity, IconServer } from '@tabler/icons-react'

// Live log of members coming online / going offline plus moderation events
// (kicks, bans) and channel create/delete, shown while you're in the server but
// not in any voice channel.
// Fed by presence boundary crossings in Main — invisible users report offline,
// so they never surface here as "came online", and going invisible reads as
// "went offline" (same as leaving). Each entry carries its own `action` verb.
function ServerTraffic({ entries, clients }) {
  const listRef = useRef(null)
  // `entries` is newest-first; we render oldest→newest so the latest sits at the
  // bottom. Force to the bottom on open, then stay pinned there as new events
  // arrive unless the user has scrolled up to read history.
  const stickRef = useRef(true)
  useLayoutEffect(() => {
    const el = listRef.current
    if (el && stickRef.current) el.scrollTop = el.scrollHeight
  })
  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  if (!entries.length) {
    return (
      <div className="traffic-empty">
        <IconActivity size={28} stroke={1.5} />
        <p>No recent activity</p>
        <span>Member activity and channel changes will show up here.</span>
      </div>
    )
  }

  return (
    <div className="traffic-list" ref={listRef} onScroll={onScroll}>
      {[...entries].reverse().map((e) => {
        const avatar = clients.find((c) => c.id === e.clientId)?.avatar
        return (
          <div className="traffic-row" key={e.id}>
            <span className="traffic-avatar">
              {avatar ? (
                <img src={avatar} alt="" aria-hidden="true" />
              ) : e.online === null ? (
                <IconServer size={16} stroke={2} />
              ) : (
                (e.name?.charAt(0).toUpperCase() ?? '?')
              )}
              {e.online !== null && (
                <span className={`presence-dot presence-${e.online ? 'online' : 'offline'}`} />
              )}
            </span>
            <span className="traffic-text">
              {/* Channel rows read "Channel <name> was created"; member rows have no prefix. */}
              {e.online === null && <span className="traffic-action">Channel</span>}
              <span className="traffic-name">{e.name}</span>
              <span className="traffic-action">{e.action}</span>
            </span>
            <time className="traffic-time">
              {new Date(e.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </time>
          </div>
        )
      })}
    </div>
  )
}

export default ServerTraffic
