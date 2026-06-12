import { useState, useEffect, useRef } from 'react'
import './Main.css'
import '../App.css'
import { useAuth } from '../context/AuthContext'
import SideBar from '../components/SideBar'
import VideoGrid from '../components/VideoGrid'
import LoginScreen from '../components/LoginScreen'
import Settings from './Settings'
import { DEV_MODE, MOCK_TOKEN, MOCK_CLIENT, MOCK_CHANNELS, MOCK_CLIENTS } from '../lib/mock'
import { IconVideoFilled, IconMessage2Filled, IconMessage, IconVideo } from '@tabler/icons-react'

function Main() {
  const { token, setToken, client, setClient } = useAuth()
  const [channels, setChannels] = useState([])
  const [clients, setClients] = useState([])
  const [log, setLog] = useState([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState(null)
  const [viewMode, setViewMode] = useState('log') // 'log' or 'video'
  const [allVideoStreams, setAllVideoStreams] = useState([])
  const [selectedStreamId, setSelectedStreamId] = useState(null)
  const eventsWsRef = useRef(null)

  // Keep a focused stream selected when streams change
  useEffect(() => {
    if (!allVideoStreams.length) {
      setSelectedStreamId(null)
      return
    }
    if (!selectedStreamId || !allVideoStreams.some((s) => s.consumerId === selectedStreamId)) {
      setSelectedStreamId(allVideoStreams[0].consumerId)
    }
  }, [allVideoStreams, selectedStreamId])

  // Handle user login - sends credentials to API and stores auth token
  const handleLogin = () => {
    if (DEV_MODE) {
      setToken(MOCK_TOKEN)
      setClient(MOCK_CLIENT)
      setLoginError(null)
      return
    }

    fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.token) {
          setToken(data.token)
          setClient(data.client)
          setLoginError(null)
        } else {
          setLoginError(data.message || 'Login failed')
        }
      })
      .catch(() => setLoginError('Login failed'))
  }

  // Fetch channels/clients and set up WebSocket + IPC listeners on mount
  useEffect(() => {
    if (!token) return

    if (DEV_MODE) {
      setChannels(MOCK_CHANNELS)
      setClients(MOCK_CLIENTS)
      setLog(['Connected to server (dev mode)'])
      return
    }

    Promise.all([
      fetch('/api/server/channel', {
        headers: { Authorization: `Bearer ${token}` }
      }).then((res) => res.json()),
      fetch('/api/server/client', {
        headers: { Authorization: `Bearer ${token}` }
      }).then((res) => res.json())
    ]).then(([channelData, clientData]) => {
      setChannels(channelData)
      setClients(clientData)
      setLog(['Connected to server'])
    }).catch((err) => console.error('Failed to fetch:', err))

    const ws = new WebSocket('ws://47.16.222.82:3000/ws')
    eventsWsRef.current = ws
    ws.onopen = () => {
      console.log('WebSocket connected')
      ws.send(JSON.stringify({ op: 0, data: { token } }))
    }
    ws.onmessage = (event) => {
      const { ev, data } = JSON.parse(event.data)

      // Audio status update (mic mute / deafen) broadcast from another client
      if (ev === 'VoiceStateUpdate') {
        const { client_id, muted, deaf } = data
        setClients((prev) => prev.map((c) => c.id === client_id ? { ...c, self_mute: muted, self_deaf: deaf } : c))
        return
      }

      if (ev === 'NewUser') {
        setClients((prev) => [...prev, data])
        setLog((prev) => [...prev, `${data.name} joined the server`])
      } else if (ev === 'ClientModified') {
        setClients((prev) => prev.map((c) => c.id === data.id ? { ...c, channel_id: data.channel_id } : c))
        setLog((prev) => [...prev, `${data.name} moved to a new channel`])
      } else {
        setLog((prev) => [...prev, `Unknown event: ${ev}`])
      }
    }
    ws.onclose = () => {
      console.log('WebSocket disconnected')
      eventsWsRef.current = null
    }
    ws.onerror = (err) => console.error('WebSocket error:', err)

    window.electron.ipcRenderer.on('log-message', (_, message) => {
      setLog((prev) => [...prev, message])
    })

    return () => {
      ws.close()
      eventsWsRef.current = null
      window.electron.ipcRenderer.removeAllListeners('log-message')
    }
  }, [token])

  // Broadcast our mic-mute / deafen status to other clients
  const sendStatus = (selfMute, selfDeaf) => {
    if (eventsWsRef.current?.readyState === WebSocket.OPEN) {
      eventsWsRef.current.send(JSON.stringify({ op: 1, data: { self_mute: selfMute, self_deaf: selfDeaf } }))
    }
  }

  // Merge stream updates from a specific channel into the global streams list
  const handleStreamsUpdate = (channelId, streams) => {
    setAllVideoStreams((prev) => {
      const filtered = prev.filter((s) => s.channelId !== channelId)
      return [...filtered, ...streams.map((s) => ({ ...s, channelId }))]
    })
  }

  const [showSettings, setShowSettings] = useState(false)

  if (!token) {
    return (
      <LoginScreen
        username={username}
        password={password}
        onUsernameChange={setUsername}
        onPasswordChange={setPassword}
        onLogin={handleLogin}
        loginError={loginError}
      />
    )
  }

  if (!channels.length) return <div className="loading">Hang tight....</div>

  return (
    <div className="layout">
      <SideBar
        channels={channels}
        clients={clients}
        token={token}
        self={client}
        onStreamsUpdate={handleStreamsUpdate}
        onStatusChange={sendStatus}
        // provide a renderer-level openSettings hook
        onOpenSettings={() => setShowSettings(true)}
      />

      <main className="chat-area">
        <div className="chat-header">
          <div className="header-content">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {viewMode === 'log' ? (
                <>
                  <IconMessage size={18} stroke={2} />
                  Chat Log
                </>
              ) : (
                <>
                  <IconVideo size={18} stroke={2} />
                  Video Streams
                </>
              )}
            </span>
            <button
              className="view-toggle-btn"
              onClick={() => setViewMode(viewMode === 'log' ? 'video' : 'log')}
            >
              {viewMode === 'log' ? <IconVideoFilled size={18}/> : <IconMessage2Filled size={18}/>}
            </button>
          </div>
        </div>

        {viewMode === 'log' ? (
          <div className="chat-log">
            {log.map((entry, i) => (
              <div key={i} className="log-entry">{entry}</div>
            ))}
          </div>
        ) : (
          <VideoGrid
            streams={allVideoStreams}
            selectedStreamId={selectedStreamId}
            onSelect={setSelectedStreamId}
          />
        )}
      </main>
      {showSettings && (
        <div className="settings-overlay" onClick={() => setShowSettings(false)}>
          <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
            <button className="settings-close-btn" onClick={() => setShowSettings(false)}>
              ×
            </button>
            <Settings />
          </div>
        </div>
      )}
    </div>
  )
}

export default Main