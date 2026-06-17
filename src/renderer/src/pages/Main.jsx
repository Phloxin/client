import { useState, useEffect, useRef } from 'react'
import './Main.css'
import '../App.css'
import { useAuth } from '../context/AuthContext'
import SideBar from '../components/SideBar'
import VideoGrid from '../components/VideoGrid'
import ChatPanel from '../components/ChatPanel'
import Settings from './Settings'
import { disconnect as disconnectVoice, setFocusedScreenAudio } from '../lib/soup'
import { setServerHost, apiBase, wsBase } from '../lib/serverConfig'
import { DEV_MODE, MOCK_TOKEN, MOCK_CLIENT, MOCK_CHANNELS, MOCK_CLIENTS, createMockStreams } from '../lib/mock'
import { IconVideo, IconMessage2, IconMessage } from '@tabler/icons-react'

const MAX_LOG_ENTRIES = 500
const HISTORY_LIMIT = 50

// Append an entry to the feed, dropping the oldest entries once the cap is hit.
function appendFeed(prev, entry) {
  const next = [...prev, entry]
  return next.length > MAX_LOG_ENTRIES ? next.slice(next.length - MAX_LOG_ENTRIES) : next
}

// Build a system (non-chat) feed entry, e.g. join/leave notices
function systemEntry(text) {
  return { id: crypto.randomUUID(), type: 'system', text, ts: Date.now() }
}

// Build a chat-feed entry from a MessageApiObject (POST response or MessageCreated event)
function messageFromApi(msg) {
  return {
    id: msg.id,
    type: 'message',
    channelId: msg.channel_id,
    authorId: msg.author,
    text: msg.content,
    attachments: (msg.attachments || []).map((a) => ({
      id: a.id,
      name: a.filename,
      kind: kindFromContentType(a.content_type),
      url: a.url
    })),
    ts: Date.now()
  }
}

function kindFromContentType(type) {
  if (type?.startsWith('image/')) return 'image'
  if (type?.startsWith('video/')) return 'video'
  return 'file'
}

function Main() {
  const { token, setToken, client, setClient } = useAuth()
  const [channels, setChannels] = useState([])
  const [clients, setClients] = useState([])
  const [feed, setFeed] = useState([])
  const [viewMode, setViewMode] = useState('log') // 'log' or 'video'
  const [allVideoStreams, setAllVideoStreams] = useState([])
  const [selectedStreamId, setSelectedStreamId] = useState(null)
  const [servers, setServers] = useState([])
  const [connectedServer, setConnectedServer] = useState(null)
  const [poppedOut, setPoppedOut] = useState(false)
  // Stream playback volume (0..100) and mute, owned here so they're shared
  // between the in-app grid and the popout window (popping out must not reset
  // a volume the user already lowered).
  const [streamVolume, setStreamVolume] = useState(100)
  const [streamMuted, setStreamMuted] = useState(false)
  const eventsWsRef = useRef(null)
  const channelsRef = useRef([])
  const clientsRef = useRef([])
  const popoutWindowRef = useRef(null)
  const popoutListenersRef = useRef(new Set())
  const allVideoStreamsRef = useRef([])
  const selectedStreamIdRef = useRef(null)
  const streamVolumeRef = useRef(100)
  const streamMutedRef = useRef(false)

  // Keep refs to the latest channels/clients so the events websocket handler
  // (created once in the effect below) can look them up without stale closures.
  useEffect(() => { channelsRef.current = channels }, [channels])
  useEffect(() => { clientsRef.current = clients }, [clients])

  // Keep refs to the latest streams/selection/volume so the popout bridge (set
  // up once below) always reads current values without stale closures.
  useEffect(() => { allVideoStreamsRef.current = allVideoStreams }, [allVideoStreams])
  useEffect(() => { selectedStreamIdRef.current = selectedStreamId }, [selectedStreamId])
  useEffect(() => { streamVolumeRef.current = streamVolume }, [streamVolume])
  useEffect(() => { streamMutedRef.current = streamMuted }, [streamMuted])

  // Notify the popout window whenever the data it mirrors changes.
  useEffect(() => {
    popoutListenersRef.current.forEach((cb) => cb())
  }, [allVideoStreams, clients, selectedStreamId, streamVolume, streamMuted])

  // Expose a bridge the popout window reads via window.opener. Live MediaStream
  // objects are shared by reference (same origin/process), never serialized.
  useEffect(() => {
    window.__videoPopout = {
      getData: () => ({
        streams: allVideoStreamsRef.current,
        clients: clientsRef.current,
        selectedStreamId: selectedStreamIdRef.current,
        volume: streamVolumeRef.current,
        muted: streamMutedRef.current
      }),
      select: (id) => setSelectedStreamId(id),
      setVolume: (v) => setStreamVolume(v),
      setMuted: (m) => setStreamMuted(m),
      setFocusedAudio: (clientId, opts) => setFocusedScreenAudio(clientId, opts),
      subscribe: (cb) => {
        popoutListenersRef.current.add(cb)
        return () => popoutListenersRef.current.delete(cb)
      }
    }
    return () => { delete window.__videoPopout }
  }, [])

  // Pop the video grid out into its own window: switch the main window back to
  // chat (the toggle stays disabled while popped out) and open the popout.
  const handlePopout = () => {
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.focus()
      return
    }
    const url = `${window.location.href.split('#')[0]}#/popout`
    const win = window.open(url, 'video-popout', 'width=960,height=600')
    if (!win) return
    popoutWindowRef.current = win
    setPoppedOut(true)
    setViewMode('log')
  }

  // While popped out, watch for the popout window closing (via its controls or
  // app shutdown) and restore the in-app stream view + re-enable the toggle.
  useEffect(() => {
    if (!poppedOut) return
    const id = setInterval(() => {
      if (!popoutWindowRef.current || popoutWindowRef.current.closed) {
        popoutWindowRef.current = null
        setPoppedOut(false)
        setViewMode('video')
      }
    }, 500)
    return () => clearInterval(id)
  }, [poppedOut])

  // The channel the local client currently has joined (chat is scoped to it)
  const selfChannelId = clients.find((c) => c.id === client?.id)?.channel_id ?? null

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

  // Load recent message history whenever the local client enters a channel, so
  // opening a channel shows what was said before we got here. The request goes
  // through the main process because the endpoint is a GET with a JSON body.
  useEffect(() => {
    if (DEV_MODE || !token || selfChannelId == null) return
    let cancelled = false
    const channelId = selfChannelId

    window.electron.ipcRenderer
      .invoke('get-channel-messages', {
        url: `${apiBase()}/channels/${channelId}/messages`,
        token,
        limit: HISTORY_LIMIT
      })
      .then((res) => {
        if (cancelled) return
        if (!res?.ok) {
          if (res?.error) console.error('Failed to load chat history:', res.error)
          return
        }
        const history = (res.messages || []).map(messageFromApi).sort((a, b) => a.id - b.id)
        if (!history.length) return
        setFeed((prev) => {
          // Replace this channel's messages with the authoritative fetched set
          // (deduped) and show them above the current session's entries.
          const rest = prev.filter((e) => !(e.type === 'message' && e.channelId === channelId))
          return [...history, ...rest]
        })
      })
      .catch((err) => console.error('Failed to load chat history:', err))

    return () => {
      cancelled = true
    }
  }, [token, selfChannelId])

  // Load the saved server list from the main process on mount
  useEffect(() => {
    window.electron.ipcRenderer.invoke('get-servers').then((list) => {
      if (Array.isArray(list)) setServers(list)
    })
  }, [])

  // Persist a server list change and keep local state in sync
  const saveServers = (list) => {
    setServers(list)
    window.electron.ipcRenderer.send('store-servers', list)
  }

  const handleAddServer = (server) => saveServers([...servers, server])

  const handleRemoveServer = (id) => saveServers(servers.filter((s) => s.id !== id))

  // Connect to a saved server: point all endpoints at its host, then log in with
  // its stored credentials. Setting the token triggers the data-loading effect.
  const handleConnect = async (server) => {
    if (DEV_MODE) {
      setServerHost(server.host)
      setToken(MOCK_TOKEN)
      setClient(MOCK_CLIENT)
      setConnectedServer(server)
      return
    }

    setServerHost(server.host)
    try {
      const res = await fetch(`${apiBase()}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: server.username, password: server.password })
      })
      const data = await res.json()
      if (data.token) {
        setToken(data.token)
        setClient(data.client)
        setConnectedServer(server)
      } else {
        setServerHost(null)
        setFeed([systemEntry(`Failed to connect to ${server.nickname}: ${data.message || 'login failed'}`)])
      }
    } catch {
      setServerHost(null)
      setFeed([systemEntry(`Failed to connect to ${server.nickname}: could not reach server`)])
    }
  }

  // Disconnect from the current server and return to the disconnected state.
  // Clearing the token tears down the events websocket via the effect cleanup.
  const handleDisconnect = () => {
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.close()
    }
    popoutWindowRef.current = null
    setPoppedOut(false)
    disconnectVoice()
    setToken(null)
    setClient(null)
    setChannels([])
    setClients([])
    setFeed([])
    setAllVideoStreams([])
    setConnectedServer(null)
    setServerHost(null)
  }

  // Fetch channels/clients and set up WebSocket + IPC listeners on mount
  useEffect(() => {
    if (!token) return

    if (DEV_MODE) {
      setChannels(MOCK_CHANNELS)
      setClients(MOCK_CLIENTS)
      setFeed([systemEntry('Connected to server (dev mode)')])
      const mockStreams = createMockStreams()
      setAllVideoStreams(mockStreams)
      return () => mockStreams.forEach((s) => s._stopMock?.())
    }

    Promise.all([
      fetch(`${apiBase()}/server/channel`, {
        headers: { Authorization: `Bearer ${token}` }
      }),
      fetch(`${apiBase()}/server/client`, {
        headers: { Authorization: `Bearer ${token}` }
      })
    ]).then(async ([channelRes, clientRes]) => {
      // A token may be stale/expired - drop it and return to the disconnected state
      if (channelRes.status === 401 || clientRes.status === 401) {
        setToken(null)
        setClient(null)
        setConnectedServer(null)
        setServerHost(null)
        return
      }

      const [channelData, clientData] = await Promise.all([channelRes.json(), clientRes.json()])
      setChannels(channelData)
      // The REST payload uses `muted`/`deaf`, but voice-state updates (and the
      // rest of the UI) use `self_mute`/`self_deaf` - normalize on the way in.
      setClients(clientData.map((c) => ({ ...c, self_mute: c.muted, self_deaf: c.deaf })))
      setFeed([systemEntry('Connected to server')])
    }).catch((err) => console.error('Failed to fetch:', err))

    const ws = new WebSocket(`${wsBase()}/ws`)
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
        setClients((prev) => [...prev, { ...data, self_mute: data.muted, self_deaf: data.deaf }])
        setFeed((prev) => appendFeed(prev, systemEntry(`${data.name} joined the server`)))
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

        setFeed((prev) => appendFeed(prev, systemEntry(message)))
        setClients((prev) => prev.map((c) => c.id === data.id ? { ...c, channel_id: data.channel_id } : c))
      } else if (ev === 'MessageCreated') {
        setFeed((prev) => appendFeed(prev, messageFromApi(data)))
      } else {
        setFeed((prev) => appendFeed(prev, systemEntry(`Unknown event: ${ev}`)))
      }
    }
    ws.onclose = () => {
      console.log('WebSocket disconnected')
      eventsWsRef.current = null
    }
    ws.onerror = (err) => console.error('WebSocket error:', err)

    window.electron.ipcRenderer.on('log-message', (_, message) => {
      setFeed((prev) => appendFeed(prev, systemEntry(message)))
    })

    return () => {
      ws.close()
      eventsWsRef.current = null
      window.electron.ipcRenderer.removeAllListeners('log-message')
    }
  }, [token])

  // Send a chat message (with any attachments) to the channel we're currently in
  const handleSendMessage = async (text, attachments) => {
    if (DEV_MODE) {
      setFeed((prev) => appendFeed(prev, {
        id: crypto.randomUUID(),
        type: 'message',
        channelId: selfChannelId,
        author: client?.name,
        authorId: client?.id,
        text,
        attachments,
        ts: Date.now()
      }))
      return
    }

    if (selfChannelId == null) return

    const payload = {
      content: text || undefined,
      attachments: attachments.map((a, i) => ({ id: i, filename: a.file.name, description: null }))
    }

    const formData = new FormData()
    formData.append('payload_json', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
    attachments.forEach((a, i) => formData.append(`files[${i}]`, a.file, a.file.name))
    attachments.forEach((a) => URL.revokeObjectURL(a.url))

    try {
      const res = await fetch(`${apiBase()}/channels/${selfChannelId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData
      })
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      // The server broadcasts MessageCreated back to us too, which appends it to the feed
    } catch (err) {
      setFeed((prev) => appendFeed(prev, systemEntry(`Failed to send message: ${err.message}`)))
    }
  }

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

  const connected = !!token

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
        servers={servers}
        connectedServer={connectedServer}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onAddServer={handleAddServer}
        onRemoveServer={handleRemoveServer}
      />

      <main className="chat-area">
        <div className="chat-header">
          <div className="header-content">
            <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {viewMode === 'log' ? (
                <>
                  <IconMessage size={18} stroke={2} />
                  Chat
                </>
              ) : (
                <>
                  <IconVideo size={18} stroke={2} />
                  Video Streams
                </>
              )}
            </span>
            {connected && (
              <button
                className="view-toggle-btn"
                onClick={() => setViewMode(viewMode === 'log' ? 'video' : 'log')}
                disabled={poppedOut}
                title={poppedOut ? 'Video is open in a separate window' : undefined}
              >
                {viewMode === 'log' ? <IconVideo size={18}/> : <IconMessage2 size={18}/>}
              </button>
            )}
          </div>
        </div>

        {!connected ? (
          <div className="disconnected-placeholder">
            <p className="disconnected-title">Not connected</p>
            <p className="disconnected-subtitle">
              Pick a server from the <strong>Connect</strong> menu to get started.
            </p>
          </div>
        ) : viewMode === 'log' ? (
          <ChatPanel
            feed={feed.filter((e) => e.type === 'system' || e.channelId === selfChannelId)}
            clients={clients}
            onSend={handleSendMessage}
            disabled={selfChannelId == null}
          />
        ) : (
          <VideoGrid
            streams={allVideoStreams}
            clients={clients}
            selectedStreamId={selectedStreamId}
            onSelect={setSelectedStreamId}
            onPopout={handlePopout}
            volume={streamVolume}
            muted={streamMuted}
            onVolumeChange={setStreamVolume}
            onMutedChange={setStreamMuted}
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