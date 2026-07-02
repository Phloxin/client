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
  IconUserShield,
  IconUserX,
  IconBan,
  IconMoodSilence,
  IconCheck,
  IconUserCheck
} from '@tabler/icons-react'
import { setClientAudioState, getClientAudioState } from '../lib/soup'
import { RoleIcon } from '../lib/roleIcon'

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
  onOpenDm,
  onPoke,
  onKick,
  onBan,
  onUnban,
  onSetAvatar,
  onShowClientSummary,
  roles = [],
  onAssignRole,
  onRemoveRole,
  canKickMembers = false,
  canBanMembers = false,
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

  // Apply this client's local volume/mute override whenever it changes. Skipped
  // in rosterMode — those entries don't control playback (and shouldn't clobber
  // the volume the in-channel indicator manages for the same client).
  useEffect(() => {
    if (isSelf || rosterMode) return
    setClientAudioState(client.id, { volume: volume / 100, muted: localMuted })
  }, [client.id, volume, localMuted, isSelf, rosterMode])

  // Close the context menu on outside click
  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
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
  const canBan = !isSelf && canBanMembers
  const canUnban = !isSelf && canBanMembers && isBanned
  const canAssignRole = !isSelf
  // The moderation section shows when any action on another user is available.
  const canModerate = canAssignRole || canKick || canBan
  // 'everyone' is implicit (every client has it) and 'owner' isn't hand-assigned,
  // so neither is an assignable option in the role picker.
  const assignableRoles = roles.filter((r) => {
    const name = r.name?.toLowerCase() ?? ''
    return name !== 'everyone' && !name.includes('owner')
  })

  // A banned user's menu collapses to just Unban; otherwise it offers the normal
  // set. Don't open at all when nothing would be actionable.
  const canOpenMenu = isBanned ? canUnban : canVolume || canPoke || canSetAvatar || canModerate

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

  // Hand an avatar image up to be saved. Animated GIFs can't survive a canvas
  // re-encode (it captures a single frame), so send them as-is to keep the
  // animation. Other formats (JPG/PNG/WebP) get downscaled to a small square —
  // avatars render tiny and the data URL is broadcast to everyone, so full-res
  // photos would bloat every payload. We re-encode to WebP, which keeps PNG
  // transparency (JPEG would flatten it) and compresses well; the backend
  // accepts JPG/PNG/GIF/WebP.
  const handleAvatarFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setMenuPos(null)
    if (file.type === 'image/gif') {
      const reader = new FileReader()
      reader.onload = () => onSetAvatar(reader.result)
      reader.readAsDataURL(file)
      return
    }
    const img = new Image()
    img.onload = () => {
      const size = 256
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const ctx = canvas.getContext('2d')
      // Cover-crop: scale so the shorter side fills, center the overflow.
      const scale = Math.max(size / img.width, size / img.height)
      const w = img.width * scale
      const h = img.height * scale
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h)
      onSetAvatar(canvas.toDataURL('image/webp', 0.85))
      URL.revokeObjectURL(img.src)
    }
    img.src = URL.createObjectURL(file)
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

  let statusIcon
  if (localMuted) {
    // We muted this client locally — takes priority over their own voice status.
    statusIcon = <IconMoodSilence size={18} className="mic-indicator muted" aria-label="Muted by you" />
  } else if (deafened) {
    statusIcon = <IconHeadphonesOff size={18} className="mic-indicator deafened" aria-label="Deafened" />
  } else if (micMuted) {
    statusIcon = <IconMicrophoneOff size={18} className="mic-indicator muted" aria-label="Muted" />
  } else if (visualSpeaking) {
    const cls = isFadingOut ? 'mic-indicator speaking-fade' : 'mic-indicator speaking'
    statusIcon = <IconMicrophoneFilled size={18} className={cls} aria-label="Speaking" />
  } else {
    statusIcon = <IconMicrophone size={18} className="mic-indicator" aria-label="Not speaking" />
  }

  const VolumeIcon = localMuted || volume === 0
    ? IconVolumeOff
    : volume < 50 ? IconVolume4 : volume <= 99 ? IconVolume2 : IconVolume

  return (
    <div
      className="client-indicator"
      data-anim-status={animStatus}
      onContextMenu={handleContextMenu}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {!rosterMode && statusIcon}
      <span className="client-avatar" aria-hidden="true">
        {client.avatar ? (
          <img className="client-avatar-img" src={client.avatar} alt="" />
        ) : (
          initial
        )}
      </span>
      {client.name}
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
            </>
          )}
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
                      setPokeOpen(false)
                    }
                  }}
                />
                <button type="button" className="client-poke-send" onClick={submitPoke} title="Send poke">
                  <IconHandFinger size={16} />
                </button>
              </div>
            ) : (
              <button type="button" className="client-context-menu-item" onClick={() => setPokeOpen(true)}>
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
                          onChange={(e) => setBanDuration(Math.max(0, Number(e.target.value) || 0))}
                        />
                      )}
                    </>
                  )}
                  <button type="button" className="client-context-menu-item danger" onClick={submitMod}>
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
                                has ? onRemoveRole?.(client.id, role.id) : onAssignRole?.(client.id, role.id)
                              }
                            >
                              <IconCheck size={16} style={{ visibility: has ? 'visible' : 'hidden' }} />
                              <RoleIcon role={role} size={16} />
                              {role.name}
                            </button>
                          )
                        })
                      )}
                    </div>
                  )}
                  {canKick && (
                    <button
                      type="button"
                      className="client-context-menu-item danger"
                      onClick={() => setModAction('kick')}
                    >
                      <IconUserX size={16} />
                      Kick User
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
