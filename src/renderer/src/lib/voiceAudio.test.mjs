import assert from 'node:assert/strict'
import test from 'node:test'

import { createMonoVoiceGraph } from './voiceAudio.js'
import {
  buildMicOpusOptions,
  micAudioProfileKey,
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
