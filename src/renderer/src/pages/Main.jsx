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

const MAX_LOG_ENTRIES = 500

// Append an entry to the log, dropping the oldest entries once the cap is hit.
function appendLog(prev, entry) {
  const next = [...prev, entry]
  return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next
}

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
  const channelsRef = useRef([])
  const clientsRef = useRef([])

  // Keep refs to the latest channels/clients so the events websocket handler
  // (created once in the effect below) can look them up without stale closures.
  useEffect(() => { channelsRef.current = channels }, [channels])
  useEffect(() => { clientsRef.current = clients }, [clients])

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
      }),
      fetch('/api/server/client', {
        headers: { Authorization: `Bearer ${token}` }
      })
    ]).then(async ([channelRes, clientRes]) => {
      // A stored token may be stale/expired - drop it and return to the login screen
      if (channelRes.status === 401 || clientRes.status === 401) {
        setToken(null)
        setClient(null)
        window.electron.ipcRenderer.send('clear-auth')
        return
      }

      const [channelData, clientData] = await Promise.all([channelRes.json(), clientRes.json()])
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
        setLog((prev) => appendLog(prev, `${data.name} joined the server`))
      } else if (ev === 'ClientModified') {
        const channelName = (id) => channelsRef.current.find((ch) => ch.id === id)?.name || 'Unknown Channel'
        const oldChannelId = clientsRef.current.find((c) => c.id === data.id)?.channel_id

        let message
        if (data.channel_id == null) {
          message = `${data.name} left ${channelName(oldChannelId)}`
        } else if (oldChannelId == null) {
          message = `${data.name} joined ${channelName(data.channel_id)}`
        } else {
          message = `${data.name} moved to ${channelName(data.channel_id)}`
        }

        setLog((prev) => appendLog(prev, message))
        setClients((prev) => prev.map((c) => c.id === data.id ? { ...c, channel_id: data.channel_id } : c))
      } else {
        setLog((prev) => appendLog(prev, `Unknown event: ${ev}`))
      }
    }
    ws.onclose = () => {
      console.log('WebSocket disconnected')
      eventsWsRef.current = null
    }
    ws.onerror = (err) => console.error('WebSocket error:', err)

    window.electron.ipcRenderer.on('log-message', (_, message) => {
      setLog((prev) => appendLog(prev, message))
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
            clients={clients}
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