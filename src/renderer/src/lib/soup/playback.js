import { getServerHost } from '../serverConfig'
import { configureMediaDevices, shortDeviceId, subscribeDeviceChange } from '../mediaDevices'

let getRemoteConsumers = () => new Map()

export function configurePlayback(dependencies = {}) {
  if (dependencies.getRemoteConsumers) getRemoteConsumers = dependencies.getRemoteConsumers
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

// Local volume/mute overrides, keyed by clientId, in two independent maps: one
// for a client's mic audio (the sidebar's right-click controls) and one for
// their screen-share audio (the stream view's controls). Every watched stream
// is audible at once, so each stream carries its own volume/mute rather than
// sharing one "focused stream" level. Both are persisted to localStorage per
// server host (user ids are only unique per server) so a level survives app
// restarts; see createAudioOverrideStore.
const CLIENT_AUDIO_OVERRIDES_KEY = 'clientAudioOverrides'
const STREAM_AUDIO_OVERRIDES_KEY = 'streamAudioOverrides'
const DEFAULT_AUDIO_STATE = { volume: 1, muted: false }
// Stream-audio state is shown in the UI (the stream view's sliders and mute
// badges), so changes and per-host reloads are broadcast to subscribers.
const streamAudioListeners = new Set()
const clientAudioOverrides = createAudioOverrideStore(CLIENT_AUDIO_OVERRIDES_KEY)
const streamAudioOverrides = createAudioOverrideStore(
  STREAM_AUDIO_OVERRIDES_KEY,
  notifyStreamAudioListeners
)

// ─── Rebuildable remote-audio Web Audio graph ────────────────────
// Given an audio entry (carries stream / clientId / producedType), build the
// playback graph: one source node off entry.stream on the shared playback
// context -> gain (per-client volume, may exceed 1) -> destination. Speaking
// rings come from the server's Speakers event, so nothing here analyses the
// received audio. Gain starts at 0; callers must run
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

  entry.srcNode = srcNode
  entry.gain = gainNode
}

