import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop, scrimFade } from '../lib/motionPresets'
import './Main.css'
import '../App.css'
import { useAuth } from '../context/AuthContext'
import { ClientActionsProvider } from '../context/ClientActionsContext'
import SideBar from '../components/SideBar'
import VideoGrid from '../components/VideoGrid'
import ChatPanel from '../components/ChatPanel'
import ClientSummary from '../components/ClientSummary'
import ChannelSummary from '../components/ChannelSummary'
import ServerTraffic from '../components/ServerTraffic'
import ServerSummary from '../components/ServerSummary'
import TitleBar from '../components/TitleBar'
import ConnectionOverlay from '../components/ConnectionOverlay'
import Toast from '../components/Toast'
import RolesGroupsMenu from '../components/RolesGroupsMenu'
import IdleAnimation from '../components/IdleAnimation'
import Settings from './Settings'
import {
  disconnect as disconnectVoice,
  receiveVoiceTicket,
  setFocusedScreenAudio,
  setVideoStreamRoles,
  setWatchedProducers,
  subscribeStreamViewers
} from '../lib/soup'
import { playUiSound } from '../lib/sounds'
import { setServerHost, apiBase, wsBase, cdnUrl, throwIfError } from '../lib/serverConfig'
import { validateMessage, statusOf } from '../lib/presence'
import { authFetch, getFreshToken, setOnSessionExpired } from '../lib/auth'
import { httpFetch } from '../lib/http'
import SegmentedTabs from '../components/SegmentedTabs'
import {
  IconVideo,
  IconMessage,
  IconUser,
  IconUsersGroup,
  IconX,
  IconVolume,
  IconActivity
} from '@tabler/icons-react'

const APP_TITLE = 'Pylon'

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

// Permission bits (u64, mirroring the server's Permissions bitflags). Held as
// BigInt because ADMINISTRATOR is 1<<62, well past JS's safe-integer range.
const PERM_MUTE_MEMBERS = 1n << 9n
const PERM_KICK_MEMBERS = 1n << 10n
const PERM_BAN_MEMBERS = 1n << 11n
const PERM_MANAGE_CHANNELS = 1n << 5n
const PERM_MANAGE_ROLES = 1n << 12n
const PERM_ADMINISTRATOR = 1n << 62n

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
      url: cdnUrl(a.url)
    })),
    // Link-preview / rich cards. URLs (incl. attachment://) are resolved
    // server-side, so they're render-ready. May arrive later via MessageUpdated.
    embeds: msg.embeds || [],
    // Aggregated reactions, flattened to what ChatPanel renders. Custom emoji
    // are skipped — the server marks them NOT YET IMPLEMENTED.
    reactions: (msg.reactions || [])
      .filter((r) => r.emoji?.type === 'basic')
      .map((r) => ({ emoji: r.emoji.value, count: r.count, me: r.me })),
    mentions: msg.mentions || [],
    mentionEveryone: !!msg.mention_everyone,
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

// The other party in a DM channel, given our own id. Reads `participant_ids`
// (server) or `recipients` (local), which may be plain ids or { id, name }.
function dmOther(channel, selfId) {
  for (const r of channel?.participant_ids || channel?.recipients || []) {
    const id = r && typeof r === 'object' ? r.id : r
    if (id !== selfId) return { id, name: r && typeof r === 'object' ? r.name : undefined }
  }
  return { id: undefined, name: undefined }
}

// Normalize a ClientApiObject's voice fields for the roster. Self toggles stay
// `self_mute`/`self_deaf`; the server-forced pair (`muted`/`deaf` — a moderator
// gag / server deafen) becomes `server_mute`/`server_deaf`, so `server_mute`
// alone means "gagged". Also resolves the avatar URL.
function normalizeClientVoice(c) {
  return {
    ...c,
    avatar: cdnUrl(c.avatar),
    // The server sends assigned vanity as full VanityItems; we only keep the
    // ids and resolve names/icons against the global vanity list, so icon/name
    // edits propagate from one place.
    vanity_ids: (c.vanity || []).map((v) => v.id),
    self_mute: !!c.self_mute,
    self_deaf: !!c.self_deaf,
    server_mute: !!c.muted,
    server_deaf: !!c.deaf
  }
}

