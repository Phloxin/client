// utilityProcess entry for native screenshare-audio capture. Runs the
// audio-capture N-API addon (WASAPI process loopback / PipeWire) off the main
// process so capture threads and native crashes can't take down the app.
//
// Control protocol (process.parentPort):
//   in:  { type: 'init' }                     → replies with capabilities
//   in:  { type: 'start', options }, ports: [MessagePort for PCM frames]
//   in:  { type: 'stop' }
//   out: { type: 'capabilities', capabilities }
//   out: { type: 'apps', apps } (reply to 'list-apps')
//   out: { type: 'started', backend } | { type: 'error', message }
//
// PCM data plane: 10ms interleaved f32le stereo 48kHz frames posted as
// transferable ArrayBuffers on the MessagePort handed in with 'start'.
// externalizeDepsPlugin keeps this a runtime require of the N-API package.
import { createRequire } from 'node:module'

// The addon is built locally (postinstall / npm run build:native), so a
// checkout without a Rust toolchain has no .node binary. Load it lazily and
// degrade to backend 'none' with the load error as the reason, instead of
// crashing the host and leaving the renderer guessing.
let capture = null
let loadError = null
try {
  capture = createRequire(import.meta.url)('audio-capture')
} catch (err) {
  loadError = String(err?.message ?? err)
  console.error('[audioCaptureHost] failed to load audio-capture addon:', loadError)
}

function unavailableCapabilities() {
  return {
    backend: 'none',
    perApp: false,
    excludeSelf: false,
    system: false,
    reason: loadError ?? 'audio-capture addon unavailable'
  }
}

let session = null
let pcmPort = null

function stopSession() {
  if (session) {
    try {
      session.stop()
    } catch {
      // already stopped
    }
    session = null
  }
  if (pcmPort) {
    pcmPort.close()
    pcmPort = null
  }
}

process.parentPort.on('message', (e) => {
  const msg = e.data
  switch (msg?.type) {
    case 'init': {
      let capabilities
      try {
        capabilities = capture ? capture.capabilities() : unavailableCapabilities()
      } catch (err) {
        loadError = String(err?.message ?? err)
        capabilities = unavailableCapabilities()
      }
      process.parentPort.postMessage({ type: 'capabilities', capabilities })
      break
    }

    case 'list-apps':
      try {
        process.parentPort.postMessage({ type: 'apps', apps: capture ? capture.listApps() : [] })
      } catch (err) {
        process.parentPort.postMessage({
          type: 'apps',
          apps: [],
          error: String(err?.message ?? err)
        })
      }
      break

    case 'start': {
      stopSession()
      if (!capture) {
        process.parentPort.postMessage({
          type: 'error',
          message: `audio-capture addon failed to load: ${loadError}`
        })
        break
      }
      pcmPort = e.ports[0]
      try {
        session = capture.startCapture(
          msg.options,
          (err, frame) => {
            if (err || !pcmPort) return
            // Copy out of the N-API buffer (its backing store belongs to the
            // addon) and post as a plain ArrayBuffer. MessagePortMain transfer
            // lists only accept ports, so this is a structured clone - at
            // 384KB/s the copy is negligible.
            const bytes = new Uint8Array(frame.length)
            bytes.set(frame)
            pcmPort.postMessage(bytes.buffer)
          },
          (err, message) => {
            process.parentPort.postMessage({
              type: 'error',
              message: String(err?.message ?? message)
            })
            stopSession()
          }
        )
        process.parentPort.postMessage({ type: 'started', backend: session.backend })
      } catch (err) {
        stopSession()
        process.parentPort.postMessage({ type: 'error', message: String(err?.message ?? err) })
      }
      break
    }

    case 'stop':
      stopSession()
      break
  }
})
