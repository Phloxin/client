// ─── Session facade ───────────────────────────────────────────────
// The rotating access/refresh pair lives in the main process (src/main/
// session.js), which refreshes it on a timer and attaches the credential to
// every request for the active API origin at the transport layer. This module
// is the renderer's only handle on it, through the preload bridge
// (window.api.session): it hands over the login/register response, asks for a
// refresh, and fetches the access token for the one carrier the transport
// can't cover, the events-WS identify. Nothing here keeps a token.
//
// This lives outside React on purpose: rotation must not re-render (or worse,
// tear down the events websocket, whose effect keys on the login).
import { apiBase } from './serverConfig.js'
import { httpFetch } from './http.js'

const session = () => window.api.session

let unsubscribeExpired = null

// Called when the server rejects our refresh token (session revoked/expired):
// the app must drop to the disconnected state and require a fresh login. One
// callback at a time; passing null removes it.
export function setOnSessionExpired(cb) {
  unsubscribeExpired?.()
  unsubscribeExpired = cb ? session().onExpired(cb) : null
}

// Start the session for the active server from a login or register response.
// Resolves once main holds the pair, so requests made after it carry it.
export function setAuthTokens(data) {
  return session().set({ apiOrigin: apiBase(), auth: data })
}

export function clearAuthTokens() {
  return session().clear()
}

// The current access token, refreshed first when main decides it must be (or
// always with `force`: the server refused the one we have, the event socket's
// 4002 AuthFailed). Rejects with 'Not authenticated' without a session. Use only
// for the events-WS identify, and don't keep the result.
export function getFreshToken(opts) {
  return session().getToken(opts)
}

// fetch() with the session's retry policy. The credential itself is attached
// by the main process; on a 401 { code: "token_expired" } (the request raced a
// rotation) this refreshes once (serialized in main) and retries exactly once.
export async function authFetch(url, options = {}) {
  const res = await httpFetch(url, options)
  if (res.status !== 401) return res
  const body = await res
    .clone()
    .json()
    .catch(() => null)
  if (body?.code !== 'token_expired') return res
  await session().refresh()
  return httpFetch(url, options)
}
