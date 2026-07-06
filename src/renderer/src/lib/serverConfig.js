// ─── Active server connection target ─────────────────────────────
// Holds the host (`ip:port`) of the server the client is currently connected
// to (or attempting to connect to). All API/WebSocket/TURN endpoints are built
// from this at call time so the app can target any saved server, rather than a
// single hardcoded host.

let currentHost = null

export function setServerHost(host) {
  currentHost = host
}

// HTTP API base, e.g. https://1.2.3.4:3000
export function apiBase() {
  return `https://${currentHost}`
}

// WebSocket base, e.g. wss://1.2.3.4:3000 (append /ws or /voice)
export function wsBase() {
  return `wss://${currentHost}`
}

// Throw on a failed API response, preferring the server's human-readable
// message. Handler errors come back as `{ "error": "..." }`; fall back to the
// status code when there's no JSON body. Returns the response when it's ok, so
// callers can `await throwIfError(res)` inline.
export async function throwIfError(res) {
  if (res.ok) return res
  const body = await res.json().catch(() => null)
  throw new Error(body?.error || `Server responded ${res.status}`)
}

// Resolve a server-relative asset path (e.g. /cdn/foo.png) against the active
// host. The server no longer ties file paths to an IP, so it sends bare /cdn/…
// paths that we anchor to the current host at use time. data:/blob:/absolute
// URLs (self-set avatars, pending uploads) pass through untouched.
export function cdnUrl(path) {
  if (!path || !path.startsWith('/')) return path
  return `${apiBase()}${path}`
}

// ICE servers for mediasoup transports. STUN is fixed; the TURN relay is
// derived from the active server's IP (port 3478) so voice media relays through
// whichever server we're connected to.
export function getIceServers() {
  const ip = currentHost ? currentHost.split(':')[0] : ''
  return [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: `turn:${ip}:3478`,
      username: 'test',
      credential: 'password'
    }
  ]
}
