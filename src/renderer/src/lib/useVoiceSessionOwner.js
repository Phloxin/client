import { useState, useEffect, useLayoutEffect, useRef, useMemo } from 'react'
import {
  connect,
  publish,
  republish,
  disconnect,
  shareScreen,
  shareCamera,
  setSharePaused,
  stopScreenShare,
  requestVoiceMediaRecovery,
  setVolumeGateThreshold,
  setVoiceSelf
} from './soup'
import { setE2eeSelf } from './e2ee'
import { REPUBLISH_SCOPE, classifyMicSettingsChange } from './micRepublishScope'
import {
  isPermanentMicError,
  nextMicPublishRetryDelay,
  shouldFallBackToDefaultInput
} from './voiceRecoveryState'
import { audioDeviceIds, subscribeDeviceChange } from './mediaDevices'
import { useSettings } from '../context/SettingsContext'
import { getScreenAudioCapabilities } from './screenAudio'
import { audioOptionsFor } from './captureOptions'
import { dmDisplayName } from './dm'

// Chromium's OverconstrainedError has an empty message, so err.message alone
// would render a blank banner. Each error name gets its own remedy text.
function micErrorMessage(err) {
  switch (err?.name) {
    case 'OverconstrainedError':
    case 'NotFoundError':
      return 'Your selected microphone is unavailable. Choose another in Settings → Audio.'
    case 'NotAllowedError':
      return 'Microphone access is blocked. Allow it in your system privacy settings.'
    case 'SecurityError':
      return 'Microphone access is blocked by a security policy.'
    case 'NotReadableError':
      return 'Your microphone is in use by another application.'
    default:
      return err?.message || err?.name || 'The microphone could not be started.'
  }
}

const MIC_FALLBACK_MESSAGE =
  'Your selected microphone is unavailable. Using the default input device until it returns.'

// Why a share ended without the user stopping it (soup's onShareEnded reason).
function shareEndedMessage(reason) {
  switch (reason) {
    case 'frames-stalled':
      return 'Stream ended because the shared window stopped sending frames'
    // The backend ended the stream, or the voice server lost its link to it.
    case 'server-closed':
      return 'Stream ended by the server'
    default:
      return 'Stream ended because the shared window closed'
  }
}

// Channel error banners are informational, not actionable state - the condition
// they describe is already reflected in the mic/share controls. Leaving one
// pinned forever just shrinks the user list for the rest of the session.
const ERROR_DISMISS_MS = 10_000

// Voice cleanup and the authoritative ClientModified(null) travel over separate
// sockets, so the roster update can win by a task or two. Give soup's onclose a
// bounded chance to classify the loss before converting it to an intentional
// leave (which would cancel recovery).
const VOICE_NULL_RECONCILE_GRACE_MS = 3000

