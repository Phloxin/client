import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MIC_PUBLISH_RETRY_DELAYS_MS,
  allKnownAudioConsumersReady,
  isConsumerClosedEvent,
  isPermanentMicError,
  isVoiceRecoveryReady,
  nextAudioConsumeRetryDelay,
  nextMicPublishRetryDelay,
  nextVoiceRebuildKind,
  selfChannelChime,
  shouldFallBackToDefaultInput,
  shouldKickVoiceReconnect,
  voiceRequestError,
  voiceSocketRecoveryAction
} from './voiceRecoveryState.js'

test('audio consume retries are bounded', () => {
  assert.deepEqual([0, 1, 2, 3].map(nextAudioConsumeRetryDelay), [250, 750, 2000, null])
})

test('only mic failures needing user action are permanent', () => {
  assert.equal(isPermanentMicError({ name: 'NotAllowedError' }), true)
  assert.equal(isPermanentMicError({ name: 'SecurityError' }), true)
  // A device that is merely absent comes back on its own. Classifying it as
  // permanent is what left the logged incident silent for the whole session.
  assert.equal(isPermanentMicError({ name: 'OverconstrainedError' }), false)
  assert.equal(isPermanentMicError({ name: 'NotFoundError' }), false)
  assert.equal(isPermanentMicError({ name: 'AbortError' }), false)
  assert.equal(isPermanentMicError(new Error('network')), false)
})

test('the mic publish ladder grows and then holds', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(nextMicPublishRetryDelay), MIC_PUBLISH_RETRY_DELAYS_MS)
  // Held, not exhausted: only leaving the channel stops the ladder, because a
  // re-plugged device is invisible until getUserMedia is tried again.
  const held = MIC_PUBLISH_RETRY_DELAYS_MS[MIC_PUBLISH_RETRY_DELAYS_MS.length - 1]
  assert.equal(nextMicPublishRetryDelay(5), held)
  assert.equal(nextMicPublishRetryDelay(50), held)
  assert.equal(nextMicPublishRetryDelay(-1), MIC_PUBLISH_RETRY_DELAYS_MS[0])
})

test('the default input is only used once the selected one is really gone', () => {
  const gone = {
    errorName: 'OverconstrainedError',
    selectedDeviceId: 'headset',
    availableInputIds: ['builtin']
  }
  assert.equal(shouldFallBackToDefaultInput(gone), true)
  assert.equal(shouldFallBackToDefaultInput({ ...gone, errorName: 'NotFoundError' }), true)
  // Still enumerated: the failure is something else, and falling back would
  // move the user off the device they chose for no reason.
  assert.equal(
    shouldFallBackToDefaultInput({ ...gone, availableInputIds: ['builtin', 'headset'] }),
    false
  )
  assert.equal(shouldFallBackToDefaultInput({ ...gone, errorName: 'NotReadableError' }), false)
  assert.equal(shouldFallBackToDefaultInput({ ...gone, selectedDeviceId: 'default' }), false)
  // enumerateDevices() itself failed, so absence is unproven.
  assert.equal(shouldFallBackToDefaultInput({ ...gone, availableInputIds: null }), false)
})

