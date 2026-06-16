// ─── Active server connection target ─────────────────────────────
// Holds the host (`ip:port`) of the server the client is currently connected
// to (or attempting to connect to). All API/WebSocket/TURN endpoints are built
// from this at call time so the app can target any saved server, rather than a
// single hardcoded host.

let currentHost = null

export function setServerHost(host) {
  currentHost = host
}

export function getServerHost() {
  return currentHost
}

// HTTP API base, e.g. http://1.2.3.4:3000
export function apiBase() {
  return `http://${currentHost}`
}

// WebSocket base, e.g. ws://1.2.3.4:3000 (append /ws or /voice)
export function wsBase() {
  return `ws://${currentHost}`
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
