import { useState, useRef, useEffect, useCallback } from 'react'
import {
  IconVolume,
  IconVolume2,
  IconVolume4,
  IconVolumeOff,
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
  IconPlus,
  IconPencil
} from '@tabler/icons-react'
import { fileToAvatarDataUrl } from '../lib/avatarFile'
import { RoleIcon } from '../lib/roleIcon'

// The right-click menu for a client, shared by every place a client is shown:
// the sidebar roster, a voice channel's participant list, and a chat message's
// author. Styles live in VoiceChannel.css (loaded app-wide via the sidebar).

// Which actions this menu can offer for `client`. Computed up front so callers
// can skip opening a menu that would be empty.
function capabilities(client, o) {
  const { isSelf, rosterMode, isBanned } = o
  // Volume + poke for others, avatar for ourselves. (rosterMode entries aren't
  // voice participants, so no volume there.)
  const canVolume = !isSelf && !rosterMode && !!o.volume
  const canPoke = !isSelf && !!o.onPoke
  const canSetAvatar = isSelf && !!o.onSetAvatar
  const canSetNickname = isSelf && !!o.onSetNickname
  // Moderation on another user, permission-gated by our own role permissions
  // (the server enforces them too). Kick only boots a live session, so it's
  // channel-view only; ban + roles also work from the Users roster.
  const canKick = !isSelf && !rosterMode && o.canKickMembers
  // Kick from channel just clears their channel (PATCH channel_id: null) — a much
  // lighter action than a server kick, so it's not gated on canKickMembers; the
  // server enforces MOVE_MEMBERS (incl. per-channel overwrites). Channel-view only
  // and only when they're actually in a channel.
  const canKickFromChannel =
    !isSelf && !rosterMode && !!o.onKickFromChannel && client.channel_id != null
  const canBan = !isSelf && o.canBanMembers
  const canUnban = !isSelf && o.canBanMembers && isBanned
  // Gag = server-wide mute (PATCH /client { mute }), gated on MUTE_MEMBERS. Works
  // from channel view and the roster, like ban.
  const canGag = !isSelf && !!o.onGag && o.canMuteMembers
  const canAssignRole = !isSelf
  // Groups are cosmetic, so unlike roles they're also assignable to ourselves —
  // our own menu shows the picker below Set Avatar instead of under moderation.
  const canAssignGroup = !!o.onToggleVanity
  const canModerate =
    canAssignRole ||
    (!isSelf && canAssignGroup) ||
    canKick ||
    canKickFromChannel ||
    canGag ||
    canBan
  // A banned user's menu collapses to just Unban; otherwise it offers the normal
  // set. Don't open at all when nothing would be actionable.
  const canOpen = isBanned
    ? canUnban
    : canVolume || canPoke || canSetAvatar || canSetNickname || canAssignGroup || canModerate
  return {
    canVolume,
    canPoke,
    canSetAvatar,
    canSetNickname,
    canKick,
    canKickFromChannel,
    canBan,
    canUnban,
    canGag,
    canAssignGroup,
    canModerate,
    canOpen
  }
}

