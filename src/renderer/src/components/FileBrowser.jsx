import { useEffect, useRef, useState } from 'react'
import { motion } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop } from '../lib/motionPresets'
import { formatBytes, previewKind } from '../lib/attachments'
import { assetUrl } from '../lib/serverConfig'
import './BanListMenu.css'
import './FileBrowser.css'
import {
  IconDownload,
  IconEye,
  IconFile,
  IconFileText,
  IconFiles,
  IconLink,
  IconLock,
  IconMovie,
  IconMusic,
  IconPhoto,
  IconSearch,
  IconTrash,
  IconWorld,
  IconX
} from '@tabler/icons-react'

// Page size for GET /channels/{id}/files; a full page means there may be more.
const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 250
// The server rejects a longer filename query with 400.
const MAX_QUERY_LENGTH = 256

// Type chips → the `type` query param (All sends none).
const TYPE_FILTERS = [
  { label: 'All', value: null },
  { label: 'Images', value: 'image' },
  { label: 'Videos', value: 'video' },
  { label: 'Audio', value: 'audio' },
  { label: 'Text', value: 'text' },
  { label: 'Other', value: 'other' }
]

const isImage = (file) => file.content_type?.startsWith('image/')

function FileTypeIcon({ file }) {
  const type = file.content_type || ''
  if (type.startsWith('image/')) return <IconPhoto size={20} />
  if (type.startsWith('video/')) return <IconMovie size={20} />
  if (type.startsWith('audio/')) return <IconMusic size={20} />
  if (previewKind(file.filename, type)) return <IconFileText size={20} />
  return <IconFile size={20} />
}

const formatDate = (ms) =>
  new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })

