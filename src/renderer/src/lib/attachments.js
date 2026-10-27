// Chat attachment helpers: the server's upload limits, size formatting, and
// which files the in-app viewer can show as text.

// Mirrors server/backend/src/limits.rs. The server enforces these too, but it
// rejects an oversized upload mid-stream and drops the connection, so the
// client usually sees a reset instead of the error — check before sending.
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_MESSAGE_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_ATTACHMENTS_PER_MESSAGE = 10

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

// Split `files` into the ones that fit alongside the `pending` composer
// attachments ({ file } entries) and the ones that would break a server limit.
// Returns { accepted: File[], rejected: [{ file, reason }] }.
export function fitAttachments(pending, files) {
  let count = pending.length
  let total = pending.reduce((sum, a) => sum + a.file.size, 0)
  const accepted = []
  const rejected = []
  for (const file of files) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      rejected.push({
        file,
        reason: `${file.name} is ${formatBytes(file.size)}; files can be at most ${formatBytes(MAX_ATTACHMENT_BYTES)}.`
      })
    } else if (count >= MAX_ATTACHMENTS_PER_MESSAGE) {
      rejected.push({
        file,
        reason: `A message can carry at most ${MAX_ATTACHMENTS_PER_MESSAGE} files.`
      })
    } else if (total + file.size > MAX_MESSAGE_UPLOAD_BYTES) {
      rejected.push({
        file,
        reason: `${file.name} would take this message past the ${formatBytes(MAX_MESSAGE_UPLOAD_BYTES)} upload limit.`
      })
    } else {
      accepted.push(file)
      count++
      total += file.size
    }
  }
  return { accepted, rejected }
}

const MARKDOWN_EXTENSIONS = new Set(['md', 'markdown', 'mdown', 'mkd'])

// Plain-text formats worth previewing. Uploaders often send these as
// application/octet-stream (the OS has no MIME mapping for them), so the
// extension is the more reliable signal.
const TEXT_EXTENSIONS = new Set(
  (
    'txt log csv tsv ini cfg conf toml yaml yml json xml html htm css scss js mjs cjs jsx ' +
    'ts tsx py rs go java kt c h cpp hpp cc cs rb php lua sh bash zsh ps1 bat sql nix ' +
    'diff patch srt vtt env gitignore'
  ).split(' ')
)

const TEXT_CONTENT_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-sh',
  'application/x-yaml',
  'application/toml'
])

export function fileExtension(name) {
  const dot = name?.lastIndexOf('.') ?? -1
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''
}

// 'markdown' | 'text' when the file viewer can show it, else null.
export function previewKind(name, contentType) {
  const ext = fileExtension(name)
  const type = (contentType || '').split(';')[0].trim().toLowerCase()
  if (MARKDOWN_EXTENSIONS.has(ext) || type === 'text/markdown') return 'markdown'
  if (TEXT_EXTENSIONS.has(ext) || type.startsWith('text/') || TEXT_CONTENT_TYPES.has(type)) {
    return 'text'
  }
  return null
}
