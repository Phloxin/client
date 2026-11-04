import { useState, useEffect, useMemo, useRef } from 'react'
import { motion } from 'motion/react'
import { IconX, IconDownload, IconFileText } from '@tabler/icons-react'
import SegmentedTabs from './SegmentedTabs'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop, scrimFade } from '../lib/motionPresets'
import { renderMarkdown, highlightCode } from '../lib/markdown'
import { fileExtension, formatBytes } from '../lib/attachments'
import './FileViewer.css'

// Only this much of a file is fetched for the preview — attachments run up to
// 25 MB, and a log that size would stall the renderer. Download shows the rest.
const PREVIEW_MAX_BYTES = 1024 * 1024
// Syntax highlighting is skipped past this many characters to keep big files
// responsive; they still show as plain text.
const HIGHLIGHT_MAX_CHARS = 200 * 1024

const MARKDOWN_TABS = [
  { id: 'rendered', label: 'Preview' },
  { id: 'source', label: 'Source' }
]

// Read at most `limit` bytes of the response as UTF-8 and cancel the rest of
// the download. A multi-byte character cut at the limit stays buffered in the
// streaming decoder rather than turning into a replacement glyph.
async function readTextPrefix(res, limit) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return { text: text + decoder.decode(), truncated: false }
    if (received + value.length > limit) {
      text += decoder.decode(value.subarray(0, limit - received), { stream: true })
      reader.cancel().catch(() => {})
      return { text, truncated: true }
    }
    received += value.length
    text += decoder.decode(value, { stream: true })
  }
}

// In-app viewer for text attachments (.txt, .md, source files). `kind` comes
// from previewKind(): markdown gets a rendered/source toggle, everything else
// shows as text, highlighted when its extension names a known language.
function FileViewer({ src, name, size, kind, onClose, onDownload }) {
  const [state, setState] = useState({ status: 'loading' })
  const [mode, setMode] = useState(kind === 'markdown' ? 'rendered' : 'source')
  const dialogRef = useRef(null)
  const overlayAnim = useAnimationCategory('overlays')

  useEffect(() => {
    const controller = new AbortController()
    fetch(src, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`)
        const { text, truncated } = await readTextPrefix(res, PREVIEW_MAX_BYTES)
        setState({ status: 'ready', text, truncated })
      })
      .catch((err) => {
        if (controller.signal.aborted) return
        console.error('[FileViewer] Failed to load preview:', err)
        setState({ status: 'error', message: err.message })
      })
    return () => controller.abort()
  }, [src])

  // Take focus on open so keys land here rather than in the composer.
  useEffect(() => {
    dialogRef.current?.focus()
  }, [])

  // Close on Escape. preventDefault tells Main's window-level Escape handler
  // the key is spent, so it doesn't also close the view underneath.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      onClose?.()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const text = state.status === 'ready' ? state.text : null
  const content = useMemo(() => {
    if (text == null) return null
    if (mode === 'rendered') {
      return <div className="chat-message-text file-viewer-markdown">{renderMarkdown(text)}</div>
    }
    const lang = kind === 'markdown' ? 'markdown' : fileExtension(name)
    const highlighted = text.length <= HIGHLIGHT_MAX_CHARS ? highlightCode(text, lang) : null
    return (
      <pre className="file-viewer-pre">
        {highlighted != null ? (
          // Safe: hljs.highlight HTML-escapes the code; only its own <span>
          // wrappers are added.
          <code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} />
        ) : (
          <code>{text}</code>
        )}
      </pre>
    )
  }, [text, mode, kind, name])

  return (
    <motion.div className="file-viewer-overlay" onClick={onClose} {...scrimFade(overlayAnim)}>
      <motion.div
        ref={dialogRef}
        className="file-viewer"
        role="dialog"
        aria-modal="true"
        aria-label={name}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        {...overlayPop(overlayAnim)}
      >
        <div className="file-viewer-header">
          <IconFileText size={18} className="file-viewer-icon" />
          <span className="file-viewer-name" title={name}>
            {name}
          </span>
          {size != null && <span className="file-viewer-size">{formatBytes(size)}</span>}
          <span className="file-viewer-spacer" />
          {kind === 'markdown' && (
            <SegmentedTabs
              tabs={MARKDOWN_TABS}
              active={mode}
              onChange={setMode}
              ariaLabel="Markdown view"
            />
          )}
          <button type="button" className="file-viewer-btn" title="Download" onClick={onDownload}>
            <IconDownload size={18} />
          </button>
          <button type="button" className="file-viewer-btn" title="Close" onClick={onClose}>
            <IconX size={18} />
          </button>
        </div>
        <div className="file-viewer-body">
          {state.status === 'loading' ? (
            <div className="file-viewer-status">Loading…</div>
          ) : state.status === 'error' ? (
            <div className="file-viewer-status">Couldn&apos;t load this file: {state.message}</div>
          ) : state.text === '' ? (
            <div className="file-viewer-status">This file is empty.</div>
          ) : (
            content
          )}
        </div>
        {state.truncated && (
          <div className="file-viewer-note">
            Showing the first {formatBytes(PREVIEW_MAX_BYTES)}. Download the file to see all of it.
          </div>
        )}
      </motion.div>
    </motion.div>
  )
}

export default FileViewer
