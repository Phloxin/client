import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import './VideoGrid.css'
import {
  IconVideoMinus,
  IconVideoFilled,
  IconMaximize,
  IconMinimize,
  IconChevronDown,
  IconChevronUp,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconVolume4,
  IconVolumeOff,
  IconExternalLink,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconScreenShare,
  IconScreenShareOff,
  IconEye,
  IconEyeOff,
  IconMovie,
  IconMicrophone,
  IconMicrophoneOff,
  IconHeadphones,
  IconHeadphonesOff,
  IconDeviceDesktop
} from '@tabler/icons-react'
import { RESOLUTIONS } from '../lib/captureOptions'
import { setFocusedScreenAudio, setVideoStreamRoles, subscribeStreamViewers } from '../lib/soup'
import { useImageColors } from '../lib/imageColors'
import { useWheelSlider } from '../lib/useWheelSlider'
import { useSettings } from '../context/SettingsContext'

// Stable empty default so the role effect doesn't churn when no watched set is
// passed (e.g. the popout's first render before the bridge data arrives).
const EMPTY_WATCHED = new Set()
// Same idea for the theatre-mode props the popout window never supplies.
const EMPTY_LIST = []
const EMPTY_SPEAKING = {}

// Gap (px) between grid tiles — must match the `gap` in .video-grid-layout.
const GRID_GAP = 12
const TILE_AR = 16 / 9

// How long the pointer can sit still before the overlay chrome fades out.
const CHROME_IDLE_MS = 4000

// Scroll-to-zoom bounds/step for the focused stream.
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// Largest uniform 16:9 tile width that fits `n` tiles inside a W×H area without
// scrolling. Tries every column count and, for each, takes the tile size capped
// by both the available width (per column) and height (per row), then keeps the
// biggest. This is the CSS-impossible part of a Discord-style grid: all tiles
// stay equal AND scale down together so the whole set is always on screen.
function bestUniformTileWidth(W, H, n, gap = GRID_GAP) {
  if (!W || !H || !n) return 0
  let best = 0
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const wByWidth = (W - (cols - 1) * gap) / cols
    const hByRow = (H - (rows - 1) * gap) / rows
    const wByHeight = hByRow * TILE_AR
    const w = Math.min(wByWidth, wByHeight)
    if (w > best) best = w
  }
  return Math.floor(best)
}

// Stands in for the video on a tile we aren't watching: the sharer's avatar over
// a flat colour sampled from it — the summary banner's trick, minus the
// gradient. Without an avatar it falls back to the initial on the theme tint.
function StreamPlaceholder({ avatar, initial }) {
  const colors = useImageColors(avatar)
  return (
    <div
      className="stream-stopped"
      style={
        colors
          ? { background: `color-mix(in srgb, ${colors.vibrant} 45%, var(--color-background-mute))` }
          : undefined
      }
    >
      <span className="stream-placeholder-avatar">
        {avatar ? <img src={avatar} alt="" /> : initial}
      </span>
    </div>
  )
}

