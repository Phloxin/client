// ─── Rotating token store ─────────────────────────────────────────
// Single source of truth for the access/refresh token pair. Access tokens
// live ~15 minutes; a proactive timer refreshes ~90s before expiry, and
// authFetch retries once on a token_expired 401. Refresh tokens are
// single-use and rotate on every refresh, so all refreshes are serialized
// through one in-flight promise — sending the same refresh token twice
// revokes the whole device session. The server sends expiries as Unix
// milliseconds on its own clock; they are stored as local-clock deadlines
// (see setAuthTokens). Refresh tokens are credentials: never log them.
//
// This lives outside React on purpose: rotation must not re-render (or worse,
// tear down the events websocket, whose effect keys on the login token).
import { apiBase } from './serverConfig.js'
import { httpFetch } from './http.js'

const REFRESH_EARLY_MS = 90_000 // refresh this long before access expiry
const REFRESH_RETRY_MS = 30_000 // retry delay after a network-level refresh failure
const REFRESH_REQUEST_TIMEOUT_MS = 15_000
// A pair we just received cannot need replacing again within seconds. This
// bounds the cadence if the local deadline is wrong (old server + bad clock)
// or legitimately short (last 90 s before the session's absolute expiry).
const MIN_REFRESH_INTERVAL_MS = 30_000

// *_expires_at are local-clock milliseconds since the Unix epoch; received_at
// is the local Date.now() when the pair arrived.
let tokens = null // { access_token, access_expires_at, refresh_token, refresh_expires_at, received_at }
let tokenGeneration = 0
let refreshPromise = null
let refreshTimer = null
let sessionExpired = () => {}

// Called when the server rejects our refresh token (session revoked/expired):
// the app must drop to the disconnected state and require a fresh login.
export function setOnSessionExpired(cb) {
  sessionExpired = cb || (() => {})
}

function getAccessToken() {
  return tokens?.access_token ?? null
}

// Atomically replace the whole pair (login, register, or refresh response).
// Server timestamps are converted to local deadlines once, at receipt, so a
// skewed wall clock (dual boot, no NTP) can't make a fresh token look expired.
// Older servers don't send server_time; then the deadlines are taken as-is and
// the cadence floor (MIN_REFRESH_INTERVAL_MS) is the only protection.
export function setAuthTokens(data) {
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

export function clearAuthTokens() {
  tokenGeneration++
  tokens = null
  clearTimeout(refreshTimer)
  refreshTimer = null
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
// single-use refresh token is never sent twice.
function refresh() {
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
    res = await httpFetch(`${apiBase()}/auth/refresh`, {
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
    clearAuthTokens()
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
  setAuthTokens(data)
  return data
}

// The current access token, refreshing first if it's at/near expiry (e.g. the
// machine slept through the proactive timer) and the pair is older than
// MIN_REFRESH_INTERVAL_MS, or always with `force` (the server refused the one
// we have: the event socket's 4002 AuthFailed). The age guard keeps a wrong
// local deadline from rotating the pair on every call, which would invalidate
// the access token held by every other in-flight request. Use for non-fetch
// carriers of the token: the events-WS identify.
export async function getFreshToken({ force = false } = {}) {
  if (!tokens) throw new Error('Not authenticated')
  if (force || (msUntilRefresh() === 0 && msSinceReceived() >= MIN_REFRESH_INTERVAL_MS)) {
    await refresh()
  }
  const token = getAccessToken()
  if (!token) throw new Error('Not authenticated')
  return token
}

// fetch() with a live Bearer token. On a 401 { code: "token_expired" },
// refreshes once (serialized) and retries the request exactly once.
export async function authFetch(url, options = {}) {
  const doFetch = (t) =>
    httpFetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${t}` } })
  const token = await getFreshToken()
  const res = await doFetch(token)
  if (res.status !== 401) return res
  const body = await res
    .clone()
    .json()
    .catch(() => null)
  if (body?.code !== 'token_expired') return res
  // A concurrent caller may have already rotated the pair; only refresh if
  // we're still holding the token that just expired.
  if (getAccessToken() === token) await refresh()
  return doFetch(await getFreshToken())
}
