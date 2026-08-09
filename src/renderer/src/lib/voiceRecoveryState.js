// Browser-independent decisions used by the reconnect path.  Keeping these
// small lets the failure policy be tested without WebSocket/WebRTC globals.

export const AUDIO_CONSUME_RETRY_DELAYS_MS = [250, 750, 2000]
const PERMANENT_MIC_ERRORS = new Set([
  'NotAllowedError',
  'SecurityError',
  'OverconstrainedError',
  'NotFoundError'
])

export function nextAudioConsumeRetryDelay(attempt) {
  return AUDIO_CONSUME_RETRY_DELAYS_MS[attempt] ?? null
}

// These errors need user action (permission, a vanished device, or impossible
// constraints); retrying them on every reconnect only creates a noisy loop.
export function isPermanentMicError(error) {
  return PERMANENT_MIC_ERRORS.has(error?.name)
}

export function allKnownAudioConsumersReady(knownProducerIds, activeConsumerIds) {
  const active = activeConsumerIds instanceof Set ? activeConsumerIds : new Set(activeConsumerIds)
  for (const producerId of knownProducerIds) {
    if (!active.has(producerId)) return false
  }
  return true
}

export function isVoiceRecoveryReady({ awaitingChannelId, channelId, mediaState }) {
  return awaitingChannelId != null && awaitingChannelId === channelId && mediaState === 'ready'
}
