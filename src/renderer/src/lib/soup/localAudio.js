import { loadRnnoise, RnnoiseWorkletNode } from '@sapphi-red/web-noise-suppressor'
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import { createVoiceGraph } from '../voiceAudio'
import { micConstraints, micProfileUsesRnnoise, micProfileWantsStereo } from '../micAudioProfile'
import { createSerialQueue } from '../serialQueue'

// The RNNoise WASM binary is fetched once and reused across AudioContexts.
let rnnoiseBinaryPromise = null

// ─── Shared 25 Hz audio ticker ────────────────────────────────────
// Speaking detectors and the live volume gate all need the same hidden-window-safe
// cadence. One timer avoids an independent wakeup for every stream while keeping
// analyser reads exactly where they were.
const AUDIO_TICK_INTERVAL_MS = 40
const audioTickerCallbacks = new Set()
let audioTickerTimer = null

function invokeAudioTickerCallback(callback) {
  try {
    callback()
  } catch (err) {
    // One broken analyser/gate must not stop the other participants' indicators.
    console.error('[Soup] 40ms audio ticker callback failed:', err)
  }
}

function stopAudioTicker() {
  if (audioTickerTimer !== null) {
    clearInterval(audioTickerTimer)
    audioTickerTimer = null
  }
}

function runAudioTicker() {
  // Set iteration is spec-safe under concurrent deletion: a callback removed
  // earlier in this same tick (by itself or another callback) is skipped.
  for (const callback of audioTickerCallbacks) {
    invokeAudioTickerCallback(callback)
  }
  if (audioTickerCallbacks.size === 0) stopAudioTicker()
}

// Registering runs once immediately, preserving the old detector/gate startup
// behavior. The returned function is idempotent and stops the shared timer when
// the last callback leaves.
function registerAudioTickerCallback(callback) {
  audioTickerCallbacks.add(callback)
  if (audioTickerTimer === null) {
    audioTickerTimer = setInterval(runAudioTicker, AUDIO_TICK_INTERVAL_MS)
  }
  invokeAudioTickerCallback(callback)

  return () => {
    audioTickerCallbacks.delete(callback)
    if (audioTickerCallbacks.size === 0) stopAudioTicker()
  }
}

// Fetch (once) the RNNoise WASM binary. The SIMD build is used automatically
// where the platform supports it. The binary is reused across AudioContexts.
function getRnnoiseBinary() {
  if (!rnnoiseBinaryPromise) {
    rnnoiseBinaryPromise = loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath
    }).catch((err) => {
      // Don't cache a failed load - allow a later retry.
      rnnoiseBinaryPromise = null
      throw err
    })
  }
  return rnnoiseBinaryPromise
}

// Shared AudioContext for the local mic chain. Reused across publishes so the
// RNNoise worklet module is fetched/compiled once, not on every publish or
// settings Apply (which used to rebuild the context and re-addModule each
// time). Suspended on media reset rather than closed, so the compiled module
// survives for the next publish. RNNoise is trained on 48 kHz audio, so the
// rate is pinned.
let micContext = null
const rnnoiseWorkletLoads = new WeakMap()

function ensureRnnoiseWorklet(audioContext) {
  let load = rnnoiseWorkletLoads.get(audioContext)
  if (!load) {
    load = audioContext.audioWorklet.addModule(rnnoiseWorkletPath).catch((err) => {
      rnnoiseWorkletLoads.delete(audioContext)
      throw err
    })
    rnnoiseWorkletLoads.set(audioContext, load)
  }
  return load
}

async function createRnnoiseProcessor(audioContext) {
  const [binary] = await Promise.all([getRnnoiseBinary(), ensureRnnoiseWorklet(audioContext)])
  return new RnnoiseWorkletNode(audioContext, { maxChannels: 1, wasmBinary: binary })
}

async function getMicContext() {
  if (!micContext || micContext.state === 'closed') {
    micContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 48000 })
  }
  if (micContext.state === 'suspended') await micContext.resume()
  return micContext
}

