import { useState, useEffect, useRef } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { useAnimatedPresence } from '../lib/animation'
import { collapseSection, avatarStack, avatarStackItem, spring } from '../lib/motionPresets'
import { assetUrl } from '../lib/serverConfig'
import { useMenuPosition } from '../lib/menuPosition'
import ClientIndicator from './ClientIndicator'
import './VoiceChannel.css'
import {
  IconDiamondsFilled,
  IconPlus,
  IconTrash,
  IconPointFilled,
  IconInfoCircle,
  IconChevronDown,
  IconFiles
} from '@tabler/icons-react'

const STACK_MAX = 3

function VoiceChannel({
  channel,
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  dragging,
  dropEdge,
  clients,
  self,
  liveStreamers,
  micMuted,
  deafened,
  joined,
  error,
  speakingClients,
  tileClientIds,
  onJoin,
  onDeleteChannel,
  onRequestCreateChannel,
  onShowChannelSummary,
  onOpenFiles,
  onMoveClient,
  onPreviewChannel,
  onOpenDm,
  onPoke,
  onKick,
  onKickFromChannel,
  onGag,
  onBan,
  onUnban,
  onSetAvatar,
  onShowClientSummary,
  roles,
  onAssignRole,
  onRemoveRole,
  vanity,
  onToggleVanity,
  onOpenRolesGroups,
  canKickMembers,
  canBanMembers,
  canMuteMembers,
  previewing,
  unread,
  animStatus
}) {
  // Right-click context menu position ({x, y}) or null when closed.
  const [menuPos, setMenuPos] = useState(null)
  // True while a client entry is being dragged over this channel's header (drop
  // to move them here). Distinct from channel drag-to-reorder.
  const [clientDropActive, setClientDropActive] = useState(false)
  // Collapse this channel's user list into a stacked avatar row. Session-only —
  // channels always come back expanded.
  const [collapsed, setCollapsed] = useState(false)

  const clientAnimEnabled = useAnimationCategory('userJoin')
  const clientPresence = useAnimatedPresence(clients, (c) => c.id, {
    enabled: clientAnimEnabled
  })
  // Collapse/expand of the user list rides the channel-list category — it's a
  // sidebar structure change, not a user coming or going.
  const collapseAnimEnabled = useAnimationCategory('channelList')

  const menuRef = useRef(null)
  const menuStyle = useMenuPosition(menuRef, menuPos)

  // Close the right-click menu on an outside click.
  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuPos])

  const handleContextMenu = (e) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  // Client entries carry their id under a custom MIME type so this only reacts to
  // a client drag, never the channel-reorder drag (which uses text/plain).
  const CLIENT_DND_TYPE = 'application/x-client-id'
  const handleClientDragOver = (e) => {
    if (!onMoveClient || !e.dataTransfer.types.includes(CLIENT_DND_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!clientDropActive) setClientDropActive(true)
  }
  const handleClientDrop = (e) => {
    if (!onMoveClient || !e.dataTransfer.types.includes(CLIENT_DND_TYPE)) return
    e.preventDefault()
    e.stopPropagation()
    setClientDropActive(false)
    const clientId = e.dataTransfer.getData(CLIENT_DND_TYPE)
    if (clientId) onMoveClient(clientId, channel.id)
  }

  const handleDoubleClick = () => {
    if (!joined) onJoin(channel.id)
  }

  // The tile owners plus the screen streams the backend announces in this
  // channel, joined or not. Those can only be watched from inside the channel.
  const streamingClientIds = new Set([...tileClientIds, ...(liveStreamers ?? [])])

  return (
    <div
      className={`channel-item${joined ? ' active' : ''}${previewing ? ' previewing' : ''}${dragging ? ' dragging' : ''}${dropEdge ? ` drop-${dropEdge}` : ''}`}
      data-flip-key={channel.id}
      data-anim-status={animStatus}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className={`channel-row${clientDropActive ? ' client-drop-target' : ''}`}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={handleClientDragOver}
        onDragLeave={() => setClientDropActive(false)}
        onDrop={handleClientDrop}
        onClick={() => onPreviewChannel?.(channel.id)}
        onContextMenu={handleContextMenu}
      >
        {channel.channel_icon ? (
          <img className="channel-icon-img" src={assetUrl(channel.channel_icon)} alt="" />
        ) : (
          <IconDiamondsFilled className="channel-icon-placeholder" size={25} />
        )}
        <span className="channel-name">{channel.name}</span>
        <AnimatePresence initial={false}>
          {collapsed && clients.length > 0 && (
            <motion.span className="channel-avatar-stack" {...avatarStack(collapseAnimEnabled)}>
              {clients.slice(0, STACK_MAX).map((c) => (
                <motion.span
                  className="client-avatar"
                  key={c.id}
                  title={c.name}
                  variants={avatarStackItem}
                >
                  {c.avatar ? (
                    <img className="client-avatar-img" src={c.avatar} alt="" aria-hidden="true" />
                  ) : (
                    (c.name || '?').charAt(0).toUpperCase()
                  )}
                </motion.span>
              ))}
              {clients.length > STACK_MAX && (
                <motion.span className="channel-avatar-more" variants={avatarStackItem}>
                  +{clients.length - STACK_MAX}
                </motion.span>
              )}
            </motion.span>
          )}
        </AnimatePresence>
        {/* After the avatar stack so the dot keeps the same slot — hard against
            the chevron — whether the channel is collapsed or expanded. */}
        {unread && (
          <IconPointFilled className="channel-unread-dot" size={12} aria-label="Unread messages" />
        )}
        {clients.length > 0 && (
          <button
            type="button"
            className="channel-collapse-btn"
            title={collapsed ? 'Expand users' : 'Collapse users'}
            aria-expanded={!collapsed}
            onClick={(e) => {
              e.stopPropagation()
              setCollapsed((v) => !v)
            }}
          >
            {/* One chevron that rotates rather than two that swap: +90°
                (clockwise) lands exactly on the left-pointing collapsed state. */}
            <motion.span
              className="channel-collapse-chevron"
              initial={false}
              animate={{ rotate: collapsed ? 90 : 0 }}
              transition={collapseAnimEnabled ? spring : { duration: 0 }}
            >
              <IconChevronDown size={15} />
            </motion.span>
          </button>
        )}
      </div>
      {error && <div className="channel-error">{error}</div>}
      {/* Wrapper exists purely so the user list has a single box to fold; it
          stays mounted through the collapse animation via AnimatePresence. */}
      <AnimatePresence initial={false}>
        {!collapsed && clientPresence.length > 0 && (
          <motion.div className="channel-clients" {...collapseSection(collapseAnimEnabled)}>
            {clientPresence.map(({ key, item: c, status }) => (
              <ClientIndicator
                key={key}
                client={c}
                animStatus={status}
                speaking={!!speakingClients[c.id]}
                micMuted={c.id === self?.id ? micMuted : !!c.self_mute}
                deafened={c.id === self?.id ? deafened : !!c.self_deaf}
                isSelf={c.id === self?.id}
                streaming={streamingClientIds.has(c.id)}
                streamWatchable={tileClientIds.has(c.id)}
                draggableToChannel={!!onMoveClient}
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
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {menuPos && (
        <div className="channel-context-menu" ref={menuRef} style={menuStyle}>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setMenuPos(null)
              onShowChannelSummary?.(channel.id)
            }}
          >
            <IconInfoCircle size={16} /> Channel Details
          </button>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setMenuPos(null)
              onOpenFiles?.(channel.id)
            }}
          >
            <IconFiles size={16} /> Files
          </button>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setMenuPos(null)
              onRequestCreateChannel?.(channel.id)
            }}
          >
            <IconPlus size={16} /> Add Channel
          </button>
          <button
            type="button"
            className="channel-context-item danger"
            onClick={() => {
              setMenuPos(null)
              onDeleteChannel?.(channel.id)
            }}
          >
            <IconTrash size={16} /> Delete Channel
          </button>
        </div>
      )}
    </div>
  )
}

export default VoiceChannel