function ClientContextMenu({ client, pos, onClose, opts, caps }) {
  // Poke composer state, scoped to the open menu.
  const [pokeOpen, setPokeOpen] = useState(false)
  const [pokeText, setPokeText] = useState('')
  // Display-name editor, seeded with the name we're currently showing under.
  const [nickOpen, setNickOpen] = useState(false)
  const [nickText, setNickText] = useState(client.name ?? '')
  // Kick/ban composer: which action is being composed ('kick' | 'ban' | null),
  // its optional reason, and the ban duration in seconds (0 = permanent).
  const [modAction, setModAction] = useState(null)
  const [modReason, setModReason] = useState('')
  // True when the role / server-group picker is expanded.
  const [roleOpen, setRoleOpen] = useState(false)
  const [groupOpen, setGroupOpen] = useState(false)
  const [banDuration, setBanDuration] = useState(0)
  // True when the duration select is in "Custom…" mode (banDuration comes from a
  // free-form seconds input rather than a preset).
  const [customDuration, setCustomDuration] = useState(false)
  const menuRef = useRef(null)
  const avatarInputRef = useRef(null)

  const { isBanned, roles = [], vanity = [], volume } = opts

  // Close on outside click or Escape. Escape is marked handled so the app-level
  // Escape (Main.jsx) doesn't also close a view underneath.
  useEffect(() => {
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) onClose()
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const submitPoke = () => {
    opts.onPoke?.(client.id, pokeText)
    onClose()
  }

  const submitNickname = () => {
    const name = nickText.trim()
    if (!name) return
    opts.onSetNickname?.(name)
    onClose()
  }

  const submitMod = () => {
    const reason = modReason.trim()
    if (modAction === 'ban') opts.onBan?.(client.id, { durationSeconds: banDuration, reason })
    else if (modAction === 'kick') opts.onKick?.(client.id, reason)
    onClose()
  }

  // Hand an avatar image up to be saved (downscale/re-encode lives in avatarFile).
  const handleAvatarFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    onClose()
    fileToAvatarDataUrl(file, opts.onSetAvatar)
  }

  // 'everyone' is implicit (every client has it) and 'owner' isn't hand-assigned,
  // so neither is an assignable option in the role picker.
  const assignableRoles = roles.filter((r) => {
    const name = r.name?.toLowerCase() ?? ''
    return name !== 'everyone' && !name.includes('owner')
  })

  const gagged = !!client.server_mute

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
                onClick={() => opts.onToggleVanity?.(client.id, g.id, !has)}
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
              onClose()
              opts.onOpenRolesGroups?.()
            }}
          >
            <IconPlus size={16} />
            Create Group
          </button>
        </div>
      )}
    </>
  )

  const VolumeIcon =
    !volume || volume.muted || volume.value === 0
      ? IconVolumeOff
      : volume.value < 50
        ? IconVolume4
        : volume.value <= 99
          ? IconVolume2
          : IconVolume

  return (
    <div
      className="client-context-menu"
      ref={menuRef}
      style={{ top: pos.y, left: pos.x }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      <div className="client-context-menu-header">{client.name}</div>
      {isBanned ? (
        caps.canUnban && (
          <button
            type="button"
            className="client-context-menu-item"
            onClick={() => {
              opts.onUnban?.(client.id)
              onClose()
            }}
          >
            <IconUserCheck size={16} />
            Unban User
          </button>
        )
      ) : (
        <>
          {caps.canSetNickname &&
            (nickOpen ? (
              <div className="client-poke-row">
                <input
                  className="client-poke-input"
                  value={nickText}
                  autoFocus
                  placeholder="Display name"
                  onChange={(e) => setNickText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submitNickname()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      setNickOpen(false)
                    }
                  }}
                />
                <button
                  type="button"
                  className="client-poke-send"
                  onClick={submitNickname}
                  title="Save display name"
                >
                  <IconCheck size={16} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="client-context-menu-item"
                onClick={() => setNickOpen(true)}
              >
                <IconPencil size={16} />
                Set display name
              </button>
            ))}
          {caps.canSetAvatar && (
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
                    onClose()
                    opts.onSetAvatar(null)
                  }}
                >
                  <IconPhotoX size={16} />
                  Remove avatar
                </button>
              )}
            </>
          )}
          {opts.isSelf && caps.canAssignGroup && groupPicker}
          {caps.canVolume && (
            <div className="client-context-menu-row">
              <button
                type="button"
                className="client-volume-btn"
                onClick={volume.onToggleMute}
                title={volume.muted ? 'Unmute for me' : 'Mute for me'}
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
                  value={volume.muted ? 0 : volume.value}
                  onChange={volume.onChange}
                  onDoubleClick={volume.onReset}
                  title="Volume — 100% is normal, drag right to boost (double-click to reset)"
                />
              </div>
              <span className="client-volume-value">{volume.muted ? 0 : volume.value}%</span>
            </div>
          )}
          {caps.canPoke &&
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
          {caps.canModerate && (
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
                          onChange={(e) => setBanDuration(Math.max(0, Number(e.target.value) || 0))}
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
                                  ? opts.onRemoveRole?.(client.id, role.id)
                                  : opts.onAssignRole?.(client.id, role.id)
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
                  {caps.canAssignGroup && groupPicker}
                  {caps.canKickFromChannel && (
                    <button
                      type="button"
                      className="client-context-menu-item danger"
                      onClick={() => {
                        opts.onKickFromChannel?.(client.id)
                        onClose()
                      }}
                    >
                      <IconDoorExit size={16} />
                      Kick From Channel
                    </button>
                  )}
                  {caps.canGag && (
                    <button
                      type="button"
                      className="client-context-menu-item danger"
                      onClick={() => {
                        opts.onGag?.(client.id, !gagged)
                        onClose()
                      }}
                    >
                      <IconMoodSilence size={16} />
                      {gagged ? 'Ungag' : 'Gag'}
                    </button>
                  )}
                  {caps.canKick && (
                    <button
                      type="button"
                      className="client-context-menu-item danger"
                      onClick={() => setModAction('kick')}
                    >
                      <IconUserX size={16} />
                      Kick From Server
                    </button>
                  )}
                  {caps.canBan && (
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
  )
}

// Owns the open/closed state for a client menu. Returns the menu element to drop
// into the trigger's markup, an `openMenu(event, client, extraOpts)` handler, and
// whether one is open. The client is supplied at open time so a list (a chat
// feed, a roster) needs only one menu for all its rows. `opts` are the shared
// action handlers; extraOpts carries the per-client bits (isSelf, volume, …).
// Keyed remount on open resets the poke/kick/ban composers.
export function useClientMenu(opts) {
  const [target, setTarget] = useState(null)
  const close = useCallback(() => setTarget(null), [])

  const openMenu = (e, client, extraOpts) => {
    if (!client) return
    if (!capabilities(client, { ...opts, ...extraOpts }).canOpen) return
    e.preventDefault()
    e.stopPropagation()
    setTarget({ client, extra: extraOpts, pos: { x: e.clientX, y: e.clientY } })
  }

  // Only the per-client extras are captured at open time; `opts` is re-read every
  // render so live values (the volume slider's position) stay current.
  const merged = target ? { ...opts, ...target.extra } : null
  const menu = target ? (
    <ClientContextMenu
      key={`${target.client.id}:${target.pos.x},${target.pos.y}`}
      client={target.client}
      pos={target.pos}
      onClose={close}
      opts={merged}
      caps={capabilities(target.client, merged)}
    />
  ) : null

  return { menu, openMenu, open: target != null }
}