// 'Files' popup, opened from a channel's right-click menu: the channel's
// attachments (FileApiObject[]), newest first, with search, type filter, and
// paging. Uploaders and moderators can make a file public/private or delete it;
// the server stays authoritative. Nothing is edited locally: every change
// arrives as a MessageUpdated broadcast, which bumps `revision` and refetches
// the first page.
function FileBrowser({
  channel,
  clients = [],
  selfId,
  canModerate = false,
  revision = 0,
  onList,
  onSetPublic,
  onDelete,
  onCopyLink,
  onOpenImage,
  onPreviewFile,
  onDownload,
  onClose
}) {
  const overlayAnim = useAnimationCategory('overlays')
  // Raw search box text, and the debounced, trimmed query actually sent.
  const [query, setQuery] = useState('')
  const [q, setQ] = useState('')
  const [type, setType] = useState(null)
  // The listing and the request it answers. `key` identifies the first-page
  // request (filters + revision); while it lags the current key a fetch is in
  // flight and the previous rows stay up instead of flashing empty.
  const [listing, setListing] = useState({ key: null, rows: [], hasMore: false, error: null })
  const [loadingMore, setLoadingMore] = useState(false)
  // File ids with a request in flight, so their buttons can't be double-fired.
  const [pending, setPending] = useState(() => new Set())
  // File id showing the inline "Delete? Yes / No" confirmation, or null.
  const [confirmId, setConfirmId] = useState(null)

  // onList is a fresh closure on every parent render; read it through a ref so
  // the fetch effect only reruns when the filters or revision change.
  const onListRef = useRef(onList)
  useEffect(() => {
    onListRef.current = onList
  })

  useEffect(() => {
    const t = setTimeout(() => setQ(query.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [query])

  const key = `${type ?? ''}\u0000${q}\u0000${revision}`
  const loading = listing.key !== key

  // First page: on open, on a filter change, and on every revision bump (which
  // drops any extra pages loaded so far). A late answer to a superseded
  // request is ignored.
  const keyRef = useRef(key)
  useEffect(() => {
    keyRef.current = key
    onListRef
      .current({ q: q || undefined, type: type ?? undefined, limit: PAGE_SIZE })
      .then((rows) => {
        if (keyRef.current !== key) return
        setListing({ key, rows, hasMore: rows.length === PAGE_SIZE, error: null })
      })
      .catch((err) => {
        if (keyRef.current !== key) return
        setListing({
          key,
          rows: [],
          hasMore: false,
          error: `Couldn't load files: ${err?.message || 'unknown error'}`
        })
      })
  }, [key, q, type])

  const loadMore = async () => {
    const last = listing.rows[listing.rows.length - 1]
    if (!last || loadingMore) return
    const forKey = key
    setLoadingMore(true)
    try {
      const rows = await onListRef.current({
        before: last.id,
        q: q || undefined,
        type: type ?? undefined,
        limit: PAGE_SIZE
      })
      if (keyRef.current !== forKey) return
      setListing((prev) => ({
        ...prev,
        rows: [...prev.rows, ...rows],
        hasMore: rows.length === PAGE_SIZE,
        error: null
      }))
    } catch (err) {
      if (keyRef.current !== forKey) return
      setListing((prev) => ({
        ...prev,
        error: `Couldn't load more files: ${err?.message || 'unknown error'}`
      }))
    } finally {
      setLoadingMore(false)
    }
  }

  // Run a per-file request, holding the row's buttons until it settles. The
  // row itself changes (or goes) when the broadcast-driven refetch lands.
  const run = async (fileId, action) => {
    setPending((prev) => new Set(prev).add(fileId))
    try {
      await action()
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(fileId)
        return next
      })
    }
  }

  // Open a previewable file: images in the image viewer, text in the file
  // viewer. Only offered on rows where one of the two applies.
  const open = (file) => {
    const url = assetUrl(file.url)
    if (isImage(file)) onOpenImage?.({ url, name: file.filename })
    else {
      onPreviewFile?.({
        url,
        name: file.filename,
        size: file.size,
        contentType: file.content_type
      })
    }
  }

  const uploaderName = (id) => clients.find((c) => String(c.id) === String(id))?.name || String(id)

  const rows = listing.rows
  const filtered = !!q || type != null

  return (
    <div className="bl-overlay" onClick={onClose}>
      <motion.div
        className="bl-modal fb-modal"
        onClick={(e) => e.stopPropagation()}
        {...overlayPop(overlayAnim)}
      >
        <div className="bl-header">
          <span className="bl-title fb-title">
            <span className="fb-title-text">Files · {channel.name}</span>
            {rows.length > 0 && <span className="bl-count">{rows.length}</span>}
          </span>
          <button type="button" className="bl-close" onClick={onClose} title="Close">
            <IconX size={16} />
          </button>
        </div>
        <div className="bl-search">
          <IconSearch size={15} />
          <input
            value={query}
            maxLength={MAX_QUERY_LENGTH}
            placeholder="Search by filename"
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="fb-chips">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.label}
              type="button"
              className={`fb-chip${type === f.value ? ' active' : ''}`}
              onClick={() => setType(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="bl-body">
          {rows.length === 0 && !listing.error ? (
            <div className="bl-empty">
              {loading ? (
                'Loading files…'
              ) : filtered ? (
                'No matches'
              ) : (
                <>
                  <IconFiles size={22} />
                  No files
                </>
              )}
            </div>
          ) : (
            rows.map((file) => {
              const canManage = String(file.uploader) === String(selfId) || canModerate
              const busy = pending.has(file.id)
              const confirming = confirmId === file.id
              const previewable = isImage(file) || previewKind(file.filename, file.content_type)
              return (
                <div key={file.id} className="bl-row fb-row">
                  <span className="fb-thumb">
                    {isImage(file) ? (
                      <img src={assetUrl(file.url)} alt="" loading="lazy" />
                    ) : (
                      <FileTypeIcon file={file} />
                    )}
                  </span>
                  <div className="bl-info">
                    <span className="bl-name fb-name" title={file.filename}>
                      {file.filename}
                      {file.public_url && <span className="fb-badge">public</span>}
                    </span>
                    <span className="bl-meta">
                      {formatBytes(file.size)} · {uploaderName(file.uploader)} ·{' '}
                      {formatDate(file.created_at)}
                    </span>
                  </div>
                  {confirming ? (
                    <div className="fb-confirm">
                      Delete?
                      <button
                        type="button"
                        className="fb-confirm-btn danger"
                        disabled={busy}
                        onClick={() => {
                          setConfirmId(null)
                          run(file.id, () => onDelete?.(file.id))
                        }}
                      >
                        Yes
                      </button>
                      <button
                        type="button"
                        className="fb-confirm-btn"
                        onClick={() => setConfirmId(null)}
                      >
                        No
                      </button>
                    </div>
                  ) : (
                    <div className="fb-actions">
                      {previewable ? (
                        <button
                          type="button"
                          className="fb-action"
                          title="Open"
                          onClick={() => open(file)}
                        >
                          <IconEye size={16} />
                        </button>
                      ) : (
                        // Keeps Download and the rest aligned with rows that have Open.
                        <span className="fb-action-slot" aria-hidden="true" />
                      )}
                      <button
                        type="button"
                        className="fb-action"
                        title="Download"
                        onClick={() =>
                          onDownload?.({ url: assetUrl(file.url), name: file.filename })
                        }
                      >
                        <IconDownload size={16} />
                      </button>
                      {file.public_url && (
                        <button
                          type="button"
                          className="fb-action"
                          title="Copy Link"
                          onClick={() => onCopyLink?.(file.public_url)}
                        >
                          <IconLink size={16} />
                        </button>
                      )}
                      {canManage && (
                        <>
                          <button
                            type="button"
                            className="fb-action"
                            title={file.public_url ? 'Make Private' : 'Make Public'}
                            disabled={busy}
                            onClick={() =>
                              run(file.id, () => onSetPublic?.(file.id, !file.public_url))
                            }
                          >
                            {file.public_url ? <IconLock size={16} /> : <IconWorld size={16} />}
                          </button>
                          <button
                            type="button"
                            className="fb-action danger"
                            title="Delete"
                            disabled={busy}
                            onClick={() => setConfirmId(file.id)}
                          >
                            <IconTrash size={16} />
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              )
            })
          )}
          {listing.error && <div className="fb-error">{listing.error}</div>}
          {listing.hasMore && !loading && (
            <button
              type="button"
              className="bl-unban fb-more"
              onClick={loadMore}
              disabled={loadingMore}
            >
              {loadingMore ? 'Loading…' : 'Load more'}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  )
}

export default FileBrowser
