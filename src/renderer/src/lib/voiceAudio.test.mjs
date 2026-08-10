import assert from 'node:assert/strict'
import test from 'node:test'

import { createMonoVoiceGraph, createVoiceGraph } from './voiceAudio.js'
import {
  buildMicOpusOptions,
  micAudioProfileKey,
  micProfileAllowsVoiceDsp,
  micProfileWantsStereo,
  micSettingsForPublishedStream
} from './micAudioProfile.js'

function fakeNode(name) {
  return {
    name,
    connections: [],
    connect(target) {
      this.connections.push(target)
    }
  }
}

function fakeStream(channelCount) {
  return {
    getAudioTracks: () => [
      {
        getSettings: () => ({ channelCount })
      }
    ]
  }
}

test('voice graph folds stereo capture to mono before downstream processing', () => {
  const source = fakeNode('source')
  const input = fakeNode('input')
  const destination = fakeNode('destination')
  const stream = fakeStream(2)
  const audioContext = {
    createMediaStreamSource(receivedStream) {
      assert.equal(receivedStream, stream)
      return source
    },
    createGain: () => input,
    createMediaStreamDestination: () => destination
  }

  const graph = createMonoVoiceGraph(audioContext, stream)

  assert.deepEqual(graph, { source, input, destination })
  assert.deepEqual(source.connections, [input], 'raw stereo must feed the mono fold first')
  assert.equal(input.channelCount, 1)
  assert.equal(input.channelCountMode, 'explicit')
  assert.equal(input.channelInterpretation, 'speakers')
  assert.equal(destination.channelCount, 1)
  assert.equal(destination.channelCountMode, 'explicit')
})

test('voice codec profile follows the published mono track, not stereo capture', () => {
  const rawCapture = fakeStream(2)
  const publishedVoice = fakeStream(1)
  const micSettings = { channelCount: 2, hifiVoice: false }

  // Establish the regression fixture: resolving the raw device would request
  // stereo Opus, while the actual published voice stream is mono.
  const rawOptions = buildMicOpusOptions(micSettingsForPublishedStream(micSettings, rawCapture))
  assert.equal(rawOptions.codecOptions.opusStereo, true)

  const publishedSettings = micSettingsForPublishedStream(micSettings, publishedVoice)
  const publishedOptions = buildMicOpusOptions(publishedSettings)

  assert.equal(publishedSettings.resolvedChannelCount, 1)
  assert.equal(publishedOptions.codecOptions.opusStereo, false)
  assert.equal(micAudioProfileKey(publishedSettings, publishedOptions), 'speech:false')
})

test('missing track settings fall back to the configured mono voice layout', () => {
  const publishedVoice = {
    getAudioTracks: () => [{ getSettings: () => ({}) }]
  }
  const settings = micSettingsForPublishedStream({ channelCount: 1 }, publishedVoice)

  assert.equal(settings.resolvedChannelCount, 1)
  assert.equal(buildMicOpusOptions(settings).codecOptions.opusStereo, false)
})

test('hi-fi voice publishes TeamSpeak "Opus Music" parameters', () => {
  const publishedVoice = fakeStream(2)
  const settings = micSettingsForPublishedStream(
    { channelCount: 1, hifiVoice: true },
    publishedVoice
  )
  const options = buildMicOpusOptions(settings)

  assert.deepEqual(options.encodings, [{ maxBitrate: 128_000 }])
  assert.equal(options.codecOptions.opusMaxAverageBitrate, 128_000)
  assert.equal(options.codecOptions.opusMaxPlaybackRate, 48_000)
  // Stereo is what makes libwebrtc select OPUS_APPLICATION_AUDIO.
  assert.equal(options.codecOptions.opusStereo, true)
  assert.equal(options.codecOptions.opusDtx, false)
  assert.equal(micAudioProfileKey(settings, options), 'hifi:true')
})

test('hi-fi voice asserts stereo even when the track reports no channel count', () => {
  const publishedVoice = { getAudioTracks: () => [{ getSettings: () => ({}) }] }
  const settings = micSettingsForPublishedStream(
    { channelCount: 1, hifiVoice: true },
    publishedVoice
  )

  assert.equal(settings.resolvedChannelCount, 2)
  assert.equal(buildMicOpusOptions(settings).codecOptions.opusStereo, true)
})

test('hi-fi voice drives stereo capture and disables the speech-tuned DSP', () => {
  assert.equal(micProfileWantsStereo({ hifiVoice: true }), true)
  assert.equal(micProfileAllowsVoiceDsp({ hifiVoice: true }), false)
})

test('the speech profile is unchanged and is what absent/false settings select', () => {
  for (const micSettings of [undefined, {}, { hifiVoice: false }]) {
    assert.equal(micProfileWantsStereo(micSettings), false)
    assert.equal(micProfileAllowsVoiceDsp(micSettings), true)

    const options = buildMicOpusOptions(micSettings)
    assert.deepEqual(options, {
      encodings: [{ maxBitrate: 96_000 }],
      codecOptions: {
        opusStereo: false,
        opusMaxPlaybackRate: 48_000,
        opusMaxAverageBitrate: 96_000,
        opusDtx: true,
        opusPtime: 20,
        opusFec: true,
        opusNack: true
      }
    })
    assert.equal(micAudioProfileKey(micSettings, options), 'speech:false')
  }
})

test('the stereo voice graph keeps both channels through to the published track', () => {
  const source = fakeNode('source')
  const input = fakeNode('input')
  const destination = fakeNode('destination')
  const stream = fakeStream(2)
  const audioContext = {
    createMediaStreamSource: () => source,
    createGain: () => input,
    createMediaStreamDestination: () => destination
  }

  const graph = createVoiceGraph(audioContext, stream, { stereo: true })

  assert.deepEqual(graph, { source, input, destination })
  assert.deepEqual(source.connections, [input])
  assert.equal(input.channelCount, 2)
  assert.equal(input.channelCountMode, 'explicit')
  assert.equal(input.channelInterpretation, 'speakers')
  assert.equal(destination.channelCount, 2)
  assert.equal(destination.channelCountMode, 'explicit')
})

test('createMonoVoiceGraph and the default stereo option stay mono', () => {
  const build = (factory) => {
    const source = fakeNode('source')
    const input = fakeNode('input')
    const destination = fakeNode('destination')
    factory({
      createMediaStreamSource: () => source,
      createGain: () => input,
      createMediaStreamDestination: () => destination
    })
    return { input, destination }
  }

  for (const factory of [
    (ctx) => createMonoVoiceGraph(ctx, fakeStream(2)),
    (ctx) => createVoiceGraph(ctx, fakeStream(2))
  ]) {
    const { input, destination } = build(factory)
    assert.equal(input.channelCount, 1)
    assert.equal(destination.channelCount, 1)
  }
})
