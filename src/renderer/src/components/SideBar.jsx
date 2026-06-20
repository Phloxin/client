import { useState, useRef, useEffect, useCallback } from 'react'
import VoiceChannel from './VoiceChannel'
import ServerMenu from './ServerMenu'
import { setMicMuted, setSoundMuted } from '../lib/soup'
import './SideBar.css'
import {IconSettings, IconShield, IconDoorExit, IconHeadphones, IconHeadphonesOff, IconMicrophone, IconMicrophoneOff, IconScreenShare, IconScreenShareOff, IconPlus, IconX} from '@tabler/icons-react'

const MIN_WIDTH = 180
const MAX_WIDTH = 550
const DEFAULT_WIDTH = 240

function Sidebar({
  channels,
  clients,
  token,
  self,
  onStreamsUpdate,
  onOpenSettings,
  onStatusChange,
  servers,
  connectedServer,
  onConnect,
  onDisconnect,
  onAddServer,
  onEditServer,
  onRemoveServer,
  onCreateChannel,
  onDeleteChannel,
  onPreviewChannel,
  previewChannelId
}) {
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width')
    return saved ? parseInt(saved) : DEFAULT_WIDTH
  })

  const [joinedChannelId, setJoinedChannelId] = useState(null)
  const [sharing, setSharing] = useState(false)
  const [micMuted, setMicMutedState] = useState(false)
  const [soundMuted, setSoundMutedState] = useState(false)
  const channelRefs = useRef({})

  // Create-channel modal (opened from the section "+" or a channel's right-click
  // "Add Channel"). user_limit of 0 means unlimited.
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [channelLimit, setChannelLimit] = useState(0)
  const [channelError, setChannelError] = useState(null)

  const openCreateChannel = () => {
    setChannelName('')
    setChannelLimit(0)
    setChannelError(null)
    setShowCreateChannel(true)
  }

  const submitCreateChannel = () => {
    const name = channelName.trim()
    if (!name) {
      setChannelError('Channel name is required.')
      return
    }
    onCreateChannel?.({ name, user_limit: Math.max(0, Number(channelLimit) || 0) })
    setShowCreateChannel(false)
  }

  // Channels render in server-defined order.
  const sortedChannels = [...channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

  // Apply mute state to soup whenever it changes. Deafening (soundMuted)
  // also silences the mic, regardless of the independent mic-mute toggle.
  useEffect(() => {
    setMicMuted(micMuted || soundMuted)
  }, [micMuted, soundMuted])

  useEffect(() => {
    setSoundMuted(soundMuted)
  }, [soundMuted])

  // Let other clients know our mic-mute / deafen status
  useEffect(() => {
    onStatusChange?.(micMuted, soundMuted)
  }, [micMuted, soundMuted])

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
        <ServerMenu
          servers={servers}
          connectedServer={connectedServer}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onAddServer={onAddServer}
          onEditServer={onEditServer}
          onRemoveServer={onRemoveServer}
        />
      </div>

      <div className="channel-section-label">
        <span>Channels</span>
        <span className="channel-section-divider" aria-hidden="true" />
        <button className="channel-add-btn" title="Add channel" onClick={openCreateChannel}>
          <IconPlus size={15} />
        </button>
      </div>

      {sortedChannels.map((ch) => (
        <VoiceChannel
          key={ch.id}
          ref={(el) => { channelRefs.current[ch.id] = el }}
          channel={ch}
          clients={clients.filter((c) => c.channel_id === ch.id)}
          token={token}
          self={self}
          micMuted={micMuted}
          deafened={soundMuted}
          onDeleteChannel={onDeleteChannel}
          onRequestCreateChannel={openCreateChannel}
          onPreviewChannel={onPreviewChannel}
          previewing={previewChannelId === ch.id}
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
            {sharing ? <IconScreenShareOff className="control-icon" size={20}/> : <IconScreenShare className="control-icon" size={20}/>}
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
          <button
            className={`control-btn${micMuted ? ' active' : ''}`}
            title={micMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            onClick={() => setMicMutedState((m) => !m)}
          >
            {micMuted ? <IconMicrophoneOff className="control-icon" size={20}/> : <IconMicrophone className="control-icon" size={20}/>}
          </button>
          <button
            className={`control-btn${soundMuted ? ' active' : ''}`}
            title={soundMuted ? 'Unmute Sound' : 'Mute Sound'}
            onClick={() => setSoundMutedState((m) => !m)}
          >
            {soundMuted ? <IconHeadphonesOff className="control-icon" size={20}/> : <IconHeadphones className="control-icon" size={20}/>}
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

      {showCreateChannel && (
        <div className="add-server-overlay" onClick={() => setShowCreateChannel(false)}>
          <div className="add-server-modal" onClick={(e) => e.stopPropagation()}>
            <div className="add-server-header">
              <span className="add-server-title">Add Channel</span>
              <button className="add-server-close" onClick={() => setShowCreateChannel(false)}>
                <IconX size={18} />
              </button>
            </div>

            <div className="add-server-body">
              <label className="add-server-field">
                <span>Name</span>
                <input
                  type="text"
                  value={channelName}
                  placeholder="New Channel"
                  onChange={(e) => setChannelName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCreateChannel()}
                  autoFocus
                />
              </label>
              <label className="add-server-field">
                <span>User limit (0 = unlimited)</span>
                <input
                  type="number"
                  min={0}
                  value={channelLimit}
                  onChange={(e) => setChannelLimit(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitCreateChannel()}
                />
              </label>
              {channelError && <div className="add-server-error">{channelError}</div>}
            </div>

            <div className="add-server-footer">
              <button className="add-server-btn secondary" onClick={() => setShowCreateChannel(false)}>
                Cancel
              </button>
              <button className="add-server-btn primary" onClick={submitCreateChannel}>
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  )
}

export default Sidebar