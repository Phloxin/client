import { useState, useRef, useEffect } from 'react'
import {
  IconMicrophoneOff,
  IconHeadphonesOff,
  IconMicrophoneFilled,
  IconMicrophone,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconVolume4,
  IconVolumeOff,
  IconVideoFilled,
  IconHandFinger,
  IconPhotoUp,
  IconPhotoX,
  IconUserShield,
  IconUserX,
  IconDoorExit,
  IconBan,
  IconMoodSilence,
  IconCheck,
  IconUserCheck,
  IconUsersGroup,
  IconPlus
} from '@tabler/icons-react'
import { setClientAudioState, getClientAudioState } from '../lib/soup'
import { fileToAvatarDataUrl } from '../lib/avatarFile'
import { RoleIcon } from '../lib/roleIcon'
import { useSettings } from '../context/SettingsContext'

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
  const [menuPos, setMenuPos] = useState(null)
  // Poke composer state, scoped to the open context menu.
  const [pokeOpen, setPokeOpen] = useState(false)
  const [pokeText, setPokeText] = useState('')
  // Kick/ban composer: which action is being composed ('kick' | 'ban' | null),
  // its optional reason, and the ban duration in seconds (0 = permanent).
  const [modAction, setModAction] = useState(null)
  const [modReason, setModReason] = useState('')
  // True when the role picker is expanded in the context menu.
  const [roleOpen, setRoleOpen] = useState(false)
  // True when the server-group picker is expanded in the context menu.
  const [groupOpen, setGroupOpen] = useState(false)
  const [banDuration, setBanDuration] = useState(0)
  // True when the duration select is in "Custom…" mode (banDuration comes from a
  // free-form seconds input rather than a preset).
  const [customDuration, setCustomDuration] = useState(false)
  const menuRef = useRef(null)
  const avatarInputRef = useRef(null)
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
          const natural =
            Number(firstHidden.dataset.naturalWidth) || firstHidden.scrollWidth + 16
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

  // Close the context menu on outside click or Escape. Escape is marked handled
  // so the app-level Escape (Main.jsx) doesn't also close a view underneath.
  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        setMenuPos(null)
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [menuPos])

  // Reset the poke composer whenever the menu closes.
  useEffect(() => {
    if (!menuPos) {
      setPokeOpen(false)
      setPokeText('')
      setModAction(null)
      setModReason('')
      setBanDuration(0)
      setCustomDuration(false)
      setRoleOpen(false)
      setGroupOpen(false)
    }
  }, [menuPos])

  // Which actions this indicator's menu can offer: volume + poke for others,
  // avatar for ourselves. (rosterMode entries aren't voice participants, so no
  // volume there.)
  const canVolume = !isSelf && !rosterMode
  const canPoke = !isSelf && !!onPoke
  const canSetAvatar = isSelf && !!onSetAvatar
  // Moderation actions on another user, permission-gated by our own role
  // permissions (the server enforces them too). Kick only boots a live session,
  // so it's channel-view only; ban + roles also work from the Users roster.
  const canKick = !isSelf && !rosterMode && canKickMembers
  // Kick from channel just clears their channel (PATCH channel_id: null) — a much
  // lighter action than a server kick, so it's not gated on canKickMembers; the
  // server enforces MOVE_MEMBERS (incl. per-channel overwrites). Channel-view only
  // and only when they're actually in a channel.
  const canKickFromChannel = !isSelf && !rosterMode && !!onKickFromChannel && client.channel_id != null
  const canBan = !isSelf && canBanMembers
  const canUnban = !isSelf && canBanMembers && isBanned
  // Gag = server-wide mute (PATCH /client { mute }), gated on MUTE_MEMBERS. Works
  // from channel view and the roster, like ban.
  const gagged = !!client.server_mute
  const canGag = !isSelf && !!onGag && canMuteMembers
  const canAssignRole = !isSelf
  // Groups are cosmetic, so unlike roles they're also assignable to ourselves —
  // our own menu shows the picker below Set Avatar instead of under moderation.
  const canAssignGroup = !!onToggleVanity
  // The moderation section shows when any action on another user is available.
  const canModerate =
    canAssignRole ||
    (!isSelf && canAssignGroup) ||
    canKick ||
    canKickFromChannel ||
    canGag ||
    canBan
  // 'everyone' is implicit (every client has it) and 'owner' isn't hand-assigned,
  // so neither is an assignable option in the role picker.
  const assignableRoles = roles.filter((r) => {
    const name = r.name?.toLowerCase() ?? ''
    return name !== 'everyone' && !name.includes('owner')
  })

  // A banned user's menu collapses to just Unban; otherwise it offers the normal
  // set. Don't open at all when nothing would be actionable.
  const canOpenMenu = isBanned
    ? canUnban
    : canVolume || canPoke || canSetAvatar || canAssignGroup || canModerate

  const handleContextMenu = (e) => {
    if (!canOpenMenu) return
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  const submitPoke = () => {
    onPoke?.(client.id, pokeText)
    setMenuPos(null)
  }

  const submitMod = () => {
    const reason = modReason.trim()
    if (modAction === 'ban') onBan?.(client.id, { durationSeconds: banDuration, reason })
    else if (modAction === 'kick') onKick?.(client.id, reason)
    setMenuPos(null)
  }

  // Hand an avatar image up to be saved (downscale/re-encode lives in avatarFile).
  const handleAvatarFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMenuPos(null)
    fileToAvatarDataUrl(file, onSetAvatar)
  }

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

  // Drag this entry onto a channel header to move the client there. The id rides
  // a custom MIME type the channel header keys off (see VoiceChannel). Disabled
  // for ourselves — self joins a channel via double-click, not a server move — and
  // while the context menu is open, so dragging its volume slider doesn't also
  // start a client move (the menu is a child of this draggable element).
  const canDragToChannel = draggableToChannel && !isSelf && !rosterMode && !menuPos
  const handleDragStart = (e) => {
    e.dataTransfer.setData('application/x-client-id', String(client.id))
    e.dataTransfer.effectAllowed = 'move'
  }

  const toggleLocalMute = () => setLocalMuted((prev) => !prev)

  // Server-group picker, rendered in our own menu (below Set Avatar) and in the
  // moderation section of someone else's menu.
  const groupPicker = (
    <>
      <button
        type="button"
        className="client-context-menu-item"
        onClick={() => setGroupOpen((v) => !v)}
      >
        <IconUsersGroup size={16} />
        Assign Server Groups
      </button>
      {groupOpen && (
        <div className="client-role-list">
          {vanity.map((g) => {
            const has = (client.vanity_ids || []).includes(g.id)
            return (
              <button
                key={g.id}
                type="button"
                className="client-context-menu-item"
                onClick={() => onToggleVanity?.(client.id, g.id, !has)}
              >
                <IconCheck size={16} style={{ visibility: has ? 'visible' : 'hidden' }} />
                {g.avatar ? (
                  <img src={g.avatar} alt="" className="client-group-icon" />
                ) : (
                  <IconUsersGroup size={16} />
                )}
                {g.name}
              </button>
            )
          })}
          <button
            type="button"
            className="client-context-menu-item"
            onClick={() => {
              setMenuPos(null)
              onOpenRolesGroups?.()
            }}
          >
            <IconPlus size={16} />
            Create Group
          </button>
        </div>
      )}
    </>
  )

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

  let statusIcon
  if (gagged) {
    // Server-wide gag (moderator mute) — outranks every other voice status.
    statusIcon = (
      <IconMoodSilence size={18} className="mic-indicator muted" aria-label="Gagged" />
    )
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

  const VolumeIcon =
    localMuted || volume === 0
      ? IconVolumeOff
      : volume < 50
        ? IconVolume4
        : volume <= 99
          ? IconVolume2
          : IconVolume

  return (
    <div
      className="client-indicator"
      data-anim-status={animStatus}
      draggable={canDragToChannel}
      onDragStart={canDragToChannel ? handleDragStart : undefined}
      onContextMenu={handleContextMenu}
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
      {menuPos && (
        <div
          className="client-context-menu"
          ref={menuRef}
          style={{ top: menuPos.y, left: menuPos.x }}
          onClick={(e) => e.stopPropagation()}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <div className="client-context-menu-header">{client.name}</div>
          {isBanned ? (
            canUnban && (
              <button
                type="button"
                className="client-context-menu-item"
                onClick={() => {
                  onUnban?.(client.id)
                  setMenuPos(null)
                }}
              >
                <IconUserCheck size={16} />
                Unban User
              </button>
            )
          ) : (
            <>
              {canSetAvatar && (
                <>
                  <input
                    ref={avatarInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={handleAvatarFile}
                  />
                  <button
                    type="button"
                    className="client-context-menu-item"
                    onClick={() => avatarInputRef.current?.click()}
                  >
                    <IconPhotoUp size={16} />
                    Set avatar
                  </button>
                  {client.avatar && (
                    <button
                      type="button"
                      className="client-context-menu-item danger"
                      onClick={() => {
                        setMenuPos(null)
                        onSetAvatar(null)
                      }}
                    >
                      <IconPhotoX size={16} />
                      Remove avatar
                    </button>
                  )}
                </>
              )}
              {isSelf && canAssignGroup && groupPicker}
              {canVolume && (
                <div className="client-context-menu-row">
                  <button
                    type="button"
                    className="client-volume-btn"
                    onClick={toggleLocalMute}
                    title={localMuted ? 'Unmute for me' : 'Mute for me'}
                  >
                    <VolumeIcon size={16} />
                  </button>
                  <div className="client-volume-slider-wrap">
                    <span className="client-volume-center-tick" aria-hidden="true" />
                    <input
                      type="range"
                      className="client-volume-slider"
                      min={0}
                      max={200}
                      value={localMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      onDoubleClick={resetVolume}
                      title="Volume — 100% is normal, drag right to boost (double-click to reset)"
                    />
                  </div>
                  <span className="client-volume-value">{localMuted ? 0 : volume}%</span>
                </div>
              )}
              {canPoke &&
                (pokeOpen ? (
                  <div className="client-poke-row">
                    <input
                      className="client-poke-input"
                      value={pokeText}
                      autoFocus
                      placeholder="Add a message (optional)"
                      onChange={(e) => setPokeText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          submitPoke()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          setPokeOpen(false)
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="client-poke-send"
                      onClick={submitPoke}
                      title="Send poke"
                    >
                      <IconHandFinger size={16} />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="client-context-menu-item"
                    onClick={() => setPokeOpen(true)}
                  >
                    <IconHandFinger size={16} />
                    Poke
                  </button>
                ))}
              {canModerate && (
                <>
                  <div className="client-context-menu-divider" aria-hidden="true" />
                  {modAction ? (
                    <div className="client-mod-composer">
                      <input
                        className="client-poke-input"
                        value={modReason}
                        autoFocus
                        placeholder={`${modAction === 'ban' ? 'Ban' : 'Kick'} reason (optional)`}
                        onChange={(e) => setModReason(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            submitMod()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            setModAction(null)
                          }
                        }}
                      />
                      {modAction === 'ban' && (
                        <>
                          <select
                            className="client-mod-duration"
                            value={customDuration ? 'custom' : banDuration}
                            onChange={(e) => {
                              if (e.target.value === 'custom') {
                                setCustomDuration(true)
                              } else {
                                setCustomDuration(false)
                                setBanDuration(Number(e.target.value))
                              }
                            }}
                          >
                            <option value={0}>Permanent</option>
                            <option value={3600}>1 hour</option>
                            <option value={86400}>1 day</option>
                            <option value={604800}>1 week</option>
                            <option value={2592000}>30 days</option>
                            <option value="custom">Custom…</option>
                          </select>
                          {customDuration && (
                            <input
                              type="number"
                              min={0}
                              className="client-mod-duration"
                              value={banDuration}
                              placeholder="Seconds"
                              onChange={(e) =>
                                setBanDuration(Math.max(0, Number(e.target.value) || 0))
                              }
                            />
                          )}
                        </>
                      )}
                      <button
                        type="button"
                        className="client-context-menu-item danger"
                        onClick={submitMod}
                      >
                        {modAction === 'ban' ? <IconBan size={16} /> : <IconUserX size={16} />}
                        Confirm {modAction === 'ban' ? 'Ban' : 'Kick'}
                      </button>
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="client-context-menu-item"
                        onClick={() => setRoleOpen((v) => !v)}
                      >
                        <IconUserShield size={16} />
                        Assign Role
                      </button>
                      {roleOpen && (
                        <div className="client-role-list">
                          {assignableRoles.length === 0 ? (
                            <div className="client-role-empty">No roles</div>
                          ) : (
                            assignableRoles.map((role) => {
                              const has = (client.role_ids || []).includes(role.id)
                              return (
                                <button
                                  key={role.id}
                                  type="button"
                                  className="client-context-menu-item"
                                  onClick={() =>
                                    has
                                      ? onRemoveRole?.(client.id, role.id)
                                      : onAssignRole?.(client.id, role.id)
                                  }
                                >
                                  <IconCheck
                                    size={16}
                                    style={{ visibility: has ? 'visible' : 'hidden' }}
                                  />
                                  <RoleIcon role={role} size={16} />
                                  {role.name}
                                </button>
                              )
                            })
                          )}
                        </div>
                      )}
                      {canAssignGroup && groupPicker}
                      {canKickFromChannel && (
                        <button
                          type="button"
                          className="client-context-menu-item danger"
                          onClick={() => {
                            onKickFromChannel?.(client.id)
                            setMenuPos(null)
                          }}
                        >
                          <IconDoorExit size={16} />
                          Kick From Channel
                        </button>
                      )}
                      {canGag && (
                        <button
                          type="button"
                          className="client-context-menu-item danger"
                          onClick={() => {
                            onGag?.(client.id, !gagged)
                            setMenuPos(null)
                          }}
                        >
                          <IconMoodSilence size={16} />
                          {gagged ? 'Ungag' : 'Gag'}
                        </button>
                      )}
                      {canKick && (
                        <button
                          type="button"
                          className="client-context-menu-item danger"
                          onClick={() => setModAction('kick')}
                        >
                          <IconUserX size={16} />
                          Kick From Server
                        </button>
                      )}
                      {canBan && (
                        <button
                          type="button"
                          className="client-context-menu-item danger"
                          onClick={() => setModAction('ban')}
                        >
                          <IconBan size={16} />
                          Ban User
                        </button>
                      )}
                    </>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default ClientIndicator
