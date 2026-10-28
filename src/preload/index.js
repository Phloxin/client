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
