// ─── Rotating token store ─────────────────────────────────────────
// Single source of truth for the access/refresh token pair. Access tokens
// live ~15 minutes; a proactive timer refreshes ~90s before expiry, and
// authFetch retries once on a token_expired 401. Refresh tokens are
// single-use and rotate on every refresh, so all refreshes are serialized
// through one in-flight promise — sending the same refresh token twice
// revokes the whole device session. Expiries are Unix seconds from the
// server. Refresh tokens are credentials: never log them.
//
// This lives outside React on purpose: rotation must not re-render (or worse,
// tear down the events websocket, whose effect keys on the login token).
import { apiBase } from './serverConfig'

const REFRESH_EARLY_MS = 90_000 // refresh this long before access expiry
const REFRESH_RETRY_MS = 30_000 // retry delay after a network-level refresh failure

let tokens = null // { access_token, access_expires_at, refresh_token, refresh_expires_at }
let refreshPromise = null
let refreshTimer = null
let sessionExpired = () => {}

// Called when the server rejects our refresh token (session revoked/expired):
// the app must drop to the disconnected state and require a fresh login.
export function setOnSessionExpired(cb) {
  sessionExpired = cb || (() => {})
}

export function getAccessToken() {
  return tokens?.access_token ?? null
}

// Atomically replace the whole pair (login, register, or refresh response).
export function setAuthTokens(data) {
  tokens = {
    access_token: data.access_token,
    access_expires_at: data.access_expires_at,
    refresh_token: data.refresh_token,
    refresh_expires_at: data.refresh_expires_at
  }
  scheduleProactiveRefresh()
}

export function clearAuthTokens() {
  tokens = null
  clearTimeout(refreshTimer)
  refreshTimer = null
}

function msUntilRefresh() {
  return Math.max(0, tokens.access_expires_at * 1000 - Date.now() - REFRESH_EARLY_MS)
}

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
    delay ?? msUntilRefresh()
  )
}

// Serialized rotation: concurrent callers share the in-flight refresh so the
// single-use refresh token is never sent twice.
export function refresh() {
  if (refreshPromise) return refreshPromise
  refreshPromise = doRefresh().finally(() => {
    refreshPromise = null
  })
  return refreshPromise
}

async function doRefresh() {
  if (!tokens) throw new Error('Not authenticated')
  let res
  try {
    res = await fetch(`${apiBase()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: tokens.refresh_token })
    })
  } catch {
    throw Object.assign(new Error('Could not reach server to refresh session'), {
      transient: true
    })
  }
  const data = await res.json().catch(() => ({}))
  if (!res.ok || !data.access_token) {
    // The server rejected the refresh token — the device session is gone
    // (expired, revoked, or the token was already used). Fresh login required.
    clearAuthTokens()
    sessionExpired()
    throw new Error(data.error || `Refresh failed (${res.status})`)
  }
  setAuthTokens(data)
  return data
}

// The current access token, refreshing first if it's at/near expiry (e.g. the
// machine slept through the proactive timer). Use for non-fetch carriers of
// the token: the events-WS identify, IPC-proxied requests.
export async function getFreshToken() {
  if (!tokens) throw new Error('Not authenticated')
  if (msUntilRefresh() === 0) await refresh()
  return tokens.access_token
}

// fetch() with a live Bearer token. On a 401 { code: "token_expired" },
// refreshes once (serialized) and retries the request exactly once.
export async function authFetch(url, options = {}) {
  const doFetch = (t) =>
    fetch(url, { ...options, headers: { ...options.headers, Authorization: `Bearer ${t}` } })
  const token = await getFreshToken()
  const res = await doFetch(token)
  if (res.status !== 401) return res
  const body = await res.clone().json().catch(() => null)
  if (body?.code !== 'token_expired') return res
  // A concurrent caller may have already rotated the pair; only refresh if
  // we're still holding the token that just expired.
  if (getAccessToken() === token) await refresh()
  return doFetch(getAccessToken())
}
