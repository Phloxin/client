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
import * as capture from 'audio-capture'

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
    case 'init':
      process.parentPort.postMessage({ type: 'capabilities', capabilities: capture.capabilities() })
      break

    case 'list-apps':
      try {
        process.parentPort.postMessage({ type: 'apps', apps: capture.listApps() })
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
