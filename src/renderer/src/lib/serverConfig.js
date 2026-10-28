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

// Signaling protocol version spoken on the voice socket. The voice node closes
// any other (or a missing) `v` with 4000.
export const VOICE_PROTOCOL_VERSION = 1

// Full URL for the voice signaling socket, or null when voice is unavailable.
//
// /voice lives only on the voice node, never on the API host. Every voice
// ticket arrives with the origin it is good for (op 6 `voice_endpoint`), so pass
// the one that came with the ticket about to be presented rather than
// remembering an earlier one. A server without VOICE_PUBLIC_ENDPOINT sends no
// endpoint at all, which means it has no reachable voice plane.
//
// Dev builds can force an origin with PYLON_VOICE_ENDPOINT (see
// src/preload/index.js), e.g. to reach a local node the backend doesn't
// advertise. It wins over the server's value; packaged builds never have it.
export function voiceSocketUrl(voiceEndpoint) {
  const origin = voiceOrigin(devVoiceEndpointOverride()) ?? voiceOrigin(voiceEndpoint)
  return origin ? `${origin}/voice?v=${VOICE_PROTOCOL_VERSION}` : null
}

function devVoiceEndpointOverride() {
  return globalThis.window?.api?.voiceEndpointOverride ?? null
}

// An origin is scheme, host, and optional port — nothing else, because we
// append the path ourselves. Anything else is a server asking us to dial
// somewhere we cannot build a URL for, so treat it as missing and say so: a bad
// endpoint otherwise surfaces only as voice that never connects.
function voiceOrigin(voiceEndpoint) {
  if (typeof voiceEndpoint !== 'string') return null
  const origin = voiceEndpoint.trim().replace(/\/+$/, '')
  if (origin === '') return null
  if (!/^wss?:\/\/[^/?#]+$/.test(origin)) {
    console.warn('[ServerConfig] Ignoring an unusable voice_endpoint:', voiceEndpoint)
    return null
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

// Resolve a server-relative media URL (/files/<key>, /shared/<token>) against
// the active host. The server sends every stored object as a root-relative
// path that we anchor to the current host at use time; the main process
// attaches the session to requests for that host. data:/blob:/absolute URLs
// (self-set avatars, pending uploads, external embeds) pass through untouched.
export function assetUrl(path) {
  if (!path || !path.startsWith('/')) return path
  // Do not turn stale server data into a request to `https://null/...` while a
  // connection attempt is being torn down or switched to another host.
  if (!currentHost) return null
  return `${apiBase()}${path}`
}