// ─── Build the local audio processing chain ──────────────────────
// Folds the captured mic stream to mono first, then wires it through optional
// RNNoise denoising (an AudioWorklet that suppresses keyboard/typing and steady
// background noise while preserving voice) and the optional volume gate.
// Returns the processed stream plus a stop() that tears the chain down. The
// processed stream is also the source of truth for the local speaking indicator,
// so it reflects everything that can affect what peers receive (including
// RNNoise and a closed volume gate).
export async function buildAudioProcessor(stream, micSettings) {
  const stereo = micProfileWantsStereo(micSettings)
  // The RNNoise worklet is a mono, speech-trained denoiser: it cannot preserve a
  // stereo image and would gut music, which is exactly what Hi-Fi Voice is for.
  const needsRnnoise = micProfileUsesRnnoise(micSettings)
  const needsGate = micSettings.useVolumeGate
  // Seed the live threshold from the settings this chain is being built with, so
  // a rebuild and a live drag can't disagree about the current value.
  setVolumeGateThreshold(micSettings.volumeGateThreshold)

  const audioContext = await getMicContext()
  const { source, input, destination } = createVoiceGraph(audioContext, stream, { stereo })
  // Every node this chain creates, so stop() can detach them from the shared
  // context (which lives on for the next publish, unlike the old
  // context-per-publish teardown).
  const chainNodes = [source, input, destination]
  let node = input
  let rnnoiseNode = null
  let stopGateTicker = null

  if (needsRnnoise) {
    try {
      rnnoiseNode = await createRnnoiseProcessor(audioContext)
      node.connect(rnnoiseNode)
      node = rnnoiseNode
      console.log('[Soup] RNNoise denoiser applied')
    } catch (err) {
      // Fall through to the mono fold and whatever processing remains.
      console.error('[Soup] RNNoise init failed, skipping:', err)
    }
  }

  if (needsGate) {
    const reader = createSpeechLevelReader(audioContext)
    const gate = audioContext.createGain()
    const gateController = createLevelGateController(audioContext, gate, reader.read, {
      threshold: micSettings.volumeGateThreshold
    })
    chainNodes.push(...reader.nodes, gate)
    // Analysis is a sidechain so the speech-band filters never color outgoing
    // audio. The untouched denoised signal passes through the controlled gain.
    node.connect(reader.input)
    node.connect(gate)
    node = gate

    // 25Hz via the shared ticker, not rAF: level detection needs far less than
    // display rate, and rAF is throttled/paused when the window is hidden — which
    // would stall the gate and stick outgoing audio gated/ungated while minimized.
    // The threshold is read per tick from module state rather than captured, so
    // dragging the slider moves the gate live instead of needing a republish.
    stopGateTicker = registerAudioTickerCallback(() => gateController.update(liveGateThreshold))
    console.log('[Soup] Volume gate applied, threshold:', micSettings.volumeGateThreshold)
  }

  node.connect(destination)

  const stop = () => {
    stopGateTicker?.()
    stopGateTicker = null
    try {
      rnnoiseNode?.destroy()
    } catch {
      // The worklet may already have torn itself down.
    }
    for (const chainNode of chainNodes) {
      try {
        chainNode.disconnect()
      } catch {
        // A partially built or already-stopped chain is safe to ignore.
      }
    }
    // The shared context stays open (suspended on media reset) so the
    // compiled worklet module is reused by the next publish.
  }

  // `tap` is the last graph node before the destination — everything that decides
  // what peers receive (mono fold, RNNoise, volume gate) has already been applied.
  // The muted-talk detector listens there instead of the raw capture, so it only
  // hears audio that would really be transmitted, and it keeps hearing it while
  // muted (muting disables the destination's *track*, not the graph feeding it).
  return { stream: destination.stream, stop, tap: { context: audioContext, node } }
}

// Release a raw getUserMedia capture, closing the OS mic handle. Safe on null.
// Only call once the capture no longer feeds a live processing graph.
export function stopRawStream(stream) {
  stream?.getTracks().forEach((track) => track.stop())
}

// Chromium binds its audio processing (AGC / noise suppression / echo
// cancellation) to the shared capture source for a device, not to the individual
// track. A getUserMedia on a device that is still open silently inherits the
// processing the source was created with, so the new constraints are dropped and
// the old settings persist until every handle closes (i.e. an app restart).
// applyConstraints() does not reconfigure these flags either.
//
// So: serialize every mic acquisition, release the previous capture first, and
// let the source actually tear down before asking for a new one. The constraints
// themselves live in micAudioProfile.js, where the republish classifier can read
// them without pulling in this module.

// track.stop() returns before Chromium has torn the capture source down; a short
// hop lets the release land so the next open is cold.
// ponytail: fixed delay, not a readback of source state — there is no API to
// observe it. If constraints still stick occasionally, raise this.
const MIC_SOURCE_RELEASE_MS = 50

const enqueueMicAcquire = createSerialQueue()

// Acquire a mic capture with `micSettings` applied for real. `previousStream` is
// the caller's own capture to release first — pass it rather than stopping it
// yourself, so the release and the re-open stay ordered.
export function acquireMicCapture(micSettings, previousStream) {
  return enqueueMicAcquire(async () => {
    stopRawStream(previousStream)
    await new Promise((resolve) => setTimeout(resolve, MIC_SOURCE_RELEASE_MS))
    return navigator.mediaDevices.getUserMedia({ audio: micConstraints(micSettings) })
  })
}

