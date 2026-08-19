import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import {
  connect,
  publish,
  republish,
  disconnect,
  shareScreen,
  shareCamera,
  stopScreenShare,
  rebindCallbacks,
  cancelExpectedVoiceSessionRebuild,
  expectVoiceSessionRebuild,
  requestVoiceMediaRecovery,
  setLocalClientId,
  setVolumeGateThreshold
} from '../lib/soup'
import { REPUBLISH_SCOPE, classifyMicSettingsChange } from '../lib/micRepublishScope'
import {
  isPermanentMicError,
  nextMicPublishRetryDelay,
  shouldFallBackToDefaultInput
} from '../lib/voiceRecoveryState'
import { audioDeviceIds, subscribeDeviceChange } from '../lib/mediaDevices'
import { motion, AnimatePresence } from 'motion/react'
import { useSettings, useAnimationCategory } from '../context/SettingsContext'
import { useAnimatedPresence } from '../lib/animation'
import { collapseSection, avatarStack, avatarStackItem, spring } from '../lib/motionPresets'
import { cdnUrl } from '../lib/serverConfig'
import { useMenuPosition } from '../lib/menuPosition'
import ClientIndicator from './ClientIndicator'
import ScreenSourcePicker from './ScreenSourcePicker'
import { getScreenAudioCapabilities } from '../lib/screenAudio'
import { audioOptionsFor } from '../lib/captureOptions'
import './VoiceChannel.css'
import {
  IconDiamondsFilled,
  IconPlus,
  IconTrash,
  IconPointFilled,
  IconInfoCircle,
  IconChevronDown
} from '@tabler/icons-react'

const STACK_MAX = 3

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

