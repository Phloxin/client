import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import {
  IconPaperclip,
  IconMoodSmile,
  IconSend,
  IconX,
  IconFileText,
  IconPhotoVideo
} from '@tabler/icons-react'
import ImageViewer from './ImageViewer'
import EmojiPicker from './EmojiPicker'
import './ChatPanel.css'

// The message box grows with its content up to this many lines, then scrolls.
const MAX_INPUT_LINES = 10

function attachmentKind(file) {
  if (file.type.startsWith('image/')) return 'image'
  if (file.type.startsWith('video/')) return 'video'
  return 'file'
}

function formatTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function ChatPanel({ feed, clients, onSend, disabled }) {
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
        {feed.map((entry) =>
          entry.type === 'system' ? (
            <div key={entry.id} className="chat-system-entry">{entry.text}</div>
          ) : (
            <div key={entry.id} className="chat-message">
              <span className="chat-avatar" aria-hidden="true">
                {resolveName(entry).charAt(0).toUpperCase()}
              </span>
              <div className="chat-message-body">
                <div className="chat-message-header">
                  <span className="chat-message-author">{resolveName(entry)}</span>
                  <span className="chat-message-time">{formatTime(entry.ts)}</span>
                </div>
                {entry.text && <div className="chat-message-text">{entry.text}</div>}
                {!!entry.attachments?.length && (
                  <div className="chat-message-attachments">
                    {entry.attachments.map((a) => (
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
              </div>
            </div>
          )
        )}
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
          onChange={(e) => setText(e.target.value)}
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
