import { useState } from 'react'
import { connect, publish, disconnect, shareScreen, stopScreenShare } from '../lib/soup'
import { useSettings } from '../context/SettingsContext'
import './VoiceChannel.css'

function VoiceChannel({ channel, clients, token, self, onStreamsUpdate }) {
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(null)
  const [sharing, setSharing] = useState(false)
  const [videoStreams, setVideoStreams] = useState([])
  const { micSettings } = useSettings()

  const handleVideoStream = ({ stream, kind, consumerId }) => {
    setVideoStreams((prev) => {
      const updated = [...prev, {
        stream,
        consumerId,
        kind,
        isSelf: false,
        channelId: channel.id,
        channelName: channel.name,
        label: `${channel.name} ${kind === 'video' ? 'Stream' : 'Feed'}`
      }]
      if (onStreamsUpdate) {
        onStreamsUpdate(updated)
      }
      return updated
    })
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
          if (onStreamsUpdate) {
            onStreamsUpdate([])
          }
        },
        onVideoStream: handleVideoStream
      })
    } catch (err) {
      setError(err.message)
      setConnecting(false)
    }
  }

  const handleLeave = async () => {
    disconnect()
    setJoined(false)
    setSharing(false)
    setVideoStreams([])
    if (onStreamsUpdate) {
      onStreamsUpdate([])
    }
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

  const handleScreenShare = async () => {
    if (sharing) {
      await stopScreenShare()
      setSharing(false)
      setVideoStreams((prev) => {
        const remaining = prev.filter((item) => !item.isSelf)
        if (onStreamsUpdate) {
          onStreamsUpdate(remaining)
        }
        return remaining
      })
    } else {
      try {
        const screen = await shareScreen()
        if (screen?.stream) {
          screen.stream.getVideoTracks()[0].onended = () => {
            stopScreenShare()
            setSharing(false)
            setVideoStreams((prev) => {
              const remaining = prev.filter((item) => !item.isSelf)
              if (onStreamsUpdate) {
                onStreamsUpdate(remaining)
              }
              return remaining
            })
          }

          setVideoStreams((prev) => {
            const updated = [...prev, {
              stream: screen.stream,
              consumerId: screen.id,
              kind: 'video',
              isSelf: true,
              channelName: channel.name,
              label: `${self.name || 'You'} (You)`
            }]
            if (onStreamsUpdate) {
              onStreamsUpdate(updated)
            }
            return updated
          })
        }
        setSharing(true)
      } catch (err) {
        console.error('[VoiceChannel] Screen share failed:', err)
        setError(err.message)
      }
    }
  }

  return (
    <div>
      <div className="channel-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {channel.name}
        <div style={{ display: 'flex', gap: 4 }}>
          {joined && (
            <button
              className="share-btn"
              onClick={handleScreenShare}
              style={{ background: sharing ? '#faa61a' : '#5865f2' }}
            >
              {sharing ? 'Stop' : 'Share'}
            </button>
          )}
          {!joined ? (
            <button className="join-btn" onClick={handleJoin} disabled={connecting}>
              {connecting ? '...' : 'Join'}
            </button>
          ) : (
            <button className="leave-btn" onClick={handleLeave} style={{ background: '#ed4245' }}>
              Leave
            </button>
          )}
        </div>
      </div>
      {error && <div style={{ color: '#ed4245', fontSize: 11, paddingLeft: 16 }}>{error}</div>}
      {clients.map((c) => (
        <div key={c.id} className="client-indicator">{c.name}</div>
      ))}
    </div>
  )
}

export default VoiceChannel