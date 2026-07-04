import { useState, useRef, useLayoutEffect } from 'react'
import './ClientSummary.css'
import { IconVolume, IconPencil } from '@tabler/icons-react'

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
function ChannelSummary({ channel, memberCount = 0, onSaveDescription }) {
  const limit = channel?.user_limit || 0
  const [editing, setEditing] = useState(false)
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
        <span className="client-summary-avatar" aria-hidden="true">
          <IconVolume size={28} stroke={2} />
        </span>
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
    </div>
  )
}

export default ChannelSummary
