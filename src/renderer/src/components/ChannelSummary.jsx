import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import './ClientSummary.css'
import { IconVolume, IconPencil, IconTrash, IconPhotoUp, IconZoomIn } from '@tabler/icons-react'
import ChannelPermissions from './ChannelPermissions'
import ImageViewer from './ImageViewer'
import { cdnUrl } from '../lib/serverConfig'
import { fileToAvatarDataUrl } from '../lib/avatarFile'

// Inline editor for the channel description. Mirrors ChatPanel's MessageEditor:
// auto-grows, Enter saves, Shift+Enter newlines, Escape cancels. Empty is allowed
// (clears the description).
function DescriptionEditor({ initialText, onSave, onCancel }) {
  const [value, setValue] = useState(initialText)
  const ref = useRef(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const submit = () => {
    const trimmed = value.trim()
    if (trimmed === initialText.trim()) onCancel()
    else onSave(trimmed)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="client-summary-edit">
      <textarea
        ref={ref}
        className="client-summary-edit-input"
        rows={1}
        value={value}
        placeholder="Add a channel description…"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="client-summary-edit-hint">
        escape to{' '}
        <button type="button" onClick={onCancel}>
          cancel
        </button>
        {' • '}enter to{' '}
        <button type="button" onClick={submit}>
          save
        </button>
      </div>
    </div>
  )
}

// Channel details shown in the main area when "Channel Details" is picked from a
// channel's right-click menu. Reuses the ClientSummary.css layout so the two
// summary views match. The description is editable (hover → pencil).
function ChannelSummary({
  channel,
  memberCount = 0,
  onSaveDescription,
  onSetIcon,
  roles,
  clients,
  canManagePermissions,
  onSetOverwrite,
  onDeleteOverwrite
}) {
  const limit = channel?.user_limit || 0
  const [editing, setEditing] = useState(false)
  // Full-size icon lightbox (clicking an existing icon, like a chat image).
  const [viewerOpen, setViewerOpen] = useState(false)
  // Right-click context menu on an existing icon: { x, y } or null when closed.
  const [iconMenu, setIconMenu] = useState(null)
  const iconMenuRef = useRef(null)
  const iconInputRef = useRef(null)
  const hasIcon = !!channel?.channel_icon

  // Close the icon context menu on an outside click.
  useEffect(() => {
    if (!iconMenu) return
    const close = (e) => {
      if (iconMenuRef.current && !iconMenuRef.current.contains(e.target)) setIconMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [iconMenu])

  // Same downscale/re-encode pipeline as client avatars (lib/avatarFile).
  const handleIconFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file || channel?.id == null) return
    fileToAvatarDataUrl(file, (dataUrl) => onSetIcon?.(channel.id, dataUrl))
  }

  // Icon present → view it full size; absent → pick a file to set one.
  const handleIconClick = () => {
    if (hasIcon) setViewerOpen(true)
    else iconInputRef.current?.click()
  }

  const handleIconContextMenu = (e) => {
    if (!hasIcon) return
    e.preventDefault()
    setIconMenu({ x: e.clientX, y: e.clientY })
  }

  const deleteIcon = () => {
    setIconMenu(null)
    // null clears the icon server-side.
    if (channel?.id != null) onSetIcon?.(channel.id, null)
  }

  const replaceIcon = () => {
    setIconMenu(null)
    iconInputRef.current?.click()
  }
  // Local copy so an edit shows immediately. Seeded from props; the view is keyed
  // on channel id in Main, so switching channels remounts and re-seeds.
  const [description, setDescription] = useState(channel?.description || '')

  const saveDescription = (text) => {
    setDescription(text)
    setEditing(false)
    if (channel?.id != null) onSaveDescription?.(channel.id, text)
  }

  return (
    <div className="client-summary">
      <div className="client-summary-card">
        <button
          type="button"
          className="client-summary-avatar channel-summary-avatar-btn"
          title={hasIcon ? 'View channel icon (right-click for options)' : 'Set channel icon'}
          onClick={handleIconClick}
          onContextMenu={handleIconContextMenu}
        >
          {hasIcon ? (
            <img className="client-summary-avatar-img" src={cdnUrl(channel.channel_icon)} alt="" />
          ) : (
            <IconVolume size={28} stroke={2} />
          )}
          <span className="channel-summary-avatar-overlay" aria-hidden="true">
            {hasIcon ? <IconZoomIn size={20} /> : <IconPhotoUp size={20} />}
          </span>
        </button>
        <input
          ref={iconInputRef}
          type="file"
          accept="image/*"
          style={{ display: 'none' }}
          onChange={handleIconFile}
        />
        <span className="client-summary-name">{channel?.name ?? 'Channel'}</span>
      </div>

      <section className="client-summary-section">
        <div className="client-summary-heading-row">
          <h3 className="client-summary-heading">Description</h3>
          {!editing && (
            <button
              type="button"
              className="client-summary-edit-btn"
              title="Edit description"
              onClick={() => setEditing(true)}
            >
              <IconPencil size={14} />
            </button>
          )}
        </div>
        {editing ? (
          <DescriptionEditor
            initialText={description}
            onSave={saveDescription}
            onCancel={() => setEditing(false)}
          />
        ) : description ? (
          <p className="client-summary-value">{description}</p>
        ) : (
          <p className="client-summary-placeholder">No description set.</p>
        )}
      </section>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Users</h3>
        <p className="client-summary-value">
          {memberCount} / {limit === 0 ? '∞' : limit}
        </p>
      </section>

      <ChannelPermissions
        channel={channel}
        roles={roles}
        clients={clients}
        canManage={canManagePermissions}
        onSet={onSetOverwrite}
        onDelete={onDeleteOverwrite}
      />

      {viewerOpen && hasIcon && (
        <ImageViewer
          src={cdnUrl(channel.channel_icon)}
          name={`${channel?.name ?? 'Channel'} icon`}
          onClose={() => setViewerOpen(false)}
        />
      )}

      {iconMenu && (
        <div
          className="channel-context-menu"
          ref={iconMenuRef}
          style={{ top: iconMenu.y, left: iconMenu.x }}
        >
          <button type="button" className="channel-context-item" onClick={replaceIcon}>
            <IconPhotoUp size={16} /> Replace Icon
          </button>
          <button type="button" className="channel-context-item danger" onClick={deleteIcon}>
            <IconTrash size={16} /> Remove Icon
          </button>
        </div>
      )}
    </div>
  )
}

export default ChannelSummary
