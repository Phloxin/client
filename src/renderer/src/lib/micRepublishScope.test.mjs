import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  REPUBLISH_SCOPE,
  classifyMicSettingsChange,
  micCaptureKey,
  micGraphKey
} from './micRepublishScope.js'

// Mirrors DEFAULT_SETTINGS in SettingsContext.jsx — every key the classifier can
// see, so "no tier reacts to this key" is a real assertion and not an omission.
const BASE = {
  echoCancellation: false,
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: 48000,
  channelCount: 1,
  bitrate: 128000,
  deviceId: 'default',
  useVolumeGate: false,
  volumeGateThreshold: 15,
  useRnnoise: true,
  hifiVoice: false,
  outputDeviceId: 'default',
  outputVolume: 100,
  settingsVersion: 3
}

const change = (patch) => classifyMicSettingsChange(BASE, { ...BASE, ...patch })

test('an unchanged settings object needs no republish at all', () => {
  assert.equal(change({}), REPUBLISH_SCOPE.NONE)
  assert.equal(classifyMicSettingsChange(BASE, { ...BASE }), REPUBLISH_SCOPE.NONE)
})

test('playback-only keys never touch the capture', () => {
  assert.equal(change({ outputVolume: 40 }), REPUBLISH_SCOPE.NONE)
  assert.equal(change({ outputDeviceId: 'speakers-2' }), REPUBLISH_SCOPE.NONE)
  // Non-capture bookkeeping the settings object happens to carry.
  assert.equal(change({ settingsVersion: 99 }), REPUBLISH_SCOPE.NONE)
  assert.equal(change({ bitrate: 64000 }), REPUBLISH_SCOPE.NONE)
})

test('capture keys take the full path', () => {
  assert.equal(change({ deviceId: 'usb-mic' }), REPUBLISH_SCOPE.FULL)
  assert.equal(change({ echoCancellation: true }), REPUBLISH_SCOPE.FULL)
  assert.equal(change({ autoGainControl: true }), REPUBLISH_SCOPE.FULL)
  assert.equal(change({ sampleRate: 44100 }), REPUBLISH_SCOPE.FULL)
  assert.equal(change({ channelCount: 2 }), REPUBLISH_SCOPE.FULL)
})

test('the hi-fi profile always takes the full path', () => {
  assert.equal(change({ hifiVoice: true }), REPUBLISH_SCOPE.FULL)
  assert.equal(classifyMicSettingsChange({ ...BASE, hifiVoice: true }, BASE), REPUBLISH_SCOPE.FULL)
})

test('graph-only toggles rebuild the graph on the existing capture', () => {
  assert.equal(change({ useVolumeGate: true }), REPUBLISH_SCOPE.GRAPH)
})

test('turning RNNoise off re-enables the browser suppressor, so it is a capture change', () => {
  // micConstraints suppresses noiseSuppression while RNNoise is on; turning
  // RNNoise off with the browser suppressor enabled changes what gUM must open.
  const withBrowserNs = { ...BASE, noiseSuppression: true }
  assert.equal(
    classifyMicSettingsChange(withBrowserNs, { ...withBrowserNs, useRnnoise: false }),
    REPUBLISH_SCOPE.FULL
  )
})

test('an RNNoise toggle that leaves the constraints alone is graph-only', () => {
  // With the browser suppressor off, dropping RNNoise changes only the graph.
  assert.equal(change({ useRnnoise: false }), REPUBLISH_SCOPE.GRAPH)
})

test('threshold-only changes need no republish of any kind', () => {
  const gated = { ...BASE, useVolumeGate: true }
  assert.equal(
    classifyMicSettingsChange(gated, { ...gated, volumeGateThreshold: 42 }),
    REPUBLISH_SCOPE.THRESHOLD
  )
  // Reported with the gate off too — applying it is just module state.
  assert.equal(change({ volumeGateThreshold: 42 }), REPUBLISH_SCOPE.THRESHOLD)
})

test('a capture change outranks the graph and threshold changes riding with it', () => {
  assert.equal(
    change({ deviceId: 'usb-mic', useVolumeGate: true, volumeGateThreshold: 60 }),
    REPUBLISH_SCOPE.FULL
  )
  assert.equal(change({ useVolumeGate: true, volumeGateThreshold: 60 }), REPUBLISH_SCOPE.GRAPH)
})

test('an unknown baseline is always full', () => {
  assert.equal(classifyMicSettingsChange(null, BASE), REPUBLISH_SCOPE.FULL)
  assert.equal(classifyMicSettingsChange(undefined, BASE), REPUBLISH_SCOPE.FULL)
})

test('hi-fi drops the browser DSP and captures stereo', () => {
  const hifi = { ...BASE, hifiVoice: true, echoCancellation: true, noiseSuppression: true }
  const constraints = JSON.parse(micCaptureKey(hifi))

  assert.equal(constraints.channelCount, 2)
  assert.equal(constraints.echoCancellation, false)
  assert.equal(constraints.noiseSuppression, false)
  assert.equal(constraints.autoGainControl, false)
  // The mono speech denoiser cannot preserve a stereo image, so hi-fi skips it
  // regardless of the user's toggle.
  assert.equal(JSON.parse(micGraphKey(hifi)).useRnnoise, false)
  assert.equal(JSON.parse(micGraphKey(BASE)).useRnnoise, true)
})
