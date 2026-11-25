/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  IconChevronRight,
  IconDeviceGamepad2,
  IconPaperclip,
  IconPlus,
  IconUsers
} from '@tabler/icons-react'
import './ComposerPlusMenu.css'

// Gap kept between the menus and the window edge.
const MARGIN = 8

// "2 players", or "2 to 4 players" when the range is open. Nothing for an activity with no players
// (a max of 0, such as Watch Together).
function playerCount({ min, max } = {}) {
  if (min == null && max == null) return null
  if (max === 0) return null
  const lo = min ?? max
  const hi = max ?? min
  if (lo === hi) return `${lo} player${lo === 1 ? '' : 's'}`
  return `${lo} to ${hi} players`
}

// The composer's + button: Attach, and Activities with the channel's open rooms and what can be
// started. `access` is 'ok', 'unsupported' (the server has no room protocol this client speaks:
// Activities is disabled) or 'forbidden' (no CREATE_ACTIVITY: rooms can be joined, nothing
// started).
function ComposerPlusMenu({
  disabled,
  onAttach,
  catalog = [],
  rooms = [],
  roomTabs,
  access = 'ok',
  nameOf,
  onStartActivity,
  onJoinRoom
}) {
  const [open, setOpen] = useState(false)
  const [sub, setSub] = useState(false)
  const [anchor, setAnchor] = useState(null)
  const [left, setLeft] = useState(null)
  const rootRef = useRef(null)
  const buttonRef = useRef(null)
  const menusRef = useRef(null)

  const close = () => {
    setOpen(false)
    setSub(false)
  }

  // A disabled composer shows no menu.
  const shown = open && !disabled

  useEffect(() => {
    if (!shown) return
    const onDown = (e) => {
      if (rootRef.current?.contains(e.target)) return
      setOpen(false)
      setSub(false)
    }
    // Before the app's own Escape handling, which would otherwise close a preview tab.
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      setOpen(false)
      setSub(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [shown])

  // Above the button, pulled back inside the window when the submenu makes it wide.
  useLayoutEffect(() => {
    const el = menusRef.current
    if (!shown || !anchor || !el) return
    const width = el.offsetWidth
    setLeft(Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - width - MARGIN)))
  }, [shown, sub, anchor, rooms.length, catalog.length])

  const toggle = () => {
    if (shown) return close()
    setAnchor(buttonRef.current?.getBoundingClientRect() ?? null)
    setLeft(null)
    setOpen(true)
  }

  const unsupported = access === 'unsupported'
  const forbidden = access === 'forbidden'

  return (
    <div className="composer-plus" ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        className={`chat-icon-btn${shown ? ' active' : ''}`}
        title="Attach or start an activity"
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={shown}
      >
        <IconPlus size={20} />
      </button>
      {shown && anchor && (
        <div
          className="composer-plus-menus"
          ref={menusRef}
          style={{
            left: left ?? anchor.left,
            bottom: window.innerHeight - anchor.top + 6,
            visibility: left == null ? 'hidden' : undefined
          }}
        >
          <div className="client-context-menu composer-plus-menu" role="menu">
            <button
              type="button"
              className="client-context-menu-item"
              role="menuitem"
              onClick={() => {
                close()
                onAttach?.()
              }}
            >
              <IconPaperclip size={16} />
              Attach
            </button>
            <button
              type="button"
              className={`client-context-menu-item${sub ? ' active' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={sub}
              disabled={unsupported}
              title={unsupported ? 'This server does not support activities' : undefined}
              onClick={() => setSub((s) => !s)}
            >
              <IconDeviceGamepad2 size={16} />
              Activities
              <IconChevronRight size={14} className="client-context-menu-trailing" />
            </button>
          </div>
          {sub && !unsupported && (
            <div className="client-context-menu composer-activities-menu" role="menu">
              {rooms.length > 0 && (
                <>
                  <div className="composer-menu-heading">In this channel</div>
                  {rooms.map((room) => {
                    const activity = catalog.find((a) => a.id === room.activity_id)
                    return (
                      <div key={room.id} className="composer-room-row">
                        <div className="composer-room-text">
                          <span className="composer-room-name">
                            {activity?.name ?? room.activity_id}
                          </span>
                          <span className="composer-room-meta">
                            <span className="composer-room-creator">
                              {nameOf?.(room.creator) || 'Unknown'}
                            </span>
                            <span className="composer-room-count">
                              <IconUsers size={12} />
                              {room.clients.length}
                            </span>
                          </span>
                        </div>
                        <button
                          type="button"
                          className="composer-room-join"
                          onClick={() => {
                            close()
                            onJoinRoom?.(room.id)
                          }}
                        >
                          {roomTabs?.has(room.id) ? 'Open' : 'Join'}
                        </button>
                      </div>
                    )
                  })}
                  <div className="client-context-menu-divider" aria-hidden="true" />
                </>
              )}
              <div className="composer-menu-heading">Start an activity</div>
              {catalog.map((activity) => (
                <button
                  key={activity.id}
                  type="button"
                  className="client-context-menu-item composer-activity-item"
                  role="menuitem"
                  disabled={forbidden}
                  title={forbidden ? "You can't start activities here" : undefined}
                  onClick={() => {
                    close()
                    onStartActivity?.(activity.id)
                  }}
                >
                  <span className="composer-activity-name">{activity.name}</span>
                  <span className="composer-activity-players">
                    {playerCount(activity.required_clients)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default ComposerPlusMenu
