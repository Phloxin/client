import { useState, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
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
  IconVolume4,
  IconVolumeOff,
  IconExternalLink,
  IconPlayerPauseFilled,
  IconPlayerPlayFilled,
  IconPlayerStopFilled,
  IconScreenShare,
  IconEye,
  IconMovie,
  IconMicrophone,
  IconMicrophoneOff,
  IconHeadphones,
  IconHeadphonesOff
} from '@tabler/icons-react'
import { setVideoStreamRoles, subscribeStreamViewers } from '../lib/soup'
import { useImageColors } from '../lib/imageColors'
import { useWheelSlider } from '../lib/useWheelSlider'
import { shouldPauseSelfPreview, syncSelfPreviewPlayback } from '../lib/selfPreviewPlayback'
import { resolveStreamFocus } from '../lib/streamView'
import { spring } from '../lib/motionPresets'
import { useAnimationCategory, useSettings } from '../context/SettingsContext'
import StreamContextMenu from './StreamContextMenu'

// Stable empty default so the role effect doesn't churn when no watched set is
// passed (e.g. the popout's first render before the bridge data arrives).
const EMPTY_WATCHED = new Set()
// Same idea for the theatre-mode props the popout window never supplies.
const EMPTY_LIST = []
const EMPTY_SPEAKING = {}
// ...and for the per-stream audio map before the bridge data arrives.
const EMPTY_AUDIO = {}
// A stream with no audio override plays at 100%, unmuted.
const DEFAULT_STREAM_AUDIO = { volume: 1, muted: false }

// Gap (px) between grid tiles — must match the `gap` in .video-stage.grid.
const GRID_GAP = 12
const TILE_AR = 16 / 9

// How long the pointer can sit still before the overlay chrome fades out.
const CHROME_IDLE_MS = 4000

// Scroll-to-zoom bounds/step for the focused stream.
const ZOOM_MAX = 8
const ZOOM_STEP = 1.25
const NO_ZOOM = { z: 1, x: 0, y: 0 }

// Focus/unfocus tween for the tiles (and their media wrappers): the shared snappy
// spring, which settles in roughly 180ms.
const TILE_TRANSITION = { layout: spring }

const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

// Volume glyph for a 0..200 percentage (already 0 while muted).
function volumeGlyph(percent, size) {
  if (percent === 0) return <IconVolumeOff size={size} />
  if (percent < 10) return <IconVolume4 size={size} />
  if (percent <= 50) return <IconVolume2 size={size} />
  return <IconVolume size={size} />
}

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
          ? {
              background: `color-mix(in srgb, ${colors.vibrant} 45%, var(--color-background-mute))`
            }
          : undefined
      }
    >
      <span className="stream-placeholder-avatar">
        {avatar ? <img src={avatar} alt="" /> : initial}
      </span>
    </div>
  )
}

// A small round avatar beside a name (tile labels, the viewer list): the
// image when there is one, otherwise the name's initial on the theme tint, as
// StreamPlaceholder falls back. Decorative — the name is always next to it.
// eslint-disable-next-line react/prop-types -- The renderer does not use runtime PropTypes.
function StreamAvatar({ avatar, name, small = false }) {
  return (
    <span className={`stream-avatar${small ? ' small' : ''}`} aria-hidden="true">
      {avatar ? (
        <img src={avatar} alt="" />
      ) : (
        String(name || '?')
          .charAt(0)
          .toUpperCase()
      )}
    </span>
  )
}

function readSelfPreviewPaused() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false
  const documentVisible =
    document.visibilityState == null
      ? document.hidden !== true
      : document.visibilityState === 'visible'
  const windowFocused = typeof document.hasFocus === 'function' ? document.hasFocus() : true
  return shouldPauseSelfPreview({ windowFocused, documentVisible })
}

