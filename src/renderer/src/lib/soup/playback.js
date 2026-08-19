import { getServerHost } from '../serverConfig'
import { configureMediaDevices, shortDeviceId } from '../mediaDevices'
import { createSpeakingDetector } from './localAudio'

let getRemoteConsumers = () => new Map()
let onClientSpeaking = null

export function configurePlayback(dependencies = {}) {
  if (dependencies.getRemoteConsumers) getRemoteConsumers = dependencies.getRemoteConsumers
  if (dependencies.onClientSpeaking) onClientSpeaking = dependencies.onClientSpeaking
}

let soundMuted = false
// Playback output device (sinkId) and master output volume (0..1). Persisted in
// settings and pushed in via setOutputDevice()/setMasterVolume().
let outputDeviceId = 'default'
let masterVolume = 1
// Shared AudioContext for remote playback. Each remote mic/screen audio stream
// runs through its own GainNode into this context, so a client's volume can be
// boosted above 100% (an HTMLAudioElement's volume is capped at 1.0).
let playbackContext = null
// Only the focused stream's screen-share audio should be audible - the
// client whose ScreenShareAudio should currently be unmuted, plus the
// volume/mute settings to apply to it.
let focusedClientId = null
let focusedVolume = 1
let focusedMuted = false

// Per-client local volume/mute overrides for mic audio (right-click controls
// in the sidebar) - keyed by clientId. Persisted to localStorage per server
// host (user ids are only unique per server) so a client's volume/mute survives
// app restarts. The in-memory Map mirrors the currently-connected host's slice
// of that store; ensureOverridesForCurrentHost() reloads it whenever the host
// changes (connect, disconnect, or switching servers).
const CLIENT_AUDIO_OVERRIDES_KEY = 'clientAudioOverrides'
let clientAudioOverrides = new Map()
let clientAudioOverridesHost

// ─── Rebuildable remote-audio Web Audio graph ────────────────────
// Given an audio entry (carries stream / clientId / producedType), build the
// playback graph: one source node off entry.stream on the shared playback
// context -> gain (per-client volume, may exceed 1) -> destination, plus a
// speaking detector that TAPS that same source node (see createSpeakingDetector)
// instead of making its own context/source. Gain starts at 0; callers must run
// applyAllAudioState() afterwards to set the real volume. Isolated from the
// <audio> element so the graph can be torn down and rebuilt (health self-heal)
// without dropping the WebRTC track pull.
export function buildAudioGraph(entry) {
  const ctx = getPlaybackContext()
  const srcNode = ctx.createMediaStreamSource(entry.stream)
  const gainNode = ctx.createGain()
  gainNode.gain.value = 0 // start silent; applyAllAudioState() sets the real value
  srcNode.connect(gainNode)
  gainNode.connect(ctx.destination)

  // Screen/tab audio isn't the client's voice - don't feed it into the speaking
  // indicator; clientId == null means we can't attribute speaking to anyone.
  let stopDetector = null
  if (entry.clientId != null && entry.producedType !== 'ScreenShareAudio') {
    stopDetector = createSpeakingDetector(
      entry.stream,
      (isSpeaking) => {
        onClientSpeaking?.(entry.clientId, isSpeaking)
      },
      { audioContext: ctx, sourceNode: srcNode }
    )
  }

  entry.srcNode = srcNode
  entry.gain = gainNode
  entry.stopDetector = stopDetector
}

// Tear down only the rebuildable graph nodes (leaves the <audio> element alone).
// Stop the detector first so it detaches its own tap into the source before we
// fully disconnect the source node.
export function teardownAudioGraph(entry) {
  entry.stopDetector?.()
  entry.stopDetector = null
  try {
    entry.srcNode?.disconnect()
  } catch {
    // The media source may already be disconnected during transport reset.
  }
  try {
    entry.gain?.disconnect()
  } catch {
    // The gain node may already be disconnected during transport reset.
  }
  entry.srcNode = null
  entry.gain = null
}

