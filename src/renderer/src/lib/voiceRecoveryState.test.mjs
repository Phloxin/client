import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allKnownAudioConsumersReady,
  isConsumerClosedEvent,
  isPermanentMicError,
  isVoiceRecoveryReady,
  nextAudioConsumeRetryDelay,
  voiceRequestError,
  voiceSocketRecoveryAction
} from './voiceRecoveryState.js'

test('audio consume retries are bounded', () => {
  assert.deepEqual([0, 1, 2, 3].map(nextAudioConsumeRetryDelay), [250, 750, 2000, null])
})

test('only device/permission mic failures are permanent', () => {
  assert.equal(isPermanentMicError({ name: 'NotAllowedError' }), true)
  assert.equal(isPermanentMicError({ name: 'SecurityError' }), true)
  assert.equal(isPermanentMicError({ name: 'OverconstrainedError' }), true)
  assert.equal(isPermanentMicError({ name: 'NotFoundError' }), true)
  assert.equal(isPermanentMicError({ name: 'AbortError' }), false)
  assert.equal(isPermanentMicError(new Error('network')), false)
})

test('media readiness requires a consumer for every known remote microphone', () => {
  assert.equal(allKnownAudioConsumersReady([], []), true)
  assert.equal(allKnownAudioConsumersReady(['mic-a'], []), false)
  assert.equal(allKnownAudioConsumersReady(['mic-a'], ['mic-a']), true)
  assert.equal(allKnownAudioConsumersReady(['mic-a', 'mic-b'], ['mic-a', 'screen-c']), false)
})

test('recovery needs matching membership and ready media', () => {
  assert.equal(
    isVoiceRecoveryReady({
      awaitingChannelId: 'a',
      channelId: 'a',
      mediaState: 'ready',
      mediaUpdateId: 4,
      minimumMediaUpdateId: 3
    }),
    true
  )
  assert.equal(
    isVoiceRecoveryReady({ awaitingChannelId: 'a', channelId: 'a', mediaState: 'authenticated' }),
    false
  )
  assert.equal(
    isVoiceRecoveryReady({ awaitingChannelId: 'a', channelId: 'b', mediaState: 'ready' }),
    false
  )
  assert.equal(
    isVoiceRecoveryReady({
      awaitingChannelId: 'a',
      channelId: 'a',
      mediaState: 'ready',
      mediaUpdateId: 3,
      minimumMediaUpdateId: 3
    }),
    false
  )
})

test('both SFU error variants reject request success', () => {
  assert.equal(voiceRequestError({ type: 'ResumeConsumer' }), null)
  const userError = voiceRequestError({ UserError: 'bad request' })
  assert.equal(userError.name, 'VoiceUserError')
  assert.equal(userError.message, 'bad request')
  const serverError = voiceRequestError({ ServerError: 'worker failed' })
  assert.equal(serverError.name, 'VoiceServerError')
  assert.equal(serverError.message, 'worker failed')
})

test('ConsumerClosed acknowledgement is not mistaken for a pushed event', () => {
  assert.equal(isConsumerClosedEvent({ type: 'ConsumerClosed' }), false)
  assert.equal(isConsumerClosedEvent({ type: 'ConsumerClosed', data: { id: 'consumer-a' } }), true)
})

test('a closing socket must finish teardown before a replacement starts', () => {
  assert.equal(voiceSocketRecoveryAction(0), 'close')
  assert.equal(voiceSocketRecoveryAction(1), 'close')
  assert.equal(voiceSocketRecoveryAction(2), 'wait-for-close')
  assert.equal(voiceSocketRecoveryAction(3), 'wait-for-close')
  assert.equal(voiceSocketRecoveryAction(null), 'retry')
})
