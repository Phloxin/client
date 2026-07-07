// Renderer side of the native screenshare-audio pipeline. Talks to the main
// process over window.api.screenAudio (control) and receives the PCM
// MessagePort relayed by the preload via window.postMessage. The port is
// transferred straight into an AudioWorklet, which feeds a
// MediaStreamAudioDestinationNode - the resulting track is produced to
// mediasoup exactly like a getDisplayMedia audio track would be.
import pcmSourceWorkletUrl from '../worklets/pcm-source-processor.js?url'

// One long-lived context for screenshare audio; the worklet module is added
// once and reused across shares (unlike the per-publish mic contexts).
let sharedCtx = null
let workletLoaded = false

async function getContext() {
  if (!sharedCtx || sharedCtx.state === 'closed') {
    sharedCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' })
    workletLoaded = false
  }
  if (sharedCtx.state === 'suspended') await sharedCtx.resume()
  if (!workletLoaded) {
    await sharedCtx.audioWorklet.addModule(pcmSourceWorkletUrl)
    workletLoaded = true
  }
  return sharedCtx
}

// The preload relays the Electron MessagePort into the page via
// window.postMessage({ type: 'audiocapture:port' }, '*', [port]).
function waitForPcmPort(timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      window.removeEventListener('message', onMessage)
      reject(new Error('timed out waiting for audio capture port'))
    }, timeoutMs)
    const onMessage = (e) => {
      if (e.source === window && e.data?.type === 'audiocapture:port' && e.ports[0]) {
        clearTimeout(timer)
        window.removeEventListener('message', onMessage)
        resolve(e.ports[0])
      }
    }
    window.addEventListener('message', onMessage)
  })
}

let active = null

/**
 * Start native capture and return a MediaStreamTrack carrying it.
 * @param {{ mode: string, targets?: string[] }} options - capture mode/targets
 *   ('stub' | 'app' | 'system' | 'system-exclude-self', see the addon)
 * @returns {Promise<{ track: MediaStreamTrack, backend: string, stop: () => Promise<void> }>}
 */
export async function startScreenAudio(options) {
  await stopScreenAudio()

  const ctx = await getContext()
  // Arm the port listener before asking main to start, so the port relay
  // can't race past us.
  const portPromise = waitForPcmPort()
  const { backend } = await window.api.screenAudio.start(options)
  const pcmPort = await portPromise

  const node = new AudioWorkletNode(ctx, 'pcm-source', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2]
  })
  node.port.postMessage({ type: 'pcm-port', port: pcmPort }, [pcmPort])
  node.port.onmessage = (e) => {
    if (e.data?.type === 'stats' && (e.data.underruns > 0 || e.data.overruns > 0)) {
      console.debug(
        `[ScreenAudio] buffer stats: ${e.data.bufferedMs}ms buffered, ` +
          `${e.data.underruns} underruns, ${e.data.overruns} overruns`
      )
    }
  }

  const destination = ctx.createMediaStreamDestination()
  node.connect(destination)

  const track = destination.stream.getAudioTracks()[0]

  const stop = async () => {
    if (active?.node !== node) return
    active = null
    try {
      await window.api.screenAudio.stop()
    } finally {
      node.port.postMessage({ type: 'end' })
      node.disconnect()
      track.stop()
    }
  }

  active = { node, stop }
  return { track, backend, stop }
}

export async function stopScreenAudio() {
  if (active) await active.stop()
}

export function getScreenAudioCapabilities() {
  return window.api.screenAudio.getCapabilities().then((caps) => {
    if (caps?.backend === 'none' && caps?.reason) {
      console.warn('[ScreenAudio] native capture unavailable:', caps.reason)
    }
    return caps
  })
}

export function listScreenAudioApps() {
  return window.api.screenAudio.listApps()
}

/** Fires when capture dies mid-share (host crash, device loss). */
export function onScreenAudioError(cb) {
  return window.api.screenAudio.onError(cb)
}

// Dev hook: lets you exercise the whole native pipeline from the devtools
// console without joining a call, e.g.:
//   await window.__screenAudio.start({ mode: 'stub' })  → hear a 440Hz tone
//   await window.__screenAudio.stop()
if (import.meta.env.DEV) {
  let monitor = null
  let devTrack = null
  window.__screenAudio = {
    caps: () => getScreenAudioCapabilities(),
    apps: () => listScreenAudioApps(),
    start: async (options = { mode: 'stub' }) => {
      const res = await startScreenAudio(options)
      devTrack = res.track
      monitor = new Audio()
      monitor.srcObject = new MediaStream([res.track])
      monitor.play()
      return res.backend
    },
    stop: async () => {
      monitor?.pause()
      monitor = null
      devTrack = null
      await stopScreenAudio()
    },
    // Measure the live track for ~250ms; returns peak/rms so automated tests
    // can assert signal is actually flowing.
    rms: async () => {
      if (!devTrack) throw new Error('not started')
      const ctx = new AudioContext({ sampleRate: 48000 })
      const src = ctx.createMediaStreamSource(new MediaStream([devTrack]))
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 2048
      src.connect(analyser)
      const buf = new Float32Array(analyser.fftSize)
      let peak = 0
      let sumSq = 0
      let n = 0
      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 25))
        analyser.getFloatTimeDomainData(buf)
        for (const v of buf) {
          peak = Math.max(peak, Math.abs(v))
          sumSq += v * v
          n++
        }
      }
      await ctx.close()
      return { peak, rms: Math.sqrt(sumSq / n) }
    }
  }
}
