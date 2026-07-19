import { useState, useRef, useEffect, useLayoutEffect, useMemo, memo } from 'react'
import {
  IconPaperclip,
  IconMoodSmile,
  IconSendFilled,
  IconX,
  IconFileText,
  IconPhotoVideo,
  IconPlayerPlayFilled,
  IconPencil,
  IconTrash,
  IconCopy,
  IconPhoto,
  IconArrowDown,
  IconMoodPlus
} from '@tabler/icons-react'
import { motion, AnimatePresence } from 'motion/react'
import ImageViewer from './ImageViewer'
import EmojiPicker from './EmojiPicker'
import { renderMarkdown } from '../lib/markdown'
import { useClientMenu } from './ClientContextMenu'
import { useClientActions } from '../context/ClientActionsContext'
import { useAnimationCategory, useSettings } from '../context/SettingsContext'
import { useAnimatedPresence } from '../lib/animation'
import { menuPop, overlayPop, scrimFade } from '../lib/motionPresets'
import './ChatPanel.css'

// The message box grows with its content up to this many lines, then scrolls.
const MAX_INPUT_LINES = 10

// Consecutive messages from the same author within this window are grouped under
// one header (avatar + name + time), like Discord.
const GROUP_WINDOW_MS = 7 * 60 * 1000

// Quick reactions shown in the hover bar on every message.
const QUICK_REACTIONS = ['👍', '👎', '😂', '❤️', '🍅']

// Unsent composer text per channel, so a draft survives switching chats (the
// panel remounts per channel). ponytail: in-memory only — gone on app restart;
// move to localStorage if drafts should survive relaunches.
const drafts = new Map()

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

// Replace [start, end) in a textarea with `text`. execCommand is deprecated but
// is the only route that keeps the native undo stack intact for a React-
// controlled textarea — when it no-ops (it returns false, and Chromium refuses
// it outright in some builds) fall back to writing the value through the native
// setter so React's onChange still fires, losing only the undo entry.
function replaceRange(el, start, end, text) {
  el.setSelectionRange(start, end)
  if (document.execCommand('insertText', false, text)) return
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setValue.call(el, el.value.slice(0, start) + text + el.value.slice(end))
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

// Formatting hotkeys for the composer and message editor: wrap (or unwrap) the
// selection in a markdown marker. Returns true when the key was handled.
const FORMAT_MARKERS = { b: '**', i: '*', u: '__', e: '`' }
function handleFormatHotkey(e, el) {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || !el) return false
  const key = e.key.toLowerCase()
  const marker = e.shiftKey ? (key === 'x' ? '~~' : null) : FORMAT_MARKERS[key]
  if (!marker) return false
  e.preventDefault()
  const start = el.selectionStart
  const end = el.selectionEnd
  const selected = el.value.slice(start, end)
  const wrapped =
    el.value.slice(start - marker.length, start) === marker &&
    el.value.slice(end, end + marker.length) === marker
  if (wrapped) {
    // Already wrapped → toggle off: reselect including the markers, replace
    // with the bare text, and restore the selection.
    replaceRange(el, start - marker.length, end + marker.length, selected)
    el.setSelectionRange(start - marker.length, end - marker.length)
  } else {
    replaceRange(el, start, end, marker + selected + marker)
    el.setSelectionRange(start + marker.length, end + marker.length)
  }
  return true
}

// Splits text into grapheme clusters so a ZWJ sequence, flag, or skin-tone
// variant counts as one visual emoji rather than its component code points.
// Created once — Segmenter construction isn't cheap.
const graphemeSegmenter =
  typeof Intl !== 'undefined' && Intl.Segmenter
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

// A grapheme renders as emoji if it carries a pictographic char, a regional-
// indicator (a flag's halves), or an emoji-presentation selector (U+FE0F, which
// promotes keycaps and other text-default glyphs). Plain letters/digits don't
// match, so "1" or "hi" alone stay normal-sized.
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\uFE0F/u