// ─── Shared speech level measurement ───────────────────────────────
// Analyze a speech-band sidechain without modifying the audible signal. Time-domain
// RMS is stable across different pitches and spectral shapes; averaging byte-mapped
// FFT bins was not. The level is mapped from -60..-5 dBFS to 0..100 so whispering,
// normal speech, and loud speech occupy distinct parts of the meter instead of
// clustering near its upper end. Smoothing uses real elapsed time, so meter (rAF)
// and detector/gate (25 Hz) respond alike.
const SPEECH_LEVEL_FLOOR_DB = -60
const SPEECH_LEVEL_CEILING_DB = -5
const SPEECH_LEVEL_ATTACK_MS = 35
const SPEECH_LEVEL_RELEASE_MS = 180

function createSpeechLevelReader(audioContext) {
  const highpass = audioContext.createBiquadFilter()
  highpass.type = 'highpass'
  highpass.frequency.value = 85
  highpass.Q.value = Math.SQRT1_2

  const lowpass = audioContext.createBiquadFilter()
  lowpass.type = 'lowpass'
  lowpass.frequency.value = 4000
  lowpass.Q.value = Math.SQRT1_2

  const analyser = audioContext.createAnalyser()
  analyser.fftSize = 1024
  highpass.connect(lowpass)
  lowpass.connect(analyser)

  const data = new Float32Array(analyser.fftSize)
  let smoothedLevel = 0
  let lastReadAt = null

  const read = () => {
    analyser.getFloatTimeDomainData(data)
    let sumSquares = 0
    for (let i = 0; i < data.length; i++) sumSquares += data[i] * data[i]

    const rms = Math.sqrt(sumSquares / data.length)
    const db = rms > 0 ? 20 * Math.log10(rms) : SPEECH_LEVEL_FLOOR_DB
    const rawLevel = Math.max(
      0,
      Math.min(
        100,
        ((db - SPEECH_LEVEL_FLOOR_DB) / (SPEECH_LEVEL_CEILING_DB - SPEECH_LEVEL_FLOOR_DB)) * 100
      )
    )

    const now = performance.now()
    if (lastReadAt == null) {
      smoothedLevel = rawLevel
    } else {
      const elapsedMs = Math.max(1, now - lastReadAt)
      const timeConstant =
        rawLevel > smoothedLevel ? SPEECH_LEVEL_ATTACK_MS : SPEECH_LEVEL_RELEASE_MS
      const alpha = 1 - Math.exp(-elapsedMs / timeConstant)
      smoothedLevel += (rawLevel - smoothedLevel) * alpha
      if (smoothedLevel < 0.05) smoothedLevel = 0
    }
    lastReadAt = now
    return smoothedLevel
  }

  return {
    input: highpass,
    analyser,
    nodes: [highpass, lowpass, analyser],
    read
  }
}

// Opening level for the volume gate when nothing has set one, on the shared
// speech-band RMS scale (see createSpeechLevelReader).
const DEFAULT_VOLUME_GATE_THRESHOLD = 15

// The threshold the *live* mic gate is currently using. Held at module scope
// because the controller already accepts a per-tick threshold: the value can
// therefore move without rebuilding the processing graph, which is what makes a
// threshold drag free rather than a full republish.
let liveGateThreshold = DEFAULT_VOLUME_GATE_THRESHOLD

// Move the live gate's opening level. Takes effect on the next 40ms tick; no
// capture, graph, or producer work involved.
export function setVolumeGateThreshold(threshold) {
  const value = Number(threshold)
  if (!Number.isFinite(value)) return
  liveGateThreshold = value
}

// Gate state shared by the live mic path and the settings test. A lower release
// threshold plus a short hold bridges syllable gaps; gain ramps avoid clicks.
export function createLevelGateController(
  audioContext,
  gate,
  read,
  {
    threshold = DEFAULT_VOLUME_GATE_THRESHOLD,
    hysteresis = 3,
    holdMs = 200,
    rampSeconds = 0.03
  } = {}
) {
  let open = false
  let lastVoiceAt = 0
  gate.gain.setValueAtTime(0, audioContext.currentTime)

  const setOpen = (next) => {
    if (next === open) return
    open = next
    const now = audioContext.currentTime
    const current = gate.gain.value
    gate.gain.cancelScheduledValues(now)
    gate.gain.setValueAtTime(current, now)
    gate.gain.linearRampToValueAtTime(next ? 1 : 0, now + rampSeconds)
  }

  const update = (nextThreshold = threshold) => {
    const level = read()
    const now = performance.now()
    const releaseThreshold = Math.max(0, nextThreshold - hysteresis)

    if (!open) {
      if (level >= nextThreshold) {
        lastVoiceAt = now
        setOpen(true)
      }
    } else if (level >= releaseThreshold) {
      lastVoiceAt = now
    } else if (now - lastVoiceAt >= holdMs) {
      setOpen(false)
    }

    return { level, open }
  }

  return { update, isOpen: () => open }
}

