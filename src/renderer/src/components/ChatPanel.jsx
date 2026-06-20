import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import {
  IconPaperclip,
  IconMoodSmile,
  IconSend,
  IconX,
  IconFileText,
  IconPhotoVideo,
  IconPlayerPlayFilled
} from '@tabler/icons-react'
import ImageViewer from './ImageViewer'
import EmojiPicker from './EmojiPicker'
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

// Split text into plain strings + clickable links. Clicking an <a target=_blank>
// is handled by the main process's window-open handler (opens in the system
// browser). Trailing sentence punctuation is kept out of the link.
const URL_RE = /(https?:\/\/[^\s<]+)/g
function linkify(text) {
  const out = []
  let last = 0
  let m
  URL_RE.lastIndex = 0
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index))
    let url = m[0]
    const trail = url.match(/[.,!?;:'")\]}]+$/)
    const trailing = trail ? trail[0] : ''
    if (trailing) url = url.slice(0, -trailing.length)
    out.push(
      <a key={m.index} href={url} target="_blank" rel="noreferrer noopener" className="chat-link">
        {url}
      </a>
    )
    if (trailing) out.push(trailing)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
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

function ChatPanel({ feed, clients, onSend, onTyping, typingUsers = [], disabled }) {
  const [text, setText] = useState('')
  const [attachments, setAttachments] = useState([])
  const [showEmoji, setShowEmoji] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [viewerImage, setViewerImage] = useState(null)
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
          if (entry.type === 'system') {
            return <div key={entry.id} className="chat-system-entry">{entry.text}</div>
          }
          // Group consecutive messages from the same author (within a short
          // window, and not split by a system notice): only the first shows the
          // avatar + author + time; the rest are bare lines aligned beneath it.
          const prev = feed[i - 1]
          const grouped =
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
          return (
            <div key={entry.id} className={`chat-message${grouped ? ' grouped' : ''}`}>
              {grouped ? (
                <span className="chat-avatar-spacer" aria-hidden="true" />
              ) : (
                <span className="chat-avatar" aria-hidden="true">
                  {resolveName(entry).charAt(0).toUpperCase()}
                </span>
              )}
              <div className="chat-message-body">
                {!grouped && (
                  <div className="chat-message-header">
                    <span className="chat-message-author">{resolveName(entry)}</span>
                    <span className="chat-message-time">{formatTime(entry.ts)}</span>
                  </div>
                )}
                {entry.text && <div className="chat-message-text">{linkify(entry.text)}</div>}
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
    </div>
  )
}

export default ChatPanel