function Main() {
  //Server Connection State Hooks
  const { token, applyAuthResponse, clearAuth, client } = useAuth()
  const [channels, setChannels] = useState([])
  const [clients, setClients] = useState([])
  // PresenceApiObject by client_id. Kept separate from `clients` because presence
  // is user-level and outlives a connection — an entry can exist for someone the
  // roster no longer lists, and `clients` is replaced wholesale by Ready.
  const [presences, setPresences] = useState({})
  // Server-traffic log (newest first): members crossing the online/offline
  // boundary while we're lurking. Fed by PresenceUpdate below, cleared on
  // connect/disconnect. Rendered by ServerTraffic when not in a voice channel.
  const [traffic, setTraffic] = useState([])
  const [feed, setFeed] = useState([])
  const [viewMode, setViewMode] = useState('log') // 'log' or 'video'
  const [servers, setServers] = useState([])
  const [roles, setRoles] = useState([])
  // Vanity items (cosmetic server groups: name + icon, no permissions).
  const [vanity, setVanity] = useState([])
  // 'Roles and Groups' popup, opened from a client context menu.
  const [rolesGroupsOpen, setRolesGroupsOpen] = useState(false)
  const [bans, setBans] = useState([])
  const [connectedServer, setConnectedServer] = useState(null)
  const [connectionStatus, setConnectionStatus] = useState('connected')
  // Transient toast banner: { message, variant } or null when hidden. 'error'
  // reports partial failures (bad requests, permission denials, failed fetches);
  // 'success' confirms completed actions. Latest toast replaces any showing.
  const [toast, setToast] = useState(null)
  // True while a connect attempt is in flight (login → token), so the idle view
  // can say so. Cleared on success (we leave the idle view) or failure.
  const [connecting, setConnecting] = useState(false)
  // Every error toast is also the single place we chime an error cue. The second
  // arg is the caught Error (its `.status` distinguishes a 403 permission failure)
  // or `{ silent: true }` where the caller already plays its own specific sound.
  const showError = useCallback((message, err) => {
    setToast({ message, variant: 'error' })
    if (err?.silent) return
    const permission =
      err?.status === 403 || /permission|forbidden|not allowed|insufficient/i.test(message)
    playUiSound(permission ? 'insufficient_permissions' : 'error')
  }, [])
  const showSuccess = useCallback((message) => setToast({ message, variant: 'success' }), [])
  const dismissToast = useCallback(() => setToast(null), [])

  //Client UI Hooks
  const [allVideoStreams, setAllVideoStreams] = useState([])
  // Logical stream intent is keyed by client id. A codec downgrade creates a
  // new producer/consumer id for the same client's stream; using that transient
  // id here used to clear focus, stop watching, and hard-mute stream audio.
  const [selectedStreamClientId, setSelectedStreamClientId] = useState(null)
  const [poppedOut, setPoppedOut] = useState(false)
  const [streamVolume, setStreamVolume] = useState(100)
  const [streamMuted, setStreamMuted] = useState(false)
  const [watchedStreamClientIds, setWatchedStreamClientIds] = useState(() => new Set())
  const [notifications, setNotifications] = useState([])
  const [dmNotifications, setDmNotifications] = useState([])
  const [readStates, setReadStates] = useState({})
  const [typingEntries, setTypingEntries] = useState([])

  //Broad Server Ref Hooks
  const eventsWsRef = useRef(null)
  const channelsRef = useRef([])
  const clientsRef = useRef([])
  const refreshPresencesRef = useRef(null)
  // Latest presences, read by the events handler to diff old→new status without
  // a stale closure (mirrors the channels/clients ref pattern above).
  const presencesRef = useRef({})
  const dndRef = useRef(false)

  //Stream Ref Hooks
  const popoutWindowRef = useRef(null)
  const popoutListenersRef = useRef(new Set())
  const allVideoStreamsRef = useRef([])
  const selectedStreamClientIdRef = useRef(null)
  const streamVolumeRef = useRef(100)
  const streamMutedRef = useRef(false)
  // The soup socket (and thus the viewer map) lives only in this window; the
  // popout runs in a separate JS realm with an empty soup instance, so mirror
  // the snapshot here and hand it over the bridge instead of letting the popout
  // subscribe to its own (always-empty) copy.
  const streamViewersRef = useRef(new Map())
  const watchedStreamClientIdsRef = useRef(new Set())

  const lastTypingSentRef = useRef(0)
  const lastEventSeqRef = useRef(null)
  const sessionIdRef = useRef(null)
  const selfIdRef = useRef(null)
  const selfChannelIdRef = useRef(null)
  // Timestamp of our last own channel action (create/edit/move/etc). The server
  // echoes ChannelUpdated back to us, and a reorder also reindexes sibling
  // channels — so within a short window after acting we suppress the "your
  // current channel was edited" cue (which is only meant for edits by others),
  // while our action's own specific cue still plays.
  const lastSelfChannelActionAtRef = useRef(0)
  const SELF_CHANNEL_ACTION_MS = 2000
  const activeChatChannelIdRef = useRef(null)
  const chatVisibleRef = useRef(true)
  const feedRef = useRef([])
  const loadingOlderRef = useRef(false)
  const [exhaustedChannels, setExhaustedChannels] = useState(() => new Set())
  const prevStreamIdsRef = useRef(new Set())
  const streamSoundsArmedRef = useRef(false)

  // Keep refs to the latest channels/clients so the events websocket handler
  // (created once in the effect below) can look them up without stale closures.
  useEffect(() => {
    channelsRef.current = channels
  }, [channels])
  const rolesRef = useRef([])
  useEffect(() => {
    rolesRef.current = roles
  }, [roles])
  const vanityRef = useRef([])
  useEffect(() => {
    vanityRef.current = vanity
  }, [vanity])
  useEffect(() => {
    clientsRef.current = clients
  }, [clients])
  useEffect(() => {
    presencesRef.current = presences
  }, [presences])

  // Same for the popout bridge's data, read once-bound without stale closures.
  useEffect(() => {
    allVideoStreamsRef.current = allVideoStreams
  }, [allVideoStreams])
  useEffect(() => {
    selectedStreamClientIdRef.current = selectedStreamClientId
  }, [selectedStreamClientId])
  useEffect(() => {
    streamVolumeRef.current = streamVolume
  }, [streamVolume])
  useEffect(() => {
    streamMutedRef.current = streamMuted
  }, [streamMuted])
  useEffect(() => {
    watchedStreamClientIdsRef.current = watchedStreamClientIds
  }, [watchedStreamClientIds])

  // Mirror the live viewer map for the popout bridge. subscribeStreamViewers
  // fires immediately with the current snapshot, and again on every change, so
  // the popout's viewer count stays in sync.
  useEffect(
    () =>
      subscribeStreamViewers((snapshot) => {
        streamViewersRef.current = snapshot
        popoutListenersRef.current.forEach((cb) => cb())
      }),
    []
  )

  // Notify the popout window whenever the data it mirrors changes.
  useEffect(() => {
    popoutListenersRef.current.forEach((cb) => cb())
  }, [
    allVideoStreams,
    clients,
    selectedStreamClientId,
    streamVolume,
    streamMuted,
    watchedStreamClientIds
  ])

  // Consumer lifetime follows the watch set: watching a stream subscribes to it,
  // stopping unsubscribes. Driven here rather than in VideoGrid because the
  // popout routes its play/stop back into this same state, so this one effect
  // covers both windows. Watch intent is keyed by client, producers by id.
  const watchedProducerKey = allVideoStreams
    .filter((s) => !s.isSelf && watchedStreamClientIds.has(s.clientId))
    .map((s) => s.producerId)
    .filter(Boolean)
    .sort()
    .join(',')
  useEffect(() => {
    setWatchedProducers(watchedProducerKey ? watchedProducerKey.split(',') : [])
  }, [watchedProducerKey])

  // Toggle whether a stream is watched (consumed); shared with the popout.
  const handleSetStreamWatched = (clientId, watched) =>
    setWatchedStreamClientIds((prev) => {
      if (watched === prev.has(clientId)) return prev
      const next = new Set(prev)
      if (watched) next.add(clientId)
      else next.delete(clientId)
      return next
    })

  // Replacement handoffs retain a placeholder tile (the SFU marks their
  // ProducerClosed event), so any client absent here genuinely stopped sharing.
  // Clear intent immediately: a later unrelated share must require a new click.
  useEffect(() => {
    const liveClientIds = new Set(allVideoStreams.map((stream) => stream.clientId))
    setWatchedStreamClientIds((prev) => {
      if (prev.size === 0) return prev
      if ([...prev].every((id) => liveClientIds.has(id))) return prev
      return new Set([...prev].filter((id) => liveClientIds.has(id)))
    })
    setSelectedStreamClientId((current) =>
      current != null && !liveClientIds.has(current) ? null : current
    )
  }, [allVideoStreams])

  // Clear notification + unread history on connect/disconnect only — switching
  // channels shouldn't wipe what you've already been notified of.
  useEffect(() => {
    setNotifications([])
    setDmNotifications([])
    setReadStates({})
    setTraffic([])
    setShowTraffic(false)
    setShowServerSummary(false)
  }, [token])

  // Expose a bridge the popout window reads via window.opener. Live MediaStream
  // objects are shared by reference (same origin/process), never serialized.
  useEffect(() => {
    window.__videoPopout = {
      getData: () => ({
        streams: allVideoStreamsRef.current,
        clients: clientsRef.current,
        selectedStreamClientId: selectedStreamClientIdRef.current,
        volume: streamVolumeRef.current,
        muted: streamMutedRef.current,
        watchedStreamClientIds: watchedStreamClientIdsRef.current,
        streamViewers: streamViewersRef.current
      }),
      select: (id) => setSelectedStreamClientId(id),
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
  // Polls `.closed` rather than listening for 'pagehide': the new window's empty
  // document fires pagehide as it navigates to the popout route, which read as an
  // instant close and yanked the view back with the popout still open. `.closed`
  // only flips on a genuine close, so it has no such false positive.
  useEffect(() => {
    if (!poppedOut) return
    const id = setInterval(() => {
      if (!popoutWindowRef.current || popoutWindowRef.current.closed) {
        popoutWindowRef.current = null
        setPoppedOut(false)
        setViewMode('video')
      }
    }, 1000)
    return () => clearInterval(id)
  }, [poppedOut])

  // A channel we're "peeking" into: viewing/posting in its chat without joining
  // its voice (no streams, no view tabs). Null in the normal joined-channel view.
  const [previewChannelId, setPreviewChannelId] = useState(null)

  // A client whose summary/profile we're viewing in the main area (single-click a
  // client). Mutually exclusive with the chat preview. Null when not viewing one.
  const [summaryClientId, setSummaryClientId] = useState(null)

  // A channel whose details we're viewing in the main area (right-click → Channel
  // Details). Mutually exclusive with the chat preview and client summary.
  const [summaryChannelId, setSummaryChannelId] = useState(null)

  // Explicitly viewing the server-traffic log (server menu → View server
  // traffic), forced on top of the in-channel chat/streams view. Another canvas
  // override, mutually exclusive with the preview/summary views above; cleared
  // by Esc or navigating elsewhere. When lurking, traffic is the default view
  // anyway, so this only matters while in a voice channel.
  const [showTraffic, setShowTraffic] = useState(false)
  // Forced server-summary view (server menu). Same canvas-override rules as
  // showTraffic: mutually exclusive with the preview/summary views, cleared by
  // Esc or navigating elsewhere.
  const [showServerSummary, setShowServerSummary] = useState(false)

  // The channel the local client currently has joined (chat is scoped to it)
  const selfChannelId = clients.find((c) => c.id === client?.id)?.channel_id ?? null

  // Chat (messages / typing / history) follows the previewed channel when
  // peeking, otherwise the joined channel.
  const activeChatChannelId = previewChannelId ?? selfChannelId

  // Chat is on screen when peeking a channel or when the joined channel's Chat
  // tab is selected (mirrors the render condition below).
  const chatVisible = previewChannelId != null || viewMode === 'log'

  // Do Not Disturb silences interruptions (notification/inbox toasts, the new
  // message chime) but never suppresses the notification itself — unread counts
  // still tick up so nothing is missed, it just waits for you. Declared here
  // rather than beside its consumers because the ref-sync effect below reads it
  // during render, in its dependency array.
  const dnd = statusOf(presences[client?.id]) === 'do_not_disturb'

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
  // Read inside the socket handler, which closes over its first render.
  useEffect(() => {
    dndRef.current = dnd
  }, [dnd])
  useEffect(() => {
    feedRef.current = feed
  }, [feed])

  // Unread is derived, not stored: a channel is unread when its newest message
  // (last_message_id) differs from our acknowledged cursor. A null===null pair
  // (empty channel, never acked) is correctly read. Drives the sidebar dot.
  const unreadChannelIds = useMemo(() => {
    const set = new Set()
    for (const ch of channels) {
      if ((ch.last_message_id ?? null) !== (readStates[ch.id] ?? null)) set.add(ch.id)
    }
    return set
  }, [channels, readStates])

  // Ack our read cursor in a channel up to `messageId` (the channel's latest).
  const markChannelRead = useCallback(
    (channelId, messageId) => {
      if (!token || channelId == null) return
      authFetch(`${apiBase()}/channels/${channelId}/read-state`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ last_acknowledged_message_id: messageId ?? null })
      }).catch((err) => console.error('Failed to mark channel read:', err))
    },
    [token]
  )

  // Viewing a channel's chat (chatVisible) acks its latest message and clears the
  // unread dot, optimistically updating the local cursor. Re-runs when a new
  // message lands in the open channel.
  useEffect(() => {
    if (activeChatChannelId == null || !chatVisible) return
    // Reading a DM also clears its inbox alert.
    setDmNotifications((prev) =>
      prev.some((n) => n.channelId === activeChatChannelId)
        ? prev.filter((n) => n.channelId !== activeChatChannelId)
        : prev
    )
    if (!token) return
    const latest = channels.find((c) => c.id === activeChatChannelId)?.last_message_id ?? null
    if (latest === (readStates[activeChatChannelId] ?? null)) return
    setReadStates((prev) => ({ ...prev, [activeChatChannelId]: latest }))
    markChannelRead(activeChatChannelId, latest)
  }, [activeChatChannelId, chatVisible, channels, readStates, token, markChannelRead])

  // (Re)baseline stream-sound detection on connect / channel change / recovery:
  // snapshot the streams in view (by clientId, so re-consumed streams after a
  // reconnect aren't heard as restarts) without sounding, then arm after a delay.
  // Stays disarmed until healthy. Must run before the diff effect below so a
  // channel switch disarms before the diff sees the new channel's streams.
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
  // in just returns to the normal view. Closes any open client summary.
  const handlePreviewChannel = (channelId) => {
    setSummaryClientId(null)
    setSummaryChannelId(null)
    setShowTraffic(false)
    setShowServerSummary(false)
    setPreviewChannelId(channelId === selfChannelId ? null : channelId)
  }

  // Single-click a client: show their summary/profile in the main area.
  const handleShowClientSummary = (userId) => {
    setPreviewChannelId(null)
    setSummaryChannelId(null)
    setShowTraffic(false)
    setShowServerSummary(false)
    setSummaryClientId(userId)
  }

  // Right-click a channel → Channel Details: show the channel summary in the main
  // area. Mutually exclusive with the chat preview and client summary.
  const handleShowChannelSummary = (channelId) => {
    setPreviewChannelId(null)
    setSummaryClientId(null)
    setShowTraffic(false)
    setShowServerSummary(false)
    setSummaryChannelId(channelId)
  }

  // Server menu → View server traffic: force the traffic log into the canvas,
  // clearing any other canvas override. Navigating anywhere (Esc, a channel, a
  // profile) drops it again.
  const handleViewServerTraffic = () => {
    setPreviewChannelId(null)
    setSummaryClientId(null)
    setSummaryChannelId(null)
    setShowServerSummary(false)
    setShowTraffic(true)
  }

  // Server menu → View server summary: force the server-summary card into the
  // canvas, clearing any other override. Cleared like the traffic view.
  const handleViewServerSummary = () => {
    setPreviewChannelId(null)
    setSummaryClientId(null)
    setSummaryChannelId(null)
    setShowTraffic(false)
    setShowServerSummary(true)
  }

  // Open the DM an inbox alert points at: by sender id when known (resolves the
  // header), else peek the channel by id. Viewing clears the alert.
  const handleOpenDmNotification = (n) => {
    if (n.authorId != null) {
      handleOpenDm(n.authorId)
    } else if (n.channelId != null) {
      setSummaryClientId(null)
      setSummaryChannelId(null)
      setPreviewChannelId(n.channelId)
    }
  }

  // Open the channel a bell notification (e.g. a mention) points at.
  const handleOpenNotification = (n) => {
    if (n.channelId == null) return
    setSummaryClientId(null)
    setSummaryChannelId(null)
    setPreviewChannelId(n.channelId)
  }

  // Close the summary if the client leaves the server (mirrors the preview-drop
  // above): we can't show a profile for someone no longer connected.
  useEffect(() => {
    if (summaryClientId != null && !clients.some((c) => c.id === summaryClientId)) {
      setSummaryClientId(null)
    }
  }, [summaryClientId, clients])

  // Close the channel summary if the channel is deleted out from under us.
  useEffect(() => {
    if (summaryChannelId != null && !channels.some((c) => c.id === summaryChannelId)) {
      setSummaryChannelId(null)
    }
  }, [summaryChannelId, channels])

  // Get-or-create the 1:1 DM channel with another user and make it known to
  // `channels`, returning its id. Shared by handleOpenDm (peek) and handlePoke
  // (fire a message without necessarily switching views). Idempotent server-side.
  const ensureDmChannel = useCallback(
    async (userId) => {
      const res = await authFetch(`${apiBase()}/channels/dm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Array so the same endpoint creates a group chat later; today both entry
        // points (double-click, poke) only ever send one recipient.
        body: JSON.stringify({ recipient_ids: [userId] })
      })
      await throwIfError(res)
      const channel = await res.json()
      if (channel?.id == null) return null
      // Stamp the recipients/type we know from the click so the header resolves to
      // the other user's name regardless of the server's channel shape. Merge onto
      // any existing entry: the server's Ready/ChannelCreated may have already added
      // this channel in its bare shape, and our stamp needs to win.
      const dm = { ...channel, type: 'dm', recipients: [client?.id, userId] }
      setChannels((prev) =>
        prev.some((c) => c.id === dm.id)
          ? prev.map((c) => (c.id === dm.id ? { ...c, ...dm } : c))
          : [...prev, dm]
      )
      return dm.id
    },
    [token, client]
  )

  // Open (or create) a 1:1 DM and peek into its chat. DMs are just 'dm' channels,
  // so they ride the same preview path as a channel peek.
  const handleOpenDm = useCallback(
    async (userId) => {
      if (!userId || userId === client?.id) return
      setSummaryClientId(null)
      setShowTraffic(false)
      setShowServerSummary(false)
      try {
        const id = await ensureDmChannel(userId)
        // The preview-drop effect clears any previewed id not in `channels`, but
        // ensureDmChannel has already registered it, so this is safe.
        if (id != null) setPreviewChannelId(id)
      } catch (err) {
        showError(`Failed to open direct message: ${err.message}`, err)
      }
    },
    [client, ensureDmChannel]
  )

  // Poke a client: fire off a DM message (the attached note, or a wave if none)
  // without leaving the current view. For now it's just a normal DM under the
  // hood; the dedicated poke notification can come later.
  const handlePoke = useCallback(
    async (userId, message) => {
      if (!userId || userId === client?.id) return
      const text = (message || '').trim() || '👋'

      try {
        const id = await ensureDmChannel(userId)
        if (id == null) return
        // Mirror handleSendMessage's multipart shape (text-only, no files) so the
        // server sees an ordinary DM message and broadcasts MessageCreated back.
        const formData = new FormData()
        formData.append(
          'payload_json',
          new Blob([JSON.stringify({ content: text, attachments: [] })], {
            type: 'application/json'
          })
        )
        const res = await authFetch(`${apiBase()}/channels/${id}/messages`, {
          method: 'POST',
          body: formData
        })
        await throwIfError(res)
      } catch (err) {
        showError(`Failed to poke: ${err.message}`, err)
      }
    },
    [client, token, ensureDmChannel]
  )

  // Admin moderation. The backend designates the first user to enter a server as
  // admin and enforces these; non-admins just get an error toast. The kicked/
  // banned user leaving is broadcast back as a normal roster removal.
  const handleKickUser = useCallback(
    async (userId, reason) => {
      if (!userId || userId === client?.id) return
      try {
        const res = await authFetch(`${apiBase()}/server/clients/${userId}/kick`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reason ? { reason } : {})
        })
        await throwIfError(res)
      } catch (err) {
        showError(`Failed to kick user: ${err.message}`, err)
      }
    },
    [client, token, showError]
  )

  // Load the server's role list once per connection. It feeds both the Assign
  // Role menu and our own permission computation (which gates kick/ban below).
  useEffect(() => {
    if (!token) {
      setRoles([])
      return
    }
    authFetch(`${apiBase()}/server/roles`)
      .then((res) => res.json())
      .then((data) => setRoles(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load roles:', err))
  }, [token])

  // Load the server's vanity groups once per connection; VanityCreated/
  // VanityDeleted events keep the list current afterwards. Icons come back as
  // /cdn/… paths, resolved against the active host like avatars.
  useEffect(() => {
    if (!token) {
      setVanity([])
      return
    }
    authFetch(`${apiBase()}/server/vanity`)
      .then((res) => res.json())
      .then((data) =>
        setVanity(Array.isArray(data) ? data.map((v) => ({ ...v, avatar: cdnUrl(v.avatar) })) : [])
      )
      .catch((err) => console.error('Failed to load vanity groups:', err))
  }, [token])

  // Our effective permissions: the OR of every role we hold (explicit role_ids
  // plus the implicit 'everyone' role). ADMINISTRATOR implies all. Computed from
  // the live roster entry so it tracks role changes via ClientModified.
  const myPermissions = useMemo(() => {
    const self = clients.find((c) => c.id === client?.id)
    const myRoleIds = new Set(self?.role_ids || client?.role_ids || [])
    let bits = 0n
    for (const r of roles) {
      if (r.name?.toLowerCase() === 'everyone' || myRoleIds.has(r.id)) {
        try {
          bits |= BigInt(r.permissions ?? 0)
        } catch {
          // Ignore a malformed permission string rather than crash the menu.
        }
      }
    }
    return bits
  }, [roles, clients, client])

  const isAdmin = (myPermissions & PERM_ADMINISTRATOR) !== 0n
  const canKickMembers = isAdmin || (myPermissions & PERM_KICK_MEMBERS) !== 0n
  const canBanMembers = isAdmin || (myPermissions & PERM_BAN_MEMBERS) !== 0n
  const canMuteMembers = isAdmin || (myPermissions & PERM_MUTE_MEMBERS) !== 0n
  // Editing a channel's permission overwrites needs MANAGE_CHANNELS or
  // MANAGE_ROLES (or admin). The server is authoritative; this only gates the UI.
  const canManageChannels =
    isAdmin || (myPermissions & (PERM_MANAGE_CHANNELS | PERM_MANAGE_ROLES)) !== 0n

  // The current ban list (BanApiObject[] = { reason, user }). Banned users are
  // surfaced in the Users roster so they can be unbanned; refreshed after our
  // own ban/unban actions since those change the list. Gated on canBanMembers —
  // the server 403s the fetch for anyone else, so don't fire a guaranteed-
  // forbidden request on every join (it re-runs if our roles later allow it).
  const refreshBans = useCallback(() => {
    if (!token || !canBanMembers) {
      setBans([])
      return
    }
    authFetch(`${apiBase()}/server/bans`)
      .then((res) => res.json())
      .then((data) => setBans(Array.isArray(data) ? data : []))
      .catch((err) => console.error('Failed to load bans:', err))
  }, [token, canBanMembers])

  useEffect(() => {
    refreshBans()
  }, [refreshBans])

  // Banned users, shaped like roster clients (resolved avatar) so ClientIndicator
  // can render them. Marked via the returned id set below.
  const bannedUsers = useMemo(
    () => bans.map((b) => ({ ...b.user, avatar: cdnUrl(b.user.avatar) })),
    [bans]
  )

  // Assign / remove a role. role_ids is updated on success (not optimistically),
  // so a server rejection — e.g. missing MANAGE_ROLES — doesn't leave a stale
  // checkmark in the menu. The server may also broadcast ClientModified with
  // role_ids, which the events handler merges for everyone else.
  const handleAssignRole = useCallback(
    async (clientId, roleId) => {
      const roleName = roles.find((r) => r.id === roleId)?.name ?? 'role'
      const clientName = clients.find((c) => c.id === clientId)?.name ?? 'user'
      const apply = () => {
        setClients((prev) =>
          prev.map((c) =>
            c.id === clientId && !(c.role_ids || []).includes(roleId)
              ? { ...c, role_ids: [...(c.role_ids || []), roleId] }
              : c
          )
        )
        showSuccess(`Assigned "${roleName}" to ${clientName}`)
      }
      try {
        const res = await authFetch(`${apiBase()}/server/clients/${clientId}/roles/${roleId}`, {
          method: 'PUT'
        })
        await throwIfError(res)
        apply()
      } catch (err) {
        showError(`Failed to assign role: ${err.message}`, err)
      }
    },
    [token, roles, clients, showError, showSuccess]
  )

  const handleRemoveRole = useCallback(
    async (clientId, roleId) => {
      const roleName = roles.find((r) => r.id === roleId)?.name ?? 'role'
      const clientName = clients.find((c) => c.id === clientId)?.name ?? 'user'
      const apply = () => {
        setClients((prev) =>
          prev.map((c) =>
            c.id === clientId
              ? { ...c, role_ids: (c.role_ids || []).filter((r) => r !== roleId) }
              : c
          )
        )
        // Green like assign: a revocation we carried out is a success — red is
        // reserved for actions taken against us (see the ClientModified diff).
        showSuccess(`Revoked "${roleName}" from ${clientName}`)
      }
      try {
        const res = await authFetch(`${apiBase()}/server/clients/${clientId}/roles/${roleId}`, {
          method: 'DELETE'
        })
        await throwIfError(res)
        apply()
      } catch (err) {
        showError(`Failed to remove role: ${err.message}`, err)
      }
    },
    [token, roles, clients, showError, showSuccess]
  )

  // Create a vanity group (name + optional icon data URL). The server
  // broadcasts VanityCreated — echoed back to us too — which is what adds it
  // to the list, so nothing is applied locally here.
  const handleCreateVanityGroup = useCallback(
    async (name, avatar) => {
      try {
        const res = await authFetch(`${apiBase()}/server/vanity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'group', name, ...(avatar ? { avatar } : {}) })
        })
        await throwIfError(res)
        showSuccess(`Created group "${name}"`)
      } catch (err) {
        showError(`Failed to create group: ${err.message}`, err)
      }
    },
    [token, showError, showSuccess]
  )

  // Assign / remove a vanity group on a client. Mirrors roles: vanity_ids is
  // updated on success (not optimistically); the server broadcasts
  // ClientModified with vanity_ids, which the events handler merges for
  // everyone else.
  const handleToggleVanity = useCallback(
    async (clientId, vanityId, assign) => {
      const groupName = vanity.find((v) => v.id === vanityId)?.name ?? 'group'
      const clientName = clients.find((c) => c.id === clientId)?.name ?? 'user'
      try {
        const res = await authFetch(`${apiBase()}/server/clients/${clientId}/vanity/${vanityId}`, {
          method: assign ? 'PUT' : 'DELETE'
        })
        await throwIfError(res)
        setClients((prev) =>
          prev.map((c) => {
            if (c.id !== clientId) return c
            const ids = (c.vanity_ids || []).filter((id) => id !== vanityId)
            return { ...c, vanity_ids: assign ? [...ids, vanityId] : ids }
          })
        )
        showSuccess(
          assign
            ? `Assigned "${groupName}" to ${clientName}`
            : `Removed "${groupName}" from ${clientName}`
        )
      } catch (err) {
        showError(`Failed to update group: ${err.message}`, err)
      }
    },
    [token, vanity, clients, showError, showSuccess]
  )

  // durationSeconds 0 = permanent (server default); reason optional.
  const handleBanUser = useCallback(
    async (userId, { durationSeconds = 0, reason } = {}) => {
      if (!userId || userId === client?.id) return
      try {
        const body = { duration_seconds: durationSeconds }
        if (reason) body.reason = reason
        const res = await authFetch(`${apiBase()}/server/clients/${userId}/ban`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        })
        await throwIfError(res)
        refreshBans()
      } catch (err) {
        showError(`Failed to ban user: ${err.message}`, err)
      }
    },
    [client, token, showError, refreshBans]
  )

  // Lift a ban. No self-guard (unbanning yourself is a harmless no-op) and no
  // local roster change — a banned client isn't connected, so there's nothing to
  // update here; the server just clears the ban entry.
  const handleUnbanUser = useCallback(
    async (userId) => {
      if (!userId) return
      try {
        const res = await authFetch(`${apiBase()}/server/clients/${userId}/ban`, {
          method: 'DELETE'
        })
        await throwIfError(res)
        refreshBans()
      } catch (err) {
        showError(`Failed to unban user: ${err.message}`, err)
      }
    },
    [token, showError, refreshBans]
  )

  // Edit our own profile: PATCH /client/self //Update locally -> Server broadcasts ClientModified to others.
  // `patch` is { avatar } and/or { nickname }; `local` is how it maps onto our
  // client row (the server calls it nickname, the roster renders it as `name`).
  const patchSelf = useCallback(
    async (patch, local, label) => {
      const selfId = client?.id
      setClients((prev) => prev.map((c) => (c.id === selfId ? { ...c, ...local } : c)))
      try {
        const res = await authFetch(`${apiBase()}/client/self`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch)
        })
        await throwIfError(res)
      } catch (err) {
        showError(`Failed to set ${label}: ${err.message}`, err)
      }
    },
    [client, token]
  )

  // avatar is a `data:image/...;base64,...` string, or null to remove it.
  const handleSetAvatar = useCallback(
    (avatar) => {
      if (avatar === undefined) return
      patchSelf({ avatar }, { avatar }, 'avatar')
    },
    [patchSelf]
  )

  // Display name shown to other clients; decoupled from the login username.
  const handleSetNickname = useCallback(
    (nickname) => {
      const name = nickname.trim()
      if (!name) return
      patchSelf({ nickname: name }, { name }, 'nickname')
    },
    [patchSelf]
  )

  // Fetch a channel's recent history and replace that channel's feed entries with it.
  // Routed through the main process (GET with a JSON body). `shouldApply`
  // bails if the result is stale (user switched channels before it arrived).
  const loadChannelHistory = useCallback(
    (channelId, shouldApply = () => true) => {
      if (!token || channelId == null) return Promise.resolve()
      // The request runs in the main process, outside authFetch — hand it a
      // token refreshed here if needed.
      return getFreshToken()
        .then((accessToken) =>
          window.electron.ipcRenderer.invoke('get-channel-messages', {
            url: `${apiBase()}/channels/${channelId}/messages`,
            token: accessToken,
            limit: HISTORY_LIMIT
          })
        )
        .then((res) => {
          if (!shouldApply()) return
          if (!res?.ok) {
            if (res?.error) console.error('Failed to load chat history:', res.error)
            return
          }
          const history = (res.messages || []).map(messageFromApi).sort(byChronology)
          // We just replaced this channel's messages with the recent page, so
          // it's no longer scrolled to the start — let scroll-up paginate again.
          setExhaustedChannels((prev) => {
            if (!prev.has(channelId)) return prev
            const next = new Set(prev)
            next.delete(channelId)
            return next
          })
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

  // Scroll-up pagination: fetch the page of messages older than the oldest one currently held and prepend it
  // The server returns at most HISTORY_LIMIT; a short page means we've reached the start -> mark the channel exhausted and stop asking.
  const loadOlderMessages = useCallback(() => {
    const channelId = activeChatChannelIdRef.current
    if (!token || channelId == null || loadingOlderRef.current) return Promise.resolve()
    const oldest = feedRef.current.reduce((min, e) => {
      if (e.type !== 'message' || e.channelId !== channelId) return min
      return !min || byChronology(e, min) < 0 ? e : min
    }, null)
    if (!oldest) return Promise.resolve()
    loadingOlderRef.current = true
    return getFreshToken()
      .then((accessToken) =>
        window.electron.ipcRenderer.invoke('get-channel-messages', {
          url: `${apiBase()}/channels/${channelId}/messages`,
          token: accessToken,
          limit: HISTORY_LIMIT,
          before: oldest.id
        })
      )
      .then((res) => {
        if (!res?.ok) {
          if (res?.error) console.error('Failed to load older messages:', res.error)
          return 0
        }
        const older = (res.messages || []).map(messageFromApi)
        if (older.length < HISTORY_LIMIT) {
          setExhaustedChannels((prev) => new Set(prev).add(channelId))
        }
        const have = new Set(feedRef.current.map((e) => e.id))
        const fresh = older.filter((m) => !have.has(m.id)).sort(byChronology)
        if (fresh.length) setFeed((prev) => [...fresh, ...prev])
        return fresh.length
      })
      .catch((err) => {
        console.error('Failed to load older messages:', err)
        return 0
      })
      .finally(() => {
        loadingOlderRef.current = false
      })
  }, [token])

  // Load recent messages when local client joins channel, opening a channel shows what was said before joining
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

  // Open the suppression window just before a self channel action, so the echoed
  // ChannelUpdated (which can arrive before the HTTP response resolves) doesn't
  // also fire the "your current channel was edited" cue.
  const markSelfChannelAction = () => {
    lastSelfChannelActionAtRef.current = Date.now()
  }

  // Create a channel on the server. Position is computed to append after the current last channel.
  //The server also broadcasts ChannelCreated, so the add here is deduped by id in case that broadcast echoes back to us.
  const handleCreateChannel = async ({ name, user_limit, afterPosition }) => {
    const trimmed = name.trim()
    if (!trimmed) return
    // Insert just below the channel the create was launched from; otherwise
    // append after the current last channel. The backend reorders the rest.
    const position =
      typeof afterPosition === 'number'
        ? afterPosition + 1
        : channels.reduce((max, ch) => Math.max(max, ch.position ?? 0), -1) + 1

    try {
      const res = await authFetch(`${apiBase()}/server/channel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed, user_limit, position })
      })
      await throwIfError(res)
      const created = await res.json().catch(() => null)
      if (created && created.id != null) {
        setChannels((prev) => (prev.some((ch) => ch.id === created.id) ? prev : [...prev, created]))
      }
      playUiSound('channel_created')
    } catch (err) {
      showError(`Failed to create channel: ${err.message}`, err)
    }
  }

  // Delete a channel. Removed locally on success; the server may also broadcast
  // a deletion to other clients.
  const handleDeleteChannel = async (id) => {
    try {
      const res = await authFetch(`${apiBase()}/channels/${id}`, {
        method: 'DELETE'
      })
      await throwIfError(res)
      setChannels((prev) => prev.filter((ch) => ch.id !== id))
      playUiSound('channel_deleted')
    } catch (err) {
      showError(`Failed to delete channel: ${err.message}`, err)
    }
  }

  // Move a channel to a new position (drag-to-reorder). The server reindexes the
  // rest and broadcasts ChannelUpdated for the affected channels, so we don't
  // mutate locally on success.
  const handleReorderChannel = async (id, position) => {
    markSelfChannelAction()
    try {
      const res = await authFetch(`${apiBase()}/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ position })
      })
      await throwIfError(res)
      playUiSound('channel_moved')
      showSuccess('Channel moved')
    } catch (err) {
      showError(`Failed to reorder channel: ${err.message}`, err)
    }
  }

  // Set a channel's description (edited from the Channel Details view). Like
  // reorder, the server broadcasts ChannelUpdated, so we don't mutate locally on
  // success.
  const handleSetChannelDescription = async (id, description) => {
    markSelfChannelAction()
    try {
      const res = await authFetch(`${apiBase()}/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description })
      })
      await throwIfError(res)
      playUiSound('channel_edited')
      showSuccess('Channel description updated')
    } catch (err) {
      showError(`Failed to update channel description: ${err.message}`, err)
    }
  }

  // Set a channel's icon (from the channel's right-click menu). channel_icon is
  // a `data:image/...;base64,...` string, same pipeline as client avatars. The
  // server broadcasts ChannelUpdated, so no local mutate here.
  const handleSetChannelIcon = async (id, channel_icon) => {
    markSelfChannelAction()
    try {
      const res = await authFetch(`${apiBase()}/channels/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel_icon })
      })
      await throwIfError(res)
      playUiSound('channel_edited')
      showSuccess(channel_icon ? 'Channel icon updated' : 'Channel icon removed')
    } catch (err) {
      showError(`Failed to set channel icon: ${err.message}`, err)
    }
  }

  // Upsert a channel permission overwrite for a role or user (allow/deny are
  // decimal bitfield strings). Like description/reorder, the server broadcasts
  // ChannelUpdated with the new overwrites, so we don't mutate locally
  // on success.
  const handleSetChannelOverwrite = async (channelId, targetId, targetType, allow, deny) => {
    markSelfChannelAction()
    try {
      const res = await authFetch(`${apiBase()}/channels/${channelId}/permissions/${targetId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: targetType, allow, deny })
      })
      await throwIfError(res)
      playUiSound('channel_edited')
      showSuccess('Channel permissions updated')
    } catch (err) {
      showError(`Failed to update channel permissions: ${err.message}`, err)
    }
  }

  const handleDeleteChannelOverwrite = async (channelId, targetId) => {
    markSelfChannelAction()
    try {
      const res = await authFetch(`${apiBase()}/channels/${channelId}/permissions/${targetId}`, {
        method: 'DELETE'
      })
      await throwIfError(res)
      playUiSound('channel_edited')
      showSuccess('Channel permission removed')
    } catch (err) {
      showError(`Failed to remove channel permission: ${err.message}`, err)
    }
  }

  // Move another client into a channel (drag their entry onto a channel header).
  // The server enforces permissions and broadcasts ClientModified, so we don't
  // mutate locally on success.
  const handleMoveClientToChannel = useCallback(
    async (userId, channelId) => {
      if (userId == null) return
      // No-op if they're already there.
      const current = clients.find((c) => String(c.id) === String(userId))
      if (current && current.channel_id === channelId) return

      try {
        const res = await authFetch(`${apiBase()}/client/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel_id: channelId })
        })
        await throwIfError(res)
        // Clearing their channel (channel_id null) is a kick from it. If they were
        // in our channel, that's "someone was kicked from your channel". Only we,
        // the kicker, can tell this from a normal leave, so it only chimes for us.
        if (channelId == null && current?.channel_id === selfChannelIdRef.current) {
          playUiSound('neutral_kicked_channel_awayfromcurrentchannel')
        }
      } catch (err) {
        showError(`Failed to move user: ${err.message}`, err)
      }
    },
    [clients, token, showError]
  )

  // Kick a client out of their voice channel (without disconnecting them from the
  // server): clear their channel via the same PATCH the move uses, channel_id null.
  const handleKickFromChannel = useCallback(
    (userId) => handleMoveClientToChannel(userId, null),
    [handleMoveClientToChannel]
  )

  // Gag / ungag a client: server-wide mute (PATCH /client { mute }) so they can't
  // speak in any channel. The server broadcasts VoiceStateUpdate with the new
  // server_mute, so we don't mutate locally on success.
  const handleGagUser = useCallback(
    async (userId, gag) => {
      try {
        const res = await authFetch(`${apiBase()}/client/${userId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mute: gag })
        })
        await throwIfError(res)
      } catch (err) {
        showError(`Failed to ${gag ? 'gag' : 'ungag'} user: ${err.message}`, err)
      }
    },
    [token, showError]
  )

  // Connect to a saved server: point all endpoints at its host, then log in with
  // its stored credentials. Setting the token triggers the data-loading effect.
  const handleConnect = async (server) => {
    // A host is global because the REST/WebSocket helpers are shared. Tear down
    // the previous session before changing it, otherwise old channel data and
    // reconnect callbacks can issue requests against the new host (or null).
    if (token || connectedServer) handleDisconnect()
    setServerHost(server.host)
    setConnecting(true)

    const credentials = {
      username: server.username,
      password: server.password,
      device_name: 'Pylon Desktop'
    }
    const login = () =>
      httpFetch(`${apiBase()}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(credentials)
      }).then(async (res) => ({ response: res, data: await res.json().catch(() => ({})) }))

    try {
      let result = await login()
      let data = result.data
      // Preserve the existing first-connect experience: an unauthorized login
      // may be a first-time account, so try registration and then retry login.
      if (result.response.status === 401) {
        const registerResponse = await httpFetch(`${apiBase()}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(credentials)
        })
        if (registerResponse.ok) {
          result = await login()
          data = result.data
        }
      }

      if (result.response.ok && data.access_token) {
        applyAuthResponse(data)
        setConnectedServer(server)
        playUiSound('connected')
      } else {
        setServerHost(null)
        showError(`Failed to connect to ${server.nickname}: ${data.error || 'login failed'}`)
      }
    } catch {
      setServerHost(null)
      showError(`Failed to connect to ${server.nickname}: could not reach server`)
    } finally {
      setConnecting(false)
    }
  }

  // Single source of truth for dropping back to the disconnected state (the
  // reconnect paths call it too on a rejected token, so none leave half-cleared
  // state). Clearing the token tears down the events socket via effect cleanup.
  const handleDisconnect = useCallback((opts) => {
    if (popoutWindowRef.current && !popoutWindowRef.current.closed) {
      popoutWindowRef.current.close()
    }
    popoutWindowRef.current = null
    setPoppedOut(false)
    disconnectVoice()
    clearAuth()
    setChannels([])
    setClients([])
    setFeed([])
    setAllVideoStreams([])
    setSelectedStreamClientId(null)
    setWatchedStreamClientIds(new Set())
    setConnectedServer(null)
    setServerHost(null)
    setPreviewChannelId(null)
    setSummaryClientId(null)
    setReadStates({})
    setConnectionStatus('connected')
    // Kick/ban paths play their own specific cue and pass skipSound.
    if (!opts?.skipSound) playUiSound('disconnected')
  }, [clearAuth])

  // A refresh the server rejects means the device session is revoked or
  // expired — drop to the disconnected state and require a fresh login.
  useEffect(() => {
    setOnSessionExpired(() => {
      showError('Session expired — please reconnect', { silent: true })
      handleDisconnect()
    })
    return () => setOnSessionExpired(null)
  }, [handleDisconnect, showError])

  // Fetch channels/clients and set up WebSocket + IPC listeners on mount
  useEffect(() => {
    if (!token) return

    // Reset any session carried over from a previous token/server so the first
    // IDENTIFY of this session is fresh — we must never resume into a session
    // that belongs to a different server.
    sessionIdRef.current = null
    lastEventSeqRef.current = null
    setConnectionStatus('connected')

    // Resync after losing our session (we can't replay the events we missed).
    // Channels/clients are restored by the server's Ready event on fresh re-auth;
    // here we only need to reload the active channel's message history, which
    // Ready does not include.
    const reloadHistory = () => loadChannelHistory(activeChatChannelIdRef.current)

    // Seed the inbox from DM channels that are unread per the read cursors (i.e.
    // messages arrived while we were offline). `clientList` is Ready's clients —
    // the refs aren't populated yet when Ready fires, so resolve names from it.
    const seedUnreadDms = (chans, reads, clientList) => {
      const self = selfIdRef.current
      const seeded = chans
        .filter((c) => c.type === 'dm' && (c.last_message_id ?? null) !== (reads[c.id] ?? null))
        .map((c) => {
          const o = dmOther(c, self)
          const name =
            o.name || clientList.find((cl) => cl.id === o.id)?.name || c.name || 'Someone'
          return {
            id: `unread-${c.id}`,
            channelId: c.id,
            authorId: o.id,
            message: `${name} sent you a direct message`,
            timestamp: Date.now()
          }
        })
      if (!seeded.length) return
      const seededChannels = new Set(seeded.map((s) => s.channelId))
      setDmNotifications((prev) => [
        ...seeded,
        ...prev.filter((p) => !seededChannels.has(p.channelId))
      ])
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
        if (hadSession) reloadHistory()
        // Ready follows and carries a presence snapshot, so no resync needed here.
      } else if (reply.kind === 'Resumed') {
        // Replay should redeliver the PresenceUpdates we missed, but a resume that
        // outlived the server's buffer would silently leave stale dots on screen.
        // A resync is one small request — cheap insurance on a rare path.
        refreshPresencesRef.current?.()
        // Resume accepted: the events we missed replay next as ordered, dup-free
        // dispatches, then live events continue. Keep our position; refresh id.
        if (reply.session_id != null) sessionIdRef.current = reply.session_id
      } else if (reply.kind === 'InvalidSession') {
        // Resume refused (server restarted or we were away too long): drop the
        // session, full resync, and reconnect fresh. Clearing the refs makes the
        // next connect identify without a resume object.
        sessionIdRef.current = null
        lastEventSeqRef.current = null
        reloadHistory()
        closedByUs = false
        ws.close()
      } else if (reply.kind === 'Unauthorized') {
        // Token rejected — stop reconnecting and return to a fully clean
        // disconnected state (not a half-torn-down one that would leave a stale
        // channel list on screen).
        closedByUs = true
        ws.close()
        handleDisconnect()
      }
    }

    // A create/reorder makes the server broadcast one ChannelCreated/Updated per
    // affected channel, each in its own ws message — and each message is its own
    // task, so React commits them separately and the sidebar's reorder animation
    // plays as several out-of-sync partial moves. Coalesce the burst into one
    // setChannels so a whole reorder lands in a single commit (= one animation).
    let pendingChannelUpserts = new Map()
    let channelFlushTimer = null
    const queueChannelUpsert = (data) => {
      pendingChannelUpserts.set(data.id, { ...pendingChannelUpserts.get(data.id), ...data })
      clearTimeout(channelFlushTimer)
      // ponytail: 30ms debounce window; if server bursts ever span longer, batch server-side instead
      channelFlushTimer = setTimeout(() => {
        const pending = pendingChannelUpserts
        pendingChannelUpserts = new Map()
        setChannels((prev) => {
          const merged = prev.map((ch) =>
            pending.has(ch.id) ? { ...ch, ...pending.get(ch.id) } : ch
          )
          const existing = new Set(prev.map((ch) => ch.id))
          const added = [...pending.values()].filter((ch) => !existing.has(ch.id))
          return added.length ? [...merged, ...added] : merged
        })
      }, 150)
    }

    // Apply a dispatched event to local state.
    const handleEvent = (ev, data) => {
      // Initial snapshot pushed by the server right after a fresh, non-resuming
      // auth. Replaces (not merges) the lists with the authoritative state — this
      // is the websocket's equivalent of the old REST baseline fetch.
      if (ev === 'Ready') {
        setChannels(data.channels)
        // Authoritative presence snapshot. Keyed by client_id; absent = offline.
        setPresences(Object.fromEntries((data.presences || []).map((p) => [p.client_id, p])))
        // Voice state splits into self toggles (`self_mute`/`self_deaf`) and
        // server-forced state (`muted`/`deaf`, i.e. a moderator gag / server
        // deafen). Normalize the server-forced pair to `server_mute`/`server_deaf`
        // so `server_mute` alone means "gagged".
        setClients(data.clients.map(normalizeClientVoice))
        // Seed read cursors (one entry per visible channel).
        const reads = {}
        for (const rs of data.read_states || []) {
          reads[rs.channel_id] = rs.last_acknowledged_message_id
        }
        setReadStates(reads)
        // Surface DMs that went unread while we were away in the inbox.
        seedUnreadDms(data.channels || [], reads, data.clients || [])
        return
      }

      // Public presence broadcast. The object is authoritative for that user —
      // replace it wholesale rather than merging, so a cleared status_message
      // (null) doesn't leave the previous one behind.
      if (ev === 'PresenceUpdate') {
        // Server traffic: log a crossing of the online/offline boundary (someone
        // else). Invisible == offline, so an invisible user never crosses into
        // visible (no "came online"), and going invisible reads as "went offline".
        const wasOffline = statusOf(presencesRef.current[data.client_id]) === 'offline'
        const isOffline = statusOf(data) === 'offline'
        if (wasOffline !== isOffline && data.client_id !== selfIdRef.current) {
          const name = clientsRef.current.find((c) => c.id === data.client_id)?.name || 'Someone'
          const now = Date.now()
          setTraffic((prev) =>
            [
              { id: `${data.client_id}-${now}`, clientId: data.client_id, name, online: !isOffline, ts: now },
              ...prev
            ].slice(0, MAX_LOG_ENTRIES)
          )
        }
        // Our own away status toggling (set from the status menu, echoed back).
        if (data.client_id === selfIdRef.current) {
          const wasAway = statusOf(presencesRef.current[data.client_id]) === 'away'
          const isAway = statusOf(data) === 'away'
          if (isAway !== wasAway) playUiSound(isAway ? 'away_activated' : 'away_deactivated')
        }
        setPresences((prev) => ({ ...prev, [data.client_id]: data }))
        return
      }

      // Voice state update broadcast for a client: self toggles + server-forced
      // gag/deafen. Authoritative source for all mute/deafen state (ClientModified
      // no longer carries it).
      if (ev === 'VoiceStateUpdate') {
        const { client_id, muted, deaf, self_mute, self_deaf } = data
        // A change to our own server_mute is a gag/ungag by a moderator (our own
        // mic mute is self_mute, not this). Chime on the transition only.
        if (client_id === selfIdRef.current) {
          const wasGagged = !!clientsRef.current.find((c) => c.id === client_id)?.server_mute
          if (!!muted !== wasGagged) playUiSound(muted ? 'you_were_gagged' : 'you_were_ungagged')
        }
        setClients((prev) =>
          prev.map((c) =>
            c.id === client_id
              ? {
                  ...c,
                  self_mute: !!self_mute,
                  self_deaf: !!self_deaf,
                  server_mute: !!muted,
                  server_deaf: !!deaf
                }
              : c
          )
        )
        return
      }

      if (ev === 'NewUser') {
        const entry = normalizeClientVoice(data)
        // Upsert by id: a kicked client is kept in the roster (kick = disconnect,
        // not removal), so should the server ever re-announce one on rejoin, we
        // replace the stale entry rather than adding a duplicate.
        setClients((prev) =>
          prev.some((c) => c.id === entry.id)
            ? prev.map((c) => (c.id === entry.id ? entry : c))
            : [...prev, entry]
        )
        // Surface lobby arrivals in the bell — NewUser fires when someone joins
        // the server (Ready already seeded everyone present at connect), so this
        // catches people lurking before they enter any channel.
        const now = Date.now()
        setNotifications((prev) =>
          [
            {
              id: `join-${data.id}-${now}`,
              message: `${data.name || 'Someone'} joined the server.`,
              timestamp: now
            },
            ...prev
          ].slice(0, 50)
        )
      } else if (ev === 'ClientModified') {
        const oldChannelId = clientsRef.current.find((c) => c.id === data.id)?.channel_id

        // Someone changed OUR roles: diff old vs new ids and toast. When we
        // changed them ourselves, handleAssignRole/handleRemoveRole already
        // updated local state (and toasted), so the diff here is empty and
        // this stays silent — no double toast.
        if (data.id === selfIdRef.current && 'role_ids' in data) {
          const before = new Set(clientsRef.current.find((c) => c.id === data.id)?.role_ids || [])
          const after = new Set(data.role_ids || [])
          const roleName = (id) => rolesRef.current.find((r) => r.id === id)?.name ?? 'a role'
          const added = [...after].find((id) => !before.has(id))
          const removed = [...before].find((id) => !after.has(id))
          if (added != null) {
            showSuccess(`You were given the "${roleName(added)}" role`)
            playUiSound('servergroup_assigned')
          } else if (removed != null) {
            showError(`Your "${roleName(removed)}" role was revoked`, { silent: true })
            playUiSound('servergroup_revoked')
          }
        }
        // Same for OUR vanity groups: green when another user adds us to one,
        // red when they remove us. Our own toggles were already applied (and
        // toasted green) by handleToggleVanity, so the diff here stays empty.
        if (data.id === selfIdRef.current && 'vanity' in data) {
          const before = new Set(clientsRef.current.find((c) => c.id === data.id)?.vanity_ids || [])
          const after = new Set((data.vanity || []).map((v) => v.id))
          const groupName = (id) =>
            (data.vanity || []).find((v) => v.id === id)?.name ??
            vanityRef.current.find((v) => v.id === id)?.name ??
            'a group'
          const added = [...after].find((id) => !before.has(id))
          const removed = [...before].find((id) => !after.has(id))
          if (added != null) {
            showSuccess(`You were added to the "${groupName(added)}" group`)
            playUiSound('servergroup_assigned')
          } else if (removed != null) {
            showError(`You were removed from the "${groupName(removed)}" group`, { silent: true })
            playUiSound('servergroup_revoked')
          }
        }
        // ClientModified also carries profile changes (avatar / nickname). Merge
        // whatever fields are present so we don't clobber the others; `in` guards
        // keep an event that omits a field from wiping it.
        setClients((prev) =>
          prev.map((c) => {
            if (c.id !== data.id) return c
            const next = { ...c }
            if ('channel_id' in data) next.channel_id = data.channel_id
            if ('role_ids' in data) next.role_ids = data.role_ids
            if ('vanity' in data) next.vanity_ids = (data.vanity || []).map((v) => v.id)
            if ('avatar' in data) next.avatar = cdnUrl(data.avatar)
            if (data.nickname != null) next.name = data.nickname
            if (data.name != null) next.name = data.name
            return next
          })
        )

        // What channel WE last declared (pre-sync). If it still differs from what
        // the server now reports for us, we never asked for this change — it was
        // forced (a moderator kick/move), not our own leave/switch.
        const selfDeclaredChannel = voiceStateRef.current.channel_id

        // A forced move (a moderator's PATCH /client) changes our channel without
        // us sending a VoiceStateUpdate, so sync the declarative voice-state ref.
        // Otherwise the next mute/deafen merges our stale channel_id and yanks us
        // back to the channel we were moved out of.
        if (data.id === selfIdRef.current && 'channel_id' in data) {
          voiceStateRef.current = { ...voiceStateRef.current, channel_id: data.channel_id }
        }

        // Join/leave chimes. For ourselves: a move into a channel is a "join",
        // dropping out (channel_id null) is a "leave" — but only when the channel
        // actually changed. ClientModified now also fires for same-channel updates
        // (e.g. a mute/deafen VoiceStateUpdate re-asserts our channel_id), and
        // those must stay silent. For others: only sound when they enter or leave
        // the channel we're currently in. Skip entirely for profile-only edits
        // (avatar/nickname) that don't carry a channel_id.
        const myChannel = selfChannelIdRef.current
        if (!('channel_id' in data)) {
          // no channel move to chime for
        } else if (data.id === selfIdRef.current) {
          if (oldChannelId !== data.channel_id) {
            if (data.channel_id != null) {
              // Moving into a channel — "you moved to another channel".
              playUiSound('channel_switched')
            } else if (selfDeclaredChannel != null) {
              // Dropped to no channel without us asking for it → kicked from the
              // channel. A voluntary leave declares channel_id null first, so
              // selfDeclaredChannel would be null there and this stays silent.
              playUiSound('you_kicked_channel')
            }
          }
        } else if (myChannel != null) {
          if (data.channel_id === myChannel && oldChannelId !== myChannel) {
            playUiSound('channel-join')
          } else if (oldChannelId === myChannel && data.channel_id !== myChannel) {
            playUiSound('channel-leave')
          }
        }
      } else if (ev === 'MessageCreated') {
        setFeed((prev) => appendFeed(prev, messageFromApi(data)))
        // Advance the channel's newest-message pointer — unread is derived from
        // this vs. our read cursor. (The server does not auto-ack the sender, so
        // our own sends rely on the view→ack effect to mark them read.)
        setChannels((prev) =>
          prev.map((c) => (c.id === data.channel_id ? { ...c, last_message_id: data.id } : c))
        )
        // Sending a message ends that author's typing indicator immediately,
        // leaving anyone else still typing untouched.
        setTypingEntries((prev) => prev.filter((t) => t.clientId !== data.author))
        // Chime for messages arriving in the channel we're viewing, from anyone
        // but ourselves — regardless of whether we're on the chat or video tab.
        if (
          data.author !== selfIdRef.current &&
          data.channel_id === activeChatChannelIdRef.current &&
          !dndRef.current
        ) {
          playUiSound('new-message')
        }
        // A DM message from someone else, while we're not reading it, raises a
        // clickable inbox alert (deduped to the latest message per DM channel).
        const readingHere =
          data.channel_id === activeChatChannelIdRef.current && chatVisibleRef.current
        // Being mentioned (directly or via @everyone) rings the bell — even
        // while viewing that channel. Snowflakes compared as strings since
        // JSON may carry them as numbers.
        const mentioned =
          data.mention_everyone ||
          (data.mentions || []).some((id) => String(id) === String(selfIdRef.current))
        if (mentioned && data.author !== selfIdRef.current) {
          const channel = channelsRef.current.find((c) => c.id === data.channel_id)
          const now = Date.now()
          setNotifications((prev) =>
            [
              {
                id: `mention-${data.id ?? now}`,
                channelId: data.channel_id,
                message: `You were mentioned in ${channel?.name || 'a channel'}`,
                timestamp: now
              },
              ...prev
            ].slice(0, 50)
          )
        }
        if (data.author !== selfIdRef.current && !readingHere) {
          const dmChannel = channelsRef.current.find((c) => c.id === data.channel_id)
          if (dmChannel?.type === 'dm') {
            const name = clientsRef.current.find((c) => c.id === data.author)?.name || 'Someone'
            setDmNotifications((prev) => [
              {
                id: data.id ?? `${data.channel_id}-${Date.now()}`,
                channelId: data.channel_id,
                authorId: data.author,
                message: `${name} sent you a direct message`,
                timestamp: Date.now()
              },
              ...prev.filter((n) => n.channelId !== data.channel_id)
            ])
          }
        }
      } else if (ev === 'ReadStateUpdated') {
        // Private to us: another session (or our own ack) moved a read cursor.
        setReadStates((prev) => ({
          ...prev,
          [data.channel_id]: data.last_acknowledged_message_id
        }))
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
        // The event carries the channel's new newest-message id (null if now
        // empty); keep last_message_id in sync so unread derivation stays correct.
        if (data !== null && typeof data === 'object' && 'last_message_id' in data) {
          setChannels((prev) =>
            prev.map((c) =>
              c.id === data.channel_id ? { ...c, last_message_id: data.last_message_id } : c
            )
          )
        }
      } else if (ev === 'ChannelCreated' || ev === 'ChannelUpdated') {
        queueChannelUpsert(data)
        // Someone else edited the channel we're currently in. Our own edits play
        // the plain "channel edited" cue and mark the echo (consumed here) so this
        // stays silent for them.
        if (
          ev === 'ChannelUpdated' &&
          data.id === selfChannelIdRef.current &&
          Date.now() - lastSelfChannelActionAtRef.current > SELF_CHANNEL_ACTION_MS
        ) {
          playUiSound('your_channel_was_edited')
        }
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
      } else if (ev === 'ClientRemoved') {
        // Authoritative roster removal (leave / kick / ban all emit this). `data`
        // is the ClientApiObject itself.
        setClients((prev) => prev.filter((c) => c.id !== data.id))
      } else if (ev === 'ClientKicked') {
        // { client, reason }. A kick only disconnects the client — they stay a
        // server member and may rejoin — so we deliberately DON'T prune the
        // roster here. Pruning would desync: the server still considers them a
        // member and so never re-announces them (NewUser) on rejoin, leaving them
        // invisible to everyone else. Ban is different (see ClientBanned).
        // Chime if someone in our channel was kicked (not our own kick — that's
        // handled on the socket close).
        if (data.client?.id !== selfIdRef.current && data.client?.channel_id === selfChannelIdRef.current) {
          playUiSound('neutral_kicked_server_currentchannel')
        }
      } else if (ev === 'ClientBanned') {
        // { client, duration_seconds, reason }. Drop from the roster and record
        // the ban so they surface in the Users tab (where they can be unbanned).
        // The event carries the full client, so no /server/bans refetch is needed.
        if (data.client?.id !== selfIdRef.current && data.client?.channel_id === selfChannelIdRef.current) {
          playUiSound('neutral_banned_server_currentchannel')
        }
        setClients((prev) => prev.filter((c) => c.id !== data.client.id))
        setBans((prev) =>
          prev.some((b) => b.user.id === data.client.id)
            ? prev
            : [...prev, { reason: data.reason ?? null, user: data.client }]
        )
      } else if (ev === 'VanityCreated') {
        // data is the VanityItem ({ id, type: 'group', name, avatar }). Upsert
        // by id — our own POST gets this broadcast echoed back too.
        const item = { ...data, avatar: cdnUrl(data.avatar) }
        setVanity((prev) =>
          prev.some((v) => v.id === item.id)
            ? prev.map((v) => (v.id === item.id ? item : v))
            : [...prev, item]
        )
      } else if (ev === 'VanityDeleted') {
        setVanity((prev) => prev.filter((v) => v.id !== data.id))
        // Strip the dead id from anyone still wearing it.
        setClients((prev) =>
          prev.map((c) =>
            (c.vanity_ids || []).includes(data.id)
              ? { ...c, vanity_ids: c.vanity_ids.filter((id) => id !== data.id) }
              : c
          )
        )
      } else {
        setFeed((prev) => appendFeed(prev, systemEntry(`Unknown event: ${ev}`)))
      }
    }

    // Open a socket and run the handshake. Reused for the initial connection and
    // every reconnect; `connect` reassigns the shared `ws` each time.
    const connect = async () => {
      // Identify must carry a live access token: the one from login may have
      // expired while we were disconnected, so refresh first when needed.
      let accessToken
      try {
        accessToken = await getFreshToken()
      } catch {
        // Couldn't refresh (network). Back off and retry; a dead session fires
        // the session-expired handler instead, which tears this effect down.
        scheduleReconnect()
        return
      }
      if (closedByUs) return
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
          ? {
              token: accessToken,
              resume: { session_id: sessionIdRef.current, seq: lastEventSeqRef.current }
            }
          : { token: accessToken }
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

        // Voice ticket (op 6): the server's reply to a VoiceStateUpdate that
        // moved us from no channel into a voice one. Hand it to soup, which is
        // opening (or about to open) the voice socket that needs it.
        if (msg.op === 6) {
          receiveVoiceTicket(msg.ticket)
          return
        }

        // Rejected command (e.g. an invalid presence update). This is a reply to
        // one message, not a connection fault — surface it and keep the socket.
        if (typeof msg.err === 'string') {
          showError(msg.err)
          return
        }

        // Events are wrapped as { op: 3, data: <event>, seq }, or arrive bare as
        // { ev, data }. Support both, and remember the latest sequence so the
        // heartbeat and any resume can report our position.
        if (typeof msg.seq === 'number') lastEventSeqRef.current = msg.seq
        const { ev, data } = msg.op === 3 ? msg.data : msg
        handleEvent(ev, data)
      }

      ws.onclose = (event) => {
        console.log('WebSocket disconnected', event.code, event.reason)
        clearHeartbeat()
        if (eventsWsRef.current === ws) eventsWsRef.current = null
        // Forced removal by an admin: the server closes with an application code
        // and a reason. Stop retrying (a reconnect would just be rejected) and
        // tell the user instead of silently dropping to the disconnected screen.
        // ponytail: codes assumed 4001 kick / 4002 ban; the reason-text match is
        // the fallback if the server numbers them differently.
        const reason = (event.reason || '').toLowerCase()
        const banned = event.code === 4002 || reason.includes('ban')
        const kicked = event.code === 4001 || reason.includes('kick')
        if (banned || kicked) {
          closedByUs = true // suppress the reconnect path below
          showError(`You have been ${banned ? 'banned' : 'kicked'} from the server`, {
            silent: true
          })
          playUiSound(banned ? 'you_were_banned' : 'you_kicked_server')
          handleDisconnect({ skipSound: true })
          return
        }
        // Recover unless the close was intentional. We resume if we still hold a
        // session; the next handshake reply decides resume vs. fresh.
        scheduleReconnect()
      }

      ws.onerror = (err) => console.error('WebSocket error:', err)
    }

    // First connection. The first IDENTIFY is always fresh (session refs were
    // cleared above), so the server's Ready event — pushed right after the
    // Authenticated handshake — is our starting channel/client state.
    setFeed([])
    connect()

    return () => {
      closedByUs = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      clearTimeout(channelFlushTimer)
      clearHeartbeat()
      if (ws) ws.close()
      eventsWsRef.current = null
    }
  }, [token, loadChannelHistory, handleDisconnect])

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
    if (activeChatChannelId == null) return
    const now = Date.now()
    if (now - lastTypingSentRef.current < TYPING_DURATION_MS) return
    lastTypingSentRef.current = now
    authFetch(`${apiBase()}/channels/${activeChatChannelId}/typing`, {
      method: 'POST'
    }).catch((err) => console.error('Failed to send typing:', err))
  }

  // Send a chat message (with any attachments) to the channel we're currently in
  const handleSendMessage = async (text, attachments) => {
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
      const res = await authFetch(`${apiBase()}/channels/${activeChatChannelId}/messages`, {
        method: 'POST',
        body: formData
      })
      await throwIfError(res)
      playUiSound('chat_message_outbound')
      // The server broadcasts MessageCreated back to us too, which appends it to the feed
    } catch (err) {
      showError(`Failed to send message: ${err.message}`, err)
    }
  }

  // Edit one of our own messages. The server validates ownership (only the
  // author may edit) and broadcasts MessageUpdated with the new content and an
  // edited_timestamp, which patches the feed entry in place — so we don't touch
  // local state here on success, mirroring how send relies on MessageCreated.
  const handleEditMessage = async (messageId, content) => {
    const trimmed = content.trim()
    if (!trimmed) return

    if (activeChatChannelId == null) return

    try {
      const res = await authFetch(
        `${apiBase()}/channels/${activeChatChannelId}/messages/${messageId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: trimmed })
        }
      )
      await throwIfError(res)
      // The server broadcasts MessageUpdated back to us, patching the feed entry.
    } catch (err) {
      showError(`Failed to edit message: ${err.message}`, err)
    }
  }

  // Flip one reaction in the local feed (add / bump / un-react).
  const toggleReactionLocal = (messageId, emoji) => {
    setFeed((prev) =>
      prev.map((e) => {
        if (e.type !== 'message' || e.id !== messageId) return e
        const reactions = e.reactions || []
        const existing = reactions.find((r) => r.emoji === emoji)
        let next
        if (existing?.me) {
          // Un-react: drop our count; remove the chip when it hits zero.
          next = reactions
            .map((r) => (r.emoji === emoji ? { ...r, count: r.count - 1, me: false } : r))
            .filter((r) => r.count > 0)
        } else if (existing) {
          next = reactions.map((r) =>
            r.emoji === emoji ? { ...r, count: r.count + 1, me: true } : r
          )
        } else {
          next = [...reactions, { emoji, count: 1, me: true }]
        }
        return { ...e, reactions: next }
      })
    )
  }

  // Toggle a reaction: optimistic local flip, then PUT (add) or DELETE
  // (remove) with the emoji as the path segment. The server's MessageUpdated
  // broadcast carries the authoritative aggregate and overwrites the guess;
  // on request failure we flip back.
  const handleReactMessage = async (messageId, emoji) => {
    const entry = feed.find((e) => e.type === 'message' && e.id === messageId)
    if (!entry) return
    const had = !!(entry.reactions || []).find((r) => r.emoji === emoji)?.me
    toggleReactionLocal(messageId, emoji)

    try {
      const res = await authFetch(
        `${apiBase()}/channels/${entry.channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
        { method: had ? 'DELETE' : 'PUT' }
      )
      await throwIfError(res)
    } catch (err) {
      toggleReactionLocal(messageId, emoji)
      showError(`Failed to ${had ? 'remove' : 'add'} reaction: ${err.message}`, err)
    }
  }

  // Delete one of our own messages. The server validates ownership and broadcasts
  // MessageDeleted; we also drop it locally on success so it disappears
  // immediately even if the broadcast is delayed (the broadcast is idempotent).
  const handleDeleteMessage = async (messageId) => {
    if (activeChatChannelId == null) return

    try {
      const res = await authFetch(
        `${apiBase()}/channels/${activeChatChannelId}/messages/${messageId}`,
        { method: 'DELETE' }
      )
      await throwIfError(res)
      setFeed((prev) => prev.filter((e) => !(e.type === 'message' && e.id === messageId)))
    } catch (err) {
      showError(`Failed to delete message: ${err.message}`, err)
    }
  }

  // Single source of truth for our outbound voice state. The server's
  // VoiceStateUpdate (op 1) is declarative: it carries the *full* desired state,
  // and a missing channel_id is read as "leave all channels". So every send must
  // include all three fields. We hold them in a ref and merge each partial update
  // optimistically — that way a mute toggle never drops our channel, a channel
  // move never resets our mute/deafen, and a rapid move-then-mute can't race on a
  // server-echoed field that hasn't arrived yet.
  const voiceStateRef = useRef({ self_mute: false, self_deaf: false, channel_id: null })
  const sendVoiceState = useCallback((patch) => {
    const next = { ...voiceStateRef.current, ...patch }
    voiceStateRef.current = next
    if (eventsWsRef.current?.readyState === WebSocket.OPEN) {
      eventsWsRef.current.send(JSON.stringify({ op: 1, data: next }))
    }
  }, [])

  // Broadcast our mic-mute / deafen status, keeping our current channel.
  const sendStatus = (selfMute, selfDeaf) =>
    sendVoiceState({ self_mute: selfMute, self_deaf: selfDeaf })

  // Change our own presence (op 5). Unlike voice state this is a genuine patch:
  // an omitted field is preserved server-side, so send only what changed —
  // `status_message: null` is meaningful (clears it) and must survive the trip.
  const sendPresence = useCallback(
    (patch) => {
      if (patch.status == null && !('status_message' in patch)) return
      if ('status_message' in patch) {
        const { message, error } = validateMessage(patch.status_message)
        if (error) {
          showError(error)
          return
        }
        patch = { ...patch, status_message: message }
      }
      if (eventsWsRef.current?.readyState !== WebSocket.OPEN) {
        showError('Not connected — presence not updated')
        return
      }
      eventsWsRef.current.send(JSON.stringify({ op: 5, data: patch }))
      // No optimistic update: the server echoes PresenceUpdate to us too, and it
      // arbitrates between our devices (last write wins). Guessing here would
      // flicker whenever another device wins the race.
    },
    [showError]
  )

  // Full resync. The gateway is the live path; this is for recovering after a
  // reconnect that resumed (no fresh Ready, so no new presence snapshot).
  const refreshPresences = useCallback(async () => {
    if (!token) return
    try {
      const res = await authFetch(`${apiBase()}/server/presences`)
      const list = await (await throwIfError(res)).json()
      setPresences(Object.fromEntries((list || []).map((p) => [p.client_id, p])))
    } catch (err) {
      console.warn('[Presence] resync failed:', err.message)
    }
  }, [token])

  // Mirrored into a ref so the socket effect can call it without listing it as a
  // dep — that effect owns the connection and must not re-run when a callback
  // identity changes, or every render would drop and rebuild the WebSocket.
  useEffect(() => {
    refreshPresencesRef.current = refreshPresences
  }, [refreshPresences])

  // Merge stream updates from a specific channel into the global streams list
  const handleStreamsUpdate = (channelId, streams) => {
    setAllVideoStreams((prev) => {
      const filtered = prev.filter((s) => s.channelId !== channelId)
      return [...filtered, ...streams.map((s) => ({ ...s, channelId }))]
    })
  }

  const [showSettings, setShowSettings] = useState(false)
  // Exit animation is handled by AnimatePresence in the JSX below, so open/
  // close are plain state flips — closing never blocks on a timer.
  const openSettings = () => setShowSettings(true)
  const closeSettings = () => setShowSettings(false)
  const overlayAnim = useAnimationCategory('overlays')

  // Focused Escape closes the topmost open menu/view, one layer per press, in
  // stacking order (settings overlay → roles/groups menu → canvas summary/peek
  // views). Skips when a nested control already handled the key (defaultPrevented,
  // e.g. an open picker) so it never yanks a layer out from under one.
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (showSettings) setShowSettings(false)
      else if (rolesGroupsOpen) setRolesGroupsOpen(false)
      else if (summaryChannelId != null) setSummaryChannelId(null)
      else if (summaryClientId != null) setSummaryClientId(null)
      else if (previewChannelId != null) setPreviewChannelId(null)
      else if (showTraffic) setShowTraffic(false)
      else if (showServerSummary) setShowServerSummary(false)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [showSettings, rolesGroupsOpen, summaryChannelId, summaryClientId, previewChannelId, showTraffic, showServerSummary])

  const connected = !!token
  const titleText = connectedServer ? `${APP_TITLE} — ${connectedServer.nickname}` : APP_TITLE

  // Canvas header title: the joined voice channel, or the server when lurking.
  const joinedChannel = channels.find((c) => c.id === selfChannelId)
  const joinedChannelUserCount = clients.filter((c) => c.channel_id === selfChannelId).length

  // Names of other clients typing in the channel we're viewing (self excluded).
  const typingUsers = typingEntries
    .filter((t) => t.channelId === activeChatChannelId && t.clientId !== client?.id)
    .map((t) => t.name)

  // Title for the peeked-into chat header: for a DM, the other recipient's name;
  // otherwise the channel name. The name may be unresolvable if the other user is
  // offline (not in `clients`), so fall back to the channel's own name.
  const previewChannel = channels.find((c) => c.id === previewChannelId)
  let previewChannelName
  if (previewChannel?.type === 'dm') {
    const o = dmOther(previewChannel, client?.id)
    previewChannelName =
      o.name || clients.find((c) => c.id === o.id)?.name || previewChannel.name || 'Direct Message'
  } else {
    previewChannelName = previewChannel?.name ?? 'Channel'
  }

  // The client whose summary is open (single-click), or null.
  const summaryClient =
    summaryClientId != null ? clients.find((c) => c.id === summaryClientId) : null

  // The channel whose details are open (right-click → Channel Details), or null,
  // plus its current member count for the "#joined / limit" line.
  const summaryChannel =
    summaryChannelId != null ? channels.find((c) => c.id === summaryChannelId) : null
  const summaryChannelMemberCount =
    summaryChannel != null ? clients.filter((c) => c.channel_id === summaryChannel.id).length : 0

  // Handed to ClientActionsProvider so a client context menu can be opened from
  // anywhere (currently the sidebar roster and chat message authors).
  const clientActions = {
    onOpenDm: handleOpenDm,
    onPoke: handlePoke,
    onKick: handleKickUser,
    onKickFromChannel: handleKickFromChannel,
    onGag: handleGagUser,
    onBan: handleBanUser,
    onUnban: handleUnbanUser,
    onSetAvatar: handleSetAvatar,
    onSetNickname: handleSetNickname,
    presences,
    onSetPresence: sendPresence,
    onShowClientSummary: handleShowClientSummary,
    roles,
    onAssignRole: handleAssignRole,
    onRemoveRole: handleRemoveRole,
    vanity,
    onToggleVanity: handleToggleVanity,
    onOpenRolesGroups: () => setRolesGroupsOpen(true),
    canKickMembers,
    canBanMembers,
    canMuteMembers
  }

  return (
    <ClientActionsProvider value={clientActions}>
      <div className="app-shell">
        <Toast message={toast?.message} variant={toast?.variant} onDismiss={dismissToast} />
        {rolesGroupsOpen && (
          <RolesGroupsMenu
            roles={roles}
            vanity={vanity}
            onCreateVanity={handleCreateVanityGroup}
            onClose={() => setRolesGroupsOpen(false)}
          />
        )}
        <TitleBar
          title={titleText}
          icon={IconUsersGroup}
          notifications={notifications}
          onClearNotifications={() => setNotifications([])}
          onOpenNotification={handleOpenNotification}
          silentNotifications={dnd}
          dmNotifications={dmNotifications}
          onOpenDmNotification={handleOpenDmNotification}
          onClearDmNotifications={() => setDmNotifications([])}
        />
        <div className="layout">
          <SideBar
            channels={channels}
            clients={clients}
            self={client}
            onStreamsUpdate={handleStreamsUpdate}
            onStatusChange={sendStatus}
            onSelfChannelChange={(channelId) => {
              // Joining/leaving a voice channel is a navigation — drop the
              // forced traffic view so we land on that channel's chat.
              setShowTraffic(false)
              setShowServerSummary(false)
              sendVoiceState({ channel_id: channelId })
            }}
            onViewServerTraffic={handleViewServerTraffic}
            onViewServerSummary={handleViewServerSummary}
            // provide a renderer-level openSettings hook
            onOpenSettings={openSettings}
            servers={servers}
            connectedServer={connectedServer}
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onAddServer={handleAddServer}
            onEditServer={handleEditServer}
            onRemoveServer={handleRemoveServer}
            onNotify={showSuccess}
            onCreateChannel={handleCreateChannel}
            onDeleteChannel={handleDeleteChannel}
            onReorderChannel={handleReorderChannel}
            onMoveClient={handleMoveClientToChannel}
            onPreviewChannel={handlePreviewChannel}
            onShowChannelSummary={handleShowChannelSummary}
            onOpenDm={handleOpenDm}
            onPoke={handlePoke}
            onKick={handleKickUser}
            onKickFromChannel={handleKickFromChannel}
            onGag={handleGagUser}
            onBan={handleBanUser}
            onError={showError}
            onUnban={handleUnbanUser}
            onSetAvatar={handleSetAvatar}
            onShowClientSummary={handleShowClientSummary}
            roles={roles}
            onAssignRole={handleAssignRole}
            onRemoveRole={handleRemoveRole}
            vanity={vanity}
            onToggleVanity={handleToggleVanity}
            onOpenRolesGroups={() => setRolesGroupsOpen(true)}
            bannedUsers={bannedUsers}
            canKickMembers={canKickMembers}
            canBanMembers={canBanMembers}
            canMuteMembers={canMuteMembers}
            previewChannelId={previewChannelId}
            summaryChannelId={summaryChannelId}
            unreadChannelIds={unreadChannelIds}
          />

          <main className="chat-area">
            {/* Summary views have no header bar: their banner card acts as the header.
              Leaving a view = clicking back to your joined channel in the sidebar. */}
            {summaryChannelId == null && summaryClientId == null && !showServerSummary && (
              <div className="chat-header">
                <div className="header-content">
                  {showTraffic ? (
                    // Forced traffic view (server menu). Title-only header like a
                    // peek — Esc or navigating elsewhere returns to the channel.
                    <span className="view-preview-title">
                      <IconActivity size={18} stroke={2} />
                      Server Traffic
                    </span>
                  ) : previewChannelId != null ? (
                    // Peeking into another channel's chat: no view tabs (no streams),
                    // just the channel name.
                    <span className="view-preview-title">
                      {previewChannel?.type === 'dm' ? (
                        <IconUser size={18} stroke={2} />
                      ) : (
                        <IconMessage size={18} stroke={2} />
                      )}
                      {previewChannelName}
                    </span>
                  ) : connected && joinedChannel ? (
                    // In a voice channel: channel name + member count + Chat/Streams tabs.
                    <>
                      <div className="chat-title">
                        <span className="chat-title-icon">
                          <IconVolume size={17} stroke={2} />
                        </span>
                        <span className="chat-title-text">
                          <span className="chat-title-name">{joinedChannel.name}</span>
                          <span className="chat-title-sub">{joinedChannelUserCount} in voice</span>
                        </span>
                      </div>
                      <SegmentedTabs
                        ariaLabel="Main view"
                        active={viewMode}
                        onChange={setViewMode}
                        tabs={[
                          {
                            id: 'log',
                            label: 'Chat',
                            icon: <IconMessage size={15} stroke={2} />
                          },
                          {
                            id: 'video',
                            label: 'Streams',
                            icon: <IconVideo size={15} stroke={2} />,
                            disabled: poppedOut,
                            title: poppedOut ? 'Video is open in a separate window' : undefined
                          }
                        ]}
                      />
                    </>
                  ) : connected ? (
                    // Lurking (not in a voice channel): just the server name — the
                    // canvas below shows server traffic, so no tabs or subtext.
                    <div className="chat-title">
                      <span className="chat-title-icon">
                        <IconUsersGroup size={17} stroke={2} />
                      </span>
                      <span className="chat-title-text">
                        <span className="chat-title-name">
                          {connectedServer?.nickname ?? 'Connected'}
                        </span>
                      </span>
                    </div>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </div>
              </div>
            )}

            {/* Keyed so switching channel/tab remounts and replays the switch animation. */}
            <div
              className="chat-switch-region"
              key={
                !connected
                  ? 'disconnected'
                  : summaryChannelId != null
                    ? `channel-summary-${summaryChannelId}`
                    : summaryClientId != null
                      ? `summary-${summaryClientId}`
                      : showServerSummary
                        ? 'server-summary'
                        : previewChannelId != null
                        ? `preview-${previewChannelId}`
                        : showTraffic || !joinedChannel
                          ? 'lobby'
                          : viewMode
              }
            >
              {!connected ? (
                <IdleAnimation connecting={connecting} />
              ) : summaryChannelId != null ? (
                <ChannelSummary
                  channel={summaryChannel}
                  memberCount={summaryChannelMemberCount}
                  onSaveDescription={handleSetChannelDescription}
                  onSetIcon={handleSetChannelIcon}
                  roles={roles}
                  clients={clients}
                  canManagePermissions={canManageChannels}
                  onSetOverwrite={handleSetChannelOverwrite}
                  onDeleteOverwrite={handleDeleteChannelOverwrite}
                />
              ) : summaryClientId != null ? (
                <ClientSummary
                  client={summaryClient}
                  roles={roles}
                  vanity={vanity}
                  isSelf={summaryClient?.id === client?.id}
                  onSetAvatar={handleSetAvatar}
                />
              ) : showServerSummary ? (
                <ServerSummary />
              ) : showTraffic || (previewChannelId == null && !joinedChannel) ? (
                // Server-traffic log: shown on demand (server menu) or as the
                // default when lurking (not in a voice channel, not peeking).
                <ServerTraffic entries={traffic} clients={clients} />
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
                  onReactMessage={handleReactMessage}
                  onTyping={handleTyping}
                  typingUsers={typingUsers}
                  disabled={activeChatChannelId == null}
                  channelKey={activeChatChannelId}
                  onLoadOlder={loadOlderMessages}
                  hasMoreOlder={
                    activeChatChannelId != null && !exhaustedChannels.has(activeChatChannelId)
                  }
                />
              ) : (
                <VideoGrid
                  streams={allVideoStreams}
                  clients={clients}
                  selectedStreamClientId={selectedStreamClientId}
                  onSelect={setSelectedStreamClientId}
                  onPopout={handlePopout}
                  watchedStreamClientIds={watchedStreamClientIds}
                  onSetStreamWatched={handleSetStreamWatched}
                  volume={streamVolume}
                  muted={streamMuted}
                  onVolumeChange={setStreamVolume}
                  onMutedChange={setStreamMuted}
                />
              )}
            </div>
          </main>
          <AnimatePresence>
            {showSettings && (
              <motion.div
                className="settings-overlay"
                onClick={closeSettings}
                {...scrimFade(overlayAnim)}
              >
                <motion.div
                  className="settings-modal"
                  onClick={(e) => e.stopPropagation()}
                  {...overlayPop(overlayAnim)}
                >
                  <button
                    className="settings-close-btn"
                    onClick={closeSettings}
                    title="Close settings"
                  >
                    <IconX size={18} />
                  </button>
                  <Settings />
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
        {connected && connectionStatus === 'reconnecting' && (
          <ConnectionOverlay onAbort={handleDisconnect} />
        )}
      </div>
    </ClientActionsProvider>
  )
}

export default Main
