// ─── Active server connection target ─────────────────────────────
// Holds the host (`ip:port`) of the server the client is currently connected
// to (or attempting to connect to). All API/WebSocket/TURN endpoints are built
// from this at call time so the app can target any saved server, rather than a
// single hardcoded host.

let currentHost = null

export function setServerHost(host) {
  currentHost = host
}

// The host (`ip:port`) of the server we're currently connected to, or null when
// disconnected. Used to scope per-server client state (e.g. saved per-user
// volumes) since user ids are only unique within a single server.
export function getServerHost() {
  return currentHost
}

// Dev builds launched with PYLON_INSECURE=1 talk to the server over plain
// http/ws so a TLS-less test box can be used (see src/preload/index.js). The
// flag is compiled out of packaged builds, so this is always false there and we
// use TLS unconditionally.
function insecure() {
  return Boolean(globalThis.window?.api?.insecureConnections)
}

// HTTP API base for a given host, e.g. https://1.2.3.4:3000. Used before a host
// becomes the active server (e.g. registration), where currentHost isn't set yet.
export function apiBaseForHost(host) {
  return `${insecure() ? 'http' : 'https'}://${host}`
}

// HTTP API base for the active server, e.g. https://1.2.3.4:3000
export function apiBase() {
  return apiBaseForHost(currentHost)
}

// WebSocket base, e.g. wss://1.2.3.4:3000 (append /ws or /voice)
export function wsBase() {
  return `${insecure() ? 'ws' : 'wss'}://${currentHost}`
}

// Full URL for the voice signaling socket.
//
// A server may serve /voice from a different host than the API — it can run the
// SFU as a separate process — in which case every voice ticket it hands out
// arrives with the origin that ticket is good for. The value travels with the
// ticket rather than with the server, so pass whichever one came with the
// ticket about to be presented rather than remembering an earlier one.
//
// Absent means /voice is on the API host: both the default deployment and what
// every server did before the field existed.
export function voiceSocketUrl(voiceEndpoint) {
  return `${voiceOrigin(voiceEndpoint)}/voice`
}

// An origin is scheme, host, and optional port — nothing else, because we
// append the path ourselves. Anything else is a server asking us to dial
// somewhere we cannot build a URL for, so fall back to the API host and say so:
// a bad endpoint otherwise surfaces only as voice that never connects.
function voiceOrigin(voiceEndpoint) {
  if (typeof voiceEndpoint !== 'string') return wsBase()
  const origin = voiceEndpoint.trim().replace(/\/+$/, '')
  if (origin === '') return wsBase()
  if (!/^wss?:\/\/[^/?#]+$/.test(origin)) {
    console.warn('[ServerConfig] Ignoring an unusable voice_endpoint:', voiceEndpoint)
    return wsBase()
  }
  return origin
}

// Throw on a failed API response, preferring the server's human-readable
// message. Handler errors come back as `{ "error": "..." }`; fall back to the
// status code when there's no JSON body. Returns the response when it's ok, so
// callers can `await throwIfError(res)` inline.
export async function throwIfError(res) {
  if (res.ok) return res
  const body = await res.json().catch(() => null)
  const err = new Error(body?.error || `Server responded ${res.status}`)
  // Keep the HTTP status so callers can tell a permission failure (403) apart
  // from other errors without matching on message text.
  err.status = res.status
  throw err
}

// Resolve a server-relative asset path (e.g. /cdn/foo.png) against the active
// host. The server no longer ties file paths to an IP, so it sends bare /cdn/…
// paths that we anchor to the current host at use time. data:/blob:/absolute
// URLs (self-set avatars, pending uploads) pass through untouched.
export function cdnUrl(path) {
  if (!path || !path.startsWith('/')) return path
  // Do not turn stale server data into a request to `https://null/...` while a
  // connection attempt is being torn down or switched to another host.
  if (!currentHost) return null
  return `${apiBase()}${path}`
}
