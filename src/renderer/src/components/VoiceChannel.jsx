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
  createSpeakingDetector
} from '../lib/soup'
import { useSettings, useAnimationCategory } from '../context/SettingsContext'
import { useAnimatedPresence } from '../lib/animation'
import ClientIndicator from './ClientIndicator'
import ScreenSourcePicker from './ScreenSourcePicker'
import './VoiceChannel.css'
import {
  IconVolume,
  IconCircle,
  IconCircleFilled,
  IconLock,
  IconLockOpen,
  IconPlus,
  IconTrash,
  IconPointFilled
} from '@tabler/icons-react'

const VoiceChannel = forwardRef(function VoiceChannel(
  {
    channel,
    clients,
    token,
    self,
    micMuted,
    deafened,
    onStreamsUpdate,
    onSelfChannelChange,
    onJoinedChange,
    onSharingChange,
    onRequestJoin,
    onDeleteChannel,
    onRequestCreateChannel,
    onPreviewChannel,
    onOpenDm,
    onPoke,
    onShowClientSummary,
    previewing,
    unread,
    animStatus
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
  const { micSettings } = useSettings()

  const clientAnimEnabled = useAnimationCategory('userJoin')
  const clientPresence = useAnimatedPresence(clients, (c) => c.id, {
    enabled: clientAnimEnabled
  })

  const joinedRef = useRef(false)
  const localSpeakingCleanupRef = useRef(null)
  const menuRef = useRef(null)
  // Latest mic settings, read by the (re)publish path so a background reconnect
  // re-publishes with current settings rather than those captured at join time.
  const micSettingsRef = useRef(micSettings)

  // Keep joinedRef in sync with joined state
  useEffect(() => {
    joinedRef.current = joined
  }, [joined])
  useEffect(() => {
    micSettingsRef.current = micSettings
  }, [micSettings])

  // Let the sidebar know when this channel becomes the joined/sharing one
  useEffect(() => {
    onJoinedChange?.(channel.id, joined)
  }, [joined])
  useEffect(() => {
    onSharingChange?.(channel.id, sharing)
  }, [sharing])

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

  const handleClientSpeaking = (clientId, isSpeaking) => {
    setSpeakingClients((prev) => {
      if (!!prev[clientId] === isSpeaking) return prev
      return { ...prev, [clientId]: isSpeaking }
    })
  }

  const startLocalSpeakingDetector = (stream) => {
    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = createSpeakingDetector(stream, (isSpeaking) => {
      handleClientSpeaking(self.id, isSpeaking)
    })
  }

  // Publish (or, on a reconnect, re-publish) the local mic with current settings.
  const publishMic = async () => {
    try {
      await publish(micSettingsRef.current, (stream) => {
        console.log('[VoiceChannel] Local stream ready')
        startLocalSpeakingDetector(stream)
      })
    } catch (err) {
      console.error('[VoiceChannel] Publish failed:', err)
      setError(err.message)
    }
  }

  // Set our own channel on the server (join / switch / rejoin-on-reconnect) by
  // sending a VoiceStateUpdate over the event websocket instead of PATCHing
  // /server/client. Wrapped in Promise.resolve so the soup reconnect path can
  // await it the same way it awaited the old REST call. The merge in
  // sendVoiceState carries our current mute/deafen alongside the channel.
  const patchChannel = (channelId) => Promise.resolve(onSelfChannelChange?.(channelId))

  // Fired after every successful (re)auth: mark joined and (re)publish the mic.
  const handleConnectEstablished = async () => {
    setJoined(true)
    setConnecting(false)
    await publishMic()
  }

  // Fired on an unexpected drop: tear down local media UI but stay "joined" —
  // soup auto-reconnects, remote tiles re-arrive via replayed NewProducer, and
  // the mic re-publishes. Screen share is NOT auto-restored (re-capturing the
  // screen requires a fresh user gesture).
  const handleReconnecting = () => {
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = null
    if (onStreamsUpdate) onStreamsUpdate([])
  }

  // Republish audio whenever mic settings change while in a channel
  useEffect(() => {
    if (!joinedRef.current) return
    republish(micSettings, startLocalSpeakingDetector).catch((err) => {
      console.error('[VoiceChannel] Republish failed:', err)
      setError(err.message)
    })
  }, [micSettings])

  // Unmount cleanup. Always stop the local speaking detector. Additionally, if
  // this channel is being deleted out from under us *while we're joined to it*,
  // tear down the shared (singleton) voice session and clear the sidebar's
  // joined bookkeeping. Otherwise the soup connection is left orphaned — its
  // callbacks point at this dead component and `joinedChannelId` still names the
  // gone channel — so the next channel the user joins takes the "switch" path on
  // a broken session and can't transmit audio or leave.
  useEffect(
    () => () => {
      localSpeakingCleanupRef.current?.()
      if (joinedRef.current) {
        disconnect()
        onJoinedChange?.(channel.id, false)
      }
    },
    []
  )

  // Remove a remote video tile whose consumer was closed (e.g. the
  // remote client restarted screen share, replacing its old producer)
  const handleConsumerClosed = (consumerId) => {
    setVideoStreams((prev) => {
      const updated = prev.filter((s) => s.consumerId !== consumerId)
      if (onStreamsUpdate) onStreamsUpdate(updated)
      return updated
    })
  }

  const handleVideoStream = ({ stream, kind, consumerId, clientId }) => {
    // Don't bake in the client's name here - the clients list for this
    // channel may not have caught up with this client's channel move yet.
    // The label is resolved at render time from clientId instead.
    setVideoStreams((prev) => {
      const updated = [
        ...prev,
        {
          stream,
          consumerId,
          kind,
          isSelf: false,
          clientId,
          channelId: channel.id,
          channelName: channel.name,
          fallbackLabel: `${channel.name} ${kind === 'video' ? 'Stream' : 'Feed'}`
        }
      ]
      if (onStreamsUpdate) onStreamsUpdate(updated)
      return updated
    })
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

      await connect(token, {
        onConnect: handleConnectEstablished,
        onDisconnect: () => {
          setJoined(false)
          setSharing(false)
          setVideoStreams([])
          setSpeakingClients({})
          localSpeakingCleanupRef.current?.()
          localSpeakingCleanupRef.current = null
          if (onStreamsUpdate) onStreamsUpdate([])
        },
        onReconnecting: handleReconnecting,
        // Server drops us from the channel when the socket dies — re-assert
        // membership before each reconnect's ticket fetch.
        onReconnectRejoin: () => patchChannel(channel.id),
        onVideoStream: handleVideoStream,
        onClientSpeaking: handleClientSpeaking,
        onConsumerClosed: handleConsumerClosed
      })
    } catch (err) {
      setError(err.message)
      setConnecting(false)
    }
  }

  // Move to this channel without closing the websocket. The server will
  // respond with TransportsDisconnected, which resets media state and
  // triggers a republish via the rebound onTransportsDisconnected callback.
  const switchTo = async () => {
    setConnecting(true)
    setError(null)

    // Rebind callbacks BEFORE the PATCH — TransportsDisconnected can arrive
    // as soon as the server processes the PATCH, so this channel's handler
    // must already be active to catch it. This also repoints the reconnect
    // callbacks at the new channel, so a drop after the switch recovers here.
    rebindCallbacks({
      onConnect: handleConnectEstablished,
      onReconnecting: handleReconnecting,
      onReconnectRejoin: () => patchChannel(channel.id),
      onVideoStream: handleVideoStream,
      onClientSpeaking: handleClientSpeaking,
      onConsumerClosed: handleConsumerClosed,
      onTransportsDisconnected: handleConnectEstablished
    })

    try {
      await patchChannel(channel.id)
    } catch (err) {
      setError(err.message)
      setConnecting(false)
    }
  }

  // Stop being the active channel locally, without disconnecting the
  // websocket (used when switching to a different channel).
  const deactivate = () => {
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = null
    if (onStreamsUpdate) onStreamsUpdate([])
  }

  const handleLeave = () => {
    disconnect()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = null
    if (onStreamsUpdate) onStreamsUpdate([])
    // Tell the server we're leaving all channels (channel_id: null).
    onSelfChannelChange?.(null)
  }

  // Remove the local (self) screen-share tile after the share ends
  const clearSelfStream = () => {
    setVideoStreams((prev) => {
      const remaining = prev.filter((item) => !item.isSelf)
      if (onStreamsUpdate) onStreamsUpdate(remaining)
      return remaining
    })
  }

  // Capture and publish the chosen source after the user picks one
  const startShareWithSource = async (sourceId, options = {}) => {
    setShowSourcePicker(false)
    try {
      let screen
      if (options.isCamera) {
        // Webcams capture directly via getUserMedia - no main-process source
        // hand-off, and no audio/fps/resolution settings.
        screen = await shareCamera(sourceId)
      } else {
        // Tell the main process which source the display-media handler should use
        window.electron.ipcRenderer.send('set-screen-source', sourceId)
        screen = await shareScreen(options)
      }
      if (screen?.stream) {
        screen.stream.getVideoTracks()[0].onended = () => {
          stopScreenShare()
          setSharing(false)
          clearSelfStream()
        }

        setVideoStreams((prev) => {
          const updated = [
            ...prev,
            {
              stream: screen.stream,
              consumerId: screen.id,
              kind: 'video',
              isSelf: true,
              clientId: self.id,
              channelName: channel.name,
              fallbackLabel: self.name || 'You'
            }
          ]
          if (onStreamsUpdate) onStreamsUpdate(updated)
          return updated
        })
      }
      setSharing(true)
    } catch (err) {
      console.error('[VoiceChannel] Screen share failed:', err)
      setError(err.message)
    }
  }

  const handleScreenShare = async () => {
    if (sharing) {
      await stopScreenShare()
      setSharing(false)
      clearSelfStream()
    } else {
      // Let the user choose a screen/window before capturing
      setShowSourcePicker(true)
    }
  }

  useImperativeHandle(ref, () => ({
    leave: handleLeave,
    toggleShare: handleScreenShare,
    switchTo,
    deactivate
  }))

  // Clients with an active video stream (their tile is present in videoStreams).
  const streamingClientIds = new Set(
    videoStreams.filter((s) => s.kind === 'video').map((s) => s.clientId)
  )

  return (
    <div
      className={`channel-item${joined ? ' active' : ''}${previewing ? ' previewing' : ''}`}
      data-flip-key={channel.id}
      data-anim-status={animStatus}
      onDoubleClick={handleDoubleClick}
    >
      <div
        className="channel-row"
        onClick={() => onPreviewChannel?.(channel.id)}
        onContextMenu={handleContextMenu}
      >
        {joined ? <IconVolume size={20} /> : <IconCircle size={20} />}
        <span className="channel-name">{channel.name}</span>
        {unread && (
          <IconPointFilled className="channel-unread-dot" size={12} aria-label="Unread messages" />
        )}
      </div>
      {error && <div style={{ color: '#ed4245', fontSize: 11, paddingLeft: 16 }}>{error}</div>}
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
          onOpenDm={onOpenDm}
          onPoke={onPoke}
          onShowClientSummary={onShowClientSummary}
        />
      ))}
      {showSourcePicker && (
        <ScreenSourcePicker
          onSelect={startShareWithSource}
          onCancel={() => setShowSourcePicker(false)}
        />
      )}

      {menuPos && (
        <div
          className="channel-context-menu"
          ref={menuRef}
          style={{ top: menuPos.y, left: menuPos.x }}
        >
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setMenuPos(null)
              onRequestCreateChannel?.()
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
