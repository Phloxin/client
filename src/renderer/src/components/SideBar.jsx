import { useState, useRef, useEffect, useCallback } from 'react'
import VoiceChannel from './VoiceChannel'
import './SideBar.css'
import {IconSettings, IconShield, IconDoorExit, IconHeadphones, IconHeadphonesOff, IconMicrophone, IconMicrophoneOff, IconScreenShare, IconScreenShareOff} from '@tabler/icons-react'

const MIN_WIDTH = 180
const MAX_WIDTH = 550
const DEFAULT_WIDTH = 240

function Sidebar({ channels, clients, token, self, onStreamsUpdate, onOpenSettings }) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width')
    return saved ? parseInt(saved) : DEFAULT_WIDTH
  })

  const [joinedChannelId, setJoinedChannelId] = useState(null)
  const [sharing, setSharing] = useState(false)
  const channelRefs = useRef({})

  const isDragging = useRef(false)
  const sidebarRef = useRef(null)

  const onMouseDown = useCallback((e) => {
    isDragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    e.preventDefault()
  }, [])

  useEffect(() => {
    const onMouseMove = (e) => {
      if (!isDragging.current || !sidebarRef.current) return
      const rect = sidebarRef.current.getBoundingClientRect()
      const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, e.clientX - rect.left))
      sidebarRef.current.style.width = `${newWidth}px`
    }

    const onMouseUp = () => {
      if (!isDragging.current) return
      isDragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''

      if (sidebarRef.current) {
        const newWidth = parseInt(sidebarRef.current.style.width)
        setWidth(newWidth)
        localStorage.setItem('sidebar-width', newWidth)
      }
    }

    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    return () => {
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
  }, [])

  return (
    <aside className="sidebar" ref={sidebarRef} style={{ width }}>
      <div className="server-header">
        <span className="server-name">CNaps Buddies and Friends</span>
        <span className="server-status" title="Connected" />
      </div>

      <div className="channel-section-label">Channels</div>

      {channels.map((ch) => (
        <VoiceChannel
          key={ch.id}
          ref={(el) => { channelRefs.current[ch.id] = el }}
          channel={ch}
          clients={clients.filter((c) => c.channel_id === ch.id)}
          token={token}
          self={self}
          onStreamsUpdate={(streams) => {
            onStreamsUpdate(ch.id, streams)
          }}
          onJoinedChange={(channelId, joined) => {
            setJoinedChannelId((prev) => {
              if (joined) return channelId
              return prev === channelId ? null : prev
            })
          }}
          onSharingChange={(channelId, isSharing) => {
            if (channelId === joinedChannelId || isSharing) setSharing(isSharing)
          }}
          onRequestJoin={(doJoin, doSwitch) => {
            if (joinedChannelId && joinedChannelId !== ch.id) {
              channelRefs.current[joinedChannelId]?.deactivate()
              doSwitch()
            } else {
              doJoin()
            }
          }}
        />
      ))}

      <div className="control-rows">
        <div className="control-row">
          <button
            className="control-btn"
            title={sharing ? 'End Stream' : 'Start Stream'}
            disabled={!joinedChannelId}
            onClick={() => channelRefs.current[joinedChannelId]?.toggleShare()}
          >
            {sharing ? <IconScreenShareOff size={20}/> : <IconScreenShare size={20}/>}
          </button>
          <button
            className="control-btn"
            title="Leave Channel"
            disabled={!joinedChannelId}
            onClick={() => channelRefs.current[joinedChannelId]?.leave()}
          >
            <IconDoorExit size={20}/>
          </button>
        </div>
        <div className="control-row">
          <button className="control-btn" title="Mute Microphone">
            <IconMicrophoneOff size={20}/>
          </button>
          <button className="control-btn" title="Mute Sound">
            <IconHeadphonesOff size={20}/>
          </button>
          <button
            className="control-btn"
            title="Settings"
            onClick={() => {
              if (typeof onOpenSettings === 'function') {
                onOpenSettings()
              } else if (typeof window.openSettings === 'function') {
                window.openSettings()
              } else {
                // fallback to main process IPC for older behavior
                window.electron.ipcRenderer.send('open-settings')
              }
            }}
          >
            <IconSettings size={20}/>
          </button>
        </div>
      </div>
      <div className="sidebar-resize-handle" onMouseDown={onMouseDown} />
    </aside>
  )
}

export default Sidebar