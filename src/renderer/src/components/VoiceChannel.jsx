import { useState } from 'react'
import { connect, publish, disconnect } from '../lib/soup'

function VoiceChannel({ channel, clients, token, self }) {
  const [joined, setJoined] = useState(false)
  const [connecting, setConnecting] = useState(false)
  const [error, setError] = useState(null)

  const handleJoin = async () => {
    setConnecting(true)
    setError(null)
    try {
      // Step 1 — PATCH to move self into channel
      await fetch('/api/server/client', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({ client_id: self.id, channel_id: channel.id })
      })

      // Step 2 — connect to voice
      await connect(token, {
        onConnect: async () => {
          setJoined(true)
          setConnecting(false)
          // Step 3 — start publishing after authenticated
          try {
            await publish((stream) => {
              console.log('[VoiceChannel] Local stream ready')
            })
          } catch (err) {
            console.error('[VoiceChannel] Publish failed:', err)
            setError(err.message)
          }
        },
        onDisconnect: () => {
          setJoined(false)
        }
      })
    } catch (err) {
      setError(err.message)
      setConnecting(false)
    }
  }

  const handleLeave = async () => {
    disconnect()
    setJoined(false)
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

  return (
    <div>
      <div className="channel-item" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        {channel.name}
        {!joined ? (
          <button className="join-btn" onClick={handleJoin} disabled={connecting}>
            {connecting ? '...' : 'Join'}
          </button>
        ) : (
          <button className="join-btn" onClick={handleLeave} style={{ background: '#ed4245' }}>
            Leave
          </button>
        )}
      </div>
      {error && <div style={{ color: '#ed4245', fontSize: 11, paddingLeft: 16 }}>{error}</div>}
      {clients.map((c) => (
        <div key={c.id} className="client-indicator">{c.name}</div>
      ))}
    </div>
  )
}

export default VoiceChannel