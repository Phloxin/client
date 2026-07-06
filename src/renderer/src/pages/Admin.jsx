import { useState, useEffect } from 'react'
import './Admin.css'
import { useAuth } from '../context/AuthContext'

const API_BASE_URL = 'https://47.16.222.82:3000'

function Admin() {
  const { token, setToken } = useAuth()
  const [channels, setChannels] = useState([])
  const [clients, setClients] = useState([])
  const [selectedClient, setSelectedClient] = useState('')
  const [selectedChannel, setSelectedChannel] = useState('')
  const [status, setStatus] = useState(null)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loginStatus, setLoginStatus] = useState(null)

  useEffect(() => {
    if (!token) return

    Promise.all([
      fetch(`${API_BASE_URL}/server/channel`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then((res) => res.json()),
      fetch(`${API_BASE_URL}/server/client`, {
        headers: { Authorization: `Bearer ${token}` }
      }).then((res) => res.json())
    ])
      .then(([channelData, clientData]) => {
        setChannels(channelData)
        setClients(clientData)
        setSelectedClient(String(clientData[0]?.id))
        setSelectedChannel(String(channelData[0]?.id))
      })
      .catch((err) => console.error('Failed to fetch:', err))
  }, [token])

  const moveClient = () => {
    fetch(`${API_BASE_URL}/server/client`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        client_id: selectedClient,
        channel_id: selectedChannel
      })
    })
      .then(() => setStatus('Moved successfully'))
      .catch(() => setStatus('Failed to move'))
  }

  const handleLogin = () => {
    fetch(`${API_BASE_URL}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    })
      .then((res) => res.json())
      .then((data) => {
        if (data.token) {
          console.log('Auth token:', data.token)
          setToken(data.token)
          setLoginStatus('Login successful')
          window.electron.ipcRenderer.send('admin-log', `Admin logged in — token: ${data.token}`)

          Promise.all([
            fetch(`${API_BASE_URL}/server/channel`, {
              headers: { Authorization: `Bearer ${data.token}` }
            }).then((res) => res.json()),
            fetch(`${API_BASE_URL}/server/client`, {
              headers: { Authorization: `Bearer ${data.token}` }
            }).then((res) => res.json())
          ]).then(([channelData, clientData]) => {
            setChannels(channelData)
            setClients(clientData)
            setSelectedClient(String(clientData[0]?.id))
            setSelectedChannel(String(channelData[0]?.id))
          })
        } else {
          setLoginStatus(data.message || 'Login failed')
        }
      })
      .catch(() => setLoginStatus('Login failed'))
  }

  return (
    <div className="admin-layout">
      <div className="admin-header">Admin Panel</div>
      <div className="admin-body">
        <div className="admin-section">
          <label>Username</label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Enter username"
          />
        </div>
        <div className="admin-section">
          <label>Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Enter password"
          />
        </div>
        <button className="admin-btn" onClick={handleLogin}>
          Login
        </button>
        {loginStatus && <div className="admin-status">{loginStatus}</div>}
        {token && (
          <div className="admin-status" style={{ color: '#57f287' }}>
            Token active
          </div>
        )}
        <hr />
        <div className="admin-section">
          <label>Client</label>
          <select value={selectedClient} onChange={(e) => setSelectedClient(e.target.value)}>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="admin-section">
          <label>Channel</label>
          <select value={selectedChannel} onChange={(e) => setSelectedChannel(e.target.value)}>
            {channels.map((ch) => (
              <option key={ch.id} value={ch.id}>
                {ch.name}
              </option>
            ))}
          </select>
        </div>
        <button className="admin-btn" onClick={moveClient}>
          Move
        </button>
        {status && <div className="admin-status">{status}</div>}
      </div>
    </div>
  )
}

export default Admin
