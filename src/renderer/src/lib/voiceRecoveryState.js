// Browser-independent decisions used by the reconnect path.  Keeping these
// small lets the failure policy be tested without WebSocket/WebRTC globals.

export const AUDIO_CONSUME_RETRY_DELAYS_MS = [250, 750, 2000]
// Only failures the user has to resolve themselves. OverconstrainedError and
// NotFoundError mean the selected device isn't there right now, which for
// hot-pluggable audio hardware (USB/Bluetooth headsets, sleep/resume) is
// transient by definition, and they're raised at the exact moment a
// re-enumerating device is guaranteed to still be missing.
const PERMANENT_MIC_ERRORS = new Set(['NotAllowedError', 'SecurityError'])

export function nextAudioConsumeRetryDelay(attempt) {
  return AUDIO_CONSUME_RETRY_DELAYS_MS[attempt] ?? null
}

// Retrying these prompt-loops the user (permission dialogs) and cannot succeed
// without them acting, so the publish ladder stops on them.
export function isPermanentMicError(error) {
  return PERMANENT_MIC_ERRORS.has(error?.name)
}

// Reopening the microphone is the only way to discover that a vanished device
// came back, so the ladder never gives up while the user is still in the
// channel. It only stops growing. Every step re-checks membership, so leaving
// or switching cancels it.
export const MIC_PUBLISH_RETRY_DELAYS_MS = [750, 2000, 5000, 10_000, 20_000]

export function nextMicPublishRetryDelay(attempt) {
  const index = Number.isInteger(attempt) && attempt > 0 ? attempt : 0
  return MIC_PUBLISH_RETRY_DELAYS_MS[Math.min(index, MIC_PUBLISH_RETRY_DELAYS_MS.length - 1)]
}

// deviceId: {exact} is the only hard constraint the mic profile emits, so a
// selected device missing from the device list can only keep failing.
// Transmit on the default device instead. The persisted selection is
// deliberately left alone, so the ladder returns to it once it re-enumerates.
export function shouldFallBackToDefaultInput({
  errorName,
  selectedDeviceId,
  availableInputIds
} = {}) {
  if (errorName !== 'OverconstrainedError' && errorName !== 'NotFoundError') return false
  if (!selectedDeviceId || selectedDeviceId === 'default') return false
  if (availableInputIds == null) return false
  const ids = availableInputIds instanceof Set ? availableInputIds : new Set(availableInputIds)
  return !ids.has(selectedDeviceId)
}

// Voice recovery is hard-blocked on the events socket. The rejoin declaration
// that mints a ticket can't leave the client while it's down, so every
// attempt made during an events outage fails for a reason the voice backoff
// knows nothing about. Its 30s cap outlives the UI's rejoin timeout, so a
// restore that lands mid-backoff would otherwise be declared a failed recovery
// seconds before it was going to succeed.
export function shouldKickVoiceReconnect({
  everAuthenticated,
  intentionalClose,
  reconnectPending,
  reconnectInFlight,
  reconnectAttempts
} = {}) {
  if (!everAuthenticated || intentionalClose === true) return false
  // An attempt already running owns the next scheduling decision. Kicking now
  // would only race it onto a second ticket.
  if (reconnectInFlight === true) return false
  return reconnectPending === true || (reconnectAttempts ?? 0) > 0
}

export function allKnownAudioConsumersReady(knownProducerIds, activeConsumerIds) {
  const active = activeConsumerIds instanceof Set ? activeConsumerIds : new Set(activeConsumerIds)
  for (const producerId of knownProducerIds) {
    if (!active.has(producerId)) return false
  }
  return true
}

// SFU errors are externally tagged enums. Both variants are failures; treating a
// ServerError as a normal response lets callers commit transports/consumers with
// missing payloads and can leave a session permanently silent.
export function voiceRequestError(message) {
  const tagged =
    message?.UserError != null
      ? { name: 'VoiceUserError', value: message.UserError }
      : message?.ServerError != null
        ? { name: 'VoiceServerError', value: message.ServerError }
        : message?.type === 'UserError'
          ? { name: 'VoiceUserError', value: message.data }
          : message?.type === 'ServerError'
            ? { name: 'VoiceServerError', value: message.data }
            : null
  if (!tagged) return null

  const error = new Error(typeof tagged.value === 'string' ? tagged.value : 'Voice request failed')
  error.name = tagged.name
  return error
}

// ConsumerClosed is both a pushed SFU event ({ type, data: { id, ... } }) and
// the unit acknowledgement for CloseConsumer ({ type }). Only the former is an
// event; the latter must continue through the FIFO response queue.
export function isConsumerClosedEvent(message) {
  return message?.type === 'ConsumerClosed' && message?.data?.id != null
}

// WebSocket readyState values are standardized as CONNECTING=0, OPEN=1,
// CLOSING=2, CLOSED=3. A socket remains the owner of media teardown until its
// close callback runs, even after readyState reaches CLOSED.
export function voiceSocketRecoveryAction(readyState) {
  if (readyState == null) return 'retry'
  if (readyState === 0 || readyState === 1) return 'close'
  return 'wait-for-close'
}

// Decides whether a 'reconnecting' report is from a rebuild we asked for
// (switching channels, or a moderator moving us) or a real outage. Rebuilds we
// asked for happen over a healthy connection and should never show as a
// dropped connection.
//
// The kind stays the same for the whole rebuild, since one rebuild reports
// itself more than once as the socket closes and reopens. If an outage
// recovery is already in progress, that always wins, since the connection is
// genuinely down in that case.
export function nextVoiceRebuildKind(
  currentKind,
  { expected = false, outageRecovery = false } = {}
) {
  if (outageRecovery) return 'outage'
  if (expected || currentKind === 'intentional') return 'intentional'
  return 'outage'
}

// Decides what cue, if any, our own channel_id change deserves:
// 'channel_switched', 'you_kicked_channel', or null for no sound.
//
// While a rebuild is happening, our channel briefly reports as empty and then
// gets set back, which is not a real kick or switch and should stay silent.
// Only an actual channel switch the user asked for should play its cue. An
// outage rebuild stays silent here since its own "back online" cue is played
// elsewhere.
export function selfChannelChime({
  oldChannelId,
  newChannelId,
  awaitingRejoin,
  rebuildKind,
  selfDeclaredChannel
}) {
  if (oldChannelId === newChannelId) return null
  if (awaitingRejoin == null) {
    if (newChannelId != null) return 'channel_switched'
    // A voluntary leave declares channel_id null first, so selfDeclaredChannel
    // is already null there and this stays silent.
    return selfDeclaredChannel != null ? 'you_kicked_channel' : null
  }
  if (rebuildKind === 'intentional' && oldChannelId != null && newChannelId != null) {
    return 'channel_switched'
  }
  return null
}

export function isVoiceRecoveryReady({
  awaitingChannelId,
  channelId,
  mediaState,
  mediaUpdateId,
  minimumMediaUpdateId
}) {
  return (
    awaitingChannelId != null &&
    awaitingChannelId === channelId &&
    mediaState === 'ready' &&
    (minimumMediaUpdateId == null || mediaUpdateId > minimumMediaUpdateId)
  )
}