// Lazily create (and resume) the shared playback AudioContext. Created on the
// first remote audio stream, which happens after the user has clicked to join -
// so the autoplay policy lets it run.
//
// Pinned to 48 kHz (like getMicContext): WebRTC/Opus emits 48 kHz, but an
// unpinned context follows the output device's rate. On a non-48 kHz device that
// forces every remote stream through Chromium's drift-prone track→WebAudio
// resampling FIFO, which is implicated in the accumulating playout delay/crackle.
export function getPlaybackContext() {
  if (!playbackContext) {
    playbackContext = new (window.AudioContext || window.webkitAudioContext)({
      sampleRate: 48000
    })
    watchPlaybackContext(playbackContext)
    applyOutputDeviceToContext()
  }
  if (playbackContext.state === 'suspended') {
    playbackContext.resume().catch(() => {})
  }
  return playbackContext
}

// Every audible remote stream renders through this one context, created once
// per app launch. If it stops running, the user hears nobody for the rest of
// the session with nothing in the log to say so. The error event is the
// spec's signal for "the selected sink device was removed".
function watchPlaybackContext(context) {
  context.addEventListener?.('statechange', () => {
    if (context !== playbackContext) return
    reportPlaybackDown(`state=${context.state}`)
  })
  context.addEventListener?.('error', (event) => {
    if (context !== playbackContext) return
    console.warn('[Soup] playback context error:', event?.type ?? 'error')
    reportPlaybackDown('error event')
  })
}

function hasLiveRemoteAudio() {
  for (const entry of getRemoteConsumers().values()) {
    if (entry.kind === 'audio') return true
  }
  return false
}

// Detection only: a suspended context with live consumers, or an error event,
// means playback is down. Resuming is the one repair that's safe today.
// Recreating the context is deliberately not attempted until a field export
// says which of the two failure modes actually happens.
function reportPlaybackDown(reason) {
  const context = playbackContext
  if (!context) return
  if (context.state === 'running') {
    console.warn(`[Soup] playback context ${reason} (${describePlayback(context)})`)
    return
  }
  if (context.state === 'suspended' && !hasLiveRemoteAudio()) return
  console.warn(`[Soup] playback context down: ${reason} (${describePlayback(context)})`)
  context
    .resume()
    .then(() => {
      if (context !== playbackContext) return
      console.warn(`[Soup] playback context resumed (${describePlayback(context)})`)
    })
    .catch((err) => console.warn('[Soup] playback context resume failed:', err))
}

function describePlayback(context) {
  return `state=${context.state} sink=${shortDeviceId(context.sinkId ?? '')} baseLatency=${context.baseLatency ?? '?'}`
}

// A snapshot for the media watchdog's warning line. This is the single best
// field signal we get, and playback is the half the watchdog can't see.
export function playbackDiagnostics() {
  if (!playbackContext) return 'playback=none'
  return `playback=${describePlayback(playbackContext)}`
}

// Route the whole playback context to the chosen output device. AudioContext
// uses '' for the system default (unlike HTMLMediaElement which takes 'default').
function applyOutputDeviceToContext() {
  if (playbackContext && typeof playbackContext.setSinkId === 'function') {
    const sinkId = outputDeviceId === 'default' ? '' : outputDeviceId
    const context = playbackContext
    context
      .setSinkId(sinkId)
      // The success case is logged too: a sink binding that silently succeeded
      // against a device that later vanished looks identical in an export to
      // one that was never applied.
      .then(() => console.warn(`[Soup] context setSinkId ${shortDeviceId(outputDeviceId)} applied`))
      .catch((err) =>
        console.error(`[Soup] context setSinkId ${shortDeviceId(outputDeviceId)} failed:`, err)
      )
  }
}

configureMediaDevices({ getSelectedOutputId: () => outputDeviceId })

// Routes playback to the chosen output device. Pass 'default' (or empty) for
// the system default.
export function setOutputDevice(deviceId) {
  outputDeviceId = deviceId || 'default'
  applyOutputDeviceToContext()
}

// Sets the master output volume (0..1) applied on top of per-client/focus
// volumes for every remote stream.
export function setMasterVolume(volume) {
  masterVolume = Math.max(0, Math.min(1, volume))
  applyAllAudioState()
}

// Mutes/unmutes playback of all remote audio (deafen).
export function setSoundMuted(muted) {
  soundMuted = muted
  applyAllAudioState()
}

// Volume changes on live audio are ramped rather than stepped. A direct
// `gain.value =` is a discontinuity in the signal, which is audible as a click —
// on every volume drag frame, mute, deafen, and focus switch. ~15ms is fast
// enough to feel instant and slow enough to be inaudible.
const GAIN_RAMP_TIME_CONSTANT = 0.015

