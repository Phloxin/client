import { useState, useEffect, useRef, useCallback } from 'react'
import './Main.css'
import '../App.css'
import { useAuth } from '../context/AuthContext'
import SideBar from '../components/SideBar'
import VideoGrid from '../components/VideoGrid'
import ChatPanel from '../components/ChatPanel'
import TitleBar from '../components/TitleBar'
import ConnectionOverlay from '../components/ConnectionOverlay'
import Settings from './Settings'
import {
  disconnect as disconnectVoice,
  setFocusedScreenAudio,
  setVideoStreamRoles
} from '../lib/soup'
import { playUiSound } from '../lib/sounds'
import { setServerHost, apiBase, wsBase } from '../lib/serverConfig'
import { usePillIndicator } from '../lib/usePillIndicator'
import {
  DEV_MODE,
  MOCK_TOKEN,
  MOCK_CLIENT,
  MOCK_CHANNELS,
  MOCK_CLIENTS,
  createMockStreams
} from '../lib/mock'
import { IconVideo, IconMessage, IconUsersGroup, IconX } from '@tabler/icons-react'

const APP_TITLE = 'Teamspeak 26'

//Various Timing Definitions
const MAX_LOG_ENTRIES = 500
const HISTORY_LIMIT = 50
const HEARTBEAT_INTERVAL_MS = 10000
const RECONNECT_BASE_DELAY_MS = 1000
const RECONNECT_MAX_DELAY_MS = 30000
const TYPING_DURATION_MS = 10000

// Grace period after (re)connecting or changing channels during which streams
// already in view are adopted silently (no chime / "started a stream" toast).
// Sized to cover the gap between the events socket reporting healthy and the
// voice socket re-consuming streams after a reconnect.
const STREAM_BASELINE_MS = 2000

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
    // Link-preview / rich cards. URLs (incl. attachment://) are resolved
    // server-side, so they're render-ready. May arrive later via MessageUpdated.
    embeds: msg.embeds || [],
    // Server timestamp is seconds since the UNIX epoch; JS Date wants ms.
    ts: msg.timestamp,
    // Milliseconds since the UNIX epoch of the last edit, or null if never
    // edited. Drives the "(edited)" marker; set/refreshed via MessageUpdated.
    editedTs: msg.edited_timestamp ?? null
  }
}

function kindFromContentType(type) {
  if (type?.startsWith('image/')) return 'image'
  if (type?.startsWith('video/')) return 'video'
  return 'file'
}

