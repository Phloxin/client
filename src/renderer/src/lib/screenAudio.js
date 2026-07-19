// Renderer side of the native screenshare-audio pipeline. Talks to the main
// process over window.api.screenAudio (control) and receives the PCM
// MessagePort relayed by the preload via window.postMessage. The port is
// transferred straight into an AudioWorklet, which feeds a
// MediaStreamAudioDestinationNode - the resulting track is produced to
// mediasoup exactly like a getDisplayMedia audio track would be.
// Force a real same-origin asset. Vite normally inlines this small file as a
// data: URL in production; the app's CSP correctly blocks data: scripts, and
// Chromium then reports only "Unable to load a worklet's module."
import pcmSourceWorkletUrl from '../worklets/pcm-source-processor.js?url&no-inline'

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
  let timer = null
  let onMessage = null
  let rejectWait = null
  let receivedPort = null
  let settled = false

  const cleanup = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (onMessage) window.removeEventListener('message', onMessage)
  }

  const promise = new Promise((resolve, reject) => {
    rejectWait = reject
    onMessage = (e) => {
      if (e.source === window && e.data?.type === 'audiocapture:port' && e.ports[0]) {
        settled = true
        receivedPort = e.ports[0]
        cleanup()
        resolve(receivedPort)
      }
    }
    window.addEventListener('message', onMessage)
    timer = setTimeout(() => {
      settled = true
      cleanup()
      reject(new Error('timed out waiting for audio capture port'))
    }, timeoutMs)
  })

  return {
    promise,
    release() {
      receivedPort = null
    },
    cancel() {
      if (!settled) {
        settled = true
        cleanup()
        rejectWait(new Error('audio capture port wait cancelled'))
      }
      receivedPort?.close()
      receivedPort = null
    }
  }
}

let active = null
let lifecycleQueue = Promise.resolve()

// Native capture is process-global, so starts/stops must not overlap. Returning
// an owner-bound stop handle lets a stale screen-share continuation clean up its
// own session without a later call accidentally stopping the newer active one.
function enqueueLifecycle(operation) {
  const result = lifecycleQueue.then(operation, operation)
  lifecycleQueue = result.catch(() => {})
  return result
}

async function cleanupSession(session) {
  if (!session || session.stopped) return
  session.stopped = true
  if (active === session) active = null
  if (session.firstFrameTimer !== null) clearTimeout(session.firstFrameTimer)
  session.firstFrameTimer = null

  try {
    if (session.backendStarted) await window.api.screenAudio.stop()
  } finally {
    try {
      session.node?.port.postMessage({ type: 'end' })
    } catch {
      // The worklet port may already be closed after a host failure.
    }
    try {
      session.node?.disconnect()
    } catch {
      // A partially connected or already-stopped node is safe to ignore.
    }
    session.track?.stop()
  }
}

/**
 * Start native capture and return a MediaStreamTrack carrying it.
 * @param {{ mode: string, targets?: string[] }} options - capture mode/targets
 *   ('stub' | 'app' | 'system' | 'system-exclude-self', see the addon)
 * @returns {Promise<{ track: MediaStreamTrack, backend: string, stop: () => Promise<void> }>}
 */
export function startScreenAudio(options) {
  return enqueueLifecycle(async () => {
    if (active) await cleanupSession(active)

    const ctx = await getContext()
    // Arm the port listener before asking main to start, so the port relay
    // can't race past us.
    const portWait = waitForPcmPort()
    // The host start can take longer than the port timeout. Mark an early port
    // rejection as observed while preserving it for the later await below.
    portWait.promise.catch(() => {})
    const session = {
      backendStarted: false,
      firstFrameTimer: null,
      node: null,
      track: null,
      stopped: false
    }
    let backend
    let pcmPort = null

    try {
      const startResult = await window.api.screenAudio.start(options)
      session.backendStarted = true
      backend = startResult.backend
      pcmPort = await portWait.promise

      const node = new AudioWorkletNode(ctx, 'pcm-source', {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2]
      })
      session.node = node

      // A first-frame signal is useful diagnostics, but cannot be a readiness
      // requirement: WASAPI process-loopback is event driven and may emit no
      // packets while a correctly captured application is silent.
      node.port.onmessage = (e) => {
        if (e.data?.type === 'ready') {
          if (session.firstFrameTimer !== null) clearTimeout(session.firstFrameTimer)
          session.firstFrameTimer = null
          console.debug('[ScreenAudio] first PCM frame received')
        } else if (e.data?.type === 'stats' && (e.data.underruns > 0 || e.data.overruns > 0)) {
          console.debug(
            `[ScreenAudio] buffer stats: ${e.data.bufferedMs}ms buffered, ` +
              `${e.data.underruns} underruns, ${e.data.overruns} overruns`
          )
        }
      }

      node.port.postMessage({ type: 'pcm-port', port: pcmPort }, [pcmPort])
      portWait.release()
      pcmPort = null // ownership transferred to the worklet

      const destination = ctx.createMediaStreamDestination()
      node.connect(destination)
      session.track = destination.stream.getAudioTracks()[0]
      session.firstFrameTimer = setTimeout(() => {
        session.firstFrameTimer = null
        console.warn(
          '[ScreenAudio] capture is ready but has not delivered PCM yet; the selected source may be silent'
        )
      }, 5000)
    } catch (err) {
      // Remove the listener immediately so it cannot steal the next session's
      // port, and close a port that was already delivered but not transferred.
      // Also stop any backend that started before a port/worklet failure so the
      // OS capture handle cannot leak.
      portWait.cancel()
      pcmPort?.close()
      await cleanupSession(session).catch(() => {})
      throw err
    }

    const stop = () => enqueueLifecycle(() => cleanupSession(session))
    active = session
    return { track: session.track, backend, stop }
  })
}

export function stopScreenAudio() {
  return enqueueLifecycle(async () => {
    if (active) await cleanupSession(active)
  })
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