function rampGainTo(gainNode, target) {
  const now = gainNode.context.currentTime
  const param = gainNode.gain
  // Anchor at the value the ramp has actually reached before scheduling the
  // next one; cancelScheduledValues alone would snap back to the last
  // explicitly scheduled value.
  const current = param.value
  param.cancelScheduledValues(now)
  param.setValueAtTime(current, now)
  param.setTargetAtTime(target, now, GAIN_RAMP_TIME_CONSTANT)
}

// Applies the focus-driven ScreenShareAudio state and the per-client mic
// volume/mute overrides to every remote stream's gain node. A per-client
// override volume above 1 boosts that client louder than their natural level.
export function applyAllAudioState() {
  ensureOverridesForCurrentHost()
  for (const entry of getRemoteConsumers().values()) {
    if (entry.kind !== 'audio' || !entry.gain) continue

    let gain
    if (entry.producedType === 'ScreenShareAudio') {
      // Only the focused stream's screen-share audio should be audible.
      const audible = entry.clientId === focusedClientId && !focusedMuted
      gain = audible ? focusedVolume * masterVolume : 0
    } else {
      const override = clientAudioOverrides.get(entry.clientId)
      const muted = soundMuted || !!override?.muted
      gain = muted ? 0 : (override?.volume ?? 1) * masterVolume
    }
    rampGainTo(entry.gain, gain)
  }
}

// Called by the UI when the focused stream or its volume/mute state changes.
export function setFocusedScreenAudio(clientId, { volume, muted } = {}) {
  focusedClientId = clientId
  if (volume != null) focusedVolume = volume
  if (muted != null) focusedMuted = muted
  if (clientId != null && playbackContext?.state === 'suspended') {
    playbackContext.resume().catch(() => {})
  }
  applyAllAudioState()
}

// Read the full persisted { [host]: { [clientId]: { volume, muted } } } blob.
function readPersistedAudioOverrides() {
  try {
    return JSON.parse(localStorage.getItem(CLIENT_AUDIO_OVERRIDES_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

// Write the current host's in-memory overrides back to localStorage, pruning
// no-op entries (100% volume, unmuted) so resetting a client truly forgets it
// rather than leaving dead entries behind.
function persistCurrentHostOverrides() {
  const host = getServerHost()
  if (!host) return
  const all = readPersistedAudioOverrides()
  const slice = {}
  for (const [clientId, state] of clientAudioOverrides) {
    if (state.volume !== 1 || state.muted) slice[clientId] = state
  }
  if (Object.keys(slice).length) all[host] = slice
  else delete all[host]
  try {
    localStorage.setItem(CLIENT_AUDIO_OVERRIDES_KEY, JSON.stringify(all))
  } catch {
    // localStorage is unavailable only in unusual renderer contexts; overrides
    // still work for this session, they just won't survive a restart.
  }
}

// Reload clientAudioOverrides from storage whenever the connected host changes,
// so the Map always reflects the current server's saved volumes and never leaks
// one server's overrides onto another (user ids are only unique per server).
function ensureOverridesForCurrentHost() {
  const host = getServerHost()
  if (host === clientAudioOverridesHost) return
  clientAudioOverridesHost = host
  clientAudioOverrides = new Map()
  if (!host) return
  const slice = readPersistedAudioOverrides()[host] || {}
  for (const [clientId, state] of Object.entries(slice)) {
    clientAudioOverrides.set(clientId, {
      volume: typeof state.volume === 'number' ? state.volume : 1,
      muted: !!state.muted
    })
  }
}

// Called by the sidebar's per-client right-click controls to locally
// lower the volume of, or fully mute, a specific client's mic audio. The new
// value is persisted per server so it survives app restarts.
export function setClientAudioState(clientId, { volume, muted } = {}) {
  ensureOverridesForCurrentHost()
  const current = clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
  clientAudioOverrides.set(clientId, {
    volume: volume != null ? volume : current.volume,
    muted: muted != null ? muted : current.muted
  })
  persistCurrentHostOverrides()
  applyAllAudioState()
}

export function getClientAudioState(clientId) {
  ensureOverridesForCurrentHost()
  return clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
}

export function resetFocusedScreenAudio() {
  focusedClientId = null
}
