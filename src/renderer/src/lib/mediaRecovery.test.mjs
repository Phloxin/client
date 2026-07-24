import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detachRtpSender, recoverMicRepublish, runBeforeServerProduce } from './mediaRecovery.js'

function fakeTrack(id) {
  return {
    id,
    readyState: 'live',
    stopped: false,
    stop() {
      this.stopped = true
      this.readyState = 'ended'
    }
  }
}

function fakeStream(...tracks) {
  return { getTracks: () => tracks }
}

function fakeProducer(initialTrack, failedCalls = new Set()) {
  let replaceCalls = 0
  const producer = {
    track: initialTrack,
    closed: false,
    paused: false,
    replaceCalls: () => replaceCalls,
    async replaceTrack({ track }) {
      replaceCalls++
      if (failedCalls.has(replaceCalls)) throw new Error('replaceTrack fault')
      producer.track = track
    },
    pause() {
      producer.paused = true
    },
    resume() {
      producer.paused = false
    }
  }
  return producer
}

async function recover({ producer, oldStream, candidateStream = null, failedOperation = null }) {
  if (failedOperation) await assert.rejects(failedOperation)
  const restoredTrack = fakeTrack('restored')
  const restoredStream = fakeStream(restoredTrack)
  const candidateProcessorStop = () => {}
  const candidateTracks = candidateStream?.getTracks() ?? []
  const errors = []
  const committed = []

  const recovered = await recoverMicRepublish({
    audioProducers: [producer],
    micSettings: { deviceId: 'committed-device', useRnnoise: false },
    previousStop: () => {},
    candidateStream,
    candidateProcessedStream: candidateStream,
    candidateProcessorStop,
    onStream: null,
    isCurrent: () => true,
    rawMicStream: oldStream,
    acquireMicCapture: async (settings, previous) => {
      assert.equal(settings.deviceId, 'committed-device')
      assert.equal(previous, oldStream)
      return restoredStream
    },
    buildAudioProcessor: async (stream) => ({ stream, stop: () => {} }),
    stopRawStream: (stream) => stream?.getTracks().forEach((track) => track.stop()),
    stopCandidate: (stream, processedStream, processorStop) => {
      processorStop?.()
      for (const track of new Set([
        ...(stream?.getTracks() ?? []),
        ...(processedStream?.getTracks() ?? [])
      ])) {
        track.stop()
      }
    },
    micMuted: false,
    onPreviousStopped: () => {},
    onCommit: (state) => committed.push(state),
    onError: (phase, error) => errors.push({ phase, error })
  })

  return { recovered, restoredTrack, candidateTracks, committed, errors }
}

test('getUserMedia failure restores the committed microphone track', async () => {
  const oldTrack = fakeTrack('old')
  oldTrack.stop()
  const oldStream = fakeStream(oldTrack)
  const producer = fakeProducer(oldTrack)

  const result = await recover({
    producer,
    oldStream,
    failedOperation: async () => {
      throw new Error('getUserMedia fault')
    }
  })

  assert.equal(result.recovered, true)
  assert.equal(producer.track.id, 'restored')
  assert.equal(producer.track.readyState, 'live')
  assert.equal(result.committed.length, 1)
  assert.deepEqual(result.errors, [])
})

test('produce failure releases the candidate and restores the committed profile', async () => {
  const oldTrack = fakeTrack('old')
  oldTrack.stop()
  const oldStream = fakeStream(oldTrack)
  const candidateTrack = fakeTrack('candidate')
  const candidateStream = fakeStream(candidateTrack)
  const producer = fakeProducer(oldTrack)

  const result = await recover({
    producer,
    oldStream,
    candidateStream,
    failedOperation: async () => {
      throw new Error('produce fault')
    }
  })

  assert.equal(result.recovered, true)
  assert.equal(producer.track.id, 'restored')
  assert.equal(candidateTrack.readyState, 'ended')
  assert.equal(result.committed.length, 1)
})

test('replaceTrack failure is followed by a live-track rollback', async () => {
  const oldTrack = fakeTrack('old')
  oldTrack.stop()
  const oldStream = fakeStream(oldTrack)
  const producer = fakeProducer(oldTrack, new Set([1]))

  await assert.rejects(
    () => producer.replaceTrack({ track: fakeTrack('candidate') }),
    /replaceTrack fault/
  )
  const result = await recover({ producer, oldStream })

  assert.equal(result.recovered, true)
  assert.equal(producer.replaceCalls(), 2)
  assert.equal(producer.track.id, 'restored')
  assert.equal(result.errors.length, 0)
})

test('rejected RTP sender cleanup detaches the handler-created sender', async () => {
  const calls = []
  const sender = {
    async replaceTrack(track) {
      calls.push(track)
    }
  }

  assert.equal(await detachRtpSender(sender), true)
  assert.deepEqual(calls, [null])
})

test('strict sender preparation rejects before the server produce operation', async () => {
  let serverProduceCalls = 0
  const appData = {
    produced: 'ScreenShare',
    beforeServerProduce: async () => {
      throw new Error('setParameters fault')
    }
  }

  await assert.rejects(async () => {
    await runBeforeServerProduce(appData, { encodings: [{ scalabilityMode: 'L1T3' }] })
    serverProduceCalls++
  }, /setParameters fault/)

  assert.equal(serverProduceCalls, 0)
  assert.equal('beforeServerProduce' in appData, false)
  assert.equal(appData.produced, 'ScreenShare')
})

test('successful sender preparation runs once before server produce', async () => {
  const seen = []
  const rtpParameters = { encodings: [{ scalabilityMode: 'L1T2' }] }
  const appData = {
    produced: 'ScreenShare',
    beforeServerProduce: async (parameters) => seen.push(parameters)
  }

  assert.equal(await runBeforeServerProduce(appData, rtpParameters), true)
  assert.equal(await runBeforeServerProduce(appData, rtpParameters), false)
  assert.deepEqual(seen, [rtpParameters])
})