function emojiOnlySizeClass(text) {
  const trimmed = (text || '').trim()
  if (!trimmed || !graphemeSegmenter) return null
  let count = 0
  for (const { segment } of graphemeSegmenter.segment(trimmed)) {
    if (/^\s+$/.test(segment)) continue // whitespace between emoji is allowed
    if (!EMOJI_RE.test(segment)) return null // any other glyph → normal size
    count++
  }
  if (count === 1) return 'emoji-jumbo'
  if (count <= 3) return 'emoji-medium'
  return null // 0 (unreachable) or 4+ → normal size
}

// Renders a message body as Discord-style markdown (links, bold/italic, inline
// and fenced code, etc.). Memoized so the parse only re-runs when the text
// changes, not on every feed re-render. Emoji-only messages get a jumbo/medium
// size class (see emojiOnlySizeClass).
const MessageText = memo(function MessageText({ text, resolveMention }) {
  const sizeClass = emojiOnlySizeClass(text)
  return (
    <div className={`chat-message-text${sizeClass ? ` ${sizeClass}` : ''}`}>
      {renderMarkdown(text, resolveMention)}
    </div>
  )
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
    if (handleFormatHotkey(e, ref.current)) return
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
          <a
            href={embed.url}
            target="_blank"
            rel="noreferrer noopener"
            className="chat-embed-title"
          >
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
          <button
            type="button"
            className="chat-embed-play"
            onClick={() => setPlaying(true)}
            title="Play"
          >
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

// Copy an image to the clipboard. The clipboard only accepts PNG, so anything
// else is re-encoded through a canvas first.
async function copyImageToClipboard(url) {
  try {
    const blob = await fetch(url).then((r) => r.blob())
    let png = blob
    if (blob.type !== 'image/png') {
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
      canvas.getContext('2d').drawImage(bitmap, 0, 0)
      png = await canvas.convertToBlob({ type: 'image/png' })
    }
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })])
  } catch (err) {
    console.error('Copy image failed:', err)
  }
}

// Encode plain "@name" tokens to the wire form <@id> — the server only parses
// <@id>. Longest names first so "@timothy" isn't half-eaten by a client named
// "tim". @everyone has no client entry, so it passes through untouched.
function encodeMentions(text, clients) {
  if (!text.includes('@') || !clients?.length) return text
  const named = clients.filter((c) => c.name).sort((a, b) => b.name.length - a.name.length)
  let out = text
  for (const c of named) {
    const esc = c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    out = out.replace(new RegExp(`@${esc}(?!\\w)`, 'gi'), `<@${c.id}>`)
  }
  return out
}