// Tear down only the rebuildable graph nodes (leaves the <audio> element alone).
export function teardownAudioGraph(entry) {
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

// Every audible remote stream renders through this one context. If it stops
// running, the user hears nobody for the rest of the session with nothing in
// the log to say so. The error event is the spec's signal for "the selected
// sink device was removed".
function watchPlaybackContext(context) {
  context.addEventListener?.('statechange', () => {
    if (context !== playbackContext) return
    reportPlaybackDown(`state=${context.state}`)
    if (context.state !== 'running') schedulePlaybackCheck()
  })
  context.addEventListener?.('error', (event) => {
    if (context !== playbackContext) return
    console.warn('[Soup] playback context error:', event?.type ?? 'error')
    reportPlaybackDown('error event')
    schedulePlaybackCheck()
  })
}

function hasLiveRemoteAudio() {
  for (const entry of getRemoteConsumers().values()) {
    if (entry.kind === 'audio') return true
  }
  return false
}

// Resuming is the cheap first try at a context that's down, and is enough for
// a transient suspend (setSinkId passes through one). It is not enough for a
// lost device: see checkPlayback.
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

// ─── Output device loss ──────────────────────────────────────────
// A context bound to a sink that disappears fires 'error' and drops to
// suspended. In the field (Windows, a USB headset) its resume() never settled
// again, not even after the headset was back and voice had reconnected. Only
// a new context (an app restart) played again. So a context that stays down
// while there's someone to hear is replaced, and every remote stream is moved
// onto the new one. The new context asks for the selected output and lands on
// the default one while that's missing (setSinkId fails), the same fallback
// the mic gets, then returns to the selected output when it re-enumerates.
//
// A device change is the event that can make a new context work, so a
// replacement is allowed once per device change. A machine with no usable
// output therefore can't churn through contexts.
const PLAYBACK_CHECK_SETTLE_MS = 1000
let playbackCheckTimer = null
let playbackReplacedSinceDeviceChange = false
// Output ids from the last device change, or null before one (or when
// enumeration failed): unknown, so never read as "the device is back".
let availableOutputIds = null

function schedulePlaybackCheck() {
  // Debounced: a headset unplug is an error, a state change and two device
  // changes within a few ms, and the check should see where they settled.
  clearTimeout(playbackCheckTimer)
  playbackCheckTimer = setTimeout(() => {
    playbackCheckTimer = null
    checkPlayback()
  }, PLAYBACK_CHECK_SETTLE_MS)
}

function checkPlayback() {
  const context = playbackContext
  if (!context) return
  if (context.state === 'running') {
    returnToSelectedOutput(context)
    return
  }
  if (!hasLiveRemoteAudio()) {
    // Nobody to hear right now. Drop it, so the next stream creates a context
    // that works instead of inheriting this one.
    console.warn(`[Soup] playback context dropped while down (${describePlayback(context)})`)
    playbackContext = null
    context.close().catch(() => {})
    return
  }
  if (playbackReplacedSinceDeviceChange) return
  playbackReplacedSinceDeviceChange = true
  replacePlaybackContext(context)
}

// Move every remote stream's graph onto a new context. The <audio> pumps are
// outside the graph and keep their tracks; buildAudioGraph creates the
// context (with the selected sink) on first use.
function replacePlaybackContext(previous) {
  const entries = [...getRemoteConsumers().values()].filter((entry) => entry.kind === 'audio')
  for (const entry of entries) teardownAudioGraph(entry)
  playbackContext = null
  previous.close().catch(() => {})
  for (const entry of entries) {
    try {
      buildAudioGraph(entry)
    } catch (err) {
      console.error('[Soup] playback graph rebuild failed:', err)
    }
    // The pump is what keeps the remote track flowing into the graph, so it
    // must not have been stopped by the same device loss.
    if (entry.audioEl?.paused) entry.audioEl.play().catch(() => {})
  }
  applyAllAudioState()
  console.warn(`[Soup] playback context replaced (${playbackDiagnostics()})`)
}

// Running on the default output because the selected one was missing when the
// context was made. Move back once it's enumerated again.
function returnToSelectedOutput(context) {
  if (outputDeviceId === 'default' || context.sinkId === outputDeviceId) return
  if (!availableOutputIds?.has(outputDeviceId)) return
  applyOutputDeviceToContext()
}

subscribeDeviceChange((ids) => {
  if (ids) availableOutputIds = ids.outputIds
  playbackReplacedSinceDeviceChange = false
  if (playbackContext) schedulePlaybackCheck()
})

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

// Sets the master output volume (0..1) applied on top of the per-client mic
// and per-stream screen-audio volumes for every remote stream.
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
// on every volume drag frame, mute, and deafen. ~15ms is fast enough to feel
// instant and slow enough to be inaudible.
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

// Applies the per-stream ScreenShareAudio overrides and the per-client mic
// volume/mute overrides to every remote stream's gain node. An override volume
// above 1 boosts that client louder than their natural level. Every consumed
// screen-share audio is audible: consumers only exist for watched streams
// (watchIntent), so watching already decides what can be heard, and the level
// is the user's to set per stream. Deafen (soundMuted) covers mic audio only,
// as it always has.
export function applyAllAudioState() {
  clientAudioOverrides.ensure()
  streamAudioOverrides.ensure()
  for (const entry of getRemoteConsumers().values()) {
    if (entry.kind !== 'audio' || !entry.gain) continue

    let gain
    if (entry.producedType === 'ScreenShareAudio') {
      const override = streamAudioOverrides.get(entry.clientId)
      gain = override?.muted ? 0 : (override?.volume ?? 1) * masterVolume
    } else {
      const override = clientAudioOverrides.get(entry.clientId)
      const muted = soundMuted || !!override?.muted
      gain = muted ? 0 : (override?.volume ?? 1) * masterVolume
    }
    rampGainTo(entry.gain, gain)
  }
}

// A per-host override map persisted to localStorage under `storageKey` as
// { [host]: { [clientId]: { volume, muted } } }. The in-memory Map mirrors the
// currently-connected host's slice of that blob; ensure() reloads it whenever
// the connected host changes (connect, disconnect, or switching servers), so it
// never leaks one server's overrides onto another (user ids are only unique per
// server), then calls `onReload`. Every accessor ensures first.
function createAudioOverrideStore(storageKey, onReload) {
  let overrides = new Map()
  // Undefined (not null) until the first ensure(), so that one always loads.
  let loadedHost

  // Read the full persisted blob.
  function readPersisted() {
    try {
      return JSON.parse(localStorage.getItem(storageKey) || '{}') || {}
    } catch {
      return {}
    }
  }

  // Write the current host's in-memory overrides back to localStorage, pruning
  // no-op entries (100% volume, unmuted) so resetting a client truly forgets it
  // rather than leaving dead entries behind.
  function persist() {
    const host = getServerHost()
    if (!host) return
    const all = readPersisted()
    const slice = {}
    for (const [clientId, state] of overrides) {
      if (state.volume !== 1 || state.muted) slice[clientId] = state
    }
    if (Object.keys(slice).length) all[host] = slice
    else delete all[host]
    try {
      localStorage.setItem(storageKey, JSON.stringify(all))
    } catch {
      // localStorage is unavailable only in unusual renderer contexts; overrides
      // still work for this session, they just won't survive a restart.
    }
  }

  function ensure() {
    const host = getServerHost()
    if (host === loadedHost) return
    loadedHost = host
    overrides = new Map()
    if (host) {
      const slice = readPersisted()[host] || {}
      for (const [clientId, state] of Object.entries(slice)) {
        overrides.set(clientId, {
          volume: typeof state.volume === 'number' ? state.volume : 1,
          muted: !!state.muted
        })
      }
    }
    onReload?.()
  }

  return {
    ensure,
    get(clientId) {
      ensure()
      return overrides.get(clientId)
    },
    set(clientId, state) {
      ensure()
      overrides.set(clientId, state)
      persist()
    },
    entries() {
      ensure()
      return overrides.entries()
    }
  }
}

// Called by the sidebar's per-client right-click controls to locally
// lower the volume of, or fully mute, a specific client's mic audio. The new
// value is persisted per server so it survives app restarts.
export function setClientAudioState(clientId, { volume, muted } = {}) {
  const current = clientAudioOverrides.get(clientId) || DEFAULT_AUDIO_STATE
  clientAudioOverrides.set(clientId, {
    volume: volume != null ? volume : current.volume,
    muted: muted != null ? muted : current.muted
  })
  applyAllAudioState()
}

export function getClientAudioState(clientId) {
  return clientAudioOverrides.get(clientId) || { volume: 1, muted: false }
}

// Called by the stream view's per-stream controls (the bottom bar's volume and
// the right-click menu) to set one client's screen-share audio level. `volume`
// is a gain (1 = 100%, range 0..2); either field may be omitted to keep its
// current value. Persisted per server like the mic overrides.
export function setStreamAudioState(clientId, { volume, muted } = {}) {
  const current = streamAudioOverrides.get(clientId) || DEFAULT_AUDIO_STATE
  const next = {
    volume: volume != null ? Math.max(0, Math.min(2, volume)) : current.volume,
    muted: muted != null ? muted : current.muted
  }
  streamAudioOverrides.set(clientId, next)
  // Unmuting or raising a stream is the user asking to hear it now, so wake a
  // suspended playback context. (Building an audio graph resumes the context
  // too, via getPlaybackContext; this covers one that has suspended since.)
  const raised = muted === false || (volume != null && volume > 0)
  if (raised && !next.muted && next.volume > 0 && playbackContext?.state === 'suspended') {
    playbackContext.resume().catch(() => {})
  }
  applyAllAudioState()
  notifyStreamAudioListeners()
}

export function getStreamAudioState(clientId) {
  return { ...(streamAudioOverrides.get(clientId) || DEFAULT_AUDIO_STATE) }
}

// Plain-object snapshot of the current host's stream-audio overrides,
// { [clientId]: { volume, muted } }. A client without an entry is at the
// default (100%, unmuted).
export function getAllStreamAudioState() {
  const snapshot = {}
  for (const [clientId, state] of streamAudioOverrides.entries()) {
    snapshot[clientId] = { ...state }
  }
  return snapshot
}

// `cb()` runs after any stream-audio change and after the overrides reload for
// a new server host. Returns the unsubscribe function.
export function subscribeStreamAudio(cb) {
  streamAudioListeners.add(cb)
  return () => {
    streamAudioListeners.delete(cb)
  }
}

function notifyStreamAudioListeners() {
  for (const cb of streamAudioListeners) {
    try {
      cb()
    } catch (err) {
      console.error('[Soup] stream audio listener failed:', err)
    }
  }
}