function byChronology(a, b) {
  if (a.ts !== b.ts) return a.ts - b.ts
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
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
  // Events-socket health: 'connected' normally, 'reconnecting' once a drop is
  // detected and we're retrying. Drives the full-app reconnect overlay.
  const [connectionStatus, setConnectionStatus] = useState('connected')
  const [poppedOut, setPoppedOut] = useState(false)
  // Stream playback volume (0..100) and mute, owned here so they're shared
  // between the in-app grid and the popout window (popping out must not reset
  // a volume the user already lowered).
  const [streamVolume, setStreamVolume] = useState(100)
  const [streamMuted, setStreamMuted] = useState(false)
  // Which streams the user is actively watching. Streams default to stopped, so
  // a stream is only consumed once its id is in here. Owned at this level (not in
  // VideoGrid) so the choice survives chat/popout view switches that unmount the
  // grid, and is shared with the popout window via the bridge below.
  const [watchedStreamIds, setWatchedStreamIds] = useState(() => new Set())
  // Server notifications shown in the title-bar bell (newest first).
  const [notifications, setNotifications] = useState([])
  // Channel ids with messages we haven't seen yet (arrived while their chat
  // wasn't the active view). Drives the unread dot in the sidebar.
  const [unreadChannelIds, setUnreadChannelIds] = useState(() => new Set())
  // Other clients currently typing: { clientId, name, channelId, expiresAt }.
  // Pruned as entries expire; filtered to the active channel at render.
  const [typingEntries, setTypingEntries] = useState([])
  const eventsWsRef = useRef(null)
  const channelsRef = useRef([])
  const clientsRef = useRef([])
  const popoutWindowRef = useRef(null)
  const popoutListenersRef = useRef(new Set())
  const allVideoStreamsRef = useRef([])
  const selectedStreamIdRef = useRef(null)
  const streamVolumeRef = useRef(100)
  const streamMutedRef = useRef(false)
  const watchedStreamIdsRef = useRef(new Set())
  // Video stream consumerIds we've already accounted for, so we only notify on
  // genuinely new streams. notifyArmed gates out the streams already live when
  // we join (no burst of "started a stream" on connect).
  const seenStreamIdsRef = useRef(new Set())
  const notifyArmedRef = useRef(false)
  // Timestamp of our last typing ping, so we throttle to one per TYPING_DURATION.
  const lastTypingSentRef = useRef(0)
  // Last server event sequence we've processed, reported back in each heartbeat
  // (op 2) and as `seq` when resuming. Null until we've processed an event.
  const lastEventSeqRef = useRef(null)
  // Session id handed to us on a fresh IDENTIFY (Authenticated). Sent back in the
  // resume object on reconnect so the server can replay events we missed. Null
  // when we have no resumable session.
  const sessionIdRef = useRef(null)
  // Self id, our joined channel, and the channel whose chat we're viewing — kept
  // as refs so the once-built events-socket handler reads live values (not stale
  // closures) when deciding which UI sounds to play.
  const selfIdRef = useRef(null)
  const selfChannelIdRef = useRef(null)
  const activeChatChannelIdRef = useRef(null)
  // Whether the chat panel (not the video tab) is currently on screen. The
  // active channel only counts as "read" while its chat is actually visible, so
  // a message arriving while we're in stream view still marks it unread.
  const chatVisibleRef = useRef(true)
  // Stream-sound detection: ids present last time we diffed, and a gate that
  // suppresses chimes until shortly after a (re)connect or channel change so the
  // streams already live in a channel we just joined don't each fire a start.
  const prevStreamIdsRef = useRef(new Set())
  const streamSoundsArmedRef = useRef(false)

  // Keep refs to the latest channels/clients so the events websocket handler
  // (created once in the effect below) can look them up without stale closures.
  useEffect(() => {
    channelsRef.current = channels
  }, [channels])
  useEffect(() => {
    clientsRef.current = clients
  }, [clients])

  // Keep refs to the latest streams/selection/volume so the popout bridge (set
  // up once below) always reads current values without stale closures.
  useEffect(() => {
    allVideoStreamsRef.current = allVideoStreams
  }, [allVideoStreams])
  useEffect(() => {
    selectedStreamIdRef.current = selectedStreamId
  }, [selectedStreamId])
  useEffect(() => {
    streamVolumeRef.current = streamVolume
  }, [streamVolume])
  useEffect(() => {
    streamMutedRef.current = streamMuted
  }, [streamMuted])
  useEffect(() => {
    watchedStreamIdsRef.current = watchedStreamIds
  }, [watchedStreamIds])

  // Notify the popout window whenever the data it mirrors changes.
  useEffect(() => {
    popoutListenersRef.current.forEach((cb) => cb())
  }, [allVideoStreams, clients, selectedStreamId, streamVolume, streamMuted, watchedStreamIds])

  // Toggle whether a stream is being watched (consumed). Shared by the in-app
  // grid and, via the bridge, the popout. Functional update so it's stable.
  const handleSetStreamWatched = (consumerId, watched) =>
    setWatchedStreamIds((prev) => {
      if (watched === prev.has(consumerId)) return prev
      const next = new Set(prev)
      if (watched) next.add(consumerId)
      else next.delete(consumerId)
      return next
    })

  // Drop watched ids for streams that have gone away, so a later stream can't
  // inherit a stale "watching" state (and the set doesn't grow unbounded).
  useEffect(() => {
    setWatchedStreamIds((prev) => {
      if (prev.size === 0) return prev
      const live = new Set(allVideoStreams.map((s) => s.consumerId))
      if ([...prev].every((id) => live.has(id))) return prev
      return new Set([...prev].filter((id) => live.has(id)))
    })
  }, [allVideoStreams])

  // Clear notification + unread history on connect/disconnect only — switching
  // channels shouldn't wipe what you've already been notified of.
  useEffect(() => {
    setNotifications([])
    setUnreadChannelIds(new Set())
  }, [token])

  // Emit a notification when a remote client starts streaming. Keyed by clientId
  // (deduped) so a reconnect's new consumerIds don't re-announce existing
  // streams; self streams are ignored; clientsRef gives the freshest name.
  useEffect(() => {
    const seen = seenStreamIdsRef.current
    const remoteIds = [...new Set(allVideoStreams.filter((s) => !s.isSelf).map((s) => s.clientId))]
    const freshIds = remoteIds.filter((id) => !seen.has(id))
    seenStreamIdsRef.current = new Set(remoteIds)
    if (!notifyArmedRef.current || freshIds.length === 0) return
    const now = Date.now()
    const entries = freshIds.map((clientId) => {
      const name =
        clientsRef.current.find((c) => c.id === clientId)?.name ||
        allVideoStreams.find((s) => s.clientId === clientId)?.fallbackLabel ||
        'Someone'
      return { id: `${clientId}-${now}`, message: `${name} has started a stream.`, timestamp: now }
    })
    setNotifications((prev) => [...entries, ...prev].slice(0, 50))
  }, [allVideoStreams])

  // Expose a bridge the popout window reads via window.opener. Live MediaStream
  // objects are shared by reference (same origin/process), never serialized.
  useEffect(() => {
    window.__videoPopout = {
      getData: () => ({
        streams: allVideoStreamsRef.current,
        clients: clientsRef.current,
        selectedStreamId: selectedStreamIdRef.current,
        volume: streamVolumeRef.current,
        muted: streamMutedRef.current,
        watchedStreamIds: watchedStreamIdsRef.current
      }),
      select: (id) => setSelectedStreamId(id),
      setVolume: (v) => setStreamVolume(v),
      setMuted: (m) => setStreamMuted(m),
      setStreamWatched: (id, watched) => handleSetStreamWatched(id, watched),
      setFocusedAudio: (clientId, opts) => setFocusedScreenAudio(clientId, opts),
      setStreamRoles: (payload) => setVideoStreamRoles(payload),
      subscribe: (cb) => {
        popoutListenersRef.current.add(cb)
        return () => popoutListenersRef.current.delete(cb)
      }
    }
    return () => {
      delete window.__videoPopout
    }
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

  // A channel we're "peeking" into: viewing/posting in its chat without joining
  // its voice (no streams, no view tabs). Null in the normal joined-channel view.
  const [previewChannelId, setPreviewChannelId] = useState(null)

  // The channel the local client currently has joined (chat is scoped to it)
  const selfChannelId = clients.find((c) => c.id === client?.id)?.channel_id ?? null

  // (Re)baseline "started a stream" notifications on connect, channel change,
  // and connection recovery: snapshot the remote streamers already present —
  // keyed by clientId, which (unlike consumerId) survives a reconnect's
  // re-consume — then arm after a short delay. Stays disarmed until the
  // connection is healthy, so the transient clear/re-add while reconnecting
  // doesn't read as a flurry of new streams.
  useEffect(() => {
    notifyArmedRef.current = false
    seenStreamIdsRef.current = new Set(
      allVideoStreamsRef.current.filter((s) => !s.isSelf).map((s) => s.clientId)
    )
    if (!token || connectionStatus !== 'connected') return
    const t = setTimeout(() => {
      notifyArmedRef.current = true
    }, STREAM_BASELINE_MS)
    return () => clearTimeout(t)
  }, [token, selfChannelId, connectionStatus])

  // Chat (messages / typing / history) follows the previewed channel when
  // peeking, otherwise the joined channel.
  const activeChatChannelId = previewChannelId ?? selfChannelId

  // Mirror self id / channel / active chat channel into refs for the events
  // handler (built once) to read without stale closures.
  // Chat is on screen when peeking a channel or when the joined channel's Chat
  // tab is selected (mirrors the render condition below).
  const chatVisible = previewChannelId != null || viewMode === 'log'

  useEffect(() => {
    selfIdRef.current = client?.id ?? null
  }, [client])
  useEffect(() => {
    selfChannelIdRef.current = selfChannelId
  }, [selfChannelId])
  useEffect(() => {
    activeChatChannelIdRef.current = activeChatChannelId
  }, [activeChatChannelId])
  useEffect(() => {
    chatVisibleRef.current = chatVisible
  }, [chatVisible])

  // Actually viewing a channel's chat marks it read — drop it from the unread
  // set. Gated on chatVisible so switching to the Chat tab (not just being in the
  // channel) is what clears the dot.
  useEffect(() => {
    if (activeChatChannelId == null || !chatVisible) return
    setUnreadChannelIds((prev) => {
      if (!prev.has(activeChatChannelId)) return prev
      const next = new Set(prev)
      next.delete(activeChatChannelId)
      return next
    })
  }, [activeChatChannelId, chatVisible])

  // (Re)baseline stream-sound detection on connect, channel change, and
  // connection recovery: snapshot the streams currently in view (by clientId, so
  // a reconnect's re-consumed streams aren't heard as restarts) without
  // sounding, then arm after a short delay. Stays disarmed until the connection
  // is healthy so the transient clear/re-add while reconnecting is silent. Sits
  // before the diff effect below so on a channel switch it runs first in the
  // same commit — disarming before the diff sees the incoming channel's streams.
  useEffect(() => {
    streamSoundsArmedRef.current = false
    prevStreamIdsRef.current = new Set(allVideoStreamsRef.current.map((s) => s.clientId))
    if (!token || connectionStatus !== 'connected') return
    const t = setTimeout(() => {
      streamSoundsArmedRef.current = true
    }, STREAM_BASELINE_MS)
    return () => clearTimeout(t)
  }, [token, selfChannelId, connectionStatus])

  // Play start/stop chimes as streams appear/vanish in our channel. Includes our
  // own streams (isSelf) so we hear feedback when we start/stop sharing, and
  // fires regardless of chat vs video view.
  useEffect(() => {
    const prev = prevStreamIdsRef.current
    const curIds = new Set(allVideoStreams.map((s) => s.clientId))
    if (streamSoundsArmedRef.current) {
      let started = false
      let stopped = false
      for (const id of curIds) if (!prev.has(id)) started = true
      for (const id of prev) if (!curIds.has(id)) stopped = true
      if (started) playUiSound('stream-start')
      if (stopped) playUiSound('stream-stop')
    }
    prevStreamIdsRef.current = curIds
  }, [allVideoStreams])

  // Drop the preview once we've actually joined that channel, or it's deleted.
  useEffect(() => {
    if (previewChannelId == null) return
    if (previewChannelId === selfChannelId || !channels.some((c) => c.id === previewChannelId)) {
      setPreviewChannelId(null)
    }
  }, [previewChannelId, selfChannelId, channels])

  // Single-click a channel: peek into its chat. Clicking the one we're already
  // in just returns to the normal view.
  const handlePreviewChannel = (channelId) => {
    setPreviewChannelId(channelId === selfChannelId ? null : channelId)
  }

  // No stream is focused by default (the grid view shows them all). Only clear
  // the focus if the currently focused stream goes away.
  useEffect(() => {
    if (selectedStreamId && !allVideoStreams.some((s) => s.consumerId === selectedStreamId)) {
      setSelectedStreamId(null)
    }
  }, [allVideoStreams, selectedStreamId])

  // Fetch a channel's recent history and merge it into the feed, replacing that
  // channel's existing entries with the authoritative set. The request goes
  // through the main process because the endpoint is a GET with a JSON body.
  // `shouldApply` lets a caller bail out if the result is no longer wanted
  // (e.g. the user switched channels before it arrived).
  const loadChannelHistory = useCallback(
    (channelId, shouldApply = () => true) => {
      if (DEV_MODE || !token || channelId == null) return Promise.resolve()
      return window.electron.ipcRenderer
        .invoke('get-channel-messages', {
          url: `${apiBase()}/channels/${channelId}/messages`,
          token,
          limit: HISTORY_LIMIT
        })
        .then((res) => {
          if (!shouldApply()) return
          if (!res?.ok) {
            if (res?.error) console.error('Failed to load chat history:', res.error)
            return
          }
          const history = (res.messages || []).map(messageFromApi).sort(byChronology)
          if (!history.length) return
          setFeed((prev) => {
            const rest = prev.filter((e) => !(e.type === 'message' && e.channelId === channelId))
            return [...history, ...rest]
          })
        })
        .catch((err) => console.error('Failed to load chat history:', err))
    },
    [token]
  )

  // Load recent message history whenever the local client enters a channel, so
  // opening a channel shows what was said before we got here.
  useEffect(() => {
    if (activeChatChannelId == null) return
    let cancelled = false
    loadChannelHistory(activeChatChannelId, () => !cancelled)
    return () => {
      cancelled = true
    }
  }, [activeChatChannelId, loadChannelHistory])

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

  const handleEditServer = (server) =>
    saveServers(servers.map((s) => (s.id === server.id ? { ...s, ...server } : s)))

  const handleRemoveServer = (id) => saveServers(servers.filter((s) => s.id !== id))

  // Create a channel on the server. Position is computed to append after the
  // current last channel. The server also broadcasts ChannelCreated, so the add
  // here is deduped by id in case that broadcast echoes back to us.
  const handleCreateChannel = async ({ name, user_limit }) => {
    const trimmed = name.trim()
    if (!trimmed) return
    const position = channels.reduce((max, ch) => Math.max(max, ch.position ?? 0), -1) + 1

    if (DEV_MODE) {
      const id = Math.max(0, ...channels.map((c) => c.id)) + 1
      setChannels((prev) => [...prev, { id, name: trimmed, user_limit, position, clients: [] }])
      return
    }

    try {
      const res = await fetch(`${apiBase()}/server/channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: trimmed, user_limit, position })
      })
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      const created = await res.json().catch(() => null)
      if (created && created.id != null) {
        setChannels((prev) => (prev.some((ch) => ch.id === created.id) ? prev : [...prev, created]))
      }
    } catch (err) {
      setFeed((prev) => appendFeed(prev, systemEntry(`Failed to create channel: ${err.message}`)))
    }
  }

  // Delete a channel. Removed locally on success; the server may also broadcast
  // a deletion to other clients.
  const handleDeleteChannel = async (id) => {
    if (DEV_MODE) {
      setChannels((prev) => prev.filter((ch) => ch.id !== id))
      return
    }

    try {
      const res = await fetch(`${apiBase()}/channels/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      })
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      setChannels((prev) => prev.filter((ch) => ch.id !== id))
    } catch (err) {
      setFeed((prev) => appendFeed(prev, systemEntry(`Failed to delete channel: ${err.message}`)))
    }
  }

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

    const credentials = JSON.stringify({ username: server.username, password: server.password })
    const login = () =>
      fetch(`${apiBase()}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: credentials
      }).then((res) => res.json())

    try {
      let data = await login()
      // No token usually means the account doesn't exist yet (we're moving to
      // DB-backed users). Self-register with the saved credentials, then retry
      // the login once.
      if (!data.token) {
        await fetch(`${apiBase()}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: credentials
        })
        data = await login()
      }

      if (data.token) {
        setToken(data.token)
        setClient(data.client)
        setConnectedServer(server)
      } else {
        setServerHost(null)
        setFeed([
          systemEntry(`Failed to connect to ${server.nickname}: ${data.message || 'login failed'}`)
        ])
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
    setPreviewChannelId(null)
    setConnectionStatus('connected')
  }

  // Fetch channels/clients and set up WebSocket + IPC listeners on mount
  useEffect(() => {
    if (!token) return

    if (DEV_MODE) {
      setChannels(MOCK_CHANNELS)
      setClients(MOCK_CLIENTS)
      setFeed([])
      const mockStreams = createMockStreams()
      setAllVideoStreams(mockStreams)
      return () => mockStreams.forEach((s) => s._stopMock?.())
    }

    // Reset any session carried over from a previous token/server so the first
    // IDENTIFY of this session is fresh — we must never resume into a session
    // that belongs to a different server.
    sessionIdRef.current = null
    lastEventSeqRef.current = null
    setConnectionStatus('connected')

    // Pull the authoritative channel/client baseline over REST. Resolves true on
    // success, false if the token was rejected (we drop it) or the fetch failed.
    const fetchBaseline = () =>
      Promise.all([
        fetch(`${apiBase()}/server/channel`, { headers: { Authorization: `Bearer ${token}` } }),
        fetch(`${apiBase()}/server/client`, { headers: { Authorization: `Bearer ${token}` } })
      ])
        .then(async ([channelRes, clientRes]) => {
          // A token may be stale/expired - drop it and return to disconnected.
          if (channelRes.status === 401 || clientRes.status === 401) {
            setToken(null)
            setClient(null)
            setConnectedServer(null)
            setServerHost(null)
            return false
          }
          const [channelData, clientData] = await Promise.all([channelRes.json(), clientRes.json()])
          setChannels(channelData)
          // The REST payload uses `muted`/`deaf`, but voice-state updates (and the
          // rest of the UI) use `self_mute`/`self_deaf` - normalize on the way in.
          setClients(clientData.map((c) => ({ ...c, self_mute: c.muted, self_deaf: c.deaf })))
          return true
        })
        .catch((err) => {
          console.error('Failed to fetch:', err)
          return false
        })

    // Full resync after losing our session (we can't replay the events we
    // missed): re-pull presence/channels and reload the active channel's history.
    const fullResync = () => {
      fetchBaseline()
      loadChannelHistory(activeChatChannelIdRef.current)
    }

    // Reconnect bookkeeping. `closedByUs` suppresses reconnects on intentional
    // teardown (effect cleanup, disconnect, or an auth failure).
    let closedByUs = false
    let reconnectAttempts = 0
    let reconnectTimer = null
    let heartbeatTimer = null
    let ws = null

    const clearHeartbeat = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer)
      heartbeatTimer = null
    }

    // Exponential backoff with jitter, capped, so a blip recovers quickly but a
    // downed server isn't hammered. Reset to 0 on a successful handshake.
    const scheduleReconnect = () => {
      if (closedByUs || reconnectTimer) return
      // Surface the drop to the user (full-app overlay) while we retry.
      setConnectionStatus('reconnecting')
      const delay = Math.min(
        RECONNECT_MAX_DELAY_MS,
        RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempts
      )
      reconnectAttempts++
      const jittered = Math.round(delay * (0.5 + Math.random() * 0.5))
      console.warn(`[Events] Reconnecting in ${jittered}ms`)
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
      }, jittered)
    }

    // The server's one-shot reply to IDENTIFY (op 0) is an internally-tagged
    // enum: { type: 'Authenticated' | 'Resumed' | 'InvalidSession' | 'Unauthorized',
    // ...payload }. Returns it (renaming `type` → `kind`) or null for anything
    // else (heartbeat acks, dispatches).
    const IDENTIFY_KINDS = ['Authenticated', 'Resumed', 'InvalidSession', 'Unauthorized']
    const readIdentifyReply = (msg) => {
      if (typeof msg?.type === 'string' && IDENTIFY_KINDS.includes(msg.type)) {
        return { kind: msg.type, ...msg }
      }
      return null
    }

    const handleIdentifyReply = (reply) => {
      // A completed handshake (fresh or resumed) means we're healthy again.
      reconnectAttempts = 0
      if (reply.kind === 'Authenticated' || reply.kind === 'Resumed') {
        setConnectionStatus('connected')
      }
      if (reply.kind === 'Authenticated') {
        // Fresh session: store its id and reset our position (we've processed no
        // events yet). If we were holding a session before, our resume was
        // effectively declined — resync so we don't trust state that may have
        // drifted during the outage.
        const hadSession = sessionIdRef.current != null
        sessionIdRef.current = reply.session_id ?? null
        lastEventSeqRef.current = null
        if (hadSession) fullResync()
      } else if (reply.kind === 'Resumed') {
        // Resume accepted: the events we missed replay next as ordered, dup-free
        // dispatches, then live events continue. Keep our position; refresh id.
        if (reply.session_id != null) sessionIdRef.current = reply.session_id
      } else if (reply.kind === 'InvalidSession') {
        // Resume refused (server restarted or we were away too long): drop the
        // session, full resync, and reconnect fresh. Clearing the refs makes the
        // next connect identify without a resume object.
        sessionIdRef.current = null
        lastEventSeqRef.current = null
        fullResync()
        closedByUs = false
        ws.close()
      } else if (reply.kind === 'Unauthorized') {
        // Token rejected — stop reconnecting and return to the disconnected state.
        closedByUs = true
        ws.close()
        setToken(null)
        setClient(null)
        setConnectedServer(null)
        setServerHost(null)
      }
    }

    // Apply a dispatched event to local state.
    const handleEvent = (ev, data) => {
      // Audio status update (mic mute / deafen) broadcast from another client
      if (ev === 'VoiceStateUpdate') {
        const { client_id, muted, deaf } = data
        setClients((prev) =>
          prev.map((c) => (c.id === client_id ? { ...c, self_mute: muted, self_deaf: deaf } : c))
        )
        return
      }

      if (ev === 'NewUser') {
        setClients((prev) => [...prev, { ...data, self_mute: data.muted, self_deaf: data.deaf }])
      } else if (ev === 'ClientModified') {
        const oldChannelId = clientsRef.current.find((c) => c.id === data.id)?.channel_id
        setClients((prev) =>
          prev.map((c) => (c.id === data.id ? { ...c, channel_id: data.channel_id } : c))
        )

        // Join/leave chimes. For ourselves: any move into a channel is a "join",
        // dropping out (channel_id null) is a "leave". For others: only sound
        // when they enter or leave the channel we're currently in.
        const myChannel = selfChannelIdRef.current
        if (data.id === selfIdRef.current) {
          playUiSound(data.channel_id == null ? 'channel-leave' : 'channel-join')
        } else if (myChannel != null) {
          if (data.channel_id === myChannel && oldChannelId !== myChannel) {
            playUiSound('channel-join')
          } else if (oldChannelId === myChannel && data.channel_id !== myChannel) {
            playUiSound('channel-leave')
          }
        }
      } else if (ev === 'MessageCreated') {
        setFeed((prev) => appendFeed(prev, messageFromApi(data)))
        // Sending a message ends that author's typing indicator immediately,
        // leaving anyone else still typing untouched.
        setTypingEntries((prev) => prev.filter((t) => t.clientId !== data.author))
        // Chime for messages arriving in the channel we're viewing, from anyone
        // but ourselves — regardless of whether we're on the chat or video tab.
        if (
          data.author !== selfIdRef.current &&
          data.channel_id === activeChatChannelIdRef.current
        ) {
          playUiSound('new-message')
        }
        // Mark unread when a message from someone else lands anywhere we aren't
        // actively reading — either a different channel, or the active channel
        // while we're on the video tab (chat not visible).
        const readingHere =
          data.channel_id === activeChatChannelIdRef.current && chatVisibleRef.current
        if (data.author !== selfIdRef.current && !readingHere) {
          setUnreadChannelIds((prev) => {
            if (prev.has(data.channel_id)) return prev
            const next = new Set(prev)
            next.add(data.channel_id)
            return next
          })
        }
      } else if (ev === 'MessageUpdated') {
        // Pushed after async work (e.g. link-unfurl embeds). Carries either the
        // full updated message, or a partial { message_id, embeds }. Patch the
        // matching feed entry in place by id.
        const isFull = data.content !== undefined && data.author !== undefined
        const targetId = data.id ?? data.message_id
        setFeed((prev) =>
          prev.map((e) => {
            if (e.type !== 'message' || e.id !== targetId) return e
            return isFull ? messageFromApi(data) : { ...e, embeds: data.embeds || [] }
          })
        )
      } else if (ev === 'MessageDeleted') {
        // Tolerate either a full message object or a bare { message_id } / id.
        const removedId =
          data !== null && typeof data === 'object' ? (data.id ?? data.message_id) : data
        setFeed((prev) => prev.filter((e) => !(e.type === 'message' && e.id === removedId)))
      } else if (ev === 'ChannelCreated') {
        setChannels((prev) => (prev.some((ch) => ch.id === data.id) ? prev : [...prev, data]))
      } else if (ev === 'ChannelDeleted') {
        // Tolerate either a full channel object or a bare id.
        const removedId = data !== null && typeof data === 'object' ? data.id : data
        setChannels((prev) => prev.filter((ch) => ch.id !== removedId))
      } else if (ev === 'TypingStarted') {
        // { channel_id, timestamp, client } — refresh this client's typing entry
        // with a fresh 10s expiry (replacing any existing one). Self is filtered
        // out at render time using the current client id.
        const { channel_id, client: typingClient } = data
        setTypingEntries((prev) => [
          ...prev.filter((t) => t.clientId !== typingClient.id),
          {
            clientId: typingClient.id,
            name: typingClient.name,
            channelId: channel_id,
            expiresAt: Date.now() + TYPING_DURATION_MS
          }
        ])
      } else {
        setFeed((prev) => appendFeed(prev, systemEntry(`Unknown event: ${ev}`)))
      }
    }

    // Open a socket and run the handshake. Reused for the initial connection and
    // every reconnect; `connect` reassigns the shared `ws` each time.
    const connect = () => {
      ws = new WebSocket(`${wsBase()}/ws`)
      eventsWsRef.current = ws
      // True between sending a heartbeat (op 2) and receiving its ack (op 4). If a
      // beat is still unacknowledged when the next is due, the connection is dead.
      let awaitingAck = false

      ws.onopen = () => {
        console.log('WebSocket connected')
        // Resume only when we hold a session and a position to resume from;
        // otherwise identify fresh. The server's reply tells us which we got.
        const canResume = sessionIdRef.current != null && lastEventSeqRef.current != null
        const data = canResume
          ? { token, resume: { session_id: sessionIdRef.current, seq: lastEventSeqRef.current } }
          : { token }
        ws.send(JSON.stringify({ op: 0, data }))
        // Heartbeat: prove we're still alive every interval, reporting the last
        // event sequence we've processed. If these stop arriving the server
        // evicts us, so clients that crash or are force-killed (Ctrl+C) stop
        // appearing in the channel.
        heartbeatTimer = setInterval(() => {
          if (ws.readyState !== WebSocket.OPEN) return
          if (awaitingAck) {
            // Previous heartbeat was never acknowledged — treat as a zombie
            // connection and close it (fires onclose → reconnect).
            console.warn('[Events] Heartbeat not acknowledged; closing dead connection')
            ws.close()
            return
          }
          awaitingAck = true
          ws.send(JSON.stringify({ op: 2, data: lastEventSeqRef.current }))
        }, HEARTBEAT_INTERVAL_MS)
      }

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data)

        // One-shot reply to our IDENTIFY (op 0). Checked first since it carries
        // connection-control state, not a dispatchable event.
        const reply = readIdentifyReply(msg)
        if (reply) {
          handleIdentifyReply(reply)
          return
        }

        // Heartbeat acknowledgement — clears the outstanding beat; no event body.
        if (msg.op === 4) {
          awaitingAck = false
          return
        }

        // Events are wrapped as { op: 3, data: <event>, seq }, or arrive bare as
        // { ev, data }. Support both, and remember the latest sequence so the
        // heartbeat and any resume can report our position.
        if (typeof msg.seq === 'number') lastEventSeqRef.current = msg.seq
        const { ev, data } = msg.op === 3 ? msg.data : msg
        handleEvent(ev, data)
      }

      ws.onclose = () => {
        console.log('WebSocket disconnected')
        clearHeartbeat()
        if (eventsWsRef.current === ws) eventsWsRef.current = null
        // Recover unless the close was intentional. We resume if we still hold a
        // session; the next handshake reply decides resume vs. fresh.
        scheduleReconnect()
      }

      ws.onerror = (err) => console.error('WebSocket error:', err)
    }

    // OS connectivity hints. The heartbeat eventually notices a silent drop, but
    // that can take ~20s; reacting to 'offline'/'online' shows the reconnect
    // overlay immediately and recovers the moment the network returns (closing a
    // half-open socket routes through onclose → scheduleReconnect).
    const handleOffline = () => {
      if (closedByUs) return
      setConnectionStatus('reconnecting')
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close()
      }
    }
    const handleOnline = () => {
      if (closedByUs) return
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close() // half-open socket that never noticed the drop
      } else if (reconnectTimer || !eventsWsRef.current) {
        // Waiting out a backoff (or fully closed) — reconnect now instead.
        if (reconnectTimer) clearTimeout(reconnectTimer)
        reconnectTimer = null
        reconnectAttempts = 0
        connect()
      }
    }
    window.addEventListener('offline', handleOffline)
    window.addEventListener('online', handleOnline)

    // Initial baseline + first connection. The first IDENTIFY is always fresh
    // (session refs were cleared above), so REST state is our starting point.
    setFeed([])
    fetchBaseline()
    connect()

    window.electron.ipcRenderer.on('log-message', (_, message) => {
      setFeed((prev) => appendFeed(prev, systemEntry(message)))
    })

    return () => {
      closedByUs = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearHeartbeat()
      if (ws) ws.close()
      eventsWsRef.current = null
      window.removeEventListener('offline', handleOffline)
      window.removeEventListener('online', handleOnline)
      window.electron.ipcRenderer.removeAllListeners('log-message')
    }
  }, [token, loadChannelHistory])

  // Drop typing entries as they expire. Re-scheduled to the soonest expiry each
  // time the set changes (no always-on interval); a fresh TypingStarted bumps an
  // entry's expiry and re-runs this.
  useEffect(() => {
    if (typingEntries.length === 0) return
    const soonest = Math.min(...typingEntries.map((t) => t.expiresAt))
    const id = setTimeout(
      () => {
        setTypingEntries((prev) => prev.filter((t) => t.expiresAt > Date.now()))
      },
      Math.max(0, soonest - Date.now())
    )
    return () => clearTimeout(id)
  }, [typingEntries])

  // Announce to the server that we're typing, throttled to one ping per
  // TYPING_DURATION so we don't hit the endpoint on every keystroke.
  const handleTyping = () => {
    if (DEV_MODE || activeChatChannelId == null) return
    const now = Date.now()
    if (now - lastTypingSentRef.current < TYPING_DURATION_MS) return
    lastTypingSentRef.current = now
    fetch(`${apiBase()}/channels/${activeChatChannelId}/typing`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` }
    }).catch((err) => console.error('Failed to send typing:', err))
  }

  // Send a chat message (with any attachments) to the channel we're currently in
  const handleSendMessage = async (text, attachments) => {
    if (DEV_MODE) {
      setFeed((prev) =>
        appendFeed(prev, {
          id: crypto.randomUUID(),
          type: 'message',
          channelId: activeChatChannelId,
          author: client?.name,
          authorId: client?.id,
          text,
          attachments,
          ts: Date.now()
        })
      )
      return
    }

    if (activeChatChannelId == null) return

    const payload = {
      content: text || undefined,
      attachments: attachments.map((a, i) => ({ id: i, filename: a.file.name, description: null }))
    }

    const formData = new FormData()
    formData.append(
      'payload_json',
      new Blob([JSON.stringify(payload)], { type: 'application/json' })
    )
    attachments.forEach((a, i) => formData.append(`files[${i}]`, a.file, a.file.name))
    attachments.forEach((a) => URL.revokeObjectURL(a.url))

    try {
      const res = await fetch(`${apiBase()}/channels/${activeChatChannelId}/messages`, {
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

  // Edit one of our own messages. The server validates ownership (only the
  // author may edit) and broadcasts MessageUpdated with the new content and an
  // edited_timestamp, which patches the feed entry in place — so we don't touch
  // local state here on success, mirroring how send relies on MessageCreated.
  const handleEditMessage = async (messageId, content) => {
    const trimmed = content.trim()
    if (!trimmed) return

    if (DEV_MODE) {
      setFeed((prev) =>
        prev.map((e) =>
          e.type === 'message' && e.id === messageId
            ? { ...e, text: trimmed, editedTs: Date.now() }
            : e
        )
      )
      return
    }

    if (activeChatChannelId == null) return

    try {
      const res = await fetch(
        `${apiBase()}/channels/${activeChatChannelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ content: trimmed })
        }
      )
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      // The server broadcasts MessageUpdated back to us, patching the feed entry.
    } catch (err) {
      setFeed((prev) => appendFeed(prev, systemEntry(`Failed to edit message: ${err.message}`)))
    }
  }

  // Delete one of our own messages. The server validates ownership and broadcasts
  // MessageDeleted; we also drop it locally on success so it disappears
  // immediately even if the broadcast is delayed (the broadcast is idempotent).
  const handleDeleteMessage = async (messageId) => {
    if (DEV_MODE) {
      setFeed((prev) => prev.filter((e) => !(e.type === 'message' && e.id === messageId)))
      return
    }

    if (activeChatChannelId == null) return

    try {
      const res = await fetch(
        `${apiBase()}/channels/${activeChatChannelId}/messages/${messageId}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` }
        }
      )
      if (!res.ok) throw new Error(`Server responded ${res.status}`)
      setFeed((prev) => prev.filter((e) => !(e.type === 'message' && e.id === messageId)))
    } catch (err) {
      setFeed((prev) => appendFeed(prev, systemEntry(`Failed to delete message: ${err.message}`)))
    }
  }

  // Broadcast our mic-mute / deafen status to other clients
  const sendStatus = (selfMute, selfDeaf) => {
    if (eventsWsRef.current?.readyState === WebSocket.OPEN) {
      eventsWsRef.current.send(
        JSON.stringify({ op: 1, data: { self_mute: selfMute, self_deaf: selfDeaf } })
      )
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
  // Keeps the settings modal mounted through its close animation before it
  // actually unmounts (must match the CSS animation duration).
  const [settingsClosing, setSettingsClosing] = useState(false)

  const openSettings = () => {
    setSettingsClosing(false)
    setShowSettings(true)
  }
  const closeSettings = () => {
    setSettingsClosing(true)
    setTimeout(() => {
      setShowSettings(false)
      setSettingsClosing(false)
    }, 180)
  }

  const connected = !!token
  const titleText = connectedServer ? `${APP_TITLE} — ${connectedServer.nickname}` : APP_TITLE

  // Sliding pill for the Chat / Video Streams tabs.
  const viewPill = usePillIndicator(viewMode)

  // Names of other clients typing in the channel we're viewing (self excluded).
  const typingUsers = typingEntries
    .filter((t) => t.channelId === activeChatChannelId && t.clientId !== client?.id)
    .map((t) => t.name)

  // Name of the channel being peeked into (for the preview header).
  const previewChannelName = channels.find((c) => c.id === previewChannelId)?.name ?? 'Channel'

  return (
    <div className="app-shell">
      <TitleBar
        title={titleText}
        icon={IconUsersGroup}
        notifications={notifications}
        onClearNotifications={() => setNotifications([])}
      />
      <div className="layout">
        <SideBar
          channels={channels}
          clients={clients}
          token={token}
          self={client}
          onStreamsUpdate={handleStreamsUpdate}
          onStatusChange={sendStatus}
          // provide a renderer-level openSettings hook
          onOpenSettings={openSettings}
          servers={servers}
          connectedServer={connectedServer}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onAddServer={handleAddServer}
          onEditServer={handleEditServer}
          onRemoveServer={handleRemoveServer}
          onCreateChannel={handleCreateChannel}
          onDeleteChannel={handleDeleteChannel}
          onPreviewChannel={handlePreviewChannel}
          previewChannelId={previewChannelId}
          unreadChannelIds={unreadChannelIds}
        />

        <main className="chat-area">
          <div className="chat-header">
            <div className="header-content">
              {previewChannelId != null ? (
                // Peeking into another channel's chat: no view tabs (no streams),
                // just the channel name and a close button to return to our view.
                <>
                  <span className="view-preview-title">
                    <IconMessage size={18} stroke={2} />
                    {previewChannelName}
                  </span>
                  <button
                    type="button"
                    className="view-preview-close"
                    onClick={() => setPreviewChannelId(null)}
                    title="Close chat"
                  >
                    <IconX size={18} />
                  </button>
                </>
              ) : connected ? (
                <div className="view-tabs-bar" ref={viewPill.barRef}>
                  <span
                    className="pill-indicator"
                    style={viewPill.indicatorStyle}
                    aria-hidden="true"
                  />
                  <button
                    type="button"
                    className={`view-tab${viewMode === 'log' ? ' active' : ''}`}
                    data-active={viewMode === 'log'}
                    onClick={() => setViewMode('log')}
                  >
                    <IconMessage size={15} stroke={2} /> Chat
                  </button>
                  <button
                    type="button"
                    className={`view-tab${viewMode === 'video' ? ' active' : ''}`}
                    data-active={viewMode === 'video'}
                    onClick={() => setViewMode('video')}
                    disabled={poppedOut}
                    title={poppedOut ? 'Video is open in a separate window' : undefined}
                  >
                    <IconVideo size={15} stroke={2} /> Video Streams
                  </button>
                </div>
              ) : (
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <IconMessage size={18} stroke={2} />
                  Chat
                </span>
              )}
            </div>
          </div>

          {/* Keyed so switching channel/tab remounts and replays the switch animation. */}
          <div
            className="chat-switch-region"
            key={
              !connected
                ? 'disconnected'
                : previewChannelId != null
                  ? `preview-${previewChannelId}`
                  : viewMode
            }
          >
            {!connected ? (
              <div className="disconnected-placeholder">
                <p className="disconnected-title">Not connected</p>
                <p className="disconnected-subtitle">
                  Pick a server from the <strong>Connect</strong> menu to get started.
                </p>
              </div>
            ) : previewChannelId != null || viewMode === 'log' ? (
              <ChatPanel
                feed={feed.filter(
                  (e) => e.type === 'system' || e.channelId === activeChatChannelId
                )}
                clients={clients}
                selfId={client?.id}
                onSend={handleSendMessage}
                onEditMessage={handleEditMessage}
                onDeleteMessage={handleDeleteMessage}
                onTyping={handleTyping}
                typingUsers={typingUsers}
                disabled={activeChatChannelId == null}
              />
            ) : (
              <VideoGrid
                streams={allVideoStreams}
                clients={clients}
                selectedStreamId={selectedStreamId}
                onSelect={setSelectedStreamId}
                onPopout={handlePopout}
                watchedStreamIds={watchedStreamIds}
                onSetStreamWatched={handleSetStreamWatched}
                volume={streamVolume}
                muted={streamMuted}
                onVolumeChange={setStreamVolume}
                onMutedChange={setStreamMuted}
              />
            )}
          </div>
        </main>
        {showSettings && (
          <div
            className={`settings-overlay${settingsClosing ? ' closing' : ''}`}
            onClick={closeSettings}
          >
            <div className="settings-modal" onClick={(e) => e.stopPropagation()}>
              <button className="settings-close-btn" onClick={closeSettings}>
                ×
              </button>
              <Settings />
            </div>
          </div>
        )}
      </div>
      {connected && connectionStatus === 'reconnecting' && (
        <ConnectionOverlay onAbort={handleDisconnect} />
      )}
    </div>
  )
}

export default Main
