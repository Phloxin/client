import { useState, useRef, useEffect } from 'react'
import {
  IconMicrophoneOff,
  IconHeadphonesOff,
  IconMicrophoneFilled,
  IconMicrophone,
  IconVolumeOff,
  IconVideoFilled,
  IconMoodSilence,
  IconUsersGroup,
  IconMessageCircleFilled
} from '@tabler/icons-react'
import { setClientAudioState, getClientAudioState } from '../lib/soup'
import { useClientMenu } from './ClientContextMenu'
import { useSettings } from '../context/SettingsContext'
import { useClientActions } from '../context/ClientActionsContext'

// rosterMode renders a presence-only entry (the sidebar's Users tab): no mic/
// status indicator and no right-click volume control, since those entries aren't
// voice participants we're listening to.
function ClientIndicator({
  client,
  speaking,
  micMuted,
  deafened,
  isSelf,
  streaming,
  animStatus,
  rosterMode,
  draggableToChannel,
  onOpenDm,
  onPoke,
  onKick,
  onKickFromChannel,
  onGag,
  onBan,
  onUnban,
  onSetAvatar,
  onShowClientSummary,
  roles = [],
  onAssignRole,
  onRemoveRole,
  vanity = [],
  onToggleVanity,
  onOpenRolesGroups,
  canKickMembers = false,
  canBanMembers = false,
  canMuteMembers = false,
  isBanned = false
}) {
  const initial = client.name?.charAt(0).toUpperCase() ?? '?'
  const [visualSpeaking, setVisualSpeaking] = useState(speaking)
  const [isFadingOut, setIsFadingOut] = useState(false)
  const fadeTimerRef = useRef(null)

  useEffect(() => {
    if (speaking) {
      clearTimeout(fadeTimerRef.current)
      setVisualSpeaking(true)
      setIsFadingOut(false)
    } else {
      setIsFadingOut(true)
      fadeTimerRef.current = setTimeout(() => {
        setVisualSpeaking(false)
        setIsFadingOut(false)
      }, 100)
    }
    return () => clearTimeout(fadeTimerRef.current)
  }, [speaking])

  const initialAudioState = getClientAudioState(client.id)
  const [volume, setVolume] = useState(Math.round(initialAudioState.volume * 100))
  const [localMuted, setLocalMuted] = useState(initialAudioState.muted)

  // TeamSpeak-style group decorations: tag names after the client name, icon
  // badges right-aligned. When the row runs out of space the tags give way
  // first (pure CSS — huge flex-shrink), then badges collapse into a "+N"
  // counter via the measurement ratchet below. Either decoration can be
  // toggled off in Settings → Appearance.
  const { appearanceSettings } = useSettings()
  const showTags = appearanceSettings.showGroupTags
  const showIcons = appearanceSettings.showGroupIcons
  const groups = (client.vanity_ids || [])
    .map((id) => vanity.find((v) => v.id === id))
    .filter(Boolean)
  const badgesRef = useRef(null)
  const spacerRef = useRef(null)
  const tagsRef = useRef(null)
  const [visibleBadges, setVisibleBadges] = useState(groups.length)
  const shownBadges = Math.min(visibleBadges, groups.length)
  const hiddenBadges = groups.length - shownBadges

  // Ratchet: badge content overflowing its box → hide one more icon; enough
  // free space in the spacer for another icon (with hysteresis so grow/shrink
  // can't ping-pong at the boundary) → bring one back. Re-runs via the
  // ResizeObserver as the row or its content resizes, converging in a step or
  // two per change.
  const groupCount = groups.length
  useEffect(() => {
    const badges = badgesRef.current
    const spacer = spacerRef.current
    if (!badges || !spacer || groupCount === 0) return
    const BADGE_W = 20 // 16px badge + 4px gap
    const check = () => {
      // The box is justify-content: flex-end, so a squeezed box clips content
      // off its LEFT edge — which scrollWidth never reports (it only counts
      // end-side overflow). Detect clipping geometrically: is the first
      // badge's left edge outside the box?
      const first = badges.firstElementChild
      const clipped =
        first && first.getBoundingClientRect().left < badges.getBoundingClientRect().left - 1
      if (clipped) {
        setVisibleBadges((v) => Math.max(0, Math.min(v, groupCount) - 1))
      } else if (spacer.clientWidth >= BADGE_W + 8) {
        setVisibleBadges((v) => (v < groupCount ? v + 1 : v))
      }
    }
    // No initial check() needed: observe() fires the callback once on its own.
    const ro = new ResizeObserver(check)
    ro.observe(badges)
    ro.observe(spacer)
    return () => ro.disconnect()
  }, [groupCount, showIcons])

  // Chips compress strictly right-to-left. Flex shrink alone can't do this —
  // it distributes deficit proportionally, and even a sub-pixel loss on the
  // left chip flips its ellipsis on — so the observer assigns shrink itself:
  // only the rightmost visible chip may compress (ellipsizing via CSS, no
  // floor); chips left of it are frozen at natural width. Once the active chip
  // is squeezed below readability (and actually truncated — a naturally short
  // chip stays) or clipped by the container, it's hidden AND hard-collapsed to
  // zero width. The collapse matters: a merely-invisible chip still in the
  // flex math re-expands the moment the next chip starts sharing the deficit,
  // and the two flicker in a loop. A hidden chip returns once the spacer has
  // room for a readable sliver of it (it re-enters ellipsized and expands
  // gradually with further widening — the collapse in reverse), gated on the
  // icon badges having already unfolded so restore order mirrors collapse
  // order. Everything is written to the DOM directly — no re-renders.
  useEffect(() => {
    const el = tagsRef.current
    const spacer = spacerRef.current
    if (!el || !spacer || groupCount === 0) return
    const MIN_READABLE = 30
    const SLACK = 12
    const setCollapsed = (chip, hidden) => {
      chip.style.visibility = hidden ? 'hidden' : ''
      chip.style.maxWidth = hidden ? '0px' : ''
      chip.style.paddingLeft = hidden ? '0' : ''
      chip.style.paddingRight = hidden ? '0' : ''
      chip.style.borderWidth = hidden ? '0' : ''
      // Cancel the container gap the zero-width chip would still leave.
      chip.style.marginLeft = hidden ? '-4px' : ''
    }
    const update = () => {
      const box = el.getBoundingClientRect()
      const chips = [...el.children]
      const isHidden = (c) => c.style.visibility === 'hidden'
      // Record natural widths while untruncated — the refit threshold later.
      for (const chip of chips) {
        if (!isHidden(chip) && chip.scrollWidth <= chip.clientWidth) {
          chip.dataset.naturalWidth = chip.getBoundingClientRect().width
        }
      }
      let hidOne = false
      for (const chip of chips) {
        if (isHidden(chip)) continue
        const r = chip.getBoundingClientRect()
        const squeezedOut = r.width < MIN_READABLE && chip.scrollWidth > chip.clientWidth
        if (squeezedOut || r.right > box.right + 0.5) {
          setCollapsed(chip, true)
          hidOne = true
        }
      }
      // Un-hide the leftmost hidden chip (hiding eats the list right-to-left,
      // so that's the most recently hidden one) when there's comfortably room.
      if (!hidOne) {
        const firstHidden = chips.find(isHidden)
        const badgesFolded = badgesRef.current?.querySelector('.client-badge-counter')
        if (firstHidden && !badgesFolded) {
          const natural = Number(firstHidden.dataset.naturalWidth) || firstHidden.scrollWidth + 16
          // Whichever is smaller: the whole chip (short names return whole) or
          // a readable ellipsized sliver. Kept above the ~34px a hiding chip
          // frees, so hide/show can't ping-pong at the boundary.
          const need = Math.min(natural + SLACK, MIN_READABLE + 14)
          if (spacer.clientWidth >= need) setCollapsed(firstHidden, false)
        }
      }
      const visible = chips.filter((c) => !isHidden(c))
      const lastVisible = visible[visible.length - 1]
      for (const chip of visible) {
        chip.style.flexShrink = chip === lastVisible ? '10000' : '0'
      }
    }
    const ro = new ResizeObserver(update)
    ro.observe(el)
    ro.observe(spacer)
    return () => ro.disconnect()
  }, [groupCount, showTags, showIcons])

  // Apply this client's local volume/mute override whenever it changes. Skipped
  // in rosterMode — those entries don't control playback (and shouldn't clobber
  // the volume the in-channel indicator manages for the same client).
  useEffect(() => {
    if (isSelf || rosterMode) return
    setClientAudioState(client.id, { volume: volume / 100, muted: localMuted })
  }, [client.id, volume, localMuted, isSelf, rosterMode])

  const gagged = !!client.server_mute

  // Single-click opens this client's summary; double-click opens a DM. A click
  // always precedes a dblclick, so the single-click action is deferred briefly and
  // cancelled if a double-click follows. stopPropagation keeps both off the
  // enclosing channel row (whose double-click joins voice).
  const clickTimerRef = useRef(null)
  useEffect(() => () => clearTimeout(clickTimerRef.current), [])

  const handleClick = (e) => {
    if (!onShowClientSummary) return
    e.stopPropagation()
    clearTimeout(clickTimerRef.current)
    clickTimerRef.current = setTimeout(() => onShowClientSummary(client.id), 200)
  }

  const handleDoubleClick = (e) => {
    clearTimeout(clickTimerRef.current)
    if (isSelf || !onOpenDm) return
    e.stopPropagation()
    onOpenDm(client.id)
  }

  const handleDragStart = (e) => {
    e.dataTransfer.setData('application/x-client-id', String(client.id))
    e.dataTransfer.effectAllowed = 'move'
  }

  const toggleLocalMute = () => setLocalMuted((prev) => !prev)

  const handleVolumeChange = (e) => {
    const next = Number(e.target.value)
    setVolume(next)
    if (next > 0 && localMuted) setLocalMuted(false)
    if (next === 0 && !localMuted) setLocalMuted(true)
  }

  // Snap back to the 100% baseline (the center marker)
  const resetVolume = () => {
    setVolume(100)
    setLocalMuted(false)
  }

  const { onSetNickname } = useClientActions()

  const {
    menu,
    openMenu,
    open: menuOpen
  } = useClientMenu({
    isSelf,
    rosterMode,
    isBanned,
    // ponytail: pulled from context instead of prop-drilling through SideBar +
    // VoiceChannel like onSetAvatar does. Move the rest over if more pile up.
    onSetNickname,
    onPoke,
    onKick,
    onKickFromChannel,
    onGag,
    onBan,
    onUnban,
    onSetAvatar,
    roles,
    onAssignRole,
    onRemoveRole,
    vanity,
    onToggleVanity,
    onOpenRolesGroups,
    canKickMembers,
    canBanMembers,
    canMuteMembers,
    volume: {
      value: volume,
      muted: localMuted,
      onChange: handleVolumeChange,
      onToggleMute: toggleLocalMute,
      onReset: resetVolume
    }
  })

  // Drag this entry onto a channel header to move the client there. The id rides
  // a custom MIME type the channel header keys off (see VoiceChannel). Disabled
  // for ourselves — self joins a channel via double-click, not a server move — and
  // while the context menu is open, so dragging its volume slider doesn't also
  // start a client move (the menu is a child of this draggable element).
  const canDragToChannel = draggableToChannel && !isSelf && !rosterMode && !menuOpen

  let statusIcon
  if (gagged) {
    // Server-wide gag (moderator mute) — outranks every other voice status.
    statusIcon = <IconMoodSilence size={18} className="mic-indicator muted" aria-label="Gagged" />
  } else if (localMuted) {
    // We muted this client locally — takes priority over their own voice status.
    statusIcon = (
      <IconVolumeOff size={18} className="mic-indicator muted" aria-label="Muted by you" />
    )
  } else if (deafened) {
    statusIcon = (
      <IconHeadphonesOff size={18} className="mic-indicator deafened" aria-label="Deafened" />
    )
  } else if (micMuted) {
    statusIcon = <IconMicrophoneOff size={18} className="mic-indicator muted" aria-label="Muted" />
  } else if (visualSpeaking) {
    const cls = isFadingOut ? 'mic-indicator speaking-fade' : 'mic-indicator speaking'
    statusIcon = <IconMicrophoneFilled size={18} className={cls} aria-label="Speaking" />
  } else {
    statusIcon = <IconMicrophone size={18} className="mic-indicator" aria-label="Not speaking" />
  }

  return (
    <div
      className="client-indicator"
      data-anim-status={animStatus}
      draggable={canDragToChannel}
      onDragStart={canDragToChannel ? handleDragStart : undefined}
      onContextMenu={(e) => openMenu(e, client)}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {!rosterMode && statusIcon}
      <span className="client-avatar" aria-hidden="true">
        {client.avatar ? <img className="client-avatar-img" src={client.avatar} alt="" /> : initial}
      </span>
      <span className="client-name">{client.name}</span>
      {showTags && groups.length > 0 && (
        <span className="client-tags" ref={tagsRef}>
          {groups.map((g) => (
            // flexShrink/visibility are managed imperatively by the observer
            // above (strict right-to-left collapse).
            <span key={g.id} className="client-tag">
              {g.name}
            </span>
          ))}
        </span>
      )}
      <span className="client-row-spacer" ref={spacerRef} aria-hidden="true" />
      {showIcons && groups.length > 0 && (
        <span className="client-badges" ref={badgesRef}>
          {groups.slice(0, shownBadges).map((g) => (
            <span key={g.id} className="client-badge" title={g.name}>
              {g.avatar ? (
                <img src={g.avatar} alt="" className="client-badge-img" />
              ) : (
                <IconUsersGroup size={16} />
              )}
            </span>
          ))}
          {hiddenBadges > 0 && (
            <span
              className="client-badge-counter"
              title={groups
                .slice(shownBadges)
                .map((g) => g.name)
                .join(', ')}
            >
              +{hiddenBadges}
            </span>
          )}
        </span>
      )}
      {streaming && (
        <IconVideoFilled size={15} className="client-streaming-icon" aria-label="Streaming" />
      )}
      {rosterMode && !isSelf && onOpenDm && (
        <button
          type="button"
          className="client-dm-btn"
          title={`Message ${client.name}`}
          onClick={(e) => {
            e.stopPropagation()
            clearTimeout(clickTimerRef.current)
            onOpenDm(client.id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IconMessageCircleFilled size={16} />
        </button>
      )}
      {menu}
    </div>
  )
}

export default ClientIndicator
