import { useEffect, useState } from 'react'
import './TitleBar.css'
import { IconMinus, IconSquare, IconCopy, IconX } from '@tabler/icons-react'
import NotificationBell from './NotificationBell'
import Inbox from './Inbox'

// Discord-style custom title bar for the frameless main window. The left side
// hosts the notification bell (pinned far-left) plus a drag region; the center
// shows an app icon + title (both configurable via props); the right side hosts
// the minimize / maximize-restore / close controls. Drag regions use
// -webkit-app-region: drag in CSS; the buttons opt out.
function TitleBar({
  title,
  icon: Icon,
  notifications = [],
  onClearNotifications,
  onOpenNotification,
  dmNotifications = [],
  silentNotifications = false,
  onOpenDmNotification,
  onClearDmNotifications
}) {
  const ipc = window.electron?.ipcRenderer
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!ipc) return
    ipc.invoke('window-is-maximized').then((v) => setMaximized(!!v))
    const handler = (_e, value) => setMaximized(!!value)
    ipc.on('window-maximized-change', handler)
    return () => ipc.removeAllListeners('window-maximized-change')
  }, [ipc])

  return (
    <div className="title-bar">
      {/* Left region mirrors the controls' width so the centered title stays
          window-centered: the bell is pinned far-left, the rest is drag space. */}
      <div className="title-bar-controls-left">
        <NotificationBell
          notifications={notifications}
          onClear={onClearNotifications}
          onOpen={onOpenNotification}
          silent={silentNotifications}
        />
        <Inbox
          notifications={dmNotifications}
          onOpen={onOpenDmNotification}
          onClear={onClearDmNotifications}
          silent={silentNotifications}
        />
        <div className="title-bar-left-fill" aria-hidden="true" />
      </div>
      <div className="title-bar-drag">
        {Icon && <Icon size={16} className="title-bar-icon" stroke={2} />}
        <span className="title-bar-text">{title}</span>
      </div>
      <div className="title-bar-controls">
        <button
          type="button"
          className="title-bar-btn"
          onClick={() => ipc?.send('window-minimize')}
          title="Minimize"
        >
          <IconMinus size={16} />
        </button>
        <button
          type="button"
          className="title-bar-btn"
          onClick={() => ipc?.send('window-maximize-toggle')}
          title={maximized ? 'Restore' : 'Maximize'}
        >
          {maximized ? <IconCopy size={14} /> : <IconSquare size={14} />}
        </button>
        <button
          type="button"
          className="title-bar-btn title-bar-close"
          onClick={() => ipc?.send('window-close')}
          title="Close"
        >
          <IconX size={16} />
        </button>
      </div>
    </div>
  )
}

export default TitleBar
