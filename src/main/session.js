// ─── Session: the rotating token pair, owned by the main process ──
// Single source of truth for the access/refresh token pair and the API origin
// it belongs to. The renderer never holds a token: it hands the login/register
// response over once (session:set) and main attaches the credential to every
// request for that origin at the transport layer (see the onBeforeSendHeaders
// hook in index.js), so <img>/<video> loads of private /files URLs work with
// plain src= URLs.
//
// Access tokens live ~15 minutes; a proactive timer refreshes ~90s before
// expiry, and the renderer's authFetch asks for a refresh once on a
// token_expired 401. Refresh tokens are single-use and rotate on every
// refresh, so all refreshes are serialized through one in-flight promise —
// sending the same refresh token twice revokes the whole device session. The
// server sends expiries as Unix milliseconds on its own clock; they are stored
// as local-clock deadlines (see storePair). Refresh tokens are credentials:
// never log them.
//
// Plain functions and Node's global fetch only (no Electron imports), so this
// stays unit-testable with node --test.

const REFRESH_EARLY_MS = 90_000 // refresh this long before access expiry
const REFRESH_RETRY_MS = 30_000 // retry delay after a network-level refresh failure
const REFRESH_REQUEST_TIMEOUT_MS = 15_000
// A pair we just received cannot need replacing again within seconds. This
// bounds the cadence if the local deadline is wrong (old server + bad clock)
// or legitimately short (last 90 s before the session's absolute expiry).
const MIN_REFRESH_INTERVAL_MS = 30_000

// Credential endpoints carry no session of their own; the header hook leaves
// them alone even on the session's origin.
const CREDENTIAL_PATHS = new Set(['/login', '/register', '/auth/refresh'])

// *_expires_at are local-clock milliseconds since the Unix epoch; received_at
// is the local Date.now() when the pair arrived.
let tokens = null // { access_token, access_expires_at, refresh_token, refresh_expires_at, received_at }
let origin = null // the API origin the pair is for, e.g. https://1.2.3.4:3000
let tokenGeneration = 0
let refreshPromise = null
let refreshTimer = null
const expiredListeners = new Set()

// Called when the server rejects our refresh token (session revoked/expired):
// the app must drop to the disconnected state and require a fresh login.
// Returns an unsubscribe.
export function onExpired(cb) {
  expiredListeners.add(cb)
  return () => expiredListeners.delete(cb)
}

function sessionExpired() {
  for (const cb of [...expiredListeners]) {
    try {
      cb()
    } catch (err) {
      console.error('[Session] Expiry listener failed:', err)
    }
  }
}

// Start (or replace) the session: `auth` is a login, register, or refresh
// response body, `apiOrigin` the API base the renderer is talking to.
export function setSession({ apiOrigin: base, auth } = {}) {
  const next = new URL(base).origin
  storePair(auth)
  origin = next
}

export function clearSession() {
  tokenGeneration++
  tokens = null
  origin = null
  clearTimeout(refreshTimer)
  refreshTimer = null
}

// The access token as of now, without refreshing; null when there's no
// session. For the header hook, which must never wait on a refresh.
export function currentAccessToken() {
  return tokens?.access_token ?? null
}

// The origin the session is for, or null when there's no session.
export function apiOrigin() {
  return origin
}

// The Authorization value to attach to a request for `url` that already
// carries `headers`, or null to leave it alone: only on the session's origin,
// never over a header the caller set itself, and never on the credential
// endpoints.
export function authorizationFor(url, headers = {}) {
  const token = currentAccessToken()
  if (!token || !origin) return null
  let target
  try {
    target = new URL(url)
  } catch {
    return null
  }
  if (target.origin !== origin) return null
  if (CREDENTIAL_PATHS.has(target.pathname)) return null
  if (Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) return null
  return `Bearer ${token}`
}

// Atomically replace the whole pair (login, register, or refresh response).
// Server timestamps are converted to local deadlines once, at receipt, so a
// skewed wall clock (dual boot, no NTP) can't make a fresh token look expired.
// Older servers don't send server_time; then the deadlines are taken as-is and
// the cadence floor (MIN_REFRESH_INTERVAL_MS) is the only protection.
function storePair(data) {
  tokenGeneration++
  const now = Date.now()
  const skew = Number.isFinite(data.server_time) ? now - data.server_time : 0
  tokens = {
    access_token: data.access_token,
    access_expires_at: data.access_expires_at + skew, // local clock
    refresh_token: data.refresh_token,
    refresh_expires_at: data.refresh_expires_at + skew, // local clock
    received_at: now
  }
  scheduleProactiveRefresh()
}

function msUntilRefresh() {
  return Math.max(0, tokens.access_expires_at - Date.now() - REFRESH_EARLY_MS)
}

function msSinceReceived() {
  return Date.now() - tokens.received_at
}

// `delay` is only passed by the transient-error retry; the default deadline
// is floored so a refresh can never schedule the next one for "now".
function scheduleProactiveRefresh(delay) {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(
    () => {
      refresh().catch((err) => {
        // Network blip: try again shortly. A server-side rejection has already
        // cleared the session (and fired sessionExpired) inside refresh().
        if (err.transient && tokens) scheduleProactiveRefresh(REFRESH_RETRY_MS)
      })
    },
    delay ?? Math.max(MIN_REFRESH_INTERVAL_MS, msUntilRefresh())
  )
}

// Serialized rotation: concurrent callers share the in-flight refresh so the
// single-use refresh token is never sent twice. Resolves to the new pair.
export function refresh() {
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefresh().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function doRefresh() {
  if (!tokens) throw new Error('Not authenticated')
  const generation = tokenGeneration
  const refreshToken = tokens.refresh_token
  let res
  try {
    res = await fetch(`${origin}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
      signal: AbortSignal.timeout(REFRESH_REQUEST_TIMEOUT_MS)
    })
  } catch {
    // Logout or a fresh login superseded this request while it was in flight.
    // Never let the stale request reschedule or overwrite the newer session.
    if (generation !== tokenGeneration) {
      if (tokens) return tokens
      throw new Error('Not authenticated')
    }
    throw Object.assign(new Error('Could not reach server to refresh session'), {
      transient: true
    })
  }
  const data = await res.json().catch(() => ({}))
  if (generation !== tokenGeneration) {
    if (tokens) return tokens
    throw new Error('Not authenticated')
  }
  if (res.status === 401 || res.status === 403) {
    // Only an explicit authentication rejection proves the device session is
    // gone (expired, revoked, reused, or banned). A proxy/server failure must
    // not turn a temporary outage into a local logout.
    clearSession()
    sessionExpired()
    throw new Error(data.error || `Refresh failed (${res.status})`)
  }
  if (
    !res.ok ||
    typeof data.access_token !== 'string' ||
    typeof data.refresh_token !== 'string' ||
    !Number.isFinite(data.access_expires_at) ||
    !Number.isFinite(data.refresh_expires_at)
  ) {
    throw Object.assign(new Error(data.error || `Refresh failed (${res.status})`), {
      transient: true
    })
  }
  storePair(data)
  return data
}

// The current access token, refreshing first if it's at/near expiry (e.g. the
// machine slept through the proactive timer) and the pair is older than
// MIN_REFRESH_INTERVAL_MS, or always with `force` (the server refused the one
// we have: the event socket's 4002 AuthFailed). The age guard keeps a wrong
// local deadline from rotating the pair on every call, which would invalidate
// the access token held by every other in-flight request. For non-HTTP
// carriers of the token: the events-WS identify.
export async function getFreshToken({ force = false } = {}) {
  if (!tokens) throw new Error('Not authenticated')
  if (force || (msUntilRefresh() === 0 && msSinceReceived() >= MIN_REFRESH_INTERVAL_MS)) {
    await refresh()
  }
  const token = currentAccessToken()
  if (!token) throw new Error('Not authenticated')
  return token
}