// The live voice session for any channel id, owned once by Main (VoiceSessionContext).
export function useVoiceSessionOwner({
  selfId,
  clients,
  channels,
  declareChannel,
  isReconnectRecovering,
  recoveryEpoch,
  onMediaState,
  onError
}) {
  // The channel the session belongs to, or null when not in voice.
  const [channelId, setChannelId] = useState(null)
  // A switch target whose declaration the roster hasn't confirmed yet.
  const [pendingChannelId, setPendingChannelId] = useState(null)
  const [joined, setJoined] = useState(false)
  const [error, setErrorMessage] = useState(null)
  // The session's channel when the error was raised; the banner stays there
  // after the session has left it.
  const [errorChannelId, setErrorChannelId] = useState(null)
  // Auto-dismiss. A later failure with a different message restarts the timer;
  // an identical one is a React no-op, so the original countdown stands.
  useEffect(() => {
    if (!error) return undefined
    const timer = setTimeout(() => setErrorMessage(null), ERROR_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [error])
  const [sharing, setSharing] = useState(false)
  const [sourcePickerOpen, setSourcePickerOpen] = useState(false)
  const [videoStreams, setVideoStreams] = useState([])
  const [speakingClients, setSpeakingClients] = useState({})
  // Our own speaking state, for the system-tray mic indicator.
  const [selfSpeaking, setSelfSpeaking] = useState(false)
  const { micSettings } = useSettings()

  const joinedRef = useRef(false)
  // Owner-bound handle for the local screen/camera capture. Track-ended events
  // can arrive after a successor share starts, so they must never call the
  // singleton/global stop path or clear the successor's tile.
  const activeShareRef = useRef(null)
  // What the live share was started with, so the stream view's quick menu can
  // restart it with one option changed; lastAudioRef remembers the audio setup
  // to restore when that menu toggles audio back on.
  const lastShareRef = useRef(null)
  const lastAudioRef = useRef(null)
  // Latest mic settings, read by the (re)publish path so a background reconnect
  // re-publishes with current settings rather than those captured at join time.
  const micSettingsRef = useRef(micSettings)
  // The settings the live capture/graph was last built from, and the baseline the
  // republish classifier diffs against. Null means "unknown" — the next change
  // takes the full path, which is always safe.
  const lastAppliedMicSettingsRef = useRef(null)
  // Bumped by every publish sequence, so a ladder waking from its retry delay
  // doesn't resume against a session a newer publish already owns.
  const publishEpochRef = useRef(0)
  const publishActiveRef = useRef(false)
  // Device id we fell back from while transmitting on the default input. Not
  // written to settings, so this is also what we watch for to return to it.
  const inputFallbackRef = useRef(null)
  // Resolver for a ladder currently sleeping, so a devicechange can cut the
  // remaining delay short.
  const retryWakeRef = useRef(null)
  // Inputs for the soup callbacks and the actions. Callbacks are bound once per
  // connect() and never see a later render, so they read everything here.
  const clientsRef = useRef(clients)
  const selfIdRef = useRef(selfId)
  const channelsRef = useRef(channels)
  const declareChannelRef = useRef(declareChannel)
  const isReconnectRecoveringRef = useRef(isReconnectRecovering)
  const onMediaStateRef = useRef(onMediaState)
  const onErrorRef = useRef(onError)
  // Written together with the state by the actions, so a callback firing
  // before the next render already sees the move.
  const channelIdRef = useRef(null)
  const pendingChannelIdRef = useRef(null)
  // The record ({ channelId }) the current connect()'s callbacks are bound to.
  // Leaving detaches it, so that session's late onDisconnect can't touch a
  // newer one.
  const sessionRef = useRef(null)

  // Keep joinedRef in sync with joined state
  useEffect(() => {
    joinedRef.current = joined
  }, [joined])
  useEffect(() => {
    micSettingsRef.current = micSettings
  }, [micSettings])
  useEffect(() => {
    clientsRef.current = clients
    selfIdRef.current = selfId
    channelsRef.current = channels
    declareChannelRef.current = declareChannel
    isReconnectRecoveringRef.current = isReconnectRecovering
    onMediaStateRef.current = onMediaState
    onErrorRef.current = onError
  })
  // Our sending key is derived from our client id (lib/e2ee).
  useEffect(() => {
    setE2eeSelf(selfId)
    setVoiceSelf(selfId)
  }, [selfId])

  const setSessionChannel = (id) => {
    channelIdRef.current = id
    setChannelId(id)
  }
  const setPendingChannel = (id) => {
    pendingChannelIdRef.current = id
    setPendingChannelId(id)
  }
  const setError = (message) => {
    setErrorMessage(message)
    setErrorChannelId(message ? channelIdRef.current : null)
  }
  // Media arriving while a switch is in flight already belongs to its target.
  const tileChannelId = () => pendingChannelIdRef.current ?? channelIdRef.current
  const tileChannelName = () => {
    const channel = channelsRef.current.find((c) => c.id === tileChannelId())
    if (channel?.type !== 'dm') return channel?.name ?? 'Voice'
    return dmDisplayName(
      channel,
      selfIdRef.current,
      (id) => clientsRef.current.find((c) => c.id === id)?.name
    )
  }

  const handleClientSpeaking = (clientId, isSpeaking) => {
    setSpeakingClients((prev) => {
      if (!!prev[clientId] === isSpeaking) return prev
      return { ...prev, [clientId]: isSpeaking }
    })
    // Surface our own speaking state for the system-tray mic indicator.
    if (clientId === selfIdRef.current) setSelfSpeaking(isSpeaking)
  }

  // Cut a sleeping ladder's remaining delay short (a device re-enumerated).
  const wakePublishRetry = () => {
    const wake = retryWakeRef.current
    retryWakeRef.current = null
    wake?.()
  }

  const sleepBeforeRetry = (delay) =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        retryWakeRef.current = null
        resolve()
      }, delay)
      retryWakeRef.current = () => {
        clearTimeout(timer)
        resolve()
      }
    })

  // Publish (or, on a reconnect, re-publish) the local mic with current settings.
  // publish() is single-flight in soup, so an adopt() racing the reset-driven
  // republish can't allocate a duplicate producer transport. The self speaking
  // detector is started inside soup off the published stream.
  //
  // The ladder exists because in the field this usually fails from a device
  // that's gone for seconds to minutes (headset power state, sleep/resume,
  // Bluetooth switch). Keep retrying on a growing then holding delay until the
  // user leaves. A devicechange event can short-circuit the wait.
  const publishMic = async () => {
    const epoch = ++publishEpochRef.current
    publishActiveRef.current = true
    try {
      for (let attempt = 0; ; attempt++) {
        // A failed publish may be waiting out its retry delay while the user
        // leaves or switches channels. Do not reopen the mic for a session this
        // channel no longer owns.
        if (!joinedRef.current || publishEpochRef.current !== epoch) return
        const settings = micSettingsRef.current
        const attemptSettings = inputFallbackRef.current
          ? { ...settings, deviceId: 'default' }
          : settings
        try {
          await publish(attemptSettings)
          if (publishEpochRef.current !== epoch) return
          lastAppliedMicSettingsRef.current = attemptSettings
          setError(inputFallbackRef.current ? MIC_FALLBACK_MESSAGE : null)
          return
        } catch (err) {
          if (!joinedRef.current || publishEpochRef.current !== epoch) return
          // err.message can be empty, so the error name is logged too.
          console.error('[VoiceChannel] Publish failed:', err?.name, err)
          if (isPermanentMicError(err)) {
            setError(micErrorMessage(err))
            onMediaStateRef.current(channelIdRef.current, { state: 'failed', reason: err.name })
            return
          }

          // The selected device isn't in the device list, so exact match can
          // only keep failing. Fall back to the default input instead of
          // nothing, but leave the selection untouched so we can return to it.
          if (!inputFallbackRef.current && settings.deviceId && settings.deviceId !== 'default') {
            const ids = await audioDeviceIds()
            if (!joinedRef.current || publishEpochRef.current !== epoch) return
            if (
              shouldFallBackToDefaultInput({
                errorName: err?.name,
                selectedDeviceId: settings.deviceId,
                availableInputIds: ids?.inputIds
              })
            ) {
              console.warn('[VoiceChannel] Selected microphone is gone, using the default input')
              inputFallbackRef.current = settings.deviceId
              continue
            }
          }

          // At reconnect time the OS mic is often still held by the capture we
          // just tore down. That first failure is transient, so don't banner
          // it or every reconnect would flash an error at the user.
          if (attempt > 0) setError(micErrorMessage(err))
          // A produce/transport failure is a session problem a voice reconnect
          // can fix, but a missing capture device isn't. Spending the one-shot
          // recovery budget on it would disarm the watchdog for the rest of
          // the session.
          if (!err?.micCaptureFailure && attempt === 1) {
            if (!requestVoiceMediaRecovery('Microphone publish failed')) {
              onMediaStateRef.current(channelIdRef.current, {
                state: 'failed',
                reason: 'publish-failed'
              })
            }
          }
          const delay = nextMicPublishRetryDelay(attempt)
          console.warn(
            `[VoiceChannel] Publish attempt ${attempt + 1} failed (${err?.name}), retrying in ${delay}ms`
          )
          await sleepBeforeRetry(delay)
        }
      }
    } finally {
      if (publishEpochRef.current === epoch) publishActiveRef.current = false
    }
  }

  // A device re-enumerating is the recovery signal for a vanished mic. Without
  // this, waiting out the backoff turns a 3s headset reconnect into 20s of
  // silence, and a fallback capture never returns to the user's own device.
  useEffect(
    () =>
      subscribeDeviceChange((ids) => {
        if (!joinedRef.current) return
        const fallenBackFrom = inputFallbackRef.current
        const selectedIsBack = !!fallenBackFrom && ids?.inputIds?.has(fallenBackFrom) === true
        if (selectedIsBack) inputFallbackRef.current = null
        if (publishActiveRef.current) {
          wakePublishRetry()
          return
        }
        if (!selectedIsBack) return
        // The user's device is back. Reopen the capture they actually chose.
        lastAppliedMicSettingsRef.current = null
        republish(micSettingsRef.current)
          .then(() => {
            if (!joinedRef.current) return
            lastAppliedMicSettingsRef.current = micSettingsRef.current
            setError(null)
          })
          .catch((err) => {
            console.warn('[VoiceChannel] Returning to the selected microphone failed:', err?.name)
            inputFallbackRef.current = fallenBackFrom
          })
      }),
    []
  )

  // Abandon any ladder still waiting: the session it was publishing for is gone.
  const cancelPublishRetries = () => {
    publishEpochRef.current++
    publishActiveRef.current = false
    inputFallbackRef.current = null
    wakePublishRetry()
  }

  const handleMediaState = (state) => {
    if (state?.state === 'local-capture-lost') {
      // The mic dropped mid-call and soup's one repair couldn't reopen it. The
      // session stays up; the ladder gets the capture back.
      if (joinedRef.current && !publishActiveRef.current) void publishMic()
    } else if (state?.state === 'ready') {
      if (!inputFallbackRef.current) setError(null)
      // Zero known producers looks the same as a healthy empty room in soup,
      // so the roster is the only way to tell a missed producer replay from
      // an actually empty channel. Read via ref because this callback is
      // captured at join time and would otherwise see a stale roster.
      const peers = clientsRef.current.filter(
        (client) => client.channel_id === channelIdRef.current && client.id !== selfIdRef.current
      ).length
      console.warn(
        `[VoiceChannel] Voice media ready: peers=${peers} ` +
          `knownAudioProducers=${state.knownAudioProducers ?? '?'} ` +
          `activeAudioConsumers=${state.activeAudioConsumers ?? '?'}`
      )
    }
    onMediaStateRef.current(channelIdRef.current, state)
  }

  // Set our own channel on the server (join / switch) by sending a
  // VoiceStateUpdate over the event websocket instead of PATCHing
  // /server/client. sendVoiceState adds our current mute/deafen to a join.
  //
  // A declaration that never left the client must reject: the server only mints
  // the join's voice ticket in response to it, so connecting anyway would
  // dead-end on a ticket that never arrives. Reconnects don't come through
  // here: soup resumes the session, or asks for a ticket while we stay in the
  // channel (op 13, through Main's setVoiceServerHooks).
  const patchChannel = async (channelId) => {
    const sent = await declareChannelRef.current(channelId)
    if (sent === false) throw new Error('Not connected to server')
    return sent
  }

  // Fired whenever a voice session reaches READY (initial join and every
  // reconnect): mark joined and (re)publish the mic. joinedRef is set here
  // rather than waiting for its sync effect so publishMic's retry can tell
  // "still in the channel" from "left while we were failing".
  const handleConnectEstablished = async () => {
    joinedRef.current = true
    setJoined(true)
    await publishMic()
  }

  // Fired on a teardown: our own leave (no argument), or soup giving up on
  // voice ({ failed, reason, leave }). Either way the session is over, so its
  // channel goes too.
  const handleDisconnected = (session, info) => {
    // Our own leave detached this session already (or a newer join replaced
    // it), and the hook's state is no longer its own. Main still matches the
    // idle report against the channel it may be awaiting.
    if (sessionRef.current !== session) {
      onMediaStateRef.current(session.channelId, { state: 'idle' })
      return
    }
    sessionRef.current = null
    joinedRef.current = false
    setPendingChannel(null)
    cancelPublishRetries()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    setSelfSpeaking(false)
    onMediaStateRef.current(session.channelId, { state: 'idle' })
    if (info?.failed) {
      setError(info.reason)
      // Voice won't come back on its own, so don't sit in the channel without
      // media: leave it on the server too. Not when the backend already has us
      // out (kicked), or when another of our devices took voice over: a leave
      // would take it out of voice too.
      if (info.leave !== false) declareChannelRef.current(null)
    }
    setSessionChannel(null)
  }

  // Fired when soup has to build a new session (a resume of the old one wasn't
  // possible): tear down local media UI but stay "joined". Soup asks for a
  // ticket while we stay in the channel (op 13), remote tiles come back with
  // the new session's Channel snapshot, and the mic re-publishes. Screen share
  // is NOT auto-restored (re-capturing the screen requires a fresh user
  // gesture). A resumed session never gets here: its media carries on.
  const handleReconnecting = () => {
    activeShareRef.current = null
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    setSelfSpeaking(false)
  }

  // Apply changed mic settings to the live capture — at the cheapest tier that
  // actually applies them. updateMicSettings always hands us a new object, so
  // without this classification an output-volume drag would re-open the OS mic
  // and gap outgoing audio for a change that never reaches the capture at all.
  useEffect(() => {
    if (!joinedRef.current) return
    const scope = classifyMicSettingsChange(lastAppliedMicSettingsRef.current, micSettings)
    if (scope === REPUBLISH_SCOPE.NONE) return

    if (scope === REPUBLISH_SCOPE.THRESHOLD) {
      setVolumeGateThreshold(micSettings.volumeGateThreshold)
      lastAppliedMicSettingsRef.current = micSettings
      return
    }

    // A live fallback capture outranks the persisted selection until the
    // device comes back. Otherwise any unrelated settings change would reopen
    // the capture on the device that's still missing.
    const applied = inputFallbackRef.current ? { ...micSettings, deviceId: 'default' } : micSettings
    // Optimistic: republish is serialized in soup, so a burst of changes still
    // commits in order and the last one wins.
    lastAppliedMicSettingsRef.current = applied
    republish(applied, undefined, { graphOnly: scope === REPUBLISH_SCOPE.GRAPH }).catch((err) => {
      console.error('[VoiceChannel] Republish failed:', err)
      // A failed republish restores the *previously committed* capture, so the
      // baseline no longer describes anything live. Forget it and let the next
      // change take the full path rather than diff against settings that never
      // landed.
      lastAppliedMicSettingsRef.current = null
      // Same empty-message trap as the publish path: a device error here would
      // otherwise render a blank banner.
      setError(micErrorMessage(err))
    })
  }, [micSettings])

  // The remote producer itself went away (the sharer stopped). Keyed by producer
  // rather than consumer because an unwatched stream still has a tile but no
  // consumer to identify it by.
  const handleStreamEnded = (producerId, { replaced = false } = {}) => {
    // The SFU announces a codec replacement's old producer first. Keep its tile
    // as a short-lived placeholder; handleVideoStream swaps in the successor.
    if (replaced) return
    setVideoStreams((prev) => prev.filter((s) => s.producerId !== producerId))
  }

  // Native audio capture died mid-share; the video share continues.
  const handleScreenAudioError = (message) => {
    setError(
      `Screen share audio is unavailable (${message}). Video is still sharing - ` +
        `restart the share to retry or choose another supported audio source.`
    )
  }

  // The sharer paused or resumed their stream. The tile stays and shows it
  // paused, rather than freezing on the last frame.
  const handleStreamPaused = ({ producerId, paused }) => {
    setVideoStreams((prev) =>
      prev.map((s) =>
        !s.isSelf && s.producerId === producerId && !!s.paused !== paused ? { ...s, paused } : s
      )
    )
  }

  const handleVideoStream = ({ stream, kind, consumerId, producerId, clientId, codec, paused }) => {
    // Don't bake in the client's name here - the clients list for this
    // channel may not have caught up with this client's channel move yet.
    // The label is resolved at render time from clientId instead.
    setVideoStreams((prev) => [
      ...prev.filter(
        (existing) => existing.kind !== 'video' || existing.clientId !== clientId || existing.isSelf
      ),
      {
        stream,
        consumerId,
        producerId,
        kind,
        isSelf: false,
        clientId,
        codec,
        paused: paused === true,
        channelId: tileChannelId(),
        channelName: tileChannelName(),
        fallbackLabel: `${tileChannelName()} ${kind === 'video' ? 'Stream' : 'Feed'}`
      }
    ])
  }

  // Every soup callback the session answers. Bound once per connect(), to that
  // connect's session record: a switch or an adoption moves the record and
  // channelIdRef, which they read at call time.
  const voiceCallbacks = (session) => ({
    onConnect: handleConnectEstablished,
    onDisconnect: (info) => handleDisconnected(session, info),
    onReconnecting: handleReconnecting,
    onMediaState: handleMediaState,
    onVideoStream: handleVideoStream,
    onClientSpeaking: handleClientSpeaking,
    onStreamEnded: handleStreamEnded,
    onStreamPaused: handleStreamPaused,
    onScreenAudioError: handleScreenAudioError
  })

  // Join `id` from outside voice, or move the live session there. A second
  // request for the session's channel is ignored; one for the switch target
  // still in flight declares it again.
  const join = async (id) => {
    if (channelIdRef.current == null) return handleJoin(id)
    if (id === channelIdRef.current) return
    return switchTo(id)
  }

  const handleJoin = async (id) => {
    setSessionChannel(id)
    setJoined(false)
    setError(null)
    const session = { channelId: id }
    let declared = false
    try {
      await patchChannel(id)
      declared = true
      sessionRef.current = session
      await connect(voiceCallbacks(session))
    } catch (err) {
      // We left (or another join took over) while this one was connecting.
      if (err?.name === 'VoiceMediaResetError') return
      setError(err.message)
      // The declaration put us in the channel on the server; with no voice
      // session there's nothing to be in it for.
      if (declared) declareChannelRef.current(null)
      if (sessionRef.current === session) sessionRef.current = null
      setSessionChannel(null)
    }
  }

  // Move the live voice session to `id`. v1 keeps the voice socket open and
  // moves the session server-side: soup gets Closed for the old channel's
  // sinks (and our webcam/stream), then a Channel snapshot for the new one, and
  // the mic carries over. No new ticket, no rebuild.
  const switchTo = async (id) => {
    const retry = id === pendingChannelIdRef.current
    setError(null)
    // The session only moves once the roster agrees (the reconcile effect below
    // lands it). Moving it now would trip the moderator-move check (roster
    // channel ≠ session channel) and bounce the session back to the old channel.
    setPendingChannel(id)
    try {
      await patchChannel(id)
    } catch (err) {
      setPendingChannel(null)
      setError(err.message)
      // A dropped declaration still pointed desired membership at the target.
      // Reassert the still-live channel so a reconnect re-declares that one.
      try {
        await patchChannel(channelIdRef.current)
      } catch (restoreErr) {
        onErrorRef.current(`Failed to restore the previous voice channel: ${restoreErr.message}`)
      }
      return
    }
    // The move's Closed/Channel can arrive as soon as the server processes the
    // declaration, ahead of the roster: drop the old channel's media now, not
    // when the switch lands. A retry keeps what the target already sent.
    if (!retry) deactivate()
  }

  // Drop the old channel's local media state without disconnecting the voice
  // socket: a declared switch, or the server moving us (a moderator's move).
  // The server closes our share on the move, so its handle is dropped, not
  // stopped.
  const deactivate = () => {
    activeShareRef.current = null
    cancelPublishRetries()
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
  }

  const handleLeave = () => {
    sessionRef.current = null
    activeShareRef.current = null
    joinedRef.current = false
    setPendingChannel(null)
    cancelPublishRetries()
    disconnect()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    setSelfSpeaking(false)
    setSourcePickerOpen(false)
    setSessionChannel(null)
  }

  const leave = () => {
    handleLeave()
    // Tell the server we're leaving all channels (channel_id: null).
    declareChannelRef.current(null)
  }

  // Leave locally only: the caller (a server disconnect) has already told the
  // server.
  const reset = () => handleLeave()

  // Remove the local (self) screen-share tile after the share ends
  const clearSelfStream = (consumerId = null) => {
    setVideoStreams((prev) =>
      prev.filter((item) => !item.isSelf || (consumerId !== null && item.consumerId !== consumerId))
    )
  }

  // Capture and publish the chosen source after the user picks one
  // Encoder stats land ~3s after the share starts; tag the self tile with the live
  // codec + HW/SW so the sharer sees what's actually encoding (release builds have no
  // console), including after an adaptive downgrade flips AV1 â†’ H264. Idempotent â€”
  // bails when nothing changed so it stops re-rendering once settled.
  const handleSelfEncoderStats = (consumerId, { codec, hardware }) => {
    if (hardware == null && codec == null) return
    setVideoStreams((prev) => {
      const s = prev.find((x) => x.consumerId === consumerId && x.isSelf)
      if (!s) return prev
      const nextCodec = codec ?? s.codec
      if (s.hardware === hardware && s.codec === nextCodec) return prev
      return prev.map((x) => (x === s ? { ...x, hardware, codec: nextCodec } : x))
    })
  }

  const startShareWithSource = async (sourceId, options = {}) => {
    setSourcePickerOpen(false)
    // Re-picking a source (or changing quality) while live replaces the current
    // share — stop it first so we never publish two at once.
    await stopCurrentShare()
    lastShareRef.current = { sourceId, options }
    if (options.audioMode && options.audioMode !== 'none') {
      lastAudioRef.current = { audioMode: options.audioMode, audioTargets: options.audioTargets }
    }
    try {
      let screen
      // Bound to the self tile once we know its consumerId (screen.id below).
      const onEncoderStats = (stats) => handleSelfEncoderStats(screen?.id, stats)
      // Codec/SVC fallback publishes a replacement producer. Keep the self
      // tile and its mutable share handle aligned with the server's new id so
      // viewer updates continue to resolve against this stream.
      const onProducerReplaced = ({ previousProducerId, producerId, codec }) => {
        if (screen?.id === previousProducerId) screen.id = producerId
        setVideoStreams((prev) =>
          prev.map((stream) =>
            stream.isSelf && stream.producerId === previousProducerId
              ? {
                  ...stream,
                  consumerId: producerId,
                  producerId,
                  codec: codec ?? stream.codec
                }
              : stream
          )
        )
      }
      // Screen shares can recover from a lost capture track behind the
      // scenes, so we let the share tell us when it's actually over instead
      // of watching the raw track directly. The server can also end a share
      // (camera too) on its own.
      const onShareEnded = (reason) => {
        if (activeShareRef.current !== screen) return
        activeShareRef.current = null
        setSharing(false)
        clearSelfStream(screen?.id ?? null)
        onErrorRef.current(shareEndedMessage(reason))
      }
      if (options.isCamera) {
        // Webcams capture directly via getUserMedia - no main-process source
        // hand-off, and no audio/fps/resolution settings.
        screen = await shareCamera(sourceId, onEncoderStats, onProducerReplaced, onShareEnded)
      } else {
        // Tell the main process which source and audio mode the display-media
        // handler should use. sourceId is null on Wayland, where the OS portal
        // does the picking when getDisplayMedia runs.
        await window.electron.ipcRenderer.invoke('prepare-screen-share', {
          sourceId: sourceId ?? null,
          audioMode: options.audioMode ?? 'none'
        })
        screen = await shareScreen({
          ...options,
          sourceId: sourceId ?? null,
          onEncoderStats,
          onProducerReplaced,
          onShareEnded
        })
      }
      if (screen?.stream) {
        activeShareRef.current = screen
        // Cameras can't recover, so a webcam track ending stops the share.
        if (options.isCamera) {
          screen.stream.getVideoTracks()[0].addEventListener(
            'ended',
            () => {
              if (activeShareRef.current !== screen) return
              activeShareRef.current = null
              void screen.stop?.()
              setSharing(false)
              clearSelfStream(screen.id)
            },
            { once: true }
          )

          if (screen.stream.getVideoTracks()[0].readyState === 'ended') {
            activeShareRef.current = null
            await screen.stop?.()
            setSharing(false)
            clearSelfStream(screen.id)
            return
          }
        }

        setVideoStreams((prev) => [
          ...prev,
          {
            stream: screen.stream,
            consumerId: screen.id,
            // Our own tile has no consumer â€” screen.id IS the producer id, which
            // is what the viewer map is keyed by. This is the case that matters
            // most: "who is watching me".
            producerId: screen.id,
            kind: 'video',
            isSelf: true,
            clientId: selfIdRef.current,
            codec: screen.codec,
            channelId: tileChannelId(),
            channelName: tileChannelName(),
            fallbackLabel: clientsRef.current.find((c) => c.id === selfIdRef.current)?.name || 'You'
          }
        ])
      }
      setSharing(true)
    } catch (err) {
      console.error('[VoiceChannel] Screen share failed:', err)
      // Surface as a toast (e.g. "Missing required permission" when STREAM is
      // denied in this channel).
      onErrorRef.current(`Couldn't start stream: ${err.message}`)
    }
  }

  const stopCurrentShare = async () => {
    if (!activeShareRef.current && !sharing) return
    const activeShare = activeShareRef.current
    activeShareRef.current = null
    if (activeShare?.stop) await activeShare.stop()
    else await stopScreenShare()
    setSharing(false)
    clearSelfStream(activeShare?.id ?? null)
  }

  const handleScreenShare = async () => {
    if (sharing) await stopCurrentShare()
    // Let the user choose a screen/window before capturing
    else setSourcePickerOpen(true)
  }

  // Restart the live share with tweaked capture options (fps/resolution/audio).
  // Nothing in the publish path can be retuned in place, so this is a stop and
  // re-start of the same source; on Wayland the OS portal asks again.
  const restartShare = async (patch = {}) => {
    const last = lastShareRef.current
    if (!last) return
    const { audio, ...rest } = patch
    const options = { ...last.options, ...rest }
    if (audio != null) {
      const next = audio
        ? await audioOnOptions(last.sourceId)
        : { audioMode: 'none', audioTargets: null }
      // No usable audio mode without more input — let the picker collect it.
      if (audio && !next.audioMode) {
        setSourcePickerOpen(true)
        return
      }
      Object.assign(options, next)
    }
    await startShareWithSource(last.sourceId, options)
  }

  // The audio settings to restore when the quick menu turns audio back on: what
  // we last shared with, else the default the picker would have chosen.
  const audioOnOptions = async (sourceId) => {
    if (lastAudioRef.current) return lastAudioRef.current
    const caps = await getScreenAudioCapabilities().catch(() => null)
    const tab = sourceId?.startsWith('window') ? 'windows' : 'screens'
    const mode = audioOptionsFor(tab, caps).find((o) => o.value !== 'none')?.value
    // Per-app audio needs a chosen app list, which only the picker can collect
    // (Windows infers it from the shared window itself).
    if (!mode || (mode === 'app' && caps?.platform !== 'win32')) return { audioMode: null }
    return { audioMode: mode, audioTargets: mode === 'app' ? [sourceId] : null }
  }

  // Pause or resume the live share in place (the stream view's quick menu).
  // Viewers keep the stream and see it paused; so does our own tile.
  const pauseShare = async (paused) => {
    const share = activeShareRef.current
    if (!share) return false
    const applied = await setSharePaused(paused)
    if (!applied || activeShareRef.current !== share) return false
    share.paused = paused
    setVideoStreams((prev) =>
      prev.map((s) => (s.isSelf && s.producerId === share.id ? { ...s, paused } : s))
    )
    return true
  }

  // A switch lands when the server's roster places us in its target. Its
  // teardown already ran when the declaration was sent.
  const landSwitch = (id) => {
    if (sessionRef.current) sessionRef.current.channelId = id
    setSessionChannel(id)
    setPendingChannel(null)
    joinedRef.current = true
    setJoined(true)
    // The mic survives the move, so this is normally a no-op; it covers a mic
    // that was still failing to publish when we switched.
    void publishMic()
  }

  // Follow the live voice session after the server moved us into another
  // channel (a moderator's move). Unlike switchTo we don't declare anything —
  // the server already moved us, voice session included — we only move the
  // session's channel, mark ourselves joined, and make sure the mic is up
  // (publish() is a no-op while it's live).
  const adopt = (id) => {
    deactivate()
    if (sessionRef.current) sessionRef.current.channelId = id
    setSessionChannel(id)
    setError(null)
    joinedRef.current = true
    setJoined(true)
    void publishMic()
  }

  // The functions above are rebuilt every render. Consumers get one identity
  // per action, and effects reach the current bodies, through this ref.
  const latestRef = useRef(null)
  useLayoutEffect(() => {
    latestRef.current = {
      join,
      leave,
      reset,
      landSwitch,
      adopt,
      handleScreenShare,
      stopCurrentShare,
      restartShare,
      pauseShare,
      startShareWithSource
    }
  })
  // Starting or retuning a share outside voice does nothing.
  const [actions] = useState(() => ({
    join: (id) => latestRef.current.join(id),
    leave: () => latestRef.current.leave(),
    reset: () => latestRef.current.reset(),
    toggleShare: () => {
      if (joinedRef.current) return latestRef.current.handleScreenShare()
    },
    stopShare: () => latestRef.current.stopCurrentShare(),
    restartShare: (patch) => {
      if (joinedRef.current) return latestRef.current.restartShare(patch)
    },
    pauseShare: (paused) => latestRef.current.pauseShare(paused),
    openSourcePicker: () => {
      if (joinedRef.current) setSourcePickerOpen(true)
    },
    closeSourcePicker: () => setSourcePickerOpen(false),
    startShareWithSource: (sourceId, options) => {
      if (joinedRef.current) return latestRef.current.startShareWithSource(sourceId, options)
    },
    getShareOptions: () =>
      lastShareRef.current?.options
        ? { ...lastShareRef.current.options, paused: activeShareRef.current?.paused === true }
        : null
  }))

  // The channel the server says we're in (authoritative roster) confirms our
  // own switch, and diverges from the session's channel when a moderator moves
  // us (PATCH /client) or takes us out of voice. Land the switch, follow the
  // move, or leave.
  const serverChannelId = clients.find((c) => c.id === selfId)?.channel_id ?? null
  useEffect(() => {
    if (pendingChannelId != null) {
      // Until the roster names the target the declaration is still in flight;
      // the roster never passes through null on a switch.
      if (serverChannelId === pendingChannelId) latestRef.current.landSwitch(pendingChannelId)
      return
    }
    if (!joined || channelId == null || serverChannelId === channelId) return
    if (serverChannelId == null) {
      // Right after a reconnect the server briefly reports us channel-less (it
      // dropped us from voice during the outage). Don't leave — soup is already
      // reconnecting and re-asserting membership, and leaving would tear that
      // down and yank us out for good. It restores serverChannelId when it
      // lands, re-running this effect to a consistent state.
      //
      // recoveryEpoch is what makes the *other* outcome work: when the rejoin
      // never lands and the recovery times out, the bump re-runs this effect,
      // and we now take the leave path instead of showing a phantom joined state.
      if (isReconnectRecoveringRef.current()) return
      const timer = setTimeout(() => {
        // Re-check the live recovery ref: the voice socket's close notification
        // may have arrived after this effect observed the roster null.
        if (!isReconnectRecoveringRef.current()) {
          latestRef.current.leave()
        }
      }, VOICE_NULL_RECONCILE_GRACE_MS)
      return () => clearTimeout(timer)
    }
    latestRef.current.adopt(serverChannelId)
  }, [serverChannelId, channelId, pendingChannelId, joined, isReconnectRecovering, recoveryEpoch])

  // A channel deleted (or hidden from us) while we're in it takes the session
  // with it. Left alone, the session would stay live with nothing showing it,
  // and the next join would take the switch path on a broken session.
  useEffect(() => {
    if (joined && channelId != null && !channels.some((c) => c.id === channelId)) {
      latestRef.current.leave()
    }
  }, [channels, channelId, joined])

  return useMemo(
    () => ({
      channelId,
      pendingChannelId,
      joined,
      error,
      errorChannelId: error ? errorChannelId : null,
      sharing,
      videoStreams,
      speakingClients,
      selfSpeaking,
      sourcePickerOpen,
      ...actions
    }),
    [
      channelId,
      pendingChannelId,
      joined,
      error,
      errorChannelId,
      sharing,
      videoStreams,
      speakingClients,
      selfSpeaking,
      sourcePickerOpen,
      actions
    ]
  )
}
