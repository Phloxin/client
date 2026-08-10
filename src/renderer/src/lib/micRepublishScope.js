// How much of the microphone pipeline a settings change actually has to rebuild.
//
// Every Apply used to run the full transactional republish: release the OS
// capture, wait out the source teardown, re-open getUserMedia, rebuild the
// processing graph, replace the track. That is an audible gap in outgoing audio,
// and most changes don't need any of it — output volume and output device don't
// touch capture at all, and a gate/RNNoise toggle only needs a new graph on the
// capture we already hold.
//
// Browser-independent so the classification is unit-testable; soup.js owns what
// each tier does.
// Extension-qualified so node:test can load this module directly (the bundler
// resolves either form).
import { micConstraints, micProfileUsesRnnoise, micProfileWantsStereo } from './micAudioProfile.js'

export const REPUBLISH_SCOPE = {
  // Nothing that affects capture or encoding changed (playback-only keys, or a
  // no-op Apply).
  NONE: 'none',
  // Only the volume-gate threshold moved; the live gate reads it per tick.
  THRESHOLD: 'threshold',
  // The processing graph differs but the capture behind it doesn't: rebuild the
  // graph on the existing raw stream and replaceTrack.
  GRAPH: 'graph',
  // The capture itself (device, browser DSP, channel layout) or the Opus profile
  // differs: full release/re-acquire/produce path.
  FULL: 'full'
}

// The capture identity of these settings. Equal keys mean one open capture can
// serve both — which is the whole precondition for the graph-only tier.
export function micCaptureKey(micSettings) {
  return JSON.stringify(micConstraints(micSettings))
}

// The processing-graph identity: what buildAudioProcessor would actually wire up.
// RNNoise is the *effective* value (a stereo profile skips the mono denoiser),
// so a toggle that changes nothing observable doesn't force a rebuild.
export function micGraphKey(micSettings) {
  return JSON.stringify({
    useRnnoise: micProfileUsesRnnoise(micSettings),
    useVolumeGate: micSettings?.useVolumeGate === true,
    stereo: micProfileWantsStereo(micSettings)
  })
}

// Classify previous → next. Ordered most- to least-expensive, and deliberately
// conservative: an unknown baseline (`previous == null`) or anything touching
// capture takes the full path, because over-rebuilding costs a gap while
// under-rebuilding silently ignores what the user just asked for.
export function classifyMicSettingsChange(previous, next) {
  if (!previous || !next) return REPUBLISH_SCOPE.FULL

  // hifi already shows up in the capture key (it flips channelCount and the
  // browser DSP), but compare it explicitly so a future profile that changes
  // only Opus options still gets the producer-replacing path it needs.
  if (previous.hifiVoice !== next.hifiVoice) return REPUBLISH_SCOPE.FULL
  if (micCaptureKey(previous) !== micCaptureKey(next)) return REPUBLISH_SCOPE.FULL
  if (micGraphKey(previous) !== micGraphKey(next)) return REPUBLISH_SCOPE.GRAPH
  // Reported even when the gate is off: the live threshold is module state that
  // should track the setting either way, and applying it is free.
  if (Number(previous.volumeGateThreshold) !== Number(next.volumeGateThreshold)) {
    return REPUBLISH_SCOPE.THRESHOLD
  }
  return REPUBLISH_SCOPE.NONE
}
