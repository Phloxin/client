import { useState, useRef, useEffect, useLayoutEffect, memo } from 'react'
import {
  IconPaperclip,
  IconMoodSmile,
  IconSend,
  IconX,
  IconFileText,
  IconPhotoVideo,
  IconPlayerPlayFilled,
  IconPencil,
  IconTrash
} from '@tabler/icons-react'
import ImageViewer from './ImageViewer'
import EmojiPicker from './EmojiPicker'
import { renderMarkdown } from '../lib/markdown'
import './ChatPanel.css'

// The message box grows with its content up to this many lines, then scrolls.
const MAX_INPUT_LINES = 10

// Consecutive messages from the same author within this window are grouped under
// one header (avatar + name + time), like Discord.
const GROUP_WINDOW_MS = 7 * 60 * 1000

function attachmentKind(file) {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

// "Today" / "Yesterday" / "June 24, 2026" label for a day divider.
function formatDateLabel(ts) {
  const d = new Date(ts)
  const today = new Date()
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)
  if (d.toDateString() === today.toDateString()) return 'Today'
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return d.toLocaleDateString([], { month: 'long', day: 'numeric', year: 'numeric' })
}

// Renders a message body as Discord-style markdown (links, bold/italic, inline
// and fenced code, etc.). Memoized so the parse only re-runs when the text
// changes, not on every feed re-render.
const MessageText = memo(function MessageText({ text }) {
  return <div className="chat-message-text">{renderMarkdown(text)}</div>
})

// Inline editor swapped in for a message's text while it's being edited. Mirrors
// the composer's auto-grow; Enter saves, Shift+Enter newlines, Escape cancels.
function MessageEditor({ initialText, onSave, onCancel }) {
  const [value, setValue] = useState(initialText)
  const ref = useRef(null)

  // Focus and place the caret at the end when the editor opens.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  // Grow to fit the content (no MAX cap here — edits are usually short).
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [value])

  const trimmed = value.trim()
  const submit = () => {
    if (!trimmed) return
    // No change → just close, so we don't issue a needless edit (which would
    // stamp an edited_timestamp for nothing).
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
    <div className="chat-message-edit">
      <textarea
        ref={ref}
        className="chat-message-edit-input"
        rows={1}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="chat-message-edit-hint">
        escape to{' '}
        <button type="button" onClick={onCancel}>
          cancel
        </button>
        {' • '}enter to{' '}
        <button type="button" onClick={submit} disabled={!trimmed}>
          save
        </button>
      </div>
    </div>
  )
}

// Extract a YouTube video id from a watch / youtu.be / embed / shorts URL.
function youtubeId(url) {
  if (!url) return null
  try {
    const u = new URL(url)
    const host = u.hostname.replace(/^www\./, '')
    if (host === 'youtu.be') return u.pathname.slice(1) || null
    if (host.endsWith('youtube.com')) {
      if (u.pathname === '/watch') return u.searchParams.get('v')
      const parts = u.pathname.split('/')
      if (parts[1] === 'embed' || parts[1] === 'shorts') return parts[2] || null
    }
  } catch {
    /* not a URL */
  }
  return null
}

// Only treat a video embed as a <video> when it's a real media file; provider
// "video" URLs (e.g. YouTube) are iframe players, not files.
const isDirectVideo = (url) => /\.(mp4|webm|mov|m4v)(\?|$)/i.test(url || '')

