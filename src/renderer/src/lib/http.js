// Development aid for diagnosing server connectivity and API failures.
// Keep this logger safe to leave enabled: credentials and auth material are
// redacted before anything reaches the console.

const SENSITIVE_KEY =
  /(authorization|cookie|password|passphrase|refresh[_-]?token|access[_-]?token|id[_-]?token|secret|api[_-]?key)/i
const MAX_BODY_LOG_LENGTH = 4000

function redact(value) {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(item)
      ])
    )
  }
  return value
}

function safeBody(body) {
  if (!body) return undefined
  if (typeof body !== 'string') return '[non-text body]'
  try {
    return redact(JSON.parse(body))
  } catch {
    return body.length > MAX_BODY_LOG_LENGTH ? `${body.slice(0, MAX_BODY_LOG_LENGTH)}…` : body
  }
}

function safeHeaders(headers) {
  return Object.fromEntries(
    Object.entries(Object.fromEntries(new Headers(headers))).map(([key, value]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[REDACTED]' : value
    ])
  )
}

async function logResponse(response, method, url, startedAt) {
  const contentType = response.headers.get('content-type') || ''
  let body
  if (contentType.includes('json') || contentType.startsWith('text/')) {
    const text = await response
      .clone()
      .text()
      .catch(() => '')
    if (text) {
      try {
        body = redact(JSON.parse(text))
      } catch {
        body = text.length > MAX_BODY_LOG_LENGTH ? `${text.slice(0, MAX_BODY_LOG_LENGTH)}…` : text
      }
    }
  }
  console.debug('[HTTP] response', {
    method,
    url,
    status: response.status,
    ok: response.ok,
    duration_ms: Date.now() - startedAt,
    ...(body === undefined ? {} : { body })
  })
}

// Drop-in fetch wrapper. Response logging is done from a clone so callers can
// still consume the original response body normally.
export async function httpFetch(input, options = {}) {
  const url = typeof input === 'string' ? input : input.url
  const method = options.method || (typeof input === 'object' ? input.method : 'GET') || 'GET'
  const startedAt = Date.now()

  console.debug('[HTTP] request', {
    method: method.toUpperCase(),
    url,
    headers: safeHeaders(
      options.headers || (typeof input === 'object' ? input.headers : undefined)
    ),
    ...(options.body === undefined ? {} : { body: safeBody(options.body) })
  })

  try {
    const response = await fetch(input, options)
    // Keep logging independent of response consumption and avoid delaying the
    // request caller while the diagnostic clone is read.
    logResponse(response, method.toUpperCase(), url, startedAt).catch((error) =>
      console.debug('[HTTP] response logging failed', error)
    )
    return response
  } catch (error) {
    console.debug('[HTTP] network error', {
      method: method.toUpperCase(),
      url,
      duration_ms: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