const VoiceChannel = forwardRef(function VoiceChannel(
  {
    channel,
    draggable,
    onDragStart,
    onDragOver,
    onDrop,
    onDragEnd,
    dragging,
    dropEdge,
    clients,
    self,
    micMuted,
    deafened,
    onStreamsUpdate,
    onSelfSpeaking,
    onSpeakingClientsChange,
    onVoiceMediaState,
    onSelfChannelChange,
    onJoinedChange,
    onSharingChange,
    onRequestJoin,
    onDeleteChannel,
    onRequestCreateChannel,
    onShowChannelSummary,
    onMoveClient,
    onPreviewChannel,
    onOpenDm,
    onPoke,
    onKick,
    onKickFromChannel,
    onGag,
    onBan,
    onUnban,
    onSetAvatar,
    onShowClientSummary,
    roles,
    onAssignRole,
    onRemoveRole,
    vanity,
    onToggleVanity,
    onOpenRolesGroups,
    canKickMembers,
    canBanMembers,
    canMuteMembers,
    previewing,
    unread,
    animStatus,
    onError
  },
  ref
) {
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(null)
  const [sharing, setSharing] = useState(false)
  const [showSourcePicker, setShowSourcePicker] = useState(false)
  const [videoStreams, setVideoStreams] = useState([])
  const [speakingClients, setSpeakingClients] = useState({})
  // Right-click context menu position ({x, y}) or null when closed.
  const [menuPos, setMenuPos] = useState(null)
  // True while a client entry is being dragged over this channel's header (drop
  // to move them here). Distinct from channel drag-to-reorder.
  const [clientDropActive, setClientDropActive] = useState(false)
  // Collapse this channel's user list into a stacked avatar row. Session-only —
  // channels always come back expanded.
  const [collapsed, setCollapsed] = useState(false)
  const { micSettings } = useSettings()

  const clientAnimEnabled = useAnimationCategory('userJoin')
  const clientPresence = useAnimatedPresence(clients, (c) => c.id, {
    enabled: clientAnimEnabled
  })
  // Collapse/expand of the user list rides the channel-list category — it's a
  // sidebar structure change, not a user coming or going.
  const collapseAnimEnabled = useAnimationCategory('channelList')

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
  const menuRef = useRef(null)
  const menuStyle = useMenuPosition(menuRef, menuPos)
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
  // Roster snapshot for the soup callbacks, which close over the render that
  // joined and never see a later one unless they are rebound.
  const clientsRef = useRef(clients)
  const selfIdRef = useRef(self?.id)

  // Keep joinedRef in sync with joined state
  useEffect(() => {
    joinedRef.current = joined
  }, [joined])
  useEffect(() => {
    micSettingsRef.current = micSettings
  }, [micSettings])
  useEffect(() => {
    clientsRef.current = clients
    selfIdRef.current = self?.id
  }, [clients, self?.id])
  // Tell soup our client id so its self speaking detector can report our own
  // speaking through onClientSpeaking (which rebinds to the channel we're in).
  useEffect(() => {
    setLocalClientId(self?.id)
  }, [self?.id])

  // Let the sidebar know when this channel becomes the joined/sharing one
  useEffect(() => {
    onJoinedChange?.(channel.id, joined)
  }, [joined])
  useEffect(() => {
    onSharingChange?.(channel.id, sharing)
  }, [sharing])

  // Surface the joined channel's live speaking map up to Main (for the stream
  // view's theatre-mode participant rail). Only the joined channel reports —
  // inactive channels always hold an empty map — and it clears on leave so a
  // stale speaker can't linger after we've moved on.
  useEffect(() => {
    if (joined) onSpeakingClientsChange?.(speakingClients)
  }, [joined, speakingClients])
  useEffect(() => {
    if (!joined) return
    return () => onSpeakingClientsChange?.({})
  }, [joined])

  // Mirror this channel's stream tiles up to the sidebar/Main. Done in an effect
  // rather than inside the setVideoStreams updaters so the parent's setState
  // never runs during this component's render (that triggers React's
  // "update a component while rendering a different component" warning). Fires on
  // mount with [] too, which handleStreamsUpdate reads as "no streams" â€” harmless.
  useEffect(() => {
    onStreamsUpdate?.(videoStreams)
  }, [videoStreams])

  // Close the right-click menu on an outside click.
  useEffect(() => {
    if (!menuPos) return
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuPos(null)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [menuPos])

  const handleContextMenu = (e) => {
    e.preventDefault()
    setMenuPos({ x: e.clientX, y: e.clientY })
  }

  // Client entries carry their id under a custom MIME type so this only reacts to
  // a client drag, never the channel-reorder drag (which uses text/plain).
  const CLIENT_DND_TYPE = 'application/x-client-id'
  const handleClientDragOver = (e) => {
    if (!onMoveClient || !e.dataTransfer.types.includes(CLIENT_DND_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    if (!clientDropActive) setClientDropActive(true)
  }
  const handleClientDrop = (e) => {
    if (!onMoveClient || !e.dataTransfer.types.includes(CLIENT_DND_TYPE)) return
    e.preventDefault()
    e.stopPropagation()
    setClientDropActive(false)
    const clientId = e.dataTransfer.getData(CLIENT_DND_TYPE)
    if (clientId) onMoveClient(clientId, channel.id)
  }

  const handleClientSpeaking = (clientId, isSpeaking) => {
    setSpeakingClients((prev) => {
      if (!!prev[clientId] === isSpeaking) return prev
      return { ...prev, [clientId]: isSpeaking }
    })
    // Surface our own speaking state for the system-tray mic indicator.
    if (clientId === self?.id) onSelfSpeaking?.(isSpeaking)
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
            onVoiceMediaState?.(channel.id, { state: 'failed', reason: err.name })
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
              onVoiceMediaState?.(channel.id, { state: 'failed', reason: 'publish-failed' })
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
    if (state?.state === 'ready') {
      if (!inputFallbackRef.current) setError(null)
      // Zero known producers looks the same as a healthy empty room in soup,
      // so the roster is the only way to tell a missed producer replay from
      // an actually empty channel. Read via ref because this callback is
      // captured at join time and would otherwise see a stale roster.
      const peers = clientsRef.current.filter((client) => client.id !== selfIdRef.current).length
      console.warn(
        `[VoiceChannel] Voice media ready: peers=${peers} ` +
          `knownAudioProducers=${state.knownAudioProducers ?? '?'} ` +
          `activeAudioConsumers=${state.activeAudioConsumers ?? '?'}`
      )
    }
    onVoiceMediaState?.(channel.id, state)
  }

  // Set our own channel on the server (join / switch / rejoin-on-reconnect) by
  // sending a VoiceStateUpdate over the event websocket instead of PATCHing
  // /server/client. Async so the soup reconnect path can await it the same way
  // it awaited the old REST call. The merge in sendVoiceState carries our
  // current mute/deafen alongside the channel.
  //
  // A declaration that never left the client must reject: the server only mints
  // a voice ticket in response to it, so connecting anyway would dead-end on a
  // ticket that never arrives. Rejecting instead sends the reconnect back to its
  // backoff, which keeps retrying until the events socket is back.
  const patchChannel = async (channelId) => {
    const sent = await onSelfChannelChange?.(channelId)
    if (sent === false) throw new Error('Not connected to server')
    return sent
  }

  // The rejoin a voice reconnect declares before asking for its ticket.
  //
  // Re-asserting the same channel is a silent no-op while the server still
  // holds our dead voice session (up to 60s after the socket's FIN is lost),
  // since a ticket is only minted on a real none-to-channel transition. So the
  // reconnect would dead-end waiting for a push that never comes. Declaring
  // the leave first forces the server to release that session (peers get
  // ProducerClosed instead of a silent member) and makes the join a real
  // transition. This mirrors the known-good manual leave/rejoin recovery.
  // Null-to-null costs nothing when the server already dropped us.
  const declareRejoin = async () => {
    await patchChannel(null)
    await patchChannel(channel.id)
  }

  // Fired after every successful (re)auth: mark joined and (re)publish the mic.
  // joinedRef is set here rather than waiting for its sync effect so publishMic's
  // retry can tell "still in the channel" from "left while we were failing".
  const handleConnectEstablished = async () => {
    joinedRef.current = true
    setJoined(true)
    setConnecting(false)
    await publishMic()
  }

  // Fired on an intentional/unrecoverable teardown. Named (rather than inlined at
  // the initial connect) so switchTo/adopt can rebind it too — left pointing at
  // the first-joined channel's closure, a later disconnect would clear that dead
  // component's state and leave the channel we're actually in showing as joined.
  const handleDisconnected = () => {
    joinedRef.current = false
    cancelPublishRetries()
    setJoined(false)
    setConnecting(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    onVoiceMediaState?.(channel.id, { state: 'idle' })
  }

  // Fired on an unexpected drop: tear down local media UI but stay "joined" â€”
  // soup auto-reconnects, remote tiles re-arrive via replayed NewProducer, and
  // the mic re-publishes. Screen share is NOT auto-restored (re-capturing the
  // screen requires a fresh user gesture).
  const handleReconnecting = () => {
    activeShareRef.current = null
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    onSelfSpeaking?.(false)
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

  // Unmount cleanup. If this channel is being deleted out from under us *while
  // we're joined to it*, tear down the shared (singleton) voice session and clear
  // the sidebar's
  // joined bookkeeping. Otherwise the soup connection is left orphaned â€” its
  // callbacks point at this dead component and `joinedChannelId` still names the
  // gone channel â€” so the next channel the user joins takes the "switch" path on
  // a broken session and can't transmit audio or leave.
  useEffect(
    () => () => {
      if (joinedRef.current) {
        activeShareRef.current = null
        joinedRef.current = false
        cancelPublishRetries()
        disconnect()
        onJoinedChange?.(channel.id, false)
      }
    },
    []
  )

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

  const handleVideoStream = ({ stream, kind, consumerId, producerId, clientId, codec }) => {
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
        channelId: channel.id,
        channelName: channel.name,
        fallbackLabel: `${channel.name} ${kind === 'video' ? 'Stream' : 'Feed'}`
      }
    ])
  }

  const handleDoubleClick = () => {
    if (!joined) {
      if (onRequestJoin) {
        onRequestJoin(handleJoin, switchTo)
      } else {
        handleJoin()
      }
    }
  }

  const handleJoin = async () => {
    setConnecting(true)
    setError(null)
    try {
      await patchChannel(channel.id)

      await connect({
        onConnect: handleConnectEstablished,
        onDisconnect: handleDisconnected,
        onReconnecting: handleReconnecting,
        onMediaState: handleMediaState,
        // Declared leave→join before each reconnect's ticket fetch (see
        // declareRejoin); the initial join above stays a plain declaration.
        onReconnectRejoin: declareRejoin,
        onVideoStream: handleVideoStream,
        onClientSpeaking: handleClientSpeaking,
        onStreamEnded: handleStreamEnded,
        onScreenAudioError: handleScreenAudioError
      })
    } catch (err) {
      setError(err.message)
      setConnecting(false)
    }
  }

  // Move to this channel. The server responds with TransportsDisconnected;
  // soup then authenticates a fresh SFU session because the old router peer no
  // longer exists, and onConnect publishes into that replacement session.
  const switchTo = async () => {
    setConnecting(true)
    setError(null)

    // Mark this rebuild as expected before switching, so the UI treats the
    // resulting reset as normal instead of a lost connection.
    expectVoiceSessionRebuild('channel-switch')

    // Rebind callbacks BEFORE the PATCH â€” TransportsDisconnected can arrive
    // as soon as the server processes the PATCH, so this channel's handler
    // must already be active to catch it. This also repoints the reconnect
    // callbacks at the new channel, so a drop after the switch recovers here.
    rebindCallbacks({
      onConnect: handleConnectEstablished,
      onDisconnect: handleDisconnected,
      onReconnecting: handleReconnecting,
      onMediaState: handleMediaState,
      onReconnectRejoin: declareRejoin,
      onVideoStream: handleVideoStream,
      onClientSpeaking: handleClientSpeaking,
      onStreamEnded: handleStreamEnded,
      onScreenAudioError: handleScreenAudioError
    })

    try {
      await patchChannel(channel.id)
    } catch (err) {
      // The switch request failed, so no reset is coming. Undo the expected
      // rebuild flag so a real drop isn't mistaken for this one.
      cancelExpectedVoiceSessionRebuild()
      setError(err.message)
      setConnecting(false)
      throw err
    }
  }

  // Take ownership of the live voice session after the server moved us into this
  // channel (a moderator's PATCH /client). Unlike switchTo we don't PATCH â€” the
  // server already moved us â€” we only repoint the shared session's callbacks here,
  // mark ourselves joined, and re-establish media. The server's MediaStateReset
  // may land before or after we adopt; publish() is single-flight, so calling it
  // here can't collide with a reset-driven republish. onClientSpeaking is rebound
  // to us, so soup's self speaking detector now reports to this channel.
  const adopt = async ({ reassert = false } = {}) => {
    // The server already moved us, so mark the resulting reset as expected
    // too, even if it already arrived before this runs.
    expectVoiceSessionRebuild('channel-adopted')
    rebindCallbacks({
      onConnect: handleConnectEstablished,
      onDisconnect: handleDisconnected,
      onReconnecting: handleReconnecting,
      onMediaState: handleMediaState,
      onReconnectRejoin: declareRejoin,
      onVideoStream: handleVideoStream,
      onClientSpeaking: handleClientSpeaking,
      onStreamEnded: handleStreamEnded,
      onScreenAudioError: handleScreenAudioError
    })
    // A switch declaration can fail after callbacks and desired membership were
    // pointed at the target. Reasserting here restores both to the still-live
    // previous owner; ordinary moderator adoption must not send this declaration.
    if (reassert) await patchChannel(channel.id)
    else
      onVoiceMediaState?.(channel.id, {
        state: 'reconnecting',
        reason: 'channel-adopted',
        expected: true
      })
    setError(null)
    setConnecting(false)
    joinedRef.current = true
    setJoined(true)
    await publishMic()
  }

  // Stop being the active channel locally, without disconnecting the
  // websocket (used when switching to a different channel).
  const deactivate = () => {
    activeShareRef.current = null
    joinedRef.current = false
    cancelPublishRetries()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
  }

  const handleLeave = () => {
    activeShareRef.current = null
    joinedRef.current = false
    cancelPublishRetries()
    disconnect()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    // Tell the server we're leaving all channels (channel_id: null).
    onSelfChannelChange?.(null)
  }

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
    setShowSourcePicker(false)
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
      // of watching the raw track directly.
      const onShareEnded = (reason) => {
        if (activeShareRef.current !== screen) return
        activeShareRef.current = null
        setSharing(false)
        clearSelfStream(screen?.id ?? null)
        onError?.(
          reason === 'frames-stalled'
            ? 'Stream ended because the shared window stopped sending frames'
            : 'Stream ended because the shared window closed'
        )
      }
      if (options.isCamera) {
        // Webcams capture directly via getUserMedia - no main-process source
        // hand-off, and no audio/fps/resolution settings.
        screen = await shareCamera(sourceId, onEncoderStats, onProducerReplaced)
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
            clientId: self.id,
            codec: screen.codec,
            channelName: channel.name,
            fallbackLabel: self.name || 'You'
          }
        ])
      }
      setSharing(true)
    } catch (err) {
      console.error('[VoiceChannel] Screen share failed:', err)
      // Surface as a toast (e.g. "Missing required permission" when STREAM is
      // denied in this channel); fall back to the inline banner if no toast hook.
      if (onError) onError(`Couldn't start stream: ${err.message}`)
      else setError(err.message)
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
    else setShowSourcePicker(true)
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
        setShowSourcePicker(true)
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

  useImperativeHandle(ref, () => ({
    leave: handleLeave,
    toggleShare: handleScreenShare,
    stopShare: stopCurrentShare,
    restartShare,
    openSourcePicker: () => setShowSourcePicker(true),
    getShareOptions: () => lastShareRef.current?.options ?? null,
    switchTo,
    adopt,
    restoreAfterFailedSwitch: () => adopt({ reassert: true }),
    deactivate
  }))

  // Clients with an active video stream (their tile is present in videoStreams).
  const streamingClientIds = new Set(
    videoStreams.filter((s) => s.kind === 'video').map((s) => s.clientId)
  )

  return (
    <div
      className={`channel-item${joined ? ' active' : ''}${previewing ? ' previewing' : ''}${dragging ? ' dragging' : ''}${dropEdge ? ` drop-${dropEdge}` : ''}`}
      data-flip-key={channel.id}
      data-anim-status={animStatus}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className={`channel-row${clientDropActive ? ' client-drop-target' : ''}`}
        draggable={draggable}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={handleClientDragOver}
        onDragLeave={() => setClientDropActive(false)}
        onDrop={handleClientDrop}
        onClick={() => onPreviewChannel?.(channel.id)}
        onContextMenu={handleContextMenu}
      >
        {channel.channel_icon ? (
          <img className="channel-icon-img" src={cdnUrl(channel.channel_icon)} alt="" />
        ) : (
          <IconDiamondsFilled className="channel-icon-placeholder" size={25} />
        )}
        <span className="channel-name">{channel.name}</span>
        <AnimatePresence initial={false}>
          {collapsed && clients.length > 0 && (
            <motion.span className="channel-avatar-stack" {...avatarStack(collapseAnimEnabled)}>
              {clients.slice(0, STACK_MAX).map((c) => (
                <motion.span
                  className="client-avatar"
                  key={c.id}
                  title={c.name}
                  variants={avatarStackItem}
                >
                  {c.avatar ? (
                    <img className="client-avatar-img" src={c.avatar} alt="" aria-hidden="true" />
                  ) : (
                    (c.name || '?').charAt(0).toUpperCase()
                  )}
                </motion.span>
              ))}
              {clients.length > STACK_MAX && (
                <motion.span className="channel-avatar-more" variants={avatarStackItem}>
                  +{clients.length - STACK_MAX}
                </motion.span>
              )}
            </motion.span>
          )}
        </AnimatePresence>
        {/* After the avatar stack so the dot keeps the same slot — hard against
            the chevron — whether the channel is collapsed or expanded. */}
        {unread && (
          <IconPointFilled className="channel-unread-dot" size={12} aria-label="Unread messages" />
        )}
        {clients.length > 0 && (
          <button
            type="button"
            className="channel-collapse-btn"
            title={collapsed ? 'Expand users' : 'Collapse users'}
            aria-expanded={!collapsed}
            onClick={(e) => {
              e.stopPropagation()
              setCollapsed((v) => !v)
            }}
          >
            {/* One chevron that rotates rather than two that swap: +90°
                (clockwise) lands exactly on the left-pointing collapsed state. */}
            <motion.span
              className="channel-collapse-chevron"
              initial={false}
              animate={{ rotate: collapsed ? 90 : 0 }}
              transition={collapseAnimEnabled ? spring : { duration: 0 }}
            >
              <IconChevronDown size={15} />
            </motion.span>
          </button>
        )}
      </div>
      {error && <div className="channel-error">{error}</div>}
      {/* Wrapper exists purely so the user list has a single box to fold; it
          stays mounted through the collapse animation via AnimatePresence. */}
      <AnimatePresence initial={false}>
        {!collapsed && clientPresence.length > 0 && (
          <motion.div className="channel-clients" {...collapseSection(collapseAnimEnabled)}>
            {clientPresence.map(({ key, item: c, status }) => (
              <ClientIndicator
                key={key}
                client={c}
                animStatus={status}
                speaking={!!speakingClients[c.id]}
                micMuted={c.id === self?.id ? micMuted : !!c.self_mute}
                deafened={c.id === self?.id ? deafened : !!c.self_deaf}
                isSelf={c.id === self?.id}
                streaming={streamingClientIds.has(c.id)}
                draggableToChannel={!!onMoveClient}
                onOpenDm={onOpenDm}
                onPoke={onPoke}
                onKick={onKick}
                onKickFromChannel={onKickFromChannel}
                onGag={onGag}
                onBan={onBan}
                onUnban={onUnban}
                onSetAvatar={onSetAvatar}
                onShowClientSummary={onShowClientSummary}
                roles={roles}
                onAssignRole={onAssignRole}
                onRemoveRole={onRemoveRole}
                vanity={vanity}
                onToggleVanity={onToggleVanity}
                onOpenRolesGroups={onOpenRolesGroups}
                canKickMembers={canKickMembers}
                canBanMembers={canBanMembers}
                canMuteMembers={canMuteMembers}
              />
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {showSourcePicker && (
        <ScreenSourcePicker
          onSelect={startShareWithSource}
          onCancel={() => setShowSourcePicker(false)}
        />
      )}

      {menuPos && (
        <div className="channel-context-menu" ref={menuRef} style={menuStyle}>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setMenuPos(null)
              onShowChannelSummary?.(channel.id)
            }}
          >
            <IconInfoCircle size={16} /> Channel Details
          </button>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setMenuPos(null)
              onRequestCreateChannel?.(channel.position)
            }}
          >
            <IconPlus size={16} /> Add Channel
          </button>
          <button
            type="button"
            className="channel-context-item danger"
            onClick={() => {
              setMenuPos(null)
              onDeleteChannel?.(channel.id)
            }}
          >
            <IconTrash size={16} /> Delete Channel
          </button>
        </div>
      )}
    </div>
  )
})

export default VoiceChannel
