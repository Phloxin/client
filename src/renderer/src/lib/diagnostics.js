// Packaged-build renderer diagnostics. Existing warning/error calls are kept in
// the DevTools console and forwarded to main for redacted, rotated file logging.
// console.log/debug are intentionally untouched so recurring media health and
// stats messages remain development-only.

const REDACTED_KEYS = /token|password|secret|authorization|cookie/i
const MAX_MESSAGE_LENGTH = 32 * 1024

function redactString(value) {
  return String(value)
    .slice(0, MAX_MESSAGE_LENGTH)
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;]+/gi, '$1[redacted]')
    .replace(/(bearer\s+)[a-z0-9._~+/=-]+/gi, '$1[redacted]')
    .replace(/([?&](?:access_?token|token|password|secret)=)[^&#\s]+/gi, '$1[redacted]')
    .replace(/(["'](?:access_?token|token|password|secret)["']\s*:\s*["'])[^"']+/gi, '$1[redacted]')
    .replace(/:\/\/([^/:\s]+):([^@/\s]+)@/g, '://$1:[redacted]@')
}

function serialize(value, seen = new WeakSet()) {
  if (value instanceof Error) {
    if (seen.has(value)) return '[Circular Error]'
    seen.add(value)
    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack ? redactString(value.stack) : undefined,
      ...(value.cause ? { cause: serialize(value.cause, seen) } : {})
    }
  }
  if (typeof value === 'string') return redactString(value)
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => serialize(entry, seen))

  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    output[key] = REDACTED_KEYS.test(key) ? '[redacted]' : serialize(entry, seen)
  }
  return output
}

function format(values) {
  return values
    .map((value) => {
      if (typeof value === 'string') return redactString(value)
      try {
        return JSON.stringify(serialize(value))
      } catch {
        return redactString(String(value))
      }
    })
    .join(' ')
    .slice(0, MAX_MESSAGE_LENGTH)
}

function forward(level, values) {
  try {
    window.api?.diagnostics?.log(level, format(values))
  } catch {
    // Diagnostics must never become a new application failure.
  }
}

const originalWarn = console.warn.bind(console)
const originalError = console.error.bind(console)

console.warn = (...values) => {
  originalWarn(...values)
  forward('warn', values)
}

console.error = (...values) => {
  originalError(...values)
  forward('error', values)
}

window.addEventListener('error', (event) => {
  forward('error', [
    '[Renderer] Unhandled error',
    event.error || {
      message: event.message,
      filename: event.filename,
      line: event.lineno,
      column: event.colno
    }
  ])
})

window.addEventListener('unhandledrejection', (event) => {
  forward('error', ['[Renderer] Unhandled promise rejection', event.reason])
})