function VideoGrid({
  streams,
  clients,
  selectedStreamClientId,
  onSelect,
  onPopout,
  onFocusAudio,
  onSetStreamRoles,
  watchedStreamClientIds = EMPTY_WATCHED,
  onSetStreamWatched,
  // Ends our own screen share (owned by the sidebar's VoiceChannel). Absent in
  // windows that can't reach it, which hides the stop button on our own stream.
  onStopSharing,
  // Drives the capture settings menu on our own stream: read the live options,
  // restart with new ones, or reopen the source picker.
  shareControl,
  streamViewers: streamViewersProp,
  volume,
  muted,
  onVolumeChange,
  onMutedChange,
  // Theatre mode: fills the window with participant icons + voice controls
  // overlaid. Only the main window supplies these (the popout omits them, so
  // its theatre button is hidden and the overlays never render).
  theatre = false,
  onToggleTheatre,
  voiceClients = EMPTY_LIST,
  speakingClients = EMPTY_SPEAKING,
  selfId,
  micMuted = false,
  deafened = false,
  onToggleMic,
  onToggleDeafen
}) {
  const { appearanceSettings } = useSettings()
  const showCodecBadge = appearanceSettings.showCodecBadge !== false
  const viewerRef = useRef(null)
  const gridRef = useRef(null)
  const focusRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [carouselCollapsed, setCarouselCollapsed] = useState(false)
  // Capture-settings popover on our own stream's stop button. Its contents are
  // snapshotted from shareControl when opened — the options live in the sidebar.
  const [shareMenuOpen, setShareMenuOpen] = useState(false)
  const [shareOptions, setShareOptions] = useState(null)
  // Overlay chrome (control bar, stream name, viewer count) rides the pointer:
  // shown while it's over the viewer and moving, gone once it's been still for
  // IDLE_MS or has left entirely.
  const [chromeAwake, setChromeAwake] = useState(false)
  const idleTimerRef = useRef(null)
  const wakeChrome = () => {
    setChromeAwake(true)
    clearTimeout(idleTimerRef.current)
    idleTimerRef.current = setTimeout(() => setChromeAwake(false), CHROME_IDLE_MS)
  }
  const sleepChrome = () => {
    clearTimeout(idleTimerRef.current)
    setChromeAwake(false)
  }
  useEffect(() => () => clearTimeout(idleTimerRef.current), [])
  // Scroll-to-zoom on the focused stream: scale + pan offset (px, container
  // coords, translate-then-scale from the top-left). z=1 is the normal fit view.
  // Deliberately ephemeral — reset whenever the focused stream changes.
  const [view, setView] = useState({ z: 1, x: 0, y: 0 })
  // In-progress drag-pan bookkeeping; `moved` suppresses the click-to-unfocus
  // that would otherwise fire when the drag ends.
  const dragRef = useRef(null)
  const suppressClickRef = useRef(false)
  // Computed uniform tile width (px) for the unfocused grid, so every tile is
  // the same size and the whole set fits without scrolling. Null until measured.
  const [gridTileWidth, setGridTileWidth] = useState(null)

  // Track fullscreen state from the browser (covers Esc-to-exit too)
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === viewerRef.current)
    }
    document.addEventListener('fullscreenchange', handleFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange)
  }, [])

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen()
    } else {
      viewerRef.current?.requestFullscreen()
    }
  }

  // Esc leaves theatre mode. Captured so it beats the app-level Esc handlers,
  // but deferred to the browser while OS-fullscreen is active (Esc exits that
  // first, then a second press leaves theatre).
  useEffect(() => {
    if (!theatre) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement) {
        e.preventDefault()
        e.stopPropagation()
        onToggleTheatre?.(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [theatre, onToggleTheatre])

  // Resolve the display label from the live clients list so a stream's
  // name stays correct even if it arrived before the clients list caught
  // up with that client's channel move.
  const resolveLabel = (s) =>
    clients?.find((c) => c.id === s.clientId)?.name || s.fallbackLabel || `Stream ${s.consumerId}`

  // Audience for every live producer, pushed from the voice socket. Subscribed
  // to soup directly in the main window, but the popout runs in a separate JS
  // realm with an empty soup instance, so it supplies the opener's snapshot via
  // the streamViewers prop; only subscribe when no prop is provided.
  const [localStreamViewers, setLocalStreamViewers] = useState(() => new Map())
  useEffect(() => {
    if (streamViewersProp) return
    return subscribeStreamViewers(setLocalStreamViewers)
  }, [streamViewersProp])
  const streamViewers = streamViewersProp ?? localStreamViewers
  const [viewersOpen, setViewersOpen] = useState(false)

  const sortedStreams = [...streams].sort((a, b) => {
    if (a.isSelf && !b.isSelf) return 1
    if (!a.isSelf && b.isSelf) return -1
    return 0
  })

  // No fallback: when nothing is selected, selectedStream is null and we render
  // the spread-out grid view instead of the single-focus view.
  // Focus/watch intent is keyed by the publishing client, not by the transient
  // mediasoup consumer id. Codec fallback re-produces the same logical stream
  // with a new consumer id, and must not stop playback or mute its audio.
  const selectedStream = sortedStreams.find((s) => s.clientId === selectedStreamClientId) || null

  // The sharer isn't watching their own stream, so drop them if the server
  // happens to report them; everyone else resolves to a name.
  const focusedViewers = (streamViewers.get(selectedStream?.producerId) ?? [])
    .filter((id) => id !== selectedStream?.clientId)
    .map((id) => clients?.find((c) => c.id === id)?.name || 'Unknown')
    .sort((a, b) => a.localeCompare(b))

  const watchedStreams = sortedStreams.filter((s) => watchedStreamClientIds.has(s.clientId))
  const soleWatchedClientId =
    watchedStreamClientIds.size === 1 ? watchedStreamClientIds.values().next().value : null
  // Audio follows viewer intent, not the momentary set of live video consumers.
  // A codec replacement closes the old video before its successor arrives while
  // the independent ScreenShareAudio producer remains live.
  const audibleClientId = selectedStreamClientId ?? soleWatchedClientId

  // Reset the zoom whenever focus moves (or clears) so returning to a stream
  // always starts at the normal fit view — zoom is never persisted. The viewer
  // list is per-stream, so it closes here too rather than carrying over.
  useEffect(() => {
    setView({ z: 1, x: 0, y: 0 })
    setViewersOpen(false)
    setShareMenuOpen(false)
  }, [selectedStream?.consumerId])

  // The capture options live in the sidebar's voice channel; take a snapshot
  // whenever the menu opens so the segments show what's actually live.
  useEffect(() => {
    if (shareMenuOpen) setShareOptions(shareControl?.getOptions() ?? null)
  }, [shareMenuOpen])

  // Scroll-to-zoom on the focused stream, anchored at the cursor. Native
  // listener (not React onWheel) because it must preventDefault, and wheel
  // events are passive by default.
  useEffect(() => {
    const el = focusRef.current
    if (!el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setView((v) => {
        const z = clamp(v.z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), 1, ZOOM_MAX)
        if (z === 1) return { z: 1, x: 0, y: 0 }
        // Keep the point under the cursor fixed while the scale changes, then
        // clamp so the frame's edges never pull inside the container.
        const s = z / v.z
        return {
          z,
          x: clamp(cx - (cx - v.x) * s, rect.width * (1 - z), 0),
          y: clamp(cy - (cy - v.y) * s, rect.height * (1 - z), 0)
        }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [selectedStream?.consumerId])

  // Drag to pan while zoomed. A real drag (moved past a click threshold) sets
  // suppressClickRef so the mouseup's click doesn't unfocus the stream.
  const handlePanStart = (e) => {
    if (view.z === 1 || e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false }
  }
  const handlePanMove = (e) => {
    const d = dragRef.current
    const el = focusRef.current
    if (!d || !el) return
    const dx = e.clientX - d.sx
    const dy = e.clientY - d.sy
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true
    if (!d.moved) return
    const rect = el.getBoundingClientRect()
    setView((v) => ({
      z: v.z,
      x: clamp(d.x + dx, rect.width * (1 - v.z), 0),
      y: clamp(d.y + dy, rect.height * (1 - v.z), 0)
    }))
  }
  const handlePanEnd = () => {
    if (dragRef.current?.moved) suppressClickRef.current = true
    dragRef.current = null
  }

  // Drag the minimap to move the viewport in map coordinates: dragging right
  // moves the visible region right, which pans the video content left — the
  // inverse of dragging the video itself. A minimap pixel spans (frame/map)
  // container pixels, so deltas scale by z·W/mapW. Window-level listeners let
  // the drag continue outside the tiny map.
  const handleMapPanStart = (e) => {
    e.stopPropagation() // don't start a video-pan drag underneath
    if (e.button !== 0) return
    const el = focusRef.current
    const map = e.currentTarget.getBoundingClientRect()
    if (!el || !map.width) return
    const rect = el.getBoundingClientRect()
    // Click-to-jump: center the viewport on the clicked map point first, then
    // let the drag (if any) continue from there.
    const fx = (e.clientX - map.left) / map.width
    const fy = (e.clientY - map.top) / map.height
    const jx = clamp(-(fx - 0.5 / view.z) * rect.width * view.z, rect.width * (1 - view.z), 0)
    const jy = clamp(-(fy - 0.5 / view.z) * rect.height * view.z, rect.height * (1 - view.z), 0)
    setView((v) => ({ z: v.z, x: jx, y: jy }))
    const start = { sx: e.clientX, sy: e.clientY, x: jx, y: jy }
    const onMove = (ev) => {
      const dx = ((ev.clientX - start.sx) * rect.width) / map.width
      const dy = ((ev.clientY - start.sy) * rect.height) / map.height
      setView((v) => ({
        z: v.z,
        x: clamp(start.x - dx * v.z, rect.width * (1 - v.z), 0),
        y: clamp(start.y - dy * v.z, rect.height * (1 - v.z), 0)
      }))
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // Only one screen-share audio track should be audible. Visual focus wins; in
  // grid view a sole watched stream is also audible so clicking the play button
  // cannot result in perfectly good video with hard-muted audio.
  // When popped out, onFocusAudio routes this to the opener window's soup
  // instance (which owns the actual audio playback); otherwise apply locally.
  useEffect(() => {
    const applyFocusAudio = onFocusAudio || setFocusedScreenAudio
    applyFocusAudio(audibleClientId, { volume: volume / 100, muted })
  }, [audibleClientId, volume, muted])

  // Ration video bandwidth: the focused stream gets full quality, the rest get
  // a cheaper layer (medium in grid view, tiny in the carousel), and a collapsed
  // carousel pauses them entirely. Grid tiles are always visible regardless of
  // the (focus-only) carousel-collapsed state. When popped out, onSetStreamRoles
  // routes this to the opener window's soup instance; otherwise apply locally.
  // Only streams the user has chosen to watch are visible (consumed); everything
  // else stays paused. The carousel-collapsed state additionally hides the
  // non-focused streams in focus view.
  const allVisible = !selectedStream || !carouselCollapsed
  const visibleIds = allVisible ? watchedStreams.map((s) => s.consumerId) : []
  const visibleStreamKey = visibleIds.join(',')
  useEffect(() => {
    const applyRoles = onSetStreamRoles || setVideoStreamRoles
    applyRoles({
      focusedConsumerId: selectedStream?.consumerId ?? null,
      visibleConsumerIds: visibleIds
    })
  }, [selectedStream?.consumerId, visibleStreamKey])

  // When the grid goes away entirely (switch to chat view, or the popout
  // closes) nobody is watching any stream, so pause every video consumer. The
  // role effect above re-applies focus/thumbnail layers when the grid remounts.
  // Separate from that effect so it only fires on unmount, not on every change.
  useEffect(() => {
    const applyRoles = onSetStreamRoles || setVideoStreamRoles
    return () => applyRoles({ focusedConsumerId: null, visibleConsumerIds: [] })
  }, [])

  // Recompute the uniform grid tile size whenever the grid is shown, its tile
  // count changes, or the area resizes (window/sidebar/fullscreen). A
  // ResizeObserver on the grid container keeps it in sync without polling.
  // `theatre` is a dep because entering/leaving it portals the grid to a new
  // parent, which remounts the node — the observer must follow to the new one.
  const gridShown = !selectedStream
  const gridTileCount = sortedStreams.length
  useEffect(() => {
    const el = gridRef.current
    if (!gridShown || !el) return
    const recompute = () =>
      setGridTileWidth(bestUniformTileWidth(el.clientWidth, el.clientHeight, gridTileCount))
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [gridShown, gridTileCount, theatre])

  if (!streams.length)
    return (
      <div className="video-grid empty">
        <div className="empty-message">
          <IconVideoMinus size={100} />
          No Active Streams
        </div>
      </div>
    )

  const toggleMute = () => onMutedChange(!muted)

  const handleVolumeChange = (e) => {
    const next = Number(e.target.value)
    onVolumeChange(next)
    if (next > 0 && muted) onMutedChange(false)
    if (next === 0 && !muted) onMutedChange(true)
  }

  const resetVolume = () => {
    onVolumeChange(100)
    if (muted) onMutedChange(false)
  }

  const volumeWheelRef = useWheelSlider(handleVolumeChange)

  const VolumeIcon =
    muted || volume === 0
      ? IconVolumeOff
      : volume < 10
        ? IconVolume4
        : volume <= 50
          ? IconVolume2
          : IconVolume

  const isStopped = (s) => !watchedStreamClientIds.has(s.clientId)

  // The top-right watch/close button: stop consuming a stream, or resume it.
  const toggleStopped = (s, e) => {
    e.stopPropagation()
    const watch = isStopped(s) // currently stopped → play it; currently playing → stop it
    onSetStreamWatched?.(s.clientId, watch)
    // Can't watch a stream big once it's stopped — drop focus if it was focused.
    if (!watch && selectedStream?.clientId === s.clientId) onSelect?.(null)
  }

  // The focused stream's stop action: end our own share, or stop watching
  // someone else's. Either way we drop focus and fall back to the grid.
  const stopFocused = () => {
    if (selectedStream.isSelf) onStopSharing?.()
    else onSetStreamWatched?.(selectedStream.clientId, false)
    onSelect?.(null)
  }

  // Retune the live share. Nothing can be changed in place, so this restarts the
  // stream; the segments update optimistically, then resync to whatever the
  // restart actually settled on ('on' is a placeholder until it reports back).
  const applyShareOptions = async (patch) => {
    const { audio, ...rest } = patch
    setShareOptions((prev) => ({
      ...prev,
      ...rest,
      ...(audio == null ? {} : { audioMode: audio ? 'on' : 'none' })
    }))
    await shareControl?.restart(patch)
    // Only resync if the restart left us sharing — mid-restart the sidebar's
    // handle is briefly gone, and blanking the menu then would look broken.
    const settled = shareControl?.getOptions()
    if (settled) setShareOptions(settled)
  }

  // Clicking a tile body focuses it (resuming it first if it was closed).
  const focusStream = (s) => {
    if (isStopped(s)) onSetStreamWatched?.(s.clientId, true)
    onSelect?.(s.clientId)
  }

  // A carousel thumbnail or grid tile. Shows live video (or a "stopped"
  // placeholder), the watch/close toggle, and the label.
  const renderTile = (s, variant) => {
    // Watching is intent; the stream arrives a moment later once the consumer is
    // created. Keep showing the placeholder until it does, rather than a blank
    // <video>.
    const stopped = isStopped(s) || !s.stream
    const selected = variant === 'thumbnail' && selectedStream?.producerId === s.producerId
    const tileClass = variant === 'thumbnail' ? 'video-thumbnail' : 'video-grid-tile'
    const labelClass = variant === 'thumbnail' ? 'thumb-label' : 'tile-label'
    const client = clients?.find((c) => c.id === s.clientId)
    return (
      <div
        key={s.producerId ?? s.consumerId}
        className={`${tileClass}${selected ? ' selected' : ''}${stopped ? ' stopped' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => focusStream(s)}
      >
        {/* Not watching, or watching but the consumer hasn't produced a track
            yet — either way hold the sharer's avatar rather than a blank
            <video>. */}
        {stopped ? (
          <StreamPlaceholder
            avatar={client?.avatar}
            initial={client?.name?.charAt(0).toUpperCase() ?? '?'}
          />
        ) : (
          <video
            autoPlay
            playsInline
            muted
            ref={(el) => {
              if (el && el.srcObject !== s.stream) el.srcObject = s.stream
            }}
          />
        )}
        {/* Top-right: start watching, or close the stream once we are. */}
        {isStopped(s) ? (
          <button
            type="button"
            className="stream-watch-cta"
            title="Play stream"
            onClick={(e) => {
              e.stopPropagation()
              onSetStreamWatched?.(s.clientId, true)
            }}
          >
            <IconPlayerPlayFilled size={variant === 'thumbnail' ? 13 : 15} />
            {variant !== 'thumbnail' && <span>Play</span>}
          </button>
        ) : (
          <button
            type="button"
            className="stream-toggle-btn stop"
            title="Close stream"
            onClick={(e) => toggleStopped(s, e)}
          >
            <IconPlayerStopFilled size={variant === 'thumbnail' ? 13 : 15} />
            {variant !== 'thumbnail' && <span>Stop</span>}
          </button>
        )}
        <div className={labelClass}>{resolveLabel(s)}</div>
      </div>
    )
  }

  // The theatre-mode toggle, shown in both the focus and grid control clusters.
  // Only rendered when a toggle is supplied (the main window; never the popout,
  // which is already its own window).
  const theatreBtn = onToggleTheatre ? (
    <button
      type="button"
      className={`vid-btn${theatre ? ' active' : ''}`}
      onClick={() => onToggleTheatre()}
      title={theatre ? 'Exit theatre mode' : 'Theatre mode'}
    >
      <IconMovie size={18} />
    </button>
  ) : null

  // Which channel members are live-sharing, so the theatre rail can badge them.
  const streamingClientIds = new Set(streams.map((s) => s.clientId))

  // A voice-channel participant chip for the theatre-mode left rail: avatar with
  // a speaking ring, a mute/deafen badge, a streaming marker, and the name.
  const renderParticipant = (c) => {
    const isSelfC = c.id === selfId
    const speaking = !!speakingClients[c.id]
    // Our own live toggles beat the roster echo; others come from their voice
    // state (a server gag reads as muted, matching the sidebar indicator).
    const cDeaf = isSelfC ? deafened : !!c.self_deaf
    const cMic = isSelfC ? micMuted : !!c.self_mute || !!c.server_mute
    const initial = c.name?.charAt(0).toUpperCase() ?? '?'
    return (
      <div
        key={c.id}
        className={`theatre-participant${speaking ? ' speaking' : ''}`}
        title={c.name}
      >
        <span className="theatre-avatar">
          {c.avatar ? (
            <img className="theatre-avatar-img" src={c.avatar} alt="" aria-hidden="true" />
          ) : (
            initial
          )}
          {cDeaf ? (
            <span className="theatre-avatar-badge muted" aria-label="Deafened">
              <IconHeadphonesOff size={11} />
            </span>
          ) : cMic ? (
            <span className="theatre-avatar-badge muted" aria-label="Muted">
              <IconMicrophoneOff size={11} />
            </span>
          ) : null}
        </span>
        <span className="theatre-participant-name">{c.name}</span>
        {streamingClientIds.has(c.id) && (
          <IconVideoFilled size={14} className="theatre-streaming-icon" aria-label="Streaming" />
        )}
      </div>
    )
  }

  // The theatre-only overlays: the participant rail (left) and the mic/deafen
  // voice controls (bottom-left). Layered over whichever video view is active.
  const theatreOverlays = theatre ? (
    <>
      {voiceClients.length > 0 && (
        <div
          className="theatre-rail"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {voiceClients.map(renderParticipant)}
        </div>
      )}
      <div
        className="theatre-voice-controls"
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          className={`vid-btn${micMuted ? ' danger' : ''}`}
          onClick={() => onToggleMic?.()}
          title={micMuted ? 'Unmute microphone' : 'Mute microphone'}
        >
          {micMuted ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />}
        </button>
        <button
          type="button"
          className={`vid-btn${deafened ? ' danger' : ''}`}
          onClick={() => onToggleDeafen?.()}
          title={deafened ? 'Undeafen' : 'Deafen'}
        >
          {deafened ? <IconHeadphonesOff size={18} /> : <IconHeadphones size={18} />}
        </button>
      </div>
    </>
  ) : null

  // An open popover pins the chrome — otherwise reading the settings or viewer
  // list without moving the mouse would fade the thing you're reading.
  const chromeShown = chromeAwake || shareMenuOpen || viewersOpen
  // Our own tile is present exactly while we're sharing.
  const sharingSelf = streams.some((s) => s.isSelf)

  // Capture settings for our own live share, opened by the split button's arrow.
  // Shared by the focus and grid docks — whichever one is showing hosts it.
  const shareSettingsMenu =
    shareMenuOpen && shareOptions ? (
      <div className="stream-settings-menu">
        {!shareOptions.isCamera && (
          <>
            <div className="stream-settings-row">
              <span>FPS</span>
              <div className="picker-segment">
                {[30, 60].map((val) => (
                  <button
                    key={val}
                    type="button"
                    className={`picker-segment-btn${shareOptions.fps === val ? ' active' : ''}`}
                    onClick={() => applyShareOptions({ fps: val })}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>
            <div className="stream-settings-row">
              <span>Resolution</span>
              <div className="picker-segment">
                {RESOLUTIONS.map(({ label, width, height }) => (
                  <button
                    key={label}
                    type="button"
                    className={`picker-segment-btn${shareOptions.height === height ? ' active' : ''}`}
                    onClick={() => applyShareOptions({ width, height })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="stream-settings-row">
              <span>Audio</span>
              <div className="picker-segment">
                {[
                  { on: true, label: 'On' },
                  { on: false, label: 'Off' }
                ].map(({ on, label }) => (
                  <button
                    key={label}
                    type="button"
                    className={`picker-segment-btn${(shareOptions.audioMode !== 'none' && shareOptions.audioMode != null) === on ? ' active' : ''}`}
                    onClick={() => applyShareOptions({ audio: on })}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
        <button
          type="button"
          className="stream-settings-action"
          onClick={() => {
            setShareMenuOpen(false)
            shareControl.pickSource()
          }}
        >
          <IconDeviceDesktop size={16} />
          Change Source
        </button>
        <div className="stream-settings-note">Changes restart your stream.</div>
      </div>
    ) : null

  // The settings arrow that hangs off a stop/share button.
  const shareSettingsBtn = (
    <button
      type="button"
      className="vid-btn success vid-split-more"
      title="Stream settings"
      aria-expanded={shareMenuOpen}
      onClick={() => setShareMenuOpen((v) => !v)}
    >
      <IconChevronUp size={14} />
    </button>
  )

  // The control bar, anchored to the viewer rather than the video frame, so it
  // stays put whatever the stream's aspect ratio is (and shows in grid view too).
  // Everything in it fades together with the rest of the chrome.
  const viewerControls = (
    <div
      className="viewer-controls"
      // Resting the pointer on the bar itself keeps it up; leaving restarts the
      // idle countdown.
      onMouseEnter={() => {
        clearTimeout(idleTimerRef.current)
        setChromeAwake(true)
      }}
      onMouseLeave={wakeChrome}
    >
      {selectedStream && (
        <button
          type="button"
          className="carousel-toggle"
          onClick={() => setCarouselCollapsed((prev) => !prev)}
          title={carouselCollapsed ? 'Show stream list' : 'Hide stream list'}
        >
          {carouselCollapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </button>
      )}
      {/* Centre dock, styled like the sidebar's control panel. Mic is hidden in
          theatre mode, which has its own voice controls bottom-left. */}
      <div className="focus-stream-controls">
        {!theatre && onToggleMic && (
          <button
            type="button"
            className={`vid-btn${micMuted ? ' danger' : ''}`}
            onClick={() => onToggleMic()}
            title={micMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {micMuted ? <IconMicrophoneOff size={18} /> : <IconMicrophone size={18} />}
          </button>
        )}
        {/* Grid view has no focused stream to act on, so the dock carries our own
            share toggle instead — start (opening the source picker) or stop. */}
        {!selectedStream && shareControl && (
          <div className="vid-split">
            <button
              type="button"
              className={`vid-btn${sharingSelf ? ' success' : ''}`}
              title={sharingSelf ? 'Stop streaming' : 'Start a stream'}
              onClick={() => (sharingSelf ? onStopSharing?.() : shareControl.pickSource())}
            >
              {sharingSelf ? <IconScreenShareOff size={18} /> : <IconScreenShare size={18} />}
            </button>
            {/* Nothing to retune until a share is live. */}
            {sharingSelf && shareSettingsBtn}
            {sharingSelf && shareSettingsMenu}
          </div>
        )}
        {/* Mirrors the sidebar dock toggles: green (sharing) for our own stream,
            red (muted-style) for someone else's. On our own stream it's a split
            button — the arrow opens the capture settings. */}
        {selectedStream && (!selectedStream.isSelf || onStopSharing) && (
          <div className="vid-split">
            <button
              type="button"
              className={`vid-btn ${selectedStream.isSelf ? 'success' : 'danger'}`}
              title={selectedStream.isSelf ? 'Stop streaming' : 'Stop watching'}
              onClick={stopFocused}
            >
              {selectedStream.isSelf ? <IconScreenShareOff size={18} /> : <IconEyeOff size={18} />}
            </button>
            {selectedStream.isSelf && shareControl && shareSettingsBtn}
            {selectedStream.isSelf && shareSettingsMenu}
          </div>
        )}
      </div>
      <div className="video-controls">
        <div className="volume-control">
          <div className="volume-slider-wrap">
            <span className="volume-center-tick" aria-hidden="true" />
            <input
              ref={volumeWheelRef}
              type="range"
              className="volume-slider"
              min={0}
              max={200}
              value={muted ? 0 : volume}
              onChange={handleVolumeChange}
              onDoubleClick={resetVolume}
              title="Volume — 100% is normal, drag right to boost (double-click to reset)"
            />
          </div>
          <span className="volume-value">{muted ? 0 : volume}%</span>
          <button
            type="button"
            className="vid-btn"
            onClick={toggleMute}
            title={muted ? 'Unmute' : 'Mute'}
          >
            <VolumeIcon size={18} />
          </button>
        </div>
        {onPopout && (
          <button type="button" className="vid-btn" onClick={onPopout} title="Pop out to window">
            <IconExternalLink size={18} />
          </button>
        )}
        {theatreBtn}
        <button
          type="button"
          className="vid-btn"
          onClick={toggleFullscreen}
          title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {isFullscreen ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
        </button>
      </div>
    </div>
  )

  const viewer = (
    <div
      className={`video-viewer${isFullscreen ? ' fullscreen' : ''}${theatre ? ' theatre' : ''}${
        chromeShown ? ' chrome-shown' : ''
      }`}
      ref={viewerRef}
      onMouseMove={wakeChrome}
      onMouseLeave={sleepChrome}
    >
      {selectedStream ? (
        <>
          {/* Clicking the focused video (anywhere but the controls) unfocuses it.
              Scrolling zooms toward the cursor; dragging pans while zoomed (and
              suppresses the unfocus click). */}
          <div
            className={`video-focus focusable${view.z > 1 ? ' zoomed' : ''}`}
            ref={focusRef}
            onClick={() => {
              if (suppressClickRef.current) {
                suppressClickRef.current = false
                return
              }
              // An open settings popover swallows the first outside click, so
              // dismissing it doesn't also drop you back to the grid.
              if (shareMenuOpen) {
                setShareMenuOpen(false)
                return
              }
              onSelect?.(null)
            }}
            onMouseDown={handlePanStart}
            onMouseMove={handlePanMove}
            onMouseUp={handlePanEnd}
            onMouseLeave={handlePanEnd}
          >
            <video
              autoPlay
              playsInline
              muted
              style={
                view.z > 1
                  ? {
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                      transformOrigin: '0 0'
                    }
                  : undefined
              }
              ref={(el) => {
                if (el && el.srcObject !== (selectedStream.stream ?? null))
                  el.srcObject = selectedStream.stream ?? null
              }}
            />
            {/* Zoom minimap: the full frame with the visible region outlined.
                Shown only while zoomed and hovering (same hover gate as the
                other controls, via CSS). */}
            {view.z > 1 && (
              <div
                className="zoom-minimap"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={handleMapPanStart}
              >
                <video
                  autoPlay
                  playsInline
                  muted
                  ref={(el) => {
                    if (el && el.srcObject !== selectedStream.stream)
                      el.srcObject = selectedStream.stream
                  }}
                />
                <div
                  className="zoom-minimap-rect"
                  style={{
                    left: `${(-view.x / ((focusRef.current?.clientWidth || 1) * view.z)) * 100}%`,
                    top: `${(-view.y / ((focusRef.current?.clientHeight || 1) * view.z)) * 100}%`,
                    width: `${100 / view.z}%`,
                    height: `${100 / view.z}%`
                  }}
                />
              </div>
            )}
            {showCodecBadge && selectedStream.codec && (
              <div className="focus-codec-badge" title="Video codec / encoder">
                {selectedStream.codec}
                {selectedStream.hardware != null && (
                  <span className={selectedStream.hardware ? 'enc-hw' : 'enc-sw'}>
                    {selectedStream.hardware ? 'HW' : 'SW'}
                  </span>
                )}
              </div>
            )}
            {/* Viewer count, top-right corner. Same hover gate as
                .video-controls. */}
            <div className="focus-viewers" onClick={(e) => e.stopPropagation()}>
              <button
                type="button"
                className="vid-btn focus-viewers-btn"
                onClick={() => setViewersOpen((v) => !v)}
                title={
                  focusedViewers.length === 0
                    ? 'Nobody is watching this stream'
                    : `${focusedViewers.length} watching`
                }
                aria-expanded={viewersOpen}
              >
                <IconEye size={18} />
                <span className="focus-viewers-count">{focusedViewers.length}</span>
              </button>
              {viewersOpen && (
                <div className="focus-viewers-list">
                  {focusedViewers.length === 0 ? (
                    <div className="focus-viewers-empty">Nobody is watching</div>
                  ) : (
                    focusedViewers.map((name) => (
                      <div key={name} className="focus-viewers-row">
                        {name}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <div className="focus-label">
              <span>{resolveLabel(selectedStream)}</span>
            </div>
            {theatreOverlays}
          </div>

          {!carouselCollapsed && (
            <div className="video-carousel">
              {sortedStreams
                .filter((s) => s.clientId !== selectedStream.clientId)
                .map((s) => renderTile(s, 'thumbnail'))}
            </div>
          )}
        </>
      ) : (
        /* No stream focused: spread every stream across the whole grid area.
           Click a tile to focus it. */
        <div
          className="video-grid-layout"
          ref={gridRef}
          style={gridTileWidth ? { '--grid-tile-width': `${gridTileWidth}px` } : undefined}
        >
          {sortedStreams.map((s) => renderTile(s, 'grid'))}
          {theatreOverlays}
        </div>
      )}
      {viewerControls}
    </div>
  )

  // In theatre mode the viewer escapes the chat canvas to cover the window, so
  // portal it to the body — clear of the layout's clipping/transformed ancestors.
  return theatre ? createPortal(viewer, document.body) : viewer
}

export default VideoGrid
