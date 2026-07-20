import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { overlayPop, scrimFade } from '../lib/motionPresets'
import VoiceChannel from './VoiceChannel'
import ClientIndicator from './ClientIndicator'
import ServerMenu from './ServerMenu'
import { setMicMuted, setSoundMuted } from '../lib/soup'
import { playUiSound, setSoundsDeafened } from '../lib/sounds'
import { useAnimationCategory, useSettings } from '../context/SettingsContext'
import { useAnimatedPresence, useBlockShift } from '../lib/animation'
import { keyboardEventToAccelerator, normalizeAccelerator } from '../../../shared/keybinds'
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
  IconX,
  IconFilter,
  IconSearch,
  IconCheck,
  IconUsersGroup
} from '@tabler/icons-react'
import { RoleIcon } from '../lib/roleIcon'

const MIN_WIDTH = 180
const MAX_WIDTH = 550
const DEFAULT_WIDTH = 240

function Sidebar({
  channels,
  clients,
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
  onNotify,
  onViewServerTraffic,
  onViewServerSummary,
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
  onGag,
  onBan,
  onUnban,
  onError,
  onSetAvatar,
  onShowClientSummary,
  roles,
  onAssignRole,
  onRemoveRole,
  vanity,
  onToggleVanity,
  onOpenRolesGroups,
  bannedUsers = [],
  canKickMembers,
  canBanMembers,
  canMuteMembers,
  previewChannelId,
  summaryChannelId,
  unreadChannelIds
}) {
  const { keybindSettings } = useSettings()
  const [width, setWidth] = useState(() => {
    const saved = localStorage.getItem('sidebar-width')
    return saved ? parseInt(saved) : DEFAULT_WIDTH
  })

  const [joinedChannelId, setJoinedChannelId] = useState(null)
  const [sharing, setSharing] = useState(false)
  // You can't be sharing without a joined channel. When the joined channel clears
  // — leave, kick, or a server disconnect that unmounts the VoiceChannel without
  // routing through onSharingChange — force sharing off so the dock button
  // reverts from "End Stream" to "Start Stream".
  useEffect(() => {
    if (!joinedChannelId) setSharing(false)
  }, [joinedChannelId])
  const [micMuted, setMicMutedState] = useState(false)
  const [soundMuted, setSoundMutedState] = useState(false)
  const channelRefs = useRef({})

  // Which list the sidebar body shows: the channel tree or a flat roster of every
  // connected client. Toggled by the segmented control in the section header.
  const [pickedView, setPickedView] = useState('channels')
  // Disconnecting hides the tabs, so fall back to channels rather than stranding
  // the user on a roster they can no longer switch away from.
  const sidebarView = connectedServer ? pickedView : 'channels'

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
    setDropTarget((prev) => (prev?.id === next?.id && prev?.edge === next?.edge ? prev : next))
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
    micMutedRef.current = next
    setMicMutedState(next)
    playUiSound(next ? 'mic-mute' : 'mic-unmute')
  }, [])

  const toggleSound = useCallback(() => {
    const next = !soundMutedRef.current
    soundMutedRef.current = next
    setSoundMutedState(next)
    playUiSound(next ? 'sound-mute' : 'sound-unmute')
  }, [])

  // Keep both global and focused-window shortcuts on one action path. A working
  // Wayland portal can report the same focused keystroke just after the DOM
  // event, so suppress that cross-backend duplicate instead of toggling twice.
  const lastKeybindTrigger = useRef({ action: null, source: null, time: 0 })
  const runKeybindAction = useCallback(
    (action, source) => {
      const now = performance.now()
      const previous = lastKeybindTrigger.current
      if (previous.action === action && previous.source !== source && now - previous.time < 500) {
        return
      }
      lastKeybindTrigger.current = { action, source, time: now }

      if (action === 'toggleMicMute') toggleMic()
      else if (action === 'toggleSoundMute') toggleSound()
    },
    [toggleMic, toggleSound]
  )

  // The main process owns the OS-wide keyboard hook and tells us which action
  // fired (see main/keybinds.js).
  useEffect(() => {
    const off = window.electron?.ipcRenderer?.on('keybinds:trigger', (_e, action) => {
      runKeybindAction(action, 'global')
    })
    return () => off?.()
  }, [runKeybindAction])

  // Also activate saved shortcuts from ordinary DOM keyboard events while the
  // app is focused. Wayland always permits these events, so controls remain
  // usable even when the compositor/portal cannot provide a global shortcut.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.repeat || event.defaultPrevented) return

      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
      ) {
        return
      }

      const accelerator = keyboardEventToAccelerator(event)
      if (!accelerator) return
      const action = Object.entries(keybindSettings).find(
        ([, bound]) => bound && normalizeAccelerator(bound) === accelerator
      )?.[0]
      if (!action) return

      event.preventDefault()
      runKeybindAction(action, 'focused')
    }

    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [keybindSettings, runKeybindAction])

  // Apply mute state to soup whenever it changes. Deafening (soundMuted)
  // also silences the mic, regardless of the independent mic-mute toggle.
  useEffect(() => {
    setMicMuted(micMuted || soundMuted)
  }, [micMuted, soundMuted])

  useEffect(() => {
    setSoundMuted(soundMuted)
    // Deafening also silences notification sounds (message/channel/stream); the
    // sounds module gates on this the way soup.js gates remote audio.
    setSoundsDeafened(soundMuted)
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

  // Roster filter. Ids are prefixed ('r<id>' role, 'g<id>' group) so one Set covers
  // both lists. Empty = no filter; otherwise a client shows if it matches ANY pick.
  const [filterOpen, setFilterOpen] = useState(false)
  const [filterIds, setFilterIds] = useState(() => new Set())
  const [search, setSearch] = useState('')
  const filterRef = useRef(null)

  const toggleFilter = (key) =>
    setFilterIds((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })

  // Close the filter popover on outside click, and whenever we leave the Users view.
  useEffect(() => {
    if (!filterOpen) return
    const close = (e) => {
      if (filterRef.current && !filterRef.current.contains(e.target)) setFilterOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [filterOpen])

  // Roster entry passes when it matches the role/group picks AND the search text.
  const query = search.trim().toLowerCase()
  const matchesFilter = (c) =>
    (filterIds.size === 0 ||
      (c.role_ids || []).some((id) => filterIds.has(`r${id}`)) ||
      (c.vanity_ids || []).some((id) => filterIds.has(`g${id}`))) &&
    (query === '' || (c.name || '').toLowerCase().includes(query))

  return (
    <aside className="sidebar" ref={sidebarRef} style={{ width }}>
      <div className={`server-header${connectedServer ? '' : ' disconnected'}`}>
        <ServerMenu
          servers={servers}
          connectedServer={connectedServer}
          onConnect={onConnect}
          onDisconnect={onDisconnect}
          onAddServer={onAddServer}
          onEditServer={onEditServer}
          onRemoveServer={onRemoveServer}
          onNotify={onNotify}
          onViewServerTraffic={onViewServerTraffic}
          onViewServerSummary={onViewServerSummary}
        />
      </div>

      {/* Nothing to switch between while disconnected — no channels, no roster. */}
      {connectedServer && (
        <div className="channel-section-label">
          <SegmentedTabs
            className="sidebar-view-tabs"
            ariaLabel="Sidebar view"
            active={sidebarView}
            onChange={(v) => {
              setFilterOpen(false)
              setSearch('')
              setPickedView(v)
            }}
            tabs={[
              { id: 'channels', label: 'Channels' },
              { id: 'users', label: 'Users' }
            ]}
          />
          {connectedServer &&
            (sidebarView === 'users' ? (
              <button
                type="button"
                className={`channel-add-btn${filterIds.size > 0 ? ' active' : ''}`}
                title={filterIds.size > 0 ? `Filtering by ${filterIds.size}` : 'Filter users'}
                // Keep the outside-click handler from closing on mousedown only for
                // onClick to immediately toggle it back open.
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setFilterOpen((v) => !v)}
              >
                <IconFilter size={16} stroke={2.2} />
              </button>
            ) : (
              <button
                type="button"
                className="channel-add-btn"
                title="Add channel"
                onClick={() => openCreateChannel()}
              >
                <IconPlus size={16} stroke={2.2} />
              </button>
            ))}
          {filterOpen && sidebarView === 'users' && (
            <div className="client-context-menu user-filter-menu" ref={filterRef}>
              <div className="client-context-menu-header">Filter by</div>
              <div className="user-filter-scroll">
              {roles.length === 0 && vanity.length === 0 && (
                <div className="client-role-empty">No roles or groups</div>
              )}
              {roles.length > 0 && <div className="user-filter-section">Roles</div>}
              {roles.map((r) => (
                <button
                  key={`r${r.id}`}
                  type="button"
                  className="client-context-menu-item"
                  onClick={() => toggleFilter(`r${r.id}`)}
                >
                  <IconCheck
                    size={16}
                    style={{ visibility: filterIds.has(`r${r.id}`) ? 'visible' : 'hidden' }}
                  />
                  <RoleIcon role={r} size={16} />
                  {r.name}
                </button>
              ))}
              {vanity.length > 0 && <div className="user-filter-section">Groups</div>}
              {vanity.map((g) => (
                <button
                  key={`g${g.id}`}
                  type="button"
                  className="client-context-menu-item"
                  onClick={() => toggleFilter(`g${g.id}`)}
                >
                  <IconCheck
                    size={16}
                    style={{ visibility: filterIds.has(`g${g.id}`) ? 'visible' : 'hidden' }}
                  />
                  {g.avatar ? (
                    <img src={g.avatar} alt="" className="client-group-icon" />
                  ) : (
                    <IconUsersGroup size={16} />
                  )}
                  {g.name}
                </button>
              ))}
              {filterIds.size > 0 && (
                <button
                  type="button"
                  className="client-context-menu-item danger"
                  onClick={() => setFilterIds(new Set())}
                >
                  <IconX size={16} />
                  Clear filters
                </button>
              )}
              </div>
            </div>
          )}
        </div>
      )}

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
            clients={clients
              .filter((c) => c.channel_id === ch.id)
              .sort((a, b) => (a.name || '').localeCompare(b.name || ''))}
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
            onGag={onGag}
            onBan={onBan}
            onUnban={onUnban}
            onSetAvatar={onSetAvatar}
            onShowClientSummary={onShowClientSummary}
            roles={roles}
            onAssignRole={onAssignRole}
            onRemoveRole={onRemoveRole}
            vanity={vanity}
            onToggleVanity={onToggleVanity}
            onOpenRolesGroups={onOpenRolesGroups}
            canKickMembers={canKickMembers}
            canBanMembers={canBanMembers}
            canMuteMembers={canMuteMembers}
            previewing={previewChannelId === ch.id || summaryChannelId === ch.id}
            unread={!!unreadChannelIds?.has(ch.id)}
            onError={onError}
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
        <div className="sidebar-search">
          <IconSearch size={15} stroke={2} />
          <input
            type="search"
            value={search}
            placeholder="Search users"
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                // Clear before the app-level Escape closes something underneath.
                e.preventDefault()
                e.stopPropagation()
                setSearch('')
              }
            }}
          />
          {search && (
            <button
              type="button"
              className="sidebar-search-clear"
              title="Clear search"
              aria-label="Clear search"
              onClick={() => setSearch('')}
            >
              <IconX size={14} stroke={2.2} />
            </button>
          )}
        </div>
      )}

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
            ]
              .filter(({ client: c }) => matchesFilter(c))
              .sort((a, b) => (a.client.name || '').localeCompare(b.client.name || ''))
            if (entries.length === 0 && (filterIds.size > 0 || query)) {
              return <div className="sidebar-user-empty">No matching users</div>
            }
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
                onGag={onGag}
                onBan={onBan}
                onUnban={onUnban}
                onSetAvatar={onSetAvatar}
                onShowClientSummary={onShowClientSummary}
                roles={roles}
                onAssignRole={onAssignRole}
                onRemoveRole={onRemoveRole}
                vanity={vanity}
                onToggleVanity={onToggleVanity}
                onOpenRolesGroups={onOpenRolesGroups}
                canKickMembers={canKickMembers}
                canBanMembers={canBanMembers}
                canMuteMembers={canMuteMembers}
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
            className={`control-btn${sharing ? ' streaming' : ''}`}
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitCreateChannel()
                      else if (e.key === 'Escape') setShowCreateChannel(false)
                    }}
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
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') submitCreateChannel()
                      else if (e.key === 'Escape') setShowCreateChannel(false)
                    }}
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
