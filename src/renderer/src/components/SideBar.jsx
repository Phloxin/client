import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { overlayPop, scrimFade } from '../lib/motionPresets'
import VoiceChannel from './VoiceChannel'
import ClientIndicator from './ClientIndicator'
import ServerMenu from './ServerMenu'
import { setMicMuted, setSoundMuted } from '../lib/soup'
import { playUiSound } from '../lib/sounds'
import { useAnimationCategory } from '../context/SettingsContext'
import { useAnimatedPresence, useBlockShift } from '../lib/animation'
import SegmentedTabs from './SegmentedTabs'
import './SideBar.css'
import {
  IconSettings,
  IconDoorExit,
  IconHeadphones,
  IconHeadphonesOff,
  IconMicrophone,
  IconMicrophoneOff,
  IconScreenShare,
  IconScreenShareOff,
  IconPlus,
  IconX
} from '@tabler/icons-react'

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
  onSelfChannelChange,
  servers,
  connectedServer,
  onConnect,
  onDisconnect,
  onAddServer,
  onEditServer,
  onRemoveServer,
  onCreateChannel,
  onDeleteChannel,
  onReorderChannel,
  onMoveClient,
  onPreviewChannel,
  onShowChannelSummary,
  onOpenDm,
  onPoke,
  onKick,
  onKickFromChannel,
  onBan,
  onUnban,
  onSetAvatar,
  onShowClientSummary,
  roles,
  onAssignRole,
  onRemoveRole,
  bannedUsers = [],
  canKickMembers,
  canBanMembers,
  previewChannelId,
  unreadChannelIds
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

  // Which list the sidebar body shows: the channel tree or a flat roster of every
  // connected client. Toggled by the segmented control in the section header.
  const [sidebarView, setSidebarView] = useState('channels')

  // Create-channel modal (opened from the section "+" or a channel's right-click
  // "Add Channel"). user_limit of 0 means unlimited.
  const [showCreateChannel, setShowCreateChannel] = useState(false)
  const [channelName, setChannelName] = useState('')
  const [channelLimit, setChannelLimit] = useState(0)
  const [channelError, setChannelError] = useState(null)
  // Position of the channel the create was launched from (via its right-click
  // "Add Channel"); the new channel is inserted just below it. null = append.
  const [createAfterPos, setCreateAfterPos] = useState(null)

  const openCreateChannel = (afterPos = null) => {
    setChannelName('')
    setChannelLimit(0)
    setChannelError(null)
    setCreateAfterPos(typeof afterPos === 'number' ? afterPos : null)
    setShowCreateChannel(true)
  }

  const submitCreateChannel = () => {
    const name = channelName.trim()
    if (!name) {
      setChannelError('Channel name is required.')
      return
    }
    onCreateChannel?.({
      name,
      user_limit: Math.max(0, Number(channelLimit) || 0),
      afterPosition: createAfterPos
    })
    setShowCreateChannel(false)
  }

  const channelAnimEnabled = useAnimationCategory('channelList')
  const overlayAnim = useAnimationCategory('overlays')

  // Memoized so the reference is stable for the presence hook's effect. DMs are
  // channels of type 'dm' — they're opened by double-clicking a user, not listed
  // here, so keep them out of the channel tree.
  const sortedChannels = useMemo(
    () =>
      channels.filter((c) => c.type !== 'dm').sort((a, b) => (a.position ?? 0) - (b.position ?? 0)),
    [channels]
  )

  // Channels pop in on connect / add; removals are instant (the hook has no exit
  // phase) since the bulk exit on disconnect looked bad.
  const channelPresence = useAnimatedPresence(sortedChannels, (ch) => ch.id, {
    enabled: channelAnimEnabled
  })
  const channelOrderKey = channelPresence.map((c) => c.key).join(',')

  // A reordered channel keeps its key, so useAnimatedPresence won't re-tag it
  // 'entering' — detect the move ourselves by diffing the render order against
  // the previous one, purely from the channel state the server broadcast. The
  // animation is therefore identical whether we dragged the channel or a remote
  // client did: the moved row replays the pop-in at its new slot, and useBlockShift
  // (which skips 'entering' rows) slides only the displaced siblings. Detection
  // happens during render (render-phase setState) so the tag lands in the same
  // commit as the new order — the pop never plays at the old position.
  const [movedChannelId, setMovedChannelId] = useState(null)
  const prevOrderRef = useRef(null)
  const orderKeys = channelPresence.map((c) => c.key)
  if (prevOrderRef.current == null) {
    prevOrderRef.current = orderKeys
  } else if (prevOrderRef.current.join(',') !== channelOrderKey) {
    const prev = prevOrderRef.current
    prevOrderRef.current = orderKeys
    // Same set of keys in a different order = a reorder (adds/removes are
    // handled by the presence hook). The moved channel is the one whose removal
    // makes both sequences identical. An adjacent swap is ambiguous (either row
    // qualifies) — the first match pops, the other slides; both look clean.
    const sameSet = prev.length === orderKeys.length && prev.every((k) => orderKeys.includes(k))
    if (channelAnimEnabled && sameSet) {
      const moved = orderKeys.find((x) => {
        const a = prev.filter((k) => k !== x)
        const b = orderKeys.filter((k) => k !== x)
        return a.every((k, i) => k === b[i])
      })
      if (moved != null) setMovedChannelId(moved)
    }
  }
  // Demote once the pop has played (mirrors useAnimatedPresence's enter window).
  useEffect(() => {
    if (movedChannelId == null) return
    const t = setTimeout(() => setMovedChannelId(null), 320)
    return () => clearTimeout(t)
  }, [movedChannelId])

  // Drag-to-reorder channels. dropTarget marks which gap the dragged channel
  // would land in ({ id, edge: 'before' | 'after' }); the drop sends the target
  // position to the server, which reindexes the rest and broadcasts the updates.
  const [dragId, setDragId] = useState(null)
  const [dropTarget, setDropTarget] = useState(null)

  const handleChannelDragStart = (id) => (e) => {
    setDragId(id)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', String(id)) // Firefox needs data to start a drag
  }

  // The absolute 0-based slot the dragged channel would land in for a hover over
  // `targetId`'s `edge` — this is exactly the `position` the server's MoveTo wants
  // (it shifts the affected siblings by ±1 to open that slot). Returns null when
  // the drop wouldn't move it: the two gaps touching the dragged channel resolve
  // to its current slot, so no indicator is shown there.
  const dropPositionFor = (targetId, edge) => {
    if (dragId == null) return null
    const dragIndex = sortedChannels.findIndex((c) => c.id === dragId)
    const targetIndex = sortedChannels.findIndex((c) => c.id === targetId)
    if (dragIndex === -1 || targetIndex === -1) return null
    let position = edge === 'before' ? targetIndex : targetIndex + 1
    // Dropping below the dragged channel's own row: that row vacates, so every slot
    // past it shifts up one.
    if (dragIndex < position) position -= 1
    return position === dragIndex ? null : position
  }

  const handleChannelDragOver = (id) => (e) => {
    if (dragId == null) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const edge = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
    // Suppress the indicator on no-op gaps (adjacent to the dragged channel).
    const next = dropPositionFor(id, edge) == null ? null : { id, edge }
    setDropTarget((prev) =>
      prev?.id === next?.id && prev?.edge === next?.edge ? prev : next
    )
  }
  const handleChannelDrop = (e) => {
    e.preventDefault()
    if (dragId == null || dropTarget == null) return
    const position = dropPositionFor(dropTarget.id, dropTarget.edge)
    if (position == null) return
    onReorderChannel?.(dragId, position)
  }
  const handleChannelDragEnd = () => {
    setDragId(null)
    setDropTarget(null)
  }

  // Single toggle path for mic/sound mute, shared by the control buttons and the
  // global keybind listener. Refs hold the latest value so the listener (bound
  // once) never reads stale state.
  const micMutedRef = useRef(micMuted)
  const soundMutedRef = useRef(soundMuted)
  useEffect(() => {
    micMutedRef.current = micMuted
  }, [micMuted])
  useEffect(() => {
    soundMutedRef.current = soundMuted
  }, [soundMuted])

  const toggleMic = useCallback(() => {
    const next = !micMutedRef.current
    setMicMutedState(next)
    playUiSound(next ? 'mic-mute' : 'mic-unmute')
  }, [])

  const toggleSound = useCallback(() => {
    const next = !soundMutedRef.current
    setSoundMutedState(next)
    playUiSound(next ? 'sound-mute' : 'sound-unmute')
  }, [])

  // The main process owns the OS-wide keyboard hook and tells us which action
  // fired (see main/keybinds.js). We just run the matching toggle.
  useEffect(() => {
    const off = window.electron?.ipcRenderer?.on('keybinds:trigger', (_e, action) => {
      if (action === 'toggleMicMute') toggleMic()
      else if (action === 'toggleSoundMute') toggleSound()
    })
    return () => off?.()
  }, [toggleMic, toggleSound])

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

  // The channel the server says we're in (authoritative roster) can diverge from
  // the channel our live voice session is joined to when a moderator moves us
  // (PATCH /client). When that happens, adopt the new channel so our session and
  // the joined/active UI follow the move. Self-initiated joins/switches route
  // joinedChannelId through null first, so this never fires for those.
  const selfServerChannelId = clients.find((c) => c.id === self?.id)?.channel_id ?? null
  useEffect(() => {
    if (joinedChannelId == null || selfServerChannelId === joinedChannelId) return
    if (selfServerChannelId == null) {
      // Moved out of every channel — leave voice locally.
      channelRefs.current[joinedChannelId]?.leave()
      return
    }
    channelRefs.current[joinedChannelId]?.deactivate()
    channelRefs.current[selfServerChannelId]?.adopt()
  }, [selfServerChannelId, joinedChannelId])

  const isDragging = useRef(false)
  const sidebarRef = useRef(null)

  // Slide displaced channels to their new positions as one synchronized block
  // when the order changes (a move's shifted siblings, or the rows below an
  // insertion). The moved/added row itself is skipped ('entering' pops instead),
  // so rows never slide through one another.
  useBlockShift(sidebarRef, channelOrderKey, {
    selector: '.channel-item[data-flip-key]',
    enabled: channelAnimEnabled
  })

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
        <SegmentedTabs
          className="sidebar-view-tabs"
          ariaLabel="Sidebar view"
          active={sidebarView}
          onChange={setSidebarView}
          tabs={[
            { id: 'channels', label: 'Channels' },
            { id: 'users', label: 'Users' }
          ]}
        />
        {connectedServer && (
          <button
            type="button"
            className="channel-add-btn"
            title="Add channel"
            onClick={() => openCreateChannel()}
          >
            <IconPlus size={16} stroke={2.2} />
          </button>
        )}
      </div>

      {/* Keep the channel list mounted across view switches. Unmounting it would
          run VoiceChannel's unmount cleanup, which calls disconnect() and tears
          down the live voice session. display:contents keeps the channels as
          direct flex children of the sidebar when shown; .hidden collapses them. */}
      <div className={`sidebar-channel-list${sidebarView === 'channels' ? '' : ' hidden'}`}>
        {channelPresence.map(({ key, item: ch, status }) => (
          <VoiceChannel
            key={key}
            ref={(el) => {
              channelRefs.current[ch.id] = el
            }}
            animStatus={movedChannelId === ch.id ? 'entering' : status}
            channel={ch}
            draggable
            onDragStart={handleChannelDragStart(ch.id)}
            onDragOver={handleChannelDragOver(ch.id)}
            onDrop={handleChannelDrop}
            onDragEnd={handleChannelDragEnd}
            dragging={dragId === ch.id}
            dropEdge={dropTarget?.id === ch.id && dragId !== ch.id ? dropTarget.edge : null}
            clients={clients.filter((c) => c.channel_id === ch.id)}
            token={token}
            self={self}
            micMuted={micMuted}
            deafened={soundMuted}
            onSelfChannelChange={onSelfChannelChange}
            onDeleteChannel={onDeleteChannel}
            onRequestCreateChannel={openCreateChannel}
            onShowChannelSummary={onShowChannelSummary}
            onMoveClient={onMoveClient}
            onPreviewChannel={onPreviewChannel}
            onOpenDm={onOpenDm}
            onPoke={onPoke}
            onKick={onKick}
            onKickFromChannel={onKickFromChannel}
            onBan={onBan}
            onUnban={onUnban}
            onSetAvatar={onSetAvatar}
            onShowClientSummary={onShowClientSummary}
            roles={roles}
            onAssignRole={onAssignRole}
            onRemoveRole={onRemoveRole}
            canKickMembers={canKickMembers}
            canBanMembers={canBanMembers}
            previewing={previewChannelId === ch.id}
            unread={!!unreadChannelIds?.has(ch.id)}
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
      </div>

      {sidebarView === 'users' && (
        <div className="sidebar-user-list">
          {(() => {
            // Connected clients plus any banned users not currently connected.
            // Banned entries carry isBanned so their menu collapses to Unban.
            const connectedIds = new Set(clients.map((c) => c.id))
            const entries = [
              ...clients.map((c) => ({ client: c, banned: false })),
              ...bannedUsers
                .filter((u) => !connectedIds.has(u.id))
                .map((u) => ({ client: u, banned: true }))
            ].sort((a, b) => (a.client.name || '').localeCompare(b.client.name || ''))
            return entries.map(({ client: c, banned }) => (
              <ClientIndicator
                key={c.id}
                client={c}
                isSelf={c.id === self?.id}
                rosterMode
                isBanned={banned}
                onOpenDm={onOpenDm}
                onPoke={onPoke}
                onKick={onKick}
                onBan={onBan}
                onUnban={onUnban}
                onSetAvatar={onSetAvatar}
                onShowClientSummary={onShowClientSummary}
                roles={roles}
                onAssignRole={onAssignRole}
                onRemoveRole={onRemoveRole}
                canKickMembers={canKickMembers}
                canBanMembers={canBanMembers}
              />
            ))
          })()}
          {clients.length === 0 && bannedUsers.length === 0 && (
            <div className="sidebar-user-empty">No users connected</div>
          )}
        </div>
      )}

      <div className="control-dock">
        <div className="dock-actions">
          <button
            className={`control-btn${micMuted ? ' active' : ''}`}
            title={micMuted ? 'Unmute Microphone' : 'Mute Microphone'}
            onClick={toggleMic}
          >
            {micMuted ? (
              <IconMicrophoneOff className="control-icon" size={18} />
            ) : (
              <IconMicrophone className="control-icon" size={18} />
            )}
          </button>
          <button
            className={`control-btn${soundMuted ? ' active' : ''}`}
            title={soundMuted ? 'Unmute Sound' : 'Mute Sound'}
            onClick={toggleSound}
          >
            {soundMuted ? (
              <IconHeadphonesOff className="control-icon" size={18} />
            ) : (
              <IconHeadphones className="control-icon" size={18} />
            )}
          </button>
          <button
            className="control-btn"
            title={sharing ? 'End Stream' : 'Start Stream'}
            disabled={!joinedChannelId}
            onClick={() => channelRefs.current[joinedChannelId]?.toggleShare()}
          >
            {sharing ? (
              <IconScreenShareOff className="control-icon" size={18} />
            ) : (
              <IconScreenShare className="control-icon" size={18} />
            )}
          </button>
          <button
            className="control-btn"
            title="Leave Channel"
            disabled={!joinedChannelId}
            onClick={() => channelRefs.current[joinedChannelId]?.leave()}
          >
            <IconDoorExit size={18} />
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
            <IconSettings size={18} />
          </button>
        </div>
      </div>
      <div className="sidebar-resize-handle" onMouseDown={onMouseDown} />

      <AnimatePresence>
        {showCreateChannel && (
          <motion.div
            className="add-server-overlay"
            onClick={() => setShowCreateChannel(false)}
            {...scrimFade(overlayAnim)}
          >
            <motion.div
              className="add-server-modal"
              onClick={(e) => e.stopPropagation()}
              {...overlayPop(overlayAnim)}
            >
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
                <button
                  className="add-server-btn secondary"
                  onClick={() => setShowCreateChannel(false)}
                >
                  Cancel
                </button>
                <button className="add-server-btn primary" onClick={submitCreateChannel}>
                  Create
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </aside>
  )
}

export default Sidebar