// A single embed card: link preview, image/video, or — for YouTube — a click-to-
// play facade that swaps in the (cookieless) iframe player only when clicked.
function MessageEmbed({ embed, onImageClick }) {
  const [playing, setPlaying] = useState(false)
  const ytId = youtubeId(embed.url)
  const media = embed.image || embed.thumbnail
  const poster = media?.url || (ytId ? `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg` : null)

  return (
    <div className="chat-embed">
      {embed.title &&
        (embed.url ? (
          <a href={embed.url} target="_blank" rel="noreferrer noopener" className="chat-embed-title">
            {embed.title}
          </a>
        ) : (
          <div className="chat-embed-title">{embed.title}</div>
        ))}
      {embed.description && <div className="chat-embed-description">{embed.description}</div>}

      {ytId ? (
        playing ? (
          <div className="chat-embed-player">
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${ytId}?autoplay=1`}
              title={embed.title || 'YouTube video'}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
            />
          </div>
        ) : (
          <button type="button" className="chat-embed-play" onClick={() => setPlaying(true)} title="Play">
            {poster && <img src={poster} alt={embed.title || ''} className="chat-embed-media" />}
            <span className="chat-embed-play-icon" aria-hidden="true">
              <span className="chat-embed-play-badge">
                <IconPlayerPlayFilled size={22} />
              </span>
            </span>
          </button>
        )
      ) : embed.video?.url && isDirectVideo(embed.video.url) ? (
        <video className="chat-embed-media" src={embed.video.url} controls />
      ) : media?.url ? (
        <img
          className="chat-embed-media chat-embed-image"
          src={media.url}
          alt={embed.title || ''}
          onClick={() => onImageClick({ url: media.url, name: embed.title || 'image' })}
        />
      ) : null}
    </div>
  )
}

// "Alice is typing", "Alice and Bob are typing", etc.
function formatTyping(names) {
  if (names.length === 1) return `${names[0]} is typing`
  if (names.length === 2) return `${names[0]} and ${names[1]} are typing`
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]} are typing`
  return 'Several people are typing'
}

function ChatPanel({
  feed,
  clients,
  selfId,
  onSend,
  onEditMessage,
  onDeleteMessage,
  onTyping,
  typingUsers = [],
  disabled
}) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [showEmoji, setShowEmoji] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [viewerImage, setViewerImage] = useState(null)
  // Id of the message currently being edited inline (only one at a time).
  const [editingId, setEditingId] = useState(null)
  // Id of the message pending a delete confirmation (drives the in-app dialog).
  const [pendingDeleteId, setPendingDeleteId] = useState(null)
  const fileInputRef = useRef(null)
  const emojiRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const dragCounterRef = useRef(0)

  // Keep the message list pinned to the latest entry
  useEffect(() => {
    if (listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight
    }
  }, [feed])

  // Grow the message box to fit its content, up to MAX_INPUT_LINES, then let it
  // scroll. Runs on every text change (typing, emoji insert, send-clear).
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto' // shrink first so scrollHeight reflects the content
    const cs = getComputedStyle(el)
    const lineHeight = parseFloat(cs.lineHeight) || 20
    const verticalPadding = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
    const verticalBorder = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
    const maxHeight = lineHeight * MAX_INPUT_LINES + verticalPadding + verticalBorder
    // scrollHeight excludes the border under border-box, so add it back.
    const fullHeight = el.scrollHeight + verticalBorder
    el.style.height = `${Math.min(fullHeight, maxHeight)}px`
    el.style.overflowY = fullHeight > maxHeight ? 'auto' : 'hidden'
  }, [text])

  // Close the emoji picker on outside click
  useEffect(() => {
    if (!showEmoji) return
    const close = (e) => {
      if (emojiRef.current && !emojiRef.current.contains(e.target)) setShowEmoji(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [showEmoji])

  // Release object URLs for any attachments still pending on unmount
  useEffect(() => () => attachments.forEach((a) => URL.revokeObjectURL(a.url)), [])

  // Escape closes the delete-confirmation dialog while it's open.
  useEffect(() => {
    if (pendingDeleteId == null) return
    const onKey = (e) => {
      if (e.key === 'Escape') setPendingDeleteId(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [pendingDeleteId])

  const handleFiles = (e) => {
    const files = Array.from(e.target.files || [])
    setAttachments((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        kind: attachmentKind(file),
        url: URL.createObjectURL(file)
      }))
    ])
    e.target.value = ''
  }

  const removeAttachment = (id) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.id === id)
      if (target) URL.revokeObjectURL(target.url)
      return prev.filter((a) => a.id !== id)
    })
  }

  const insertEmoji = (emoji) => {
    setText((prev) => prev + emoji)
    inputRef.current?.focus()
  }

  const handlePaste = (e) => {
    if (disabled) return
    const items = Array.from(e.clipboardData?.items || [])
    const imageItems = items.filter((item) => item.type.startsWith('image/'))
    if (!imageItems.length) return
    e.preventDefault()
    const files = imageItems.map((item) => {
      const blob = item.getAsFile()
      const ext = blob.type.split('/')[1] || 'png'
      return new File([blob], `pasted-image-${Date.now()}.${ext}`, { type: blob.type })
    })
    setAttachments((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        kind: 'image',
        url: URL.createObjectURL(file)
      }))
    ])
  }

  const handleSend = () => {
    if (disabled) return
    const trimmed = text.trim()
    if (!trimmed && !attachments.length) return
    onSend?.(trimmed, attachments)
    setText('')
    setAttachments([])
    setShowEmoji(false)
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleDragEnter = (e) => {
    e.preventDefault()
    if (disabled) return
    dragCounterRef.current++
    if (e.dataTransfer.types.includes('Files')) setDragging(true)
  }

  const handleDragLeave = (e) => {
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setDragging(false)
  }

  const handleDragOver = (e) => {
    e.preventDefault()
  }

  const handleDrop = (e) => {
    e.preventDefault()
    dragCounterRef.current = 0
    setDragging(false)
    if (disabled) return
    const files = Array.from(e.dataTransfer.files)
    if (!files.length) return
    setAttachments((prev) => [
      ...prev,
      ...files.map((file) => ({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        kind: attachmentKind(file),
        url: URL.createObjectURL(file)
      }))
    ])
  }

  const resolveName = (entry) =>
    clients?.find((c) => c.id === entry.authorId)?.name || entry.author || 'Unknown'

  const confirmDelete = () => {
    const id = pendingDeleteId
    setPendingDeleteId(null)
    if (id == null) return
    if (editingId === id) setEditingId(null)
    onDeleteMessage?.(id)
  }

  return (
    <div
      className="chat-panel"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dragging && (
        <div className="chat-drop-overlay">
          <div className="chat-drop-overlay-inner">Drop files to attach</div>
        </div>
      )}
      <div className="chat-messages" ref={listRef}>
        {feed.map((entry, i) => {
          const prev = feed[i - 1]
          // A divider marking the start of a new calendar day.
          const dayDivider =
            entry.ts &&
            (!prev || !prev.ts || new Date(prev.ts).toDateString() !== new Date(entry.ts).toDateString()) ? (
              <div key={`day-${entry.id}`} className="chat-day-divider">
                <span>{formatDateLabel(entry.ts)}</span>
              </div>
            ) : null

          if (entry.type === 'system') {
            return (
              <div key={entry.id}>
                {dayDivider}
                <div className="chat-system-entry">{entry.text}</div>
              </div>
            )
          }
          // Group consecutive messages from the same author (within a short
          // window, and not split by a system notice or day divider): only the
          // first shows the avatar + author + time; the rest are bare lines.
          const grouped =
            !dayDivider &&
            prev &&
            prev.type === 'message' &&
            prev.authorId === entry.authorId &&
            entry.ts - prev.ts < GROUP_WINDOW_MS
          // An uploaded file referenced by an embed resolves to the same URL, so
          // it's shown through the embed card — drop it from standalone attachments.
          const embedUrls = new Set()
          for (const em of entry.embeds || []) {
            for (const med of [em.image, em.thumbnail, em.video]) {
              if (med?.url) embedUrls.add(med.url)
            }
          }
          const visibleAttachments = (entry.attachments || []).filter((a) => !embedUrls.has(a.url))
          const isEditing = editingId === entry.id
          // Only the author may edit/delete their own messages (the server
          // enforces this too); hide the controls while that row is in edit mode.
          const isOwn = selfId != null && entry.authorId === selfId
          const canManage = isOwn && !disabled && !isEditing
          const edited = !!entry.editedTs && !isEditing
          return (
            <div key={entry.id}>
              {dayDivider}
              <div className={`chat-message${grouped ? ' grouped' : ''}`}>
              {grouped ? (
                <span className="chat-avatar-spacer" aria-hidden="true" />
              ) : (
                <span className="chat-avatar" aria-hidden="true">
                  {resolveName(entry).charAt(0).toUpperCase()}
                </span>
              )}
              {canManage && (
                <div className="chat-message-actions">
                  <button
                    type="button"
                    className="chat-message-action"
                    title="Edit"
                    onClick={() => setEditingId(entry.id)}
                  >
                    <IconPencil size={15} />
                  </button>
                  <button
                    type="button"
                    className="chat-message-action chat-message-action-danger"
                    title="Delete"
                    onClick={() => setPendingDeleteId(entry.id)}
                  >
                    <IconTrash size={15} />
                  </button>
                </div>
              )}
              <div className="chat-message-body">
                {!grouped && (
                  <div className="chat-message-header">
                    <span className="chat-message-author">{resolveName(entry)}</span>
                    <span className="chat-message-time">{formatTime(entry.ts)}</span>
                    {edited && <span className="chat-message-edited">(edited)</span>}
                  </div>
                )}
                {isEditing ? (
                  <MessageEditor
                    initialText={entry.text || ''}
                    onSave={(content) => {
                      onEditMessage?.(entry.id, content)
                      setEditingId(null)
                    }}
                    onCancel={() => setEditingId(null)}
                  />
                ) : (
                  entry.text && (
                    <MessageText text={entry.text} />
                  )
                )}
                {grouped && edited && (
                  <span className="chat-message-edited chat-message-edited-inline">(edited)</span>
                )}
                {visibleAttachments.length > 0 && (
                  <div className="chat-message-attachments">
                    {visibleAttachments.map((a) => (
                      <div key={a.id} className="chat-attachment">
                        {a.kind === 'image' ? (
                          <img
                            src={a.url}
                            alt={a.name}
                            className="chat-attachment-image"
                            onClick={() => setViewerImage({ url: a.url, name: a.name })}
                          />
                        ) : a.kind === 'video' ? (
                          <video src={a.url} controls />
                        ) : (
                          <div className="chat-attachment-file">
                            <IconFileText size={18} />
                            <span>{a.name}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {(entry.embeds || []).map((embed, idx) => (
                  <MessageEmbed key={idx} embed={embed} onImageClick={setViewerImage} />
                ))}
              </div>
              </div>
            </div>
          )
        })}
      </div>

      {!!attachments.length && (
        <div className="chat-attachment-previews">
          {attachments.map((a) => (
            <div key={a.id} className="chat-attachment-preview">
              {a.kind === 'image' ? (
                <img src={a.url} alt={a.name} />
              ) : a.kind === 'video' ? (
                <IconPhotoVideo size={20} />
              ) : (
                <IconFileText size={20} />
              )}
              <span className="chat-attachment-preview-name">{a.name}</span>
              <button
                type="button"
                className="chat-attachment-remove"
                title="Remove"
                onClick={() => removeAttachment(a.id)}
              >
                <IconX size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {typingUsers.length > 0 && (
        <div className="chat-typing-indicator">
          <span className="chat-typing-dots" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
          <span className="chat-typing-text">{formatTyping(typingUsers)}</span>
        </div>
      )}

      <div className="chat-input-bar">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={handleFiles}
          disabled={disabled}
        />
        <button
          type="button"
          className="chat-icon-btn"
          title="Attach files"
          onClick={() => fileInputRef.current?.click()}
          disabled={disabled}
        >
          <IconPaperclip size={20} />
        </button>
        <textarea
          ref={inputRef}
          rows={1}
          placeholder={disabled ? 'Join a channel to chat' : 'Message...'}
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            if (e.target.value) onTyping?.()
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled}
        />
        <div className="chat-emoji-wrapper" ref={emojiRef}>
          <button
            type="button"
            className="chat-icon-btn"
            title="Emoji"
            onClick={() => setShowEmoji((prev) => !prev)}
            disabled={disabled}
          >
            <IconMoodSmile size={20} />
          </button>
          {showEmoji && <EmojiPicker onSelect={insertEmoji} />}
        </div>
        <button
          type="button"
          className="chat-send-btn"
          title="Send"
          disabled={disabled || (!text.trim() && !attachments.length)}
          onClick={handleSend}
        >
          <IconSend size={20} stroke={2.5}/>
        </button>
      </div>

      {viewerImage && (
        <ImageViewer
          src={viewerImage.url}
          name={viewerImage.name}
          onClose={() => setViewerImage(null)}
        />
      )}

      {pendingDeleteId != null && (
        <div
          className="chat-confirm-overlay"
          onClick={() => setPendingDeleteId(null)}
          role="presentation"
        >
          <div
            className="chat-confirm-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="chat-confirm-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chat-confirm-body">
              Are you sure you want to delete this message? This cannot be undone.
            </div>
            <div className="chat-confirm-footer">
              <button
                type="button"
                className="chat-confirm-btn secondary"
                onClick={() => setPendingDeleteId(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="chat-confirm-btn danger"
                onClick={confirmDelete}
                autoFocus
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default ChatPanel