// Composer text split into plain segments and mention pills, for the highlight
// backdrop behind the textarea. Same matching rules as encodeMentions, so what
// lights up is exactly what will encode on send.
function composerMentionNodes(text, clients) {
  const names = (clients || [])
    .filter((c) => c.name)
    .map((c) => c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length)
  if (!text || !names.length) return text
  const re = new RegExp(`@(?:${names.join('|')})(?!\\w)`, 'gi')
  const out = []
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span className="chat-mention" key={m.index}>
        {m[0]}
      </span>
    )
    last = m.index + m[0].length
  }
  out.push(text.slice(last))
  return out
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
  onReactMessage,
  onTyping,
  typingUsers = [],
  disabled,
  channelKey,
  onLoadOlder,
  hasMoreOlder = false
}) {
  const [text, setText] = useState(() => drafts.get(channelKey) || '')
  const [attachments, setAttachments] = useState([])

  // Swap the composer over to the new channel's draft when channelKey changes
  // without a remount (in-render state adjustment, per React docs).
  const [draftKey, setDraftKey] = useState(channelKey)
  if (draftKey !== channelKey) {
    setDraftKey(channelKey)
    setText(drafts.get(channelKey) || '')
  }

  const updateText = (value) => {
    setText(value)
    drafts.set(channelKey, value)
  }
  // Compact display drops the avatar and shows a name/time header on every
  // message (no grouping), for a tighter single-line-per-message list.
  const compact = useSettings().appearanceSettings.messageDisplay === 'compact'
  const overlayAnim = useAnimationCategory('overlays')
  // New rows slide in (tagged 'entering' by the presence hook) when the
  // Messages animation category is on; the actual keyframes live in
  // styles/animations.css behind data-anim-messages.
  const msgAnim = useAnimationCategory('messages')
  const feedPresence = useAnimatedPresence(feed, (e) => e.id, {
    enabled: msgAnim,
    enterDuration: 260
  })
  const [showEmoji, setShowEmoji] = useState(false)
  // @mention autocomplete: { start, query } while the caret sits in an @token
  // being typed, else null. `start` is the index of the '@' in the text.
  const [mention, setMention] = useState(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [viewerImage, setViewerImage] = useState(null)
  // Id of the message currently being edited inline (only one at a time).
  const [editingId, setEditingId] = useState(null)
  // Id of the message pending a delete confirmation (drives the in-app dialog).
  const [pendingDeleteId, setPendingDeleteId] = useState(null)
  // Right-click menu on own messages: { id, x, y } while open, else null.
  const [msgMenu, setMsgMenu] = useState(null)
  // Emoji picker for reactions (from the hover bar's "+"): { id, x, y } or null.
  const [reactPicker, setReactPicker] = useState(null)
  const reactPickerRef = useRef(null)
  // Jump-to-bottom pill: shown when scrolled away from the bottom; switches to
  // "New messages" when something arrived below the viewport in the meantime.
  const [scrolledUp, setScrolledUp] = useState(false)
  const [newBelow, setNewBelow] = useState(false)
  const lastMsgIdRef = useRef(null)
  const msgMenuRef = useRef(null)
  const fileInputRef = useRef(null)
  const highlightRef = useRef(null)
  const emojiRef = useRef(null)
  const listRef = useRef(null)
  const inputRef = useRef(null)
  const dragCounterRef = useRef(0)
  // Last-seen scroll metrics, the channel we measured them in, and a flag set
  // when a scroll-up load is prepending older messages (so we hold the viewport
  // in place instead of snapping to the bottom).
  const metricsRef = useRef({ scrollTop: 0, scrollHeight: 0, clientHeight: 0 })
  const channelKeyRef = useRef(channelKey)
  const prependingRef = useRef(false)

  // After every feed change, decide where to leave the scroll position:
  //  - switched channels        → snap to the bottom (newest)
  //  - just prepended older msgs → keep the same messages under the viewport
  //  - was already near bottom   → follow new messages down
  //  - scrolled up reading       → leave it alone
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    const prev = metricsRef.current
    const lastId = feed[feed.length - 1]?.id
    if (channelKeyRef.current !== channelKey) {
      channelKeyRef.current = channelKey
      prependingRef.current = false
      el.scrollTop = el.scrollHeight
      setScrolledUp(false)
      setNewBelow(false)
    } else if (prependingRef.current) {
      prependingRef.current = false
      el.scrollTop = el.scrollHeight - prev.scrollHeight + prev.scrollTop
    } else if (prev.scrollHeight - prev.scrollTop - prev.clientHeight < 80) {
      el.scrollTop = el.scrollHeight
    } else if (lastId != null && lastId !== lastMsgIdRef.current) {
      // A new bottom message landed while we're scrolled up reading history.
      setNewBelow(true)
    }
    lastMsgIdRef.current = lastId
    metricsRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    }
  }, [feed, channelKey])

  // Near the top → pull the previous page (once at a time), remembering the
  // pre-prepend metrics so the layout effect can restore the viewport.
  const handleScroll = () => {
    const el = listRef.current
    if (!el) return
    metricsRef.current = {
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight
    }
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 160
    setScrolledUp(away)
    if (!away) setNewBelow(false)
    if (el.scrollTop < 80 && hasMoreOlder && !prependingRef.current && onLoadOlder) {
      prependingRef.current = true
      Promise.resolve(onLoadOlder()).then((added) => {
        // Nothing actually prepended (deduped/empty) → drop the hold so the
        // next scroll can try again.
        if (added === 0) prependingRef.current = false
      })
    }
  }

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

  // Close the message context menu on outside click.
  useEffect(() => {
    if (!msgMenu) return
    const close = (e) => {
      if (msgMenuRef.current && !msgMenuRef.current.contains(e.target)) setMsgMenu(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [msgMenu])

  // Close the reaction emoji picker on outside click.
  useEffect(() => {
    if (!reactPicker) return
    const close = (e) => {
      if (reactPickerRef.current && !reactPickerRef.current.contains(e.target)) setReactPicker(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [reactPicker])

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

  // Re-derive the active @token from the text before the caret. "@" opens the
  // popup; the query narrows as they keep typing (word chars only, so a space
  // or punctuation ends the token).
  const updateMention = (value, caret) => {
    const m = value.slice(0, caret).match(/(?:^|\s)@(\w*)$/)
    setMention(m ? { start: caret - m[1].length - 1, query: m[1] } : null)
    setMentionIndex(0)
  }

  const mentionMatches = mention
    ? (clients || [])
        .filter((c) => c.name?.toLowerCase().includes(mention.query.toLowerCase()))
        .slice(0, 8)
    : []

  // Replace the in-progress @token with the chosen name. The composer keeps
  // the friendly "@name" text; handleSend encodes it to <@id> for the wire.
  const selectMention = (c) => {
    const caret = inputRef.current?.selectionEnd ?? text.length
    updateText(`${text.slice(0, mention.start)}@${c.name} ${text.slice(caret)}`)
    setMention(null)
    const pos = mention.start + c.name.length + 2
    requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.setSelectionRange(pos, pos)
    })
  }

  const insertEmoji = (emoji) => {
    updateText(text + emoji)
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
    onSend?.(encodeMentions(trimmed, clients), attachments)
    setMention(null)
    setText('')
    drafts.delete(channelKey)
    setAttachments([])
    setShowEmoji(false)
  }

  const handleKeyDown = (e) => {
    // The mention popup captures navigation keys while it's open.
    if (mention && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const delta = e.key === 'ArrowDown' ? 1 : -1
        setMentionIndex((i) => (i + delta + mentionMatches.length) % mentionMatches.length)
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectMention(mentionMatches[mentionIndex])
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        setMention(null)
        return
      }
    }
    if (handleFormatHotkey(e, inputRef.current)) return
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

  // Stable per clients-roster so the memoized MessageText only re-parses when
  // the roster actually changes. Snowflake ids compare as strings — the token
  // regex captures a string while roster ids may be numbers.
  const resolveMention = useMemo(
    () => (id) => clients?.find((c) => String(c.id) === id)?.name,
    [clients]
  )

  const resolveAvatar = (entry) => clients?.find((c) => c.id === entry.authorId)?.avatar

  // The message author's roster entry, or undefined if they've since left — in
  // which case their name/avatar stay inert (no summary link, no menu).
  const resolveClient = (entry) => clients?.find((c) => c.id === entry.authorId)

  // One shared context menu for the whole feed (only one can be open at a time),
  // opened by right-clicking any message's author name or avatar. Same menu the
  // sidebar roster shows, minus the voice-only volume control.
  const clientActions = useClientActions()
  const { menu: authorMenu, openMenu: openAuthorMenu } = useClientMenu(clientActions)
  const authorProps = (entry) => {
    const c = resolveClient(entry)
    if (!c) return {}
    return {
      onContextMenu: (e) => openAuthorMenu(e, c, { isSelf: c.id === selfId, rosterMode: true }),
      onClick: () => clientActions.onShowClientSummary?.(c.id)
    }
  }

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
      {authorMenu}
      {dragging && (
        <div className="chat-drop-overlay">
          <div className="chat-drop-overlay-inner">Drop files to attach</div>
        </div>
      )}
      <div
        className={`chat-messages${compact ? ' compact' : ''}`}
        ref={listRef}
        onScroll={handleScroll}
      >
        {feedPresence.map(({ item: entry, status }, i) => {
          const prev = feedPresence[i - 1]?.item
          // A divider marking the start of a new calendar day.
          const dayDivider =
            entry.ts &&
            (!prev ||
              !prev.ts ||
              new Date(prev.ts).toDateString() !== new Date(entry.ts).toDateString()) ? (
              <div key={`day-${entry.id}`} className="chat-day-divider">
                <span>{formatDateLabel(entry.ts)}</span>
              </div>
            ) : null

          if (entry.type === 'system') {
            return (
              <div key={entry.id} data-anim-status={status}>
                {dayDivider}
                <div className="chat-system-entry">{entry.text}</div>
              </div>
            )
          }
          // Group consecutive messages from the same author (within a short
          // window, and not split by a system notice or day divider): only the
          // first shows the avatar + author + time; the rest are bare lines.
          const grouped =
            !compact &&
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
          // First image in the message (attachment, else embed image) for Copy Image.
          const imageUrl =
            visibleAttachments.find((a) => a.kind === 'image')?.url ||
            (entry.embeds || []).map((em) => (em.image || em.thumbnail)?.url).find(Boolean) ||
            null
          const hasMenu = canManage || entry.text || imageUrl
          // Accent wash on messages that mention us (directly or @everyone).
          const mentionsMe =
            entry.mentionEveryone || (selfId != null && (entry.mentions || []).includes(selfId))
          return (
            <div key={entry.id} data-anim-status={status}>
              {dayDivider}
              <div
                className={`chat-message${grouped ? ' grouped' : ''}${mentionsMe ? ' mentioned' : ''}`}
                onContextMenu={
                  hasMenu
                    ? (e) => {
                        e.preventDefault()
                        setMsgMenu({
                          id: entry.id,
                          x: e.clientX,
                          y: e.clientY,
                          text: entry.text || null,
                          imageUrl,
                          canManage
                        })
                      }
                    : undefined
                }
              >
                {!disabled && !isEditing && (
                  <div className="chat-hover-actions">
                    {QUICK_REACTIONS.map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        className="chat-hover-action"
                        title={`React with ${emoji}`}
                        onClick={() => onReactMessage?.(entry.id, emoji)}
                      >
                        {emoji}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="chat-hover-action"
                      title="More reactions"
                      onClick={(e) => {
                        const r = e.currentTarget.getBoundingClientRect()
                        setReactPicker({ id: entry.id, x: r.right, y: r.bottom + 4 })
                      }}
                    >
                      <IconMoodPlus size={16} />
                    </button>
                  </div>
                )}
                {grouped ? (
                  <span className="chat-avatar-spacer" aria-hidden="true" />
                ) : (
                  // aria-hidden: the avatar duplicates the author name beside it,
                  // which carries the accessible link/menu affordance.
                  <span
                    className={`chat-avatar${resolveClient(entry) ? ' chat-avatar-actionable' : ''}`}
                    aria-hidden="true"
                    {...authorProps(entry)}
                  >
                    {resolveAvatar(entry) ? (
                      <img className="chat-avatar-img" src={resolveAvatar(entry)} alt="" />
                    ) : (
                      resolveName(entry).charAt(0).toUpperCase()
                    )}
                  </span>
                )}
                <div className="chat-message-body">
                  {!grouped && (
                    <div className="chat-message-header">
                      {resolveClient(entry) ? (
                        <span
                          className="chat-message-author chat-message-author-link"
                          role="button"
                          tabIndex={0}
                          title={`View ${resolveName(entry)}'s profile`}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              clientActions.onShowClientSummary?.(entry.authorId)
                            }
                          }}
                          {...authorProps(entry)}
                        >
                          {resolveName(entry)}
                        </span>
                      ) : (
                        <span className="chat-message-author">{resolveName(entry)}</span>
                      )}
                      <span className="chat-message-time">{formatTime(entry.ts)}</span>
                      {edited && <span className="chat-message-edited">(edited)</span>}
                    </div>
                  )}
                  {isEditing ? (
                    <MessageEditor
                      initialText={entry.text || ''}
                      onSave={(content) => {
                        onEditMessage?.(entry.id, encodeMentions(content, clients))
                        setEditingId(null)
                      }}
                      onCancel={() => setEditingId(null)}
                    />
                  ) : (
                    entry.text && <MessageText text={entry.text} resolveMention={resolveMention} />
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
                  {/* Rendered even when empty (hidden via :empty) so chips can
                      play their exit animation as the last one is removed. */}
                  <div className="chat-reactions">
                    <AnimatePresence initial={false}>
                      {(entry.reactions || []).map((r) => (
                        <motion.button
                          key={r.emoji}
                          type="button"
                          className={`chat-reaction${r.me ? ' mine' : ''}`}
                          title={`${r.count} reaction${r.count === 1 ? '' : 's'}`}
                          onClick={() => onReactMessage?.(entry.id, r.emoji)}
                          layout={msgAnim}
                          // Only re-measure when this message's own reactions
                          // change — otherwise unrelated re-renders (typing
                          // indicator, new messages) replay the slide and the
                          // chips drift apart from their message.
                          layoutDependency={entry.reactions}
                          {...(msgAnim
                            ? {
                                initial: { opacity: 0, scale: 0.4 },
                                animate: { opacity: 1, scale: 1 },
                                exit: { opacity: 0, scale: 0.4 },
                                transition: { duration: 0.15, ease: 'easeOut' }
                              }
                            : { initial: false })}
                        >
                          {r.emoji}
                          {/* Keyed by count so a change remounts the number and
                              it ticks in from above. */}
                          <motion.span
                            key={msgAnim ? r.count : 'count'}
                            className="chat-reaction-count"
                            {...(msgAnim
                              ? {
                                  initial: { y: -7, opacity: 0 },
                                  animate: { y: 0, opacity: 1 },
                                  transition: { duration: 0.15, ease: 'easeOut' }
                                }
                              : {})}
                          >
                            {r.count}
                          </motion.span>
                        </motion.button>
                      ))}
                    </AnimatePresence>
                  </div>
                </div>
              </div>
            </div>
          )
        })}
        {scrolledUp && (
          <button
            type="button"
            className={`chat-jump-pill${newBelow ? ' has-new' : ''}`}
            onClick={() => {
              listRef.current?.scrollTo({
                top: listRef.current.scrollHeight,
                behavior: 'smooth'
              })
              setNewBelow(false)
            }}
          >
            <IconArrowDown size={14} stroke={2.5} />
            {newBelow ? 'New messages' : 'Jump to latest'}
          </button>
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

      <AnimatePresence>
        {typingUsers.length > 0 && (
          <motion.div
            className="chat-typing-indicator"
            {...(overlayAnim
              ? {
                  initial: { opacity: 0, y: 4 },
                  animate: { opacity: 1, y: 0 },
                  exit: { opacity: 0, y: 4 },
                  transition: { duration: 0.15, ease: 'easeOut' }
                }
              : { initial: false })}
          >
            <span className="chat-typing-dots" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
            <span className="chat-typing-text">{formatTyping(typingUsers)}</span>
          </motion.div>
        )}
      </AnimatePresence>

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
        <div className="chat-input-wrap">
          {/* Highlight backdrop: mirrors the textarea's text with mention
              pills; the textarea above it types in transparent glyphs. */}
          <div className="chat-input-highlight" ref={highlightRef} aria-hidden="true">
            {composerMentionNodes(text, clients)}
          </div>
          <textarea
            ref={inputRef}
            rows={1}
            placeholder={disabled ? 'Join a channel to chat' : 'Message...'}
            value={text}
            onChange={(e) => {
              updateText(e.target.value)
              updateMention(e.target.value, e.target.selectionEnd)
              if (e.target.value) onTyping?.()
            }}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => setMention(null)}
            onScroll={(e) => {
              // Keep the backdrop aligned when the composer scrolls at max height.
              if (highlightRef.current) highlightRef.current.scrollTop = e.target.scrollTop
            }}
            disabled={disabled}
          />
        </div>
        <AnimatePresence>
          {mention && mentionMatches.length > 0 && (
            <motion.div className="chat-mention-pop" {...menuPop(overlayAnim)}>
              {mentionMatches.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  className={`chat-mention-item${i === mentionIndex ? ' active' : ''}`}
                  // mousedown so this fires before the textarea's blur closes us
                  onMouseDown={(e) => {
                    e.preventDefault()
                    selectMention(c)
                  }}
                  onMouseEnter={() => setMentionIndex(i)}
                >
                  <span className="chat-avatar chat-mention-avatar" aria-hidden="true">
                    {c.avatar ? (
                      <img className="chat-avatar-img" src={c.avatar} alt="" />
                    ) : (
                      (c.name || '?').charAt(0).toUpperCase()
                    )}
                  </span>
                  {c.name}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
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
          <AnimatePresence>
            {showEmoji && (
              <motion.div className="chat-emoji-pop" {...menuPop(overlayAnim)}>
                <EmojiPicker onSelect={insertEmoji} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        <button
          type="button"
          className="chat-send-btn"
          title="Send"
          disabled={disabled || (!text.trim() && !attachments.length)}
          onClick={handleSend}
        >
          <IconSendFilled size={20} />
        </button>
      </div>

      {msgMenu && (
        <div
          className="client-context-menu chat-message-menu"
          ref={msgMenuRef}
          style={{ top: msgMenu.y, left: msgMenu.x }}
        >
          {msgMenu.text && (
            <button
              type="button"
              className="client-context-menu-item"
              onClick={() => {
                navigator.clipboard.writeText(msgMenu.text)
                setMsgMenu(null)
              }}
            >
              <IconCopy size={16} />
              Copy Message
            </button>
          )}
          {msgMenu.imageUrl && (
            <button
              type="button"
              className="client-context-menu-item"
              onClick={() => {
                copyImageToClipboard(msgMenu.imageUrl)
                setMsgMenu(null)
              }}
            >
              <IconPhoto size={16} />
              Copy Image
            </button>
          )}
          {msgMenu.canManage && (
            <>
              {(msgMenu.text || msgMenu.imageUrl) && (
                <div className="client-context-menu-divider" aria-hidden="true" />
              )}
              <button
                type="button"
                className="client-context-menu-item"
                onClick={() => {
                  setEditingId(msgMenu.id)
                  setMsgMenu(null)
                }}
              >
                <IconPencil size={16} />
                Edit Message
              </button>
              <button
                type="button"
                className="client-context-menu-item danger"
                onClick={() => {
                  setPendingDeleteId(msgMenu.id)
                  setMsgMenu(null)
                }}
              >
                <IconTrash size={16} />
                Delete Message
              </button>
            </>
          )}
        </div>
      )}

      <AnimatePresence>
        {reactPicker && (
          <motion.div
            className="chat-react-pop"
            ref={reactPickerRef}
            style={{
              // Keep the 320x360 picker on screen, flipping above the button
              // when there's no room below.
              left: Math.max(8, Math.min(reactPicker.x - 320, window.innerWidth - 328)),
              top:
                reactPicker.y + 360 > window.innerHeight - 8
                  ? reactPicker.y - 360 - 40
                  : reactPicker.y
            }}
            {...menuPop(overlayAnim)}
          >
            <EmojiPicker
              onSelect={(emoji) => {
                onReactMessage?.(reactPicker.id, emoji)
                setReactPicker(null)
              }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {viewerImage && (
        <ImageViewer
          src={viewerImage.url}
          name={viewerImage.name}
          onClose={() => setViewerImage(null)}
        />
      )}

      <AnimatePresence>
        {pendingDeleteId != null && (
          <motion.div
            className="chat-confirm-overlay"
            onClick={() => setPendingDeleteId(null)}
            role="presentation"
            {...scrimFade(overlayAnim)}
          >
            <motion.div
              className="chat-confirm-modal"
              role="dialog"
              aria-modal="true"
              aria-labelledby="chat-confirm-title"
              onClick={(e) => e.stopPropagation()}
              {...overlayPop(overlayAnim)}
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
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ChatPanel