test('an events restore only kicks a voice reconnect that is actually stalled', () => {
  const live = { everAuthenticated: true, intentionalClose: false }
  assert.equal(shouldKickVoiceReconnect({ ...live, reconnectPending: true }), true)
  assert.equal(shouldKickVoiceReconnect({ ...live, reconnectAttempts: 3 }), true)
  // Healthy session: nothing is waiting on the events socket.
  assert.equal(shouldKickVoiceReconnect({ ...live, reconnectAttempts: 0 }), false)
  assert.equal(
    shouldKickVoiceReconnect({ ...live, reconnectPending: true, reconnectInFlight: true }),
    false
  )
  assert.equal(
    shouldKickVoiceReconnect({ ...live, intentionalClose: true, reconnectPending: true }),
    false
  )
  assert.equal(
    shouldKickVoiceReconnect({ everAuthenticated: false, reconnectPending: true }),
    false
  )
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

test('a rebuild we asked for is not an outage', () => {
  // A channel switch is flagged expected right away, and stays intentional
  // when the socket close reports the same rebuild again unflagged.
  const claimed = nextVoiceRebuildKind(null, { expected: true })
  assert.equal(claimed, 'intentional')
  assert.equal(nextVoiceRebuildKind(claimed, {}), 'intentional')

  // A moderator move can have its reset arrive before the announcement, so
  // the first report comes in unflagged and gets marked intentional after.
  const raced = nextVoiceRebuildKind(null, {})
  assert.equal(raced, 'outage')
  assert.equal(nextVoiceRebuildKind(raced, { expected: true }), 'intentional')
})

test('a live outage recovery outranks any local claim', () => {
  assert.equal(nextVoiceRebuildKind(null, { outageRecovery: true }), 'outage')
  assert.equal(
    nextVoiceRebuildKind('intentional', { expected: true, outageRecovery: true }),
    'outage'
  )
})

test('self channel chimes with no rebuild pending', () => {
  const idle = { awaitingRejoin: null, rebuildKind: null }
  assert.equal(
    selfChannelChime({ ...idle, oldChannelId: null, newChannelId: 'a', selfDeclaredChannel: 'a' }),
    'channel_switched'
  )
  assert.equal(
    selfChannelChime({ ...idle, oldChannelId: 'a', newChannelId: 'b', selfDeclaredChannel: 'b' }),
    'channel_switched'
  )
  // Dropped out of voice without ever declaring it, which reads as a kick.
  assert.equal(
    selfChannelChime({ ...idle, oldChannelId: 'a', newChannelId: null, selfDeclaredChannel: 'a' }),
    'you_kicked_channel'
  )
  // A voluntary leave declared null first.
  assert.equal(
    selfChannelChime({ ...idle, oldChannelId: 'a', newChannelId: null, selfDeclaredChannel: null }),
    null
  )
  // A mute/deafen re-asserts the same channel.
  assert.equal(
    selfChannelChime({ ...idle, oldChannelId: 'a', newChannelId: 'a', selfDeclaredChannel: 'a' }),
    null
  )
})

test('an intentional rebuild chimes only for the move itself', () => {
  const moving = { awaitingRejoin: 'b', rebuildKind: 'intentional' }
  assert.equal(
    selfChannelChime({ ...moving, oldChannelId: 'a', newChannelId: 'b', selfDeclaredChannel: 'b' }),
    'channel_switched'
  )
  // The server drops us from voice while the old socket closes. This looks
  // exactly like a kick and must stay silent.
  assert.equal(
    selfChannelChime({
      ...moving,
      oldChannelId: 'b',
      newChannelId: null,
      selfDeclaredChannel: 'b'
    }),
    null
  )
  // The rebuild's re-assert puts us back, but the move already chimed.
  assert.equal(
    selfChannelChime({
      ...moving,
      oldChannelId: null,
      newChannelId: 'b',
      selfDeclaredChannel: 'b'
    }),
    null
  )
})

test('an outage rebuild leaves every channel change silent', () => {
  const outage = { awaitingRejoin: 'a', rebuildKind: 'outage' }
  assert.equal(
    selfChannelChime({
      ...outage,
      oldChannelId: 'a',
      newChannelId: null,
      selfDeclaredChannel: 'a'
    }),
    null
  )
  assert.equal(
    selfChannelChime({
      ...outage,
      oldChannelId: null,
      newChannelId: 'a',
      selfDeclaredChannel: 'a'
    }),
    null
  )
  assert.equal(
    selfChannelChime({ ...outage, oldChannelId: 'a', newChannelId: 'b', selfDeclaredChannel: 'a' }),
    null
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