function useSelfPreviewPaused() {
  const [selfPreviewPaused, setSelfPreviewPaused] = useState(readSelfPreviewPaused)

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined') return undefined
    const update = () => setSelfPreviewPaused(readSelfPreviewPaused())
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    update()
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])

  return selfPreviewPaused
}

// eslint-disable-next-line react/prop-types -- The renderer does not use runtime PropTypes.
function StreamVideo({ stream, isSelf = false, selfPreviewPaused = false, style }) {
  const videoRef = useRef(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    if (video.srcObject !== stream) video.srcObject = stream ?? null
    if (isSelf && stream) syncSelfPreviewPlayback(video, selfPreviewPaused)
  }, [stream, isSelf, selfPreviewPaused])

  return (
    <video
      autoPlay={!isSelf || !selfPreviewPaused}
      playsInline
      muted
      style={style}
      ref={videoRef}
    />
  )
}

// eslint-disable-next-line react/prop-types -- The renderer does not use runtime PropTypes.
function SelfPreviewPausedOverlay({ compact = false }) {
  return (
    <div className={`self-preview-paused${compact ? ' compact' : ''}`} aria-hidden="true">
      <IconPlayerPauseFilled size={compact ? 16 : 22} />
      <div>
        <strong>Preview paused</strong>
        {!compact && <span>Your stream is still live</span>}
      </div>
    </div>
  )
}

// The sharer paused the stream itself (as opposed to our local preview pausing
// above). Viewers get no frames meanwhile, so this stands in for the last one.
// eslint-disable-next-line react/prop-types -- The renderer does not use runtime PropTypes.
function StreamPausedOverlay({ compact = false, isSelf = false }) {
  return (
    <div className={`self-preview-paused${compact ? ' compact' : ''}`} aria-hidden="true">
      <IconPlayerPauseFilled size={compact ? 16 : 22} />
      <div>
        <strong>Stream paused</strong>
        {!compact && (
          <span>{isSelf ? 'Viewers see your stream as paused' : 'The sharer paused it'}</span>
        )}
      </div>
    </div>
  )
}

