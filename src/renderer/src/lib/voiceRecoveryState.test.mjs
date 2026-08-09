import assert from 'node:assert/strict'
import test from 'node:test'
import {
  allKnownAudioConsumersReady,
  isPermanentMicError,
  isVoiceRecoveryReady,
  nextAudioConsumeRetryDelay
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
    isVoiceRecoveryReady({ awaitingChannelId: 'a', channelId: 'a', mediaState: 'ready' }),
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
})
