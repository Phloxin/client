import { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { connect, publish, republish, disconnect, shareScreen, stopScreenShare, rebindCallbacks, createSpeakingDetector } from '../lib/soup'
import { useSettings } from '../context/SettingsContext'
import ClientIndicator from './ClientIndicator'
import ScreenSourcePicker from './ScreenSourcePicker'
import './VoiceChannel.css'
import { IconVolume } from '@tabler/icons-react'

const VoiceChannel = forwardRef(function VoiceChannel(
  { channel, clients, token, self, micMuted, deafened, onStreamsUpdate, onJoinedChange, onSharingChange, onRequestJoin },
  ref
) {
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(null)
  const [sharing, setSharing] = useState(false)
  const [showSourcePicker, setShowSourcePicker] = useState(false)
  const [videoStreams, setVideoStreams] = useState([])
  const [speakingClients, setSpeakingClients] = useState({})
  const { micSettings } = useSettings()

  const joinedRef = useRef(false)
  const localSpeakingCleanupRef = useRef(null)

  // Keep joinedRef in sync with joined state
  useEffect(() => { joinedRef.current = joined }, [joined])

  // Let the sidebar know when this channel becomes the joined/sharing one
  useEffect(() => { onJoinedChange?.(channel.id, joined) }, [joined])
  useEffect(() => { onSharingChange?.(channel.id, sharing) }, [sharing])

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

  // Republish audio whenever mic settings change while in a channel
  useEffect(() => {
    if (!joinedRef.current) return
    republish(micSettings, startLocalSpeakingDetector).catch((err) => {
      console.error('[VoiceChannel] Republish failed:', err)
      setError(err.message)
    })
  }, [micSettings])

  // Clean up local speaking detector on unmount
  useEffect(() => () => { localSpeakingCleanupRef.current?.() }, [])

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
      const updated = [...prev, {
        stream,
        consumerId,
        kind,
        isSelf: false,
        clientId,
        channelId: channel.id,
        channelName: channel.name,
        fallbackLabel: `${channel.name} ${kind === 'video' ? 'Stream' : 'Feed'}`
      }]
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
      await fetch('/api/server/client', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ client_id: self.id, channel_id: channel.id })
      })

      await connect(token, {
        onConnect: async () => {
          setJoined(true)
          setConnecting(false)
          try {
            await publish(micSettings, (stream) => {
              console.log('[VoiceChannel] Local stream ready')
              startLocalSpeakingDetector(stream)
            })
          } catch (err) {
            console.error('[VoiceChannel] Publish failed:', err)
            setError(err.message)
          }
        },
        onDisconnect: () => {
          setJoined(false)
          setSharing(false)
          setVideoStreams([])
          setSpeakingClients({})
          localSpeakingCleanupRef.current?.()
          localSpeakingCleanupRef.current = null
          if (onStreamsUpdate) onStreamsUpdate([])
        },
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
    // must already be active to catch it.
    rebindCallbacks({
      onVideoStream: handleVideoStream,
      onClientSpeaking: handleClientSpeaking,
      onConsumerClosed: handleConsumerClosed,
      onTransportsDisconnected: async () => {
        setJoined(true)
        setConnecting(false)
        try {
          await publish(micSettings, (stream) => {
            console.log('[VoiceChannel] Local stream ready')
            startLocalSpeakingDetector(stream)
          })
        } catch (err) {
          console.error('[VoiceChannel] Publish failed:', err)
          setError(err.message)
        }
      }
    })

    try {
      await fetch('/api/server/client', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ client_id: self.id, channel_id: channel.id })
      })
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

  const handleLeave = async () => {
    disconnect()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    setSpeakingClients({})
    localSpeakingCleanupRef.current?.()
    localSpeakingCleanupRef.current = null
    if (onStreamsUpdate) onStreamsUpdate([])
    try {
      await fetch('/api/server/client', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ client_id: self.id, channel_id: null })
      })
    } catch (err) {
      console.error('[VoiceChannel] Failed to leave channel:', err)
    }
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
  const startShareWithSource = async (sourceId) => {
    setShowSourcePicker(false)
    // Tell the main process which source the display-media handler should use
    window.electron.ipcRenderer.send('set-screen-source', sourceId)
    try {
      const screen = await shareScreen()
      if (screen?.stream) {
        screen.stream.getVideoTracks()[0].onended = () => {
          stopScreenShare()
          setSharing(false)
          clearSelfStream()
        }

        setVideoStreams((prev) => {
          const updated = [...prev, {
            stream: screen.stream,
            consumerId: screen.id,
            kind: 'video',
            isSelf: true,
            clientId: self.id,
            channelName: channel.name,
            fallbackLabel: self.name || 'You'
          }]
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

  return (
    <div className={`channel-item${joined ? ' active' : ''}`} onDoubleClick={handleDoubleClick}>
      <div className="channel-row">
        <IconVolume size={20}/>
        <span className="channel-name">{channel.name}</span>
      </div>
      {error && <div style={{ color: '#ed4245', fontSize: 11, paddingLeft: 16 }}>{error}</div>}
      {clients.map((c) => (
        <ClientIndicator
          key={c.id}
          client={c}
          speaking={!!speakingClients[c.id]}
          micMuted={c.id === self.id ? micMuted : !!c.self_mute}
          deafened={c.id === self.id ? deafened : !!c.self_deaf}
        />
      ))}
      {showSourcePicker && (
        <ScreenSourcePicker
          onSelect={startShareWithSource}
          onCancel={() => setShowSourcePicker(false)}
        />
      )}
    </div>
  )
})

export default VoiceChannel