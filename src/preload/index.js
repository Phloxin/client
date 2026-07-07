import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// MessagePorts can't cross the contextBridge, so the PCM port from main is
// relayed into the page world via window.postMessage (the page listens for
// 'audiocapture:port' messages - see renderer/src/lib/screenAudio.js).
ipcRenderer.on('audiocapture:port', (e) => {
  window.postMessage({ type: 'audiocapture:port' }, '*', e.ports)
})

// Custom APIs for renderer
const api = {
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
