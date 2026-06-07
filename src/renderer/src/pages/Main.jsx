import { useState, useEffect } from 'react'
import './Main.css'
import '../App.css'
import { useAuth } from '../context/AuthContext'
import VoiceChannel from '../components/VoiceChannel'
import LoginScreen from '../components/LoginScreen'

function Main() {
  const { token, setToken, client, setClient } = useAuth()
  const [channels, setChannels] = useState([])
  const [clients, setClients] = useState([])
  const [log, setLog] = useState([])
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginError, setLoginError] = useState(null)

  // Handle user login - sends credentials to API and stores auth token
  const handleLogin = () => {
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

    ws.onopen = () => console.log('WebSocket connected')

    ws.onmessage = (event) => {
      const { ev, data } = JSON.parse(event.data)

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

    ws.onclose = () => console.log('WebSocket disconnected')
    ws.onerror = (err) => console.error('WebSocket error:', err)

    window.electron.ipcRenderer.on('log-message', (_, message) => {
      setLog((prev) => [...prev, message])
    })

    return () => {
      ws.close()
      window.electron.ipcRenderer.removeAllListeners('log-message')
    }
  }, [token])

  // Render login screen when user is not authenticated
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

  // Show loading message while fetching channels
  if (!channels.length) return <div className="loading">Hang tight Big Yahu....</div>

  // Render main dashboard with sidebar and activity log
  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="server-name">CNaps Buddies and Friends</div>
        <div className="channel-section-label">Channels</div>
        {channels.map((ch) => (
          <VoiceChannel
            key={ch.id}
            channel={ch}
            clients={clients.filter((c) => c.channel_id === ch.id)}
            token={token}
            self={client}
          />
        ))}
        <div className="admin-btn-wrap">
          <button className="admin-btn" style={{ marginBottom: 8 }} onClick={() => window.electron.ipcRenderer.send('open-settings')}>
            Settings
          </button>
          <button className="admin-btn" onClick={() => window.electron.ipcRenderer.send('open-admin')}>
            Admin Panel
          </button>
        </div>
      </aside>

      <main className="chat-area">
        <div className="chat-header">Activity Log</div>
        <div className="chat-log">
          {log.map((entry, i) => (
            <div key={i} className="log-entry">{entry}</div>
          ))}
        </div>
      </main>
    </div>
  )
}

export default Main