import { useState, useRef, useEffect } from 'react'
import './ClientSummary.css'
import { IconUsersGroup, IconPhotoUp, IconTrash, IconZoomIn } from '@tabler/icons-react'
import { RoleIcon } from '../lib/roleIcon'
import { useClientActions } from '../context/ClientActionsContext'
import { statusOf, STATUS_LABELS } from '../lib/presence'
import { useMenuPosition } from '../lib/menuPosition'
import { useImageColors, bannerGradient } from '../lib/imageColors'
import { fileToAvatarDataUrl } from '../lib/avatarFile'
import ImageViewer from './ImageViewer'

// Profile/summary shown in the main area when a client is single-clicked. The
// name lives in the page header; this is the body. Activity stats (e.g. last
// online) get filled in once the server exposes them.
//
// The avatar frame mirrors ChannelSummary's icon frame: click an existing avatar
// to view it full size, right-click for replace/remove. Setting your own avatar
// is self-only — `isSelf` gates the context menu and the click-to-set fallback,
// so other people's avatars are view-only.
function ClientSummary({ client, roles = [], vanity = [], isSelf = false, onSetAvatar }) {
  const initial = client?.name?.charAt(0).toUpperCase() ?? '?'
  const hasAvatar = !!client?.avatar
  const canEdit = isSelf && !!onSetAvatar

  // Full-size avatar lightbox (clicking an existing avatar, like a chat image).
  const [viewerOpen, setViewerOpen] = useState(false)
  // Right-click context menu on your own avatar: { x, y } or null when closed.
  const [avatarMenu, setAvatarMenu] = useState(null)
  const avatarMenuRef = useRef(null)
  const avatarInputRef = useRef(null)
  const avatarMenuStyle = useMenuPosition(avatarMenuRef, avatarMenu)

  // Close the avatar context menu on an outside click.
  useEffect(() => {
    if (!avatarMenu) return
    const close = (e) => {
      if (avatarMenuRef.current && !avatarMenuRef.current.contains(e.target)) setAvatarMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [avatarMenu])

  // Same downscale/re-encode pipeline as everywhere else (lib/avatarFile).
  const handleAvatarFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAvatarMenu(null)
    fileToAvatarDataUrl(file, onSetAvatar)
  }

  // Avatar present → view it full size; absent → (self only) pick a file to set one.
  const handleAvatarClick = () => {
    if (hasAvatar) setViewerOpen(true)
    else if (canEdit) avatarInputRef.current?.click()
  }

  const handleAvatarContextMenu = (e) => {
    if (!canEdit) return
    e.preventDefault()
    setAvatarMenu({ x: e.clientX, y: e.clientY })
  }

  const replaceAvatar = () => {
    setAvatarMenu(null)
    avatarInputRef.current?.click()
  }

  const removeAvatar = () => {
    setAvatarMenu(null)
    onSetAvatar?.(null)
  }

  // The frame is interactive when there's an image to expand or (for self) an
  // avatar to set. Otherwise it's a plain, non-clickable initial.
  const interactive = hasAvatar || canEdit
  // The roles this client has explicitly been granted (role_ids), resolved to
  // names. 'everyone' is implicit and not in role_ids, so it won't appear here.
  const assignedRoles = roles.filter((r) => (client?.role_ids || []).includes(r.id))
  // Vanity groups this client is in (vanity_ids), resolved the same way.
  const assignedGroups = vanity.filter((g) => (client?.vanity_ids || []).includes(g.id))

  // Banner gradient sampled from the avatar, same as ChannelSummary's icon
  // banner. Null (no avatar / unreadable image) renders the plain card.
  const bannerColors = useImageColors(client?.avatar)

  // Presence is user-level and lives in the shared map, not on the client record.
  // STATUS_LABELS.offline is 'Invisible' — that's the wording for picking your own
  // status; from the outside the two are indistinguishable, so read it as Offline.
  const presence = useClientActions().presences?.[client?.id]
  const status = statusOf(presence)
  const statusLabel = status === 'offline' ? 'Offline' : STATUS_LABELS[status]

  return (
    <div className="client-summary">
      <div
        className={`client-summary-card${bannerColors ? ' channel-summary-banner' : ''}`}
        style={bannerGradient(bannerColors)}
      >
        {interactive ? (
          <button
            type="button"
            className="client-summary-avatar channel-summary-avatar-btn"
            title={
              hasAvatar
                ? canEdit
                  ? 'View avatar (right-click for options)'
                  : 'View avatar'
                : 'Set avatar'
            }
            onClick={handleAvatarClick}
            onContextMenu={handleAvatarContextMenu}
          >
            {hasAvatar ? (
              <img className="client-summary-avatar-img" src={client.avatar} alt="" />
            ) : (
              initial
            )}
            <span className="channel-summary-avatar-overlay" aria-hidden="true">
              {hasAvatar ? <IconZoomIn size={20} /> : <IconPhotoUp size={20} />}
            </span>
          </button>
        ) : (
          <span className="client-summary-avatar" aria-hidden="true">
            {hasAvatar ? (
              <img className="client-summary-avatar-img" src={client.avatar} alt="" />
            ) : (
              initial
            )}
          </span>
        )}
        {canEdit && (
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={handleAvatarFile}
          />
        )}
        <span className="client-summary-name">{client?.name ?? 'Unknown user'}</span>
      </div>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Server Roles</h3>
        {assignedRoles.length > 0 ? (
          <ul className="client-summary-roles">
            {assignedRoles.map((r) => (
              <li key={r.id} className="client-summary-role">
                <RoleIcon role={r} size={14} />
                {r.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="client-summary-placeholder">No roles to show yet.</p>
        )}
      </section>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Server Groups</h3>
        {assignedGroups.length > 0 ? (
          <ul className="client-summary-roles">
            {assignedGroups.map((g) => (
              <li key={g.id} className="client-summary-role">
                {g.avatar ? (
                  <img src={g.avatar} alt="" className="client-summary-group-icon" />
                ) : (
                  <IconUsersGroup size={14} />
                )}
                {g.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="client-summary-placeholder">No groups to show yet.</p>
        )}
      </section>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Activity</h3>
        <p className="client-summary-value client-summary-status">
          <span className={`client-summary-status-dot presence-${status}`} aria-hidden="true" />
          {statusLabel}
          {presence?.status_message && (
            <span className="client-summary-status-message">{presence.status_message}</span>
          )}
        </p>
      </section>

      {viewerOpen && hasAvatar && (
        <ImageViewer
          src={client.avatar}
          name={`${client?.name ?? 'User'} avatar`}
          onClose={() => setViewerOpen(false)}
        />
      )}

      {avatarMenu && (
        <div className="channel-context-menu" ref={avatarMenuRef} style={avatarMenuStyle}>
          <button type="button" className="channel-context-item" onClick={replaceAvatar}>
            <IconPhotoUp size={16} /> Replace Avatar
          </button>
          {hasAvatar && (
            <button type="button" className="channel-context-item danger" onClick={removeAvatar}>
              <IconTrash size={16} /> Remove Avatar
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default ClientSummary