// Build the same post-browser/post-RNNoise analysis sidechain used by the live
// gate. The returned outputNode is also suitable for local test playback.
export async function createMicLevelMonitor(audioContext, stream, micSettings) {
  const source = audioContext.createMediaStreamSource(stream)
  let outputNode = source
  let rnnoiseNode = null

  if (micSettings.useRnnoise) {
    try {
      rnnoiseNode = await createRnnoiseProcessor(audioContext)
      source.connect(rnnoiseNode)
      outputNode = rnnoiseNode
    } catch (err) {
      console.error('[Soup] RNNoise monitor init failed, using raw mic:', err)
    }
  }

  const reader = createSpeechLevelReader(audioContext)
  outputNode.connect(reader.input)

  const stop = () => {
    try {
      outputNode.disconnect(reader.input)
    } catch {
      // Already disconnected during a settings rebuild.
    }
    for (const node of reader.nodes) {
      try {
        node.disconnect()
      } catch {
        // A partially initialized monitor is safe to tear down.
      }
    }
    try {
      rnnoiseNode?.destroy()
    } catch {
      // The worklet may already have torn itself down.
    }
    try {
      source.disconnect()
    } catch {
      // Source may be the output node and already disconnected above.
    }
  }

  return { source, outputNode, analyser: reader.analyser, read: reader.read, stop }
}

// ─── Detect speaking activity on an audio stream ──────────────────
// Returns a stop function. Calls onChange(isSpeaking) whenever the
// speaking state changes, and once more with false on stop.
export function createSpeakingDetector(
  stream,
  onChange,
  {
    threshold = 12,
    hysteresis = 3,
    holdMs = 250,
    audioContext: providedContext = null,
    sourceNode: providedSource = null
  } = {}
) {
  if (!stream.getAudioTracks().length) return () => {}

  // When the caller hands us its playback context and the per-stream source node
  // (the remote-voice path does), detection adds only analysis nodes — no extra
  // AudioContext (a live render thread) and no second createMediaStreamSource per
  // stream (a separate, drift-prone track→WebAudio bridge). Standalone callers
  // (e.g. the settings mic test) pass neither and get a private context + own
  // source, closed on stop exactly as before.
  const ownContext = !providedContext
  const audioContext = providedContext ?? new (window.AudioContext || window.webkitAudioContext)()
  const reader = createSpeechLevelReader(audioContext)
  const source = providedSource ?? audioContext.createMediaStreamSource(stream)
  source.connect(reader.input)

  let speaking = false
  let lastVoiceAt = 0

  const tick = () => {
    const level = reader.read()
    const now = performance.now()
    const releaseThreshold = Math.max(0, threshold - hysteresis)

    if (!speaking) {
      if (level >= threshold) {
        speaking = true
        lastVoiceAt = now
        onChange(true)
      }
    } else if (level >= releaseThreshold) {
      lastVoiceAt = now
    } else if (now - lastVoiceAt >= holdMs) {
      speaking = false
      onChange(false)
    }
  }
  // 25Hz via the shared hidden-window-safe ticker. Registration invokes the
  // callback once immediately, matching the previous startup behavior.
  const unregisterTicker = registerAudioTickerCallback(tick)

  return () => {
    unregisterTicker()
    if (speaking) onChange(false)
    try {
      // A provided (shared) source also feeds the playback gain, so only detach
      // our own tap into the analysis chain — never a full source.disconnect().
      if (providedSource) source.disconnect(reader.input)
      else source.disconnect()
    } catch {
      // Cleanup may run after the node/context has already disconnected it.
    }
    for (const node of reader.nodes) {
      try {
        node.disconnect()
      } catch {
        // Analysis nodes may already be detached.
      }
    }
    // Only a context we created is ours to close; a shared playback context is
    // owned by getPlaybackContext() and must keep running for other streams.
    // close() rejects (async) if the context is already closed — e.g. this
    // cleanup runs twice during teardown. Skip when closed and swallow the
    // rejection so it never surfaces as an uncaught promise error.
    if (ownContext && audioContext.state !== 'closed') audioContext.close().catch(() => {})
  }
}

// Idle the reusable microphone context between media sessions without losing
// the compiled RNNoise worklet module.
export function suspendMicContext() {
  if (micContext?.state === 'running') micContext.suspend().catch(() => {})
}