// The stream view. Every stream is one always-mounted tile (keyed by the
// publishing client) inside a single stage, so moving a stream into or out of
// focus restyles and re-places its tile rather than remounting it — no <video>
// ever restarts, and Motion tweens the tile between its old and new boxes. The
// stage is either a grid (no focus: uniform tiles spread over the area) or a
// focus layout (the focused tile fills the top, the rest wrap underneath as
// thumbnails). A sole stream is always focused and can't be unfocused; see
// resolveStreamFocus. Per-stream actions live in the right-click menu
// (StreamContextMenu); the bottom bar keeps the focused stream's volume and the
// view controls.
function VideoGrid({
  streams,
  clients,
  selectedStreamClientId,
  onSelect,
  onPopout,
  onSetStreamRoles,
  watchedStreamClientIds = EMPTY_WATCHED,
  onSetStreamWatched,
  // Ends our own screen share (owned by the sidebar's VoiceChannel). Absent in
  // windows that can't reach it, which hides the stop action on our own stream.
  onStopSharing,
  // Drives our own stream's menu entries: read the live options, restart with
  // new ones, pause, or reopen the source picker.
  shareControl,
  streamViewers: streamViewersProp,
  // Per-stream screen-share audio, { [clientId]: { volume (gain, 1 = 100%),
  // muted } }; a client without an entry is at 100%. Every watched stream is
  // audible at once, each at its own level. onSetStreamAudio(clientId, patch)
  // changes one (routed to the opener's soup when popped out).
  streamAudio = EMPTY_AUDIO,
  onSetStreamAudio,
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
  // Focus/unfocus tweens the tiles between layouts (Motion layout animation),
  // gated by the Stream Focus animation setting and reduced motion.
  const animateFocus = useAnimationCategory('streamFocus')
  const selfPreviewPaused = useSelfPreviewPaused()
  const viewerRef = useRef(null)
  const stageRef = useRef(null)
  // Each tile's element, by client id; zoom/pan measure against the focused
  // one. Looked up rather than held in a ref that moves between tiles, because
  // Motion only forwards a ref on mount/unmount, so moving one onto an
  // already-mounted tile when focus changes would never take.
  const tileElsRef = useRef(new Map())
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [carouselCollapsed, setCarouselCollapsed] = useState(false)
  // The right-click menu: { clientId, pos: { x, y } } while open.
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const menuOpen = menu != null
  // Set on a tile's primary-button mousedown while the menu is open. That click
  // is the one dismissing the menu (it closes on outside mousedown), so the tile
  // must not also act on it.
  const swallowClickRef = useRef(false)
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
  const [view, setView] = useState(NO_ZOOM)
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
  // first, then a second press leaves theatre). An open stream menu is the top
  // layer, so it's left to close itself first; the next press leaves theatre.
  // (Unfocusing a stream on Esc is Main's cascade / the popout's job, below
  // every other layer.)
  useEffect(() => {
    if (!theatre) return
    const onKey = (e) => {
      if (e.key === 'Escape' && !document.fullscreenElement && !menuOpen) {
        e.preventDefault()
        e.stopPropagation()
        onToggleTheatre?.(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [theatre, onToggleTheatre, menuOpen])

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

  // Focus/watch intent is keyed by the publishing client, not by the transient
  // mediasoup consumer id. Codec fallback re-produces the same logical stream
  // with a new consumer id, and must not stop playback, drop focus, or remount
  // its tile. A sole stream is always the focused one; with more, nothing
  // selected means the grid.
  const { focusedClientId, canToggleFocus } = resolveStreamFocus({
    streams: sortedStreams,
    selectedStreamClientId
  })
  const focusedStream =
    focusedClientId == null ? null : sortedStreams.find((s) => s.clientId === focusedClientId)

  // The sharer isn't watching their own stream, so drop them if the server
  // happens to report them; everyone else resolves to a name and avatar (an
  // id we don't know yet reads as 'Unknown' with the initial fallback).
  const focusedViewers = (streamViewers.get(focusedStream?.producerId) ?? [])
    .filter((id) => id !== focusedStream?.clientId)
    .map((id) => {
      const viewer = clients?.find((c) => c.id === id)
      return { id, name: viewer?.name || 'Unknown', avatar: viewer?.avatar }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  const watchedStreams = sortedStreams.filter((s) => watchedStreamClientIds.has(s.clientId))
  const isStopped = (s) => !watchedStreamClientIds.has(s.clientId)

  // Zoom needs a picture: a sole stream we aren't watching is still the focused
  // view, but shows its placeholder, so there's nothing to zoom into.
  const zoomable = !!focusedStream && !isStopped(focusedStream) && !!focusedStream.stream
  const zoom = zoomable ? view : NO_ZOOM

  // The menu's stream went away (its sharer stopped, or every stream did): drop
  // the menu rather than leave it pointing at nothing. Adjusted during render
  // so a menu for a missing tile never paints.
  const menuStream = menu ? (sortedStreams.find((s) => s.clientId === menu.clientId) ?? null) : null
  if (menu && !menuStream) setMenu(null)

  // Reset the zoom whenever focus moves (or clears) so returning to a stream
  // always starts at the normal fit view — zoom is never persisted. The viewer
  // list is per-stream, so it closes here too rather than carrying over, and so
  // does the right-click menu.
  useEffect(() => {
    setView(NO_ZOOM)
    setViewersOpen(false)
    setMenu(null)
  }, [focusedClientId])

  // Scroll-to-zoom on the focused stream, anchored at the cursor. Native
  // listener (not React onWheel) because it must preventDefault, and wheel
  // events are passive by default. `theatre` is a dep because entering/leaving
  // it portals the viewer, which remounts the focused tile's element.
  useEffect(() => {
    const el = tileElsRef.current.get(focusedClientId)
    if (!zoomable || !el) return
    const onWheel = (e) => {
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cx = e.clientX - rect.left
      const cy = e.clientY - rect.top
      setView((v) => {
        const z = clamp(v.z * (e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP), 1, ZOOM_MAX)
        if (z === 1) return NO_ZOOM
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
  }, [focusedClientId, zoomable, theatre])

  // Drag to pan while zoomed. A real drag (moved past a click threshold) sets
  // suppressClickRef so the mouseup's click doesn't unfocus the stream.
  const handlePanStart = (e) => {
    if (zoom.z === 1 || e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, x: zoom.x, y: zoom.y, moved: false }
  }
  const handlePanMove = (e) => {
    const d = dragRef.current
    const el = tileElsRef.current.get(focusedClientId)
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
    const el = tileElsRef.current.get(focusedClientId)
    const map = e.currentTarget.getBoundingClientRect()
    if (!el || !map.width) return
    const rect = el.getBoundingClientRect()
    // Click-to-jump: center the viewport on the clicked map point first, then
    // let the drag (if any) continue from there.
    const fx = (e.clientX - map.left) / map.width
    const fy = (e.clientY - map.top) / map.height
    const jx = clamp(-(fx - 0.5 / zoom.z) * rect.width * zoom.z, rect.width * (1 - zoom.z), 0)
    const jy = clamp(-(fy - 0.5 / zoom.z) * rect.height * zoom.z, rect.height * (1 - zoom.z), 0)
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

  // Ration video bandwidth: the focused stream (a sole stream included) gets
  // full quality, the rest get a cheaper layer (medium in grid view, tiny as
  // thumbnails), and a collapsed thumbnail strip pauses them entirely. When
  // popped out, onSetStreamRoles routes this to the opener window's soup
  // instance; otherwise apply locally. Only streams the user has chosen to
  // watch are visible (consumed); everything else stays paused.
  const allVisible = !focusedStream || !carouselCollapsed
  const visibleIds = allVisible ? watchedStreams.map((s) => s.consumerId) : []
  const visibleStreamKey = visibleIds.join(',')
  useEffect(() => {
    const applyRoles = onSetStreamRoles || setVideoStreamRoles
    applyRoles({
      focusedConsumerId: focusedStream?.consumerId ?? null,
      visibleConsumerIds: visibleIds
    })
  }, [focusedStream?.consumerId, visibleStreamKey])

  // When the grid goes away entirely (switch to chat view, or the popout
  // closes) nobody is watching any stream, so pause every video consumer. The
  // role effect above re-applies focus/thumbnail layers when the grid remounts.
  // Separate from that effect so it only fires on unmount, not on every change.
  useEffect(() => {
    const applyRoles = onSetStreamRoles || setVideoStreamRoles
    return () => applyRoles({ focusedConsumerId: null, visibleConsumerIds: [] })
  }, [])

  // Recompute the uniform grid tile size whenever the stage switches to grid
  // mode, its tile count changes, or the area resizes (window/sidebar/
  // fullscreen). A ResizeObserver on the stage keeps it in sync without polling.
  // `theatre` is a dep because entering/leaving it portals the stage to a new
  // parent, which remounts the node — the observer must follow to the new one.
  const gridShown = !focusedStream
  const gridTileCount = sortedStreams.length
  useEffect(() => {
    const el = stageRef.current
    if (!gridShown || !el) return
    const recompute = () =>
      setGridTileWidth(bestUniformTileWidth(el.clientWidth, el.clientHeight, gridTileCount))
    recompute()
    const ro = new ResizeObserver(recompute)
    ro.observe(el)
    return () => ro.disconnect()
  }, [gridShown, gridTileCount, theatre])

  // Per-stream audio, shared by the bottom bar (focused stream) and the menu.
  // The sliders run 0..200 (%), showing 0 while muted; dragging to 0 mutes and
  // dragging up from it unmutes.
  const audioOf = (clientId) => streamAudio[clientId] ?? DEFAULT_STREAM_AUDIO
  const audioPercent = (a) => (a.muted ? 0 : Math.round(a.volume * 100))
  const setStreamVolume = (clientId, e) => {
    const v = Number(e.target.value)
    onSetStreamAudio?.(clientId, { volume: v / 100, muted: v === 0 })
  }
  const toggleStreamMute = (clientId) =>
    onSetStreamAudio?.(clientId, { muted: !audioOf(clientId).muted })
  const resetStreamVolume = (clientId) => onSetStreamAudio?.(clientId, { volume: 1, muted: false })

  // The bar's volume belongs to the focused stream, and only to someone else's
  // (we never hear our own).
  const barAudioClientId = focusedStream && !focusedStream.isSelf ? focusedStream.clientId : null
  const handleBarVolumeChange = (e) => {
    if (barAudioClientId != null) setStreamVolume(barAudioClientId, e)
  }

  // Keep this hook above the empty-state return. A remote stream ending changes
  // `streams` from non-empty to empty, and skipping this hook on that render
  // would change VideoGrid's hook order.
  const volumeWheelRef = useWheelSlider(handleBarVolumeChange)

  if (!streams.length)
    return (
      <div className="video-grid empty">
        <div className="empty-message">
          <IconVideoMinus size={100} />
          No Active Streams
          {shareControl && (
            <button
              type="button"
              className="btn btn-primary empty-share-btn"
              onClick={() => shareControl.pickSource()}
            >
              <IconScreenShare size={18} />
              Start streaming
            </button>
          )}
        </div>
      </div>
    )

  // Clicking a tile body focuses it (resuming it first if it was closed).
  const focusStream = (s) => {
    if (isStopped(s)) onSetStreamWatched?.(s.clientId, true)
    onSelect?.(s.clientId)
  }

  // Start or stop consuming a stream. Can't watch a stream big once it's
  // stopped, so stopping the focused one drops focus — unless it's the only
  // stream, which is always the focused view (it shows its placeholder).
  const setWatched = (s, watch) => {
    onSetStreamWatched?.(s.clientId, watch)
    if (!watch && s.clientId === focusedClientId && canToggleFocus) onSelect?.(null)
  }

  // The top-right watch/close button: stop consuming a stream, or resume it.
  const toggleStopped = (s, e) => {
    e.stopPropagation()
    setWatched(s, isStopped(s)) // currently stopped → play it; currently playing → stop it
  }

  // Focus toggling only exists with two or more streams: a grid tile or
  // thumbnail focuses, the focused tile goes back to the grid. A click that
  // ends a drag-pan, or that dismissed the menu, does neither.
  const handleTileMouseDown = (s, e) => {
    if (e.button === 0) swallowClickRef.current = menuOpen
    if (s.clientId === focusedClientId) handlePanStart(e)
  }
  const handleTileClick = (s) => {
    const dismissedMenu = swallowClickRef.current
    swallowClickRef.current = false
    if (s.clientId === focusedClientId) {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      if (!dismissedMenu && canToggleFocus) onSelect?.(null)
      return
    }
    if (!dismissedMenu && canToggleFocus) focusStream(s)
  }

  const openMenu = (s, e) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ clientId: s.clientId, pos: { x: e.clientX, y: e.clientY } })
  }

  // Speaker-off pill beside the name plate of a stream whose audio we muted.
  const muteBadge = (
    <span className="stream-mute-badge" aria-label="Stream audio muted">
      <IconVolumeOff size={13} />
    </span>
  )

  // One stream's tile, in whichever role the layout gives it: `focused` (fills
  // the top of the focus layout, with zoom/pan, minimap, codec badge and viewer
  // count), `thumb` (the others while something is focused) or `grid` (everyone
  // when nothing is). The element is the same in every role — only its class
  // changes — so the <video> inside survives focus changes. Both the tile and
  // its media wrapper are Motion layout nodes, so the tween moves the wrapper
  // with the tile instead of leaving the media behind.
  const renderTile = (s) => {
    const isFocused = s.clientId === focusedClientId
    const role = isFocused ? 'focused' : focusedStream ? 'thumb' : 'grid'
    const compact = role === 'thumb'
    // Watching is intent; the stream arrives a moment later once the consumer is
    // created. Keep showing the placeholder until it does, rather than a blank
    // <video>.
    const stopped = isStopped(s) || !s.stream
    const client = clients?.find((c) => c.id === s.clientId)
    const label = resolveLabel(s)
    // Our own stream is never played back to us, so it never carries the badge.
    const audioMuted = !s.isSelf && !!streamAudio[s.clientId]?.muted
    const zoomed = isFocused && zoom.z > 1
    // The frame the minimap's outline is measured against.
    const zoomedEl = zoomed ? tileElsRef.current.get(s.clientId) : null
    return (
      <motion.div
        key={s.clientId}
        layout={animateFocus}
        transition={TILE_TRANSITION}
        ref={(el) => {
          if (el) tileElsRef.current.set(s.clientId, el)
          else tileElsRef.current.delete(s.clientId)
        }}
        className={`stream-tile ${role}${stopped ? ' stopped' : ''}${
          canToggleFocus ? ' focusable' : ''
        }${zoomed ? ' zoomed' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => handleTileClick(s)}
        onMouseDown={(e) => handleTileMouseDown(s, e)}
        onMouseMove={isFocused ? handlePanMove : undefined}
        onMouseUp={isFocused ? handlePanEnd : undefined}
        onMouseLeave={isFocused ? handlePanEnd : undefined}
        onContextMenu={(e) => openMenu(s, e)}
      >
        <motion.div layout={animateFocus} transition={TILE_TRANSITION} className="stream-media">
          {/* Not watching, or watching but the consumer hasn't produced a track
              yet — either way hold the sharer's avatar rather than a blank
              <video>. */}
          {stopped ? (
            <StreamPlaceholder
              avatar={client?.avatar}
              initial={client?.name?.charAt(0).toUpperCase() ?? '?'}
            />
          ) : (
            <StreamVideo
              stream={s.stream}
              isSelf={s.isSelf}
              selfPreviewPaused={s.isSelf && selfPreviewPaused}
              style={
                zoomed
                  ? {
                      transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.z})`,
                      transformOrigin: '0 0'
                    }
                  : undefined
              }
            />
          )}
        </motion.div>
        {s.paused ? (
          <StreamPausedOverlay compact={compact} isSelf={s.isSelf} />
        ) : (
          s.isSelf && selfPreviewPaused && <SelfPreviewPausedOverlay compact={compact} />
        )}
        {/* Zoom minimap: the full frame with the visible region outlined.
            Shown only while zoomed and hovering (same hover gate as the
            other controls, via CSS). */}
        {zoomed && (
          <div
            className="zoom-minimap"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={handleMapPanStart}
          >
            <StreamVideo
              stream={s.stream}
              isSelf={s.isSelf}
              selfPreviewPaused={s.isSelf && selfPreviewPaused}
            />
            <div
              className="zoom-minimap-rect"
              style={{
                left: `${(-zoom.x / ((zoomedEl?.clientWidth || 1) * zoom.z)) * 100}%`,
                top: `${(-zoom.y / ((zoomedEl?.clientHeight || 1) * zoom.z)) * 100}%`,
                width: `${100 / zoom.z}%`,
                height: `${100 / zoom.z}%`
              }}
            />
          </div>
        )}
        {isFocused && showCodecBadge && s.codec && (
          <div className="focus-codec-badge" title="Video codec / encoder">
            {s.codec}
            {s.hardware != null && (
              <span className={s.hardware ? 'enc-hw' : 'enc-sw'}>{s.hardware ? 'HW' : 'SW'}</span>
            )}
          </div>
        )}
        {/* Top-right: the focused stream's viewer count (with the chrome), then
            start watching, or close the stream once we are (on hover). */}
        <div className="stream-tile-actions" onClick={(e) => e.stopPropagation()}>
          {isFocused && (
            <div className="focus-viewers">
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
                    focusedViewers.map((viewer) => (
                      <div key={viewer.id} className="focus-viewers-row">
                        <StreamAvatar avatar={viewer.avatar} name={viewer.name} />
                        <span className="stream-label-text">{viewer.name}</span>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          )}
          {/* On our own share, watching only means previewing it locally (the
              stream stays live either way), so it's worded as a preview. */}
          {isStopped(s) ? (
            <button
              type="button"
              className="stream-watch-cta"
              title={s.isSelf ? 'Preview your stream' : 'Play stream'}
              onClick={(e) => {
                e.stopPropagation()
                onSetStreamWatched?.(s.clientId, true)
              }}
            >
              <IconPlayerPlayFilled size={compact ? 13 : 15} />
              {!compact && <span>{s.isSelf ? 'Preview' : 'Play'}</span>}
            </button>
          ) : (
            <button
              type="button"
              className="stream-toggle-btn stop"
              title={s.isSelf ? 'Stop previewing' : 'Close stream'}
              onClick={(e) => toggleStopped(s, e)}
            >
              <IconPlayerStopFilled size={compact ? 13 : 15} />
              {!compact && <span>{s.isSelf ? 'Stop Preview' : 'Stop'}</span>}
            </button>
          )}
        </div>
        {/* Name plate (the owner's avatar, then their name), plus a speaker-off
            badge when we've muted this stream's audio. The focused stream's
            fades with the chrome. */}
        {isFocused ? (
          <div className="focus-label">
            <span className="focus-label-name">
              <StreamAvatar avatar={client?.avatar} name={label} />
              <span className="stream-label-text">{label}</span>
            </span>
            {audioMuted && muteBadge}
          </div>
        ) : (
          <div className="stream-tile-label-row">
            <div className={compact ? 'thumb-label' : 'tile-label'}>
              <StreamAvatar avatar={client?.avatar} name={label} small={compact} />
              <span className="stream-label-text">{label}</span>
            </div>
            {audioMuted && muteBadge}
          </div>
        )}
      </motion.div>
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
  // voice controls (bottom-left). Layered over the stage in either layout.
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

  // An open popover pins the chrome — otherwise reading the menu or viewer list
  // without moving the mouse would fade the thing you're reading.
  const chromeShown = chromeAwake || viewersOpen || menuOpen
  // Thumbnails show (and need the room above the control bar) while a stream is
  // focused, there are others, and the strip isn't collapsed.
  const thumbsShown = !!focusedStream && !carouselCollapsed && sortedStreams.length > 1

  const barAudio = barAudioClientId != null ? audioOf(barAudioClientId) : null
  const barPercent = barAudio ? audioPercent(barAudio) : 0

  // The control bar, anchored to the viewer rather than the video frame, so it
  // stays put whatever the stream's aspect ratio is (and shows in grid view too).
  // Everything in it fades together with the rest of the chrome. Per-stream
  // actions (stop, our own share's controls) live in the right-click menu.
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
      {focusedStream && canToggleFocus && (
        <button
          type="button"
          className="carousel-toggle"
          onClick={() => setCarouselCollapsed((prev) => !prev)}
          title={carouselCollapsed ? 'Show stream list' : 'Hide stream list'}
        >
          {carouselCollapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
        </button>
      )}
      <div className="video-controls">
        {barAudio && (
          <div className="volume-control">
            <div className="volume-slider-wrap">
              <span className="volume-center-tick" aria-hidden="true" />
              <input
                ref={volumeWheelRef}
                type="range"
                className="volume-slider"
                min={0}
                max={200}
                value={barPercent}
                onChange={handleBarVolumeChange}
                onDoubleClick={() => resetStreamVolume(barAudioClientId)}
                title="Volume — 100% is normal, drag right to boost (double-click to reset)"
              />
            </div>
            <span className="volume-value">{barPercent}%</span>
            <button
              type="button"
              className="vid-btn"
              onClick={() => toggleStreamMute(barAudioClientId)}
              title={barAudio.muted ? 'Unmute' : 'Mute'}
            >
              {volumeGlyph(barPercent, 18)}
            </button>
          </div>
        )}
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

  // The right-click menu for the stream it was opened on. Rendered inside the
  // viewer (not portalled to the body) so it shows while the viewer is
  // OS-fullscreen. Keyed per open so its flyout and settings snapshot reset.
  const renderStreamMenu = () => {
    const s = menuStream
    const focused = s.clientId === focusedClientId
    let audio = null
    if (!s.isSelf) {
      const a = audioOf(s.clientId)
      const value = audioPercent(a)
      audio = {
        value,
        muted: a.muted,
        icon: volumeGlyph(value, 16),
        onChange: (e) => setStreamVolume(s.clientId, e),
        onToggleMute: () => toggleStreamMute(s.clientId),
        onReset: () => resetStreamVolume(s.clientId)
      }
    }
    return (
      <StreamContextMenu
        key={`${menu.clientId}:${menu.pos.x},${menu.pos.y}`}
        label={resolveLabel(s)}
        pos={menu.pos}
        onClose={closeMenu}
        isSelf={!!s.isSelf}
        audio={audio}
        focused={focused}
        canToggleFocus={canToggleFocus}
        onToggleFocus={() => (focused ? onSelect?.(null) : focusStream(s))}
        watched={!isStopped(s)}
        onSetWatched={(watch) => setWatched(s, watch)}
        onStopSharing={
          s.isSelf && onStopSharing
            ? () => {
                onStopSharing()
                if (focused && canToggleFocus) onSelect?.(null)
              }
            : undefined
        }
        shareControl={s.isSelf ? shareControl : undefined}
        onPopout={onPopout}
        theatre={theatre}
        onToggleTheatre={onToggleTheatre}
        isFullscreen={isFullscreen}
        onToggleFullscreen={() => {
          if (document.fullscreenElement) {
            document.exitFullscreen()
            return
          }
          // Fullscreen shows the focused view, so a tile asking for it is
          // focused first; requestFullscreen stays inside this click (it needs
          // the user gesture).
          if (!focused && canToggleFocus) focusStream(s)
          viewerRef.current?.requestFullscreen()
        }}
      />
    )
  }

  const viewer = (
    <div
      className={`video-viewer${isFullscreen ? ' fullscreen' : ''}${theatre ? ' theatre' : ''}${
        chromeShown ? ' chrome-shown' : ''
      }`}
      ref={viewerRef}
      onMouseMove={wakeChrome}
      onMouseLeave={sleepChrome}
    >
      {/* One stage, one tile per stream. Grid mode spreads uniform tiles over
          the area; focus mode is a grid whose first row (held by the spacer)
          belongs to the focused tile, with the thumbnails wrapping below. */}
      <div
        className={`video-stage ${focusedStream ? 'focus' : 'grid'}${
          thumbsShown ? ' has-thumbs' : ''
        }${carouselCollapsed ? ' collapsed' : ''}`}
        ref={stageRef}
        style={
          !focusedStream && gridTileWidth
            ? { '--grid-tile-width': `${gridTileWidth}px` }
            : undefined
        }
      >
        {focusedStream && <div className="video-stage-focus-slot" aria-hidden="true" />}
        {sortedStreams.map(renderTile)}
        {theatreOverlays}
      </div>
      {viewerControls}
      {menuStream && renderStreamMenu()}
    </div>
  )

  // In theatre mode the viewer escapes the chat canvas to cover the window, so
  // portal it to the body — clear of the layout's clipping/transformed ancestors.
  return theatre ? createPortal(viewer, document.body) : viewer
}

export default VideoGrid
