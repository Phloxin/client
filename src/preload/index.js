import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// MessagePorts can't cross the contextBridge, so the PCM port from main is
// relayed into the page world via window.postMessage (the page listens for
// 'audiocapture:port' messages - see renderer/src/lib/screenAudio.js).
ipcRenderer.on('audiocapture:port', (e) => {
  window.postMessage({ type: 'audiocapture:port' }, '*', e.ports)
})

// Screen-share codec override from the environment (PREFER_SCREENSHARE_CODEC=
// H264|AV1|VP9|VP8). Normalized here so the renderer reads a clean value or null;
// invalid values are ignored (main logs a warning to the terminal). This pins
// the codec the share is produced with and disables the adaptive downgrade —
// see pickVideoCodec/maybeDowngradeScreenCodec in renderer/src/lib/soup.js.
function preferredScreenshareCodec() {
  const raw = process.env.PREFER_SCREENSHARE_CODEC?.trim().toUpperCase()
  return raw === 'H264' || raw === 'AV1' || raw === 'VP9' || raw === 'VP8' ? raw : null
}

// Dev-only escape hatch: launch with PYLON_INSECURE=1 to reach a server over
// plain http/ws instead of https/wss (a self-hosted test box without TLS). The
// import.meta.env.DEV guard is a compile-time constant, so this whole path is
// stripped from packaged builds — production can never be coerced into an
// insecure connection. Consumed by apiBase/wsBase in
// renderer/src/lib/serverConfig.js.
const insecureConnections = import.meta.env.DEV && process.env.PYLON_INSECURE === '1'

// Dev-only: launch with PYLON_VOICE_ENDPOINT=ws://host:port to dial that voice
// node instead of the voice_endpoint the server sends with each ticket (for a
// local pylon-voice the backend doesn't advertise). Stripped from packaged
// builds like PYLON_INSECURE. Consumed by voiceSocketUrl in serverConfig.js.
const voiceEndpointOverride = import.meta.env.DEV
  ? process.env.PYLON_VOICE_ENDPOINT?.trim() || null
  : null

// Custom APIs for renderer
const api = {
  platform: process.platform,
  preferScreenshareCodec: preferredScreenshareCodec(),
  insecureConnections,
  voiceEndpointOverride,
  // Installs window.pylonTest (renderer lib/testHooks.js) for the e2e harness.
  isTestHarness: process.env.PYLON_TEST === '1',
  // The native media engine's sidecar (main/mediaEngine.js). Whether a screen share goes
  // through it (PYLON_NATIVE_SHARE, else the "Native screen share" setting) is main's call,
  // told in available()'s reply. onEvent hears
  // ice_state, connected, stats, error, capture_changed, preview, closed and exit, as
  // { type, ...fields }.
  mediaEngine: {
    // { available, codecs, source, pattern, settingShown, preview }: codecs from the last
    // sidecar's hello, null before the first; source the configured kind ('screen', 'file',
    // 'pattern' or null), pattern its { width, height, fps } for 'pattern'; settingShown
    // whether the setting's row belongs in Advanced settings; preview, in development,
    // PYLON_NATIVE_PREVIEW's { fps, max_width, max_height } or null.
    available: () => ipcRenderer.invoke('mediaengine:available'),
    // Starts a sidecar and asks it for the screen (on Wayland the portal, on
    // Windows the source main holds for this share), at most options.maxFps
    // frames a second. Resolves with capture_ready's fields and codecs, or
    // { cancelled: true } when the person said no in the portal.
    // cancelCapture(options.id) closes it while it is still pending.
    capture: (options) => ipcRenderer.invoke('mediaengine:capture', options),
    cancelCapture: (id) => ipcRenderer.invoke('mediaengine:cancel-capture', id),
    open: (params) => ipcRenderer.invoke('mediaengine:open', params),
    // These name the sidecar (open's or capture's pid). Main ignores them for any other.
    start: (pid) => ipcRenderer.invoke('mediaengine:start', pid),
    setKey: (pid, key) => ipcRenderer.invoke('mediaengine:set-key', pid, key),
    close: (pid) => ipcRenderer.invoke('mediaengine:close', pid),
    // Asks that sidecar for the sharer's preview: { fps, max_width, max_height } as in its
    // protocol (fps 0 stops). Resolves false when refused. The pictures come as `preview`
    // events: { width, height, jpeg (base64) }.
    preview: (pid, request) => ipcRenderer.invoke('mediaengine:preview', pid, request),
    onEvent: (cb) => {
      const handler = (_e, event) => cb(event)
      ipcRenderer.on('mediaengine:event', handler)
      return () => ipcRenderer.removeListener('mediaengine:event', handler)
    }
  },
  screenAudio: {
    getCapabilities: () => ipcRenderer.invoke('audiocapture:get-capabilities'),
    listApps: () => ipcRenderer.invoke('audiocapture:list-apps'),
    start: (options) => ipcRenderer.invoke('audiocapture:start', options),
    stop: () => ipcRenderer.invoke('audiocapture:stop'),
    onError: (cb) => {
      const handler = (_e, payload) => cb(payload)
      ipcRenderer.on('audiocapture:error', handler)
      return () => ipcRenderer.removeListener('audiocapture:error', handler)
    }
  },
  // The session lives in main (src/main/session.js); see renderer/src/lib/auth.js.
  session: {
    set: (payload) => ipcRenderer.invoke('session:set', payload),
    clear: () => ipcRenderer.invoke('session:clear'),
    getToken: (opts) => ipcRenderer.invoke('session:get-token', opts),
    refresh: () => ipcRenderer.invoke('session:refresh'),
    onExpired: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('session:expired', handler)
      return () => ipcRenderer.removeListener('session:expired', handler)
    },
    onUpdateRequired: (cb) => {
      const handler = () => cb()
      ipcRenderer.on('session:update-required', handler)
      return () => ipcRenderer.removeListener('session:update-required', handler)
    }
  },
  // pylon://join links the OS opened Pylon with. Both take the one pending link, so a link is
  // handled once: getPending() on mount, onJoin(cb) for links that arrive later.
  deepLink: {
    getPending: () => ipcRenderer.invoke('deep-link:take'),
    onJoin: (cb) => {
      const handler = () =>
        ipcRenderer.invoke('deep-link:take').then((url) => {
          if (url) cb(url)
        })
      ipcRenderer.on('deep-link:join', handler)
      return () => ipcRenderer.removeListener('deep-link:join', handler)
    }
  },
  diagnostics: {
    isAvailable: () => ipcRenderer.invoke('diagnostics:is-available'),
    exportLogs: () => ipcRenderer.invoke('diagnostics:export'),
    log: (level, message) => ipcRenderer.send('diagnostics:log', level, message)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
    ipcRenderer.send('diagnostics:log', 'error', `[preload] Context bridge setup failed: ${error}`)
  }
} else {
  window.electron = electronAPI
  window.api = api
}
