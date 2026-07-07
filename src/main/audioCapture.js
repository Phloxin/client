// Main-process manager for native screenshare-audio capture. Owns the
// utilityProcess running the audio-capture addon (see audioCaptureHost.js)
// and bridges it to the renderer:
//   control plane: audiocapture:* IPC (invoke/handle + error events)
//   data plane:    a MessageChannelMain pair - port1 to the host, port2 to
//                  the renderer - carrying 10ms PCM frames as transferables.
import { utilityProcess, MessageChannelMain, ipcMain } from 'electron'
import { join } from 'path'

let host = null
let capabilitiesPromise = null
// webContents of the renderer that started the active capture, for error events
let activeSender = null
// Single-flight resolvers for host replies, keyed by reply type
const pending = new Map()

function rejectPending(reason) {
  for (const [, { reject }] of pending) reject(new Error(reason))
  pending.clear()
}

function notifyCaptureError(message) {
  if (activeSender && !activeSender.isDestroyed()) {
    activeSender.send('audiocapture:error', { message })
  }
  activeSender = null
}

function hostRequest(type, replyType, payload = {}, ports = []) {
  return new Promise((resolve, reject) => {
    pending.set(replyType, { resolve, reject })
    host.postMessage({ type, ...payload }, ports)
  })
}

function ensureHost() {
  if (host) return capabilitiesPromise

  host = utilityProcess.fork(join(__dirname, 'audioCaptureHost.js'), [], {
    serviceName: 'audio-capture'
  })

  host.on('message', (msg) => {
    switch (msg?.type) {
      case 'capabilities':
        pending.get('capabilities')?.resolve(msg.capabilities)
        pending.delete('capabilities')
        break
      case 'apps':
        pending.get('apps')?.resolve(msg.apps)
        pending.delete('apps')
        break
      case 'started':
        pending.get('started')?.resolve(msg.backend)
        pending.delete('started')
        break
      case 'error':
        // A pending start gets the error as its rejection; errors outside a
        // start (capture died mid-share) go to the renderer as an event.
        if (pending.has('started')) {
          pending.get('started').reject(new Error(msg.message))
          pending.delete('started')
        } else {
          notifyCaptureError(msg.message)
        }
        break
    }
  })

  host.on('exit', (code) => {
    host = null
    capabilitiesPromise = null
    rejectPending(`audio-capture host exited (code ${code})`)
    notifyCaptureError(`audio capture process exited unexpectedly (code ${code})`)
  })

  capabilitiesPromise = hostRequest('init', 'capabilities').catch((err) => {
    console.error('[audioCapture] host init failed:', err.message)
    return { backend: 'none', perApp: false, excludeSelf: false, system: false }
  })
  return capabilitiesPromise
}

// Renderer needs the session type to branch its picker UX: on Wayland the OS
// portal does the video picking, so the source grid is meaningless there.
const isWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'

export function setupAudioCapture() {
  ipcMain.handle('audiocapture:get-capabilities', async () => {
    try {
      const caps = await ensureHost()
      return { ...caps, wayland: isWayland, platform: process.platform }
    } catch {
      return {
        backend: 'none',
        perApp: false,
        excludeSelf: false,
        system: false,
        wayland: isWayland,
        platform: process.platform
      }
    }
  })

  ipcMain.handle('audiocapture:list-apps', async () => {
    await ensureHost()
    if (!host) return []
    return hostRequest('list-apps', 'apps')
  })

  // Start capture: hands the host one end of a fresh MessageChannel and the
  // renderer the other, then tells the host to begin. Resolves with the
  // backend name once frames are flowing.
  ipcMain.handle('audiocapture:start', async (event, options) => {
    await ensureHost()
    if (!host) throw new Error('audio capture unavailable')

    const { port1, port2 } = new MessageChannelMain()
    activeSender = event.sender
    // Renderer must receive the PCM port before frames start so none are
    // dropped by an unattached port.
    event.sender.postMessage('audiocapture:port', null, [port2])
    try {
      const backend = await hostRequest('start', 'started', { options }, [port1])
      return { backend }
    } catch (err) {
      activeSender = null
      throw err
    }
  })

  ipcMain.handle('audiocapture:stop', () => {
    activeSender = null
    if (host) host.postMessage({ type: 'stop' })
  })
}

export function stopAudioCaptureHost() {
  if (host) {
    host.postMessage({ type: 'stop' })
    host.kill()
    host = null
    capabilitiesPromise = null
  }
}
