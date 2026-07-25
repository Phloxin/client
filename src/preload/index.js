import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// MessagePorts can't cross the contextBridge, so the PCM port from main is
// relayed into the page world via window.postMessage (the page listens for
// 'audiocapture:port' messages - see renderer/src/lib/screenAudio.js).
ipcRenderer.on('audiocapture:port', (e) => {
  window.postMessage({ type: 'audiocapture:port' }, '*', e.ports)
})

// Screen-share codec override from the environment (PREFER_SCREENSHARE_CODEC=
// H264|AV1|VP9). Normalized here so the renderer reads a clean value or null;
// invalid values are ignored (main logs a warning to the terminal). This pins
// the codec the share is produced with and disables the adaptive downgrade —
// see pickVideoCodec/maybeDowngradeScreenCodec in renderer/src/lib/soup.js.
function preferredScreenshareCodec() {
  const raw = process.env.PREFER_SCREENSHARE_CODEC?.trim().toUpperCase()
  return raw === 'H264' || raw === 'AV1' || raw === 'VP9' ? raw : null
}

// Dev-only escape hatch: launch with PYLON_INSECURE=1 to reach a server over
// plain http/ws instead of https/wss (a self-hosted test box without TLS). The
// import.meta.env.DEV guard is a compile-time constant, so this whole path is
// stripped from packaged builds — production can never be coerced into an
// insecure connection. Consumed by apiBase/wsBase in
// renderer/src/lib/serverConfig.js.
const insecureConnections = import.meta.env.DEV && process.env.PYLON_INSECURE === '1'

// Custom APIs for renderer
const api = {
  platform: process.platform,
  preferScreenshareCodec: preferredScreenshareCodec(),
  insecureConnections,
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
  }
} else {
  window.electron = electronAPI
  window.api = api
}
