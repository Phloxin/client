import { useState, useRef, useEffect, useLayoutEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { motion } from 'motion/react'
import './VideoGrid.css'
import {
  IconVideo,
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
import { setVideoStreamRoles, startStreamDebugStats, subscribeStreamViewers } from '../lib/soup'
import { useImageColors } from '../lib/imageColors'
import { useWheelSlider } from '../lib/useWheelSlider'
import { syncSelfPreviewPlayback } from '../lib/selfPreviewPlayback'
import { useSelfPreviewPaused } from '../lib/useSelfPreviewWindow'
import {
  GRID_GAP,
  layoutUniformTiles,
  partitionStreamView,
  resolveStreamFocus
} from '../lib/streamView'
import { sortTiles } from '../lib/streamTiles'
import { spring } from '../lib/motionPresets'
import { useAnimationCategory } from '../context/SettingsContext'
import {
  setStreamDebugInfo,
  useStreamDebugInfoEnabled,
  useStreamDebugPoll
} from '../lib/useStreamDebugInfo'
import StreamContextMenu from './StreamContextMenu'
import StreamDebugOverlay from './StreamDebugOverlay'

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

// The stream view. The main area shows what you are looking at and a strip of
// thumbnails below it holds every other stream (partitionStreamView): the
// focused stream fills the main area alone, or with nothing focused the watched
// streams share it as equal tiles, so a stream nobody is watching never costs a
// full tile's room. Every stream is one always-mounted tile (keyed by tile id:
// the publishing client and its source), a direct child of a single stage in
// every layout, so moving a stream between the main area and the strip restyles
// and re-places its tile rather than remounting it — no <video> ever restarts,
// and Motion tweens the tile between its old and new boxes. A sole stream is
// always focused, and so is the only watched stream, and neither can be
// unfocused (there is nothing else to show); see resolveStreamFocus. Per-stream
// actions live in the right-click menu (StreamContextMenu); the bottom bar keeps
// the focused stream's volume and the view controls.
function VideoGrid({
  streams,
  clients,
  selectedTileId,
  onSelect,
  onPopout,
  onSetStreamRoles,
  watchedTileIds = EMPTY_WATCHED,
  onSetStreamWatched,
  // Ends one of our own shares, by its source ('screen' | 'camera'). Absent in
  // windows that can't reach it, which hides the stop action on our own streams.
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
  onToggleDeafen,
  // Starts the per-stream stats poll behind the Debug Information overlay. The
  // pop-out has no media of its own, so it passes the opener's.
  startDebugStats = startStreamDebugStats
}) {
  // Debug Information (the stream menu's toggle): the overlay on every tile in
  // the main area, fed by one poll for all of them while it is on.
  const debugInfo = useStreamDebugInfoEnabled()
  const debugStore = useStreamDebugPoll(debugInfo && streams.length > 0, startDebugStats)
  // Focus/unfocus tweens the tiles between layouts (Motion layout animation),
  // gated by the Stream Focus animation setting and reduced motion.
  const animateFocus = useAnimationCategory('streamFocus')
  const selfPreviewPaused = useSelfPreviewPaused()
  const viewerRef = useRef(null)
  const stageRef = useRef(null)
  const mainRef = useRef(null)
  // Each tile's element, by tile id; zoom/pan measure against the focused
  // one. Looked up rather than held in a ref that moves between tiles, because
  // Motion only forwards a ref on mount/unmount, so moving one onto an
  // already-mounted tile when focus changes would never take.
  const tileElsRef = useRef(new Map())
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [carouselCollapsed, setCarouselCollapsed] = useState(false)
  // The right-click menu: { tileId, pos: { x, y } } while open.
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
  // The main area's size (px), which the watched tiles are laid out in when
  // nothing is focused (layoutUniformTiles). `stage` is the theatre flag it was
  // measured under, since toggling theatre remounts the stage and the old numbers
  // belong to a different box; `live` is whether it has been seen again since, so
  // tiles never tween in from where they were first placed. Null until measured.
  const [mainArea, setMainArea] = useState(null)

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

  const clientOf = (id) => clients?.find((c) => c.id === id)

  // Resolve the display label from the live clients list so a stream's
  // name stays correct even if it arrived before the clients list caught
  // up with that client's channel move. A camera tile says so; a screen
  // share's carries the name alone.
  const resolveLabel = (s) => {
    const name =
      clients?.find((c) => c.id === s.clientId)?.name || s.fallbackLabel || `Stream ${s.consumerId}`
    return s.source === 'camera' ? `${name} · Camera` : name
  }

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

  const sortedStreams = sortTiles(streams)

  // Focus/watch intent is keyed by tile (the publishing client and its source),
  // not by the transient mediasoup consumer id. Codec fallback re-produces the
  // same logical stream with a new consumer id, and must not stop playback,
  // drop focus, or remount its tile. A sole stream is always the focused one,
  // and so is the only watched stream; with more watched, nothing selected means
  // the grid. canUnfocus is what the focused tile's affordances follow: while
  // unfocusing would change nothing, the click, menu entry and pointer stay out
  // of it.
  const { focusedTileId, canToggleFocus, canUnfocus } = resolveStreamFocus({
    streams: sortedStreams,
    selectedTileId,
    watchedTileIds
  })
  const focusedStream =
    focusedTileId == null ? null : sortedStreams.find((s) => s.tileId === focusedTileId)

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

  const watchedStreams = sortedStreams.filter((s) => watchedTileIds.has(s.tileId))
  const isStopped = (s) => !watchedTileIds.has(s.tileId)

  // The main area gets what is being looked at, the strip every other stream.
  const { main, strip } = partitionStreamView({
    streams: sortedStreams,
    watchedTileIds,
    focusedTileId
  })
  const stripTileIds = new Set(strip.map((s) => s.tileId))
  // The strip shows (and needs the room above the control bar) while it holds
  // anything and isn't collapsed; the collapse toggle exists for it in either
  // layout.
  const hasThumbs = strip.length > 0
  const thumbsShown = hasThumbs && !carouselCollapsed

  // Zoom needs a picture: a sole stream we aren't watching is still the focused
  // view, but shows its placeholder, so there's nothing to zoom into.
  const zoomable = !!focusedStream && !isStopped(focusedStream) && !!focusedStream.stream
  const zoom = zoomable ? view : NO_ZOOM

  // The menu's stream went away (its sharer stopped, or every stream did): drop
  // the menu rather than leave it pointing at nothing. Adjusted during render
  // so a menu for a missing tile never paints.
  const menuStream = menu ? (sortedStreams.find((s) => s.tileId === menu.tileId) ?? null) : null
  if (menu && !menuStream) setMenu(null)

  // Reset the zoom whenever focus moves (or clears) so returning to a stream
  // always starts at the normal fit view — zoom is never persisted. The viewer
  // list is per-stream, so it closes here too rather than carrying over, and so
  // does the right-click menu.
  useEffect(() => {
    setView(NO_ZOOM)
    setViewersOpen(false)
    setMenu(null)
  }, [focusedTileId])

  // Scroll-to-zoom on the focused stream, anchored at the cursor. Native
  // listener (not React onWheel) because it must preventDefault, and wheel
  // events are passive by default. `theatre` is a dep because entering/leaving
  // it portals the viewer, which remounts the focused tile's element.
  useEffect(() => {
    const el = tileElsRef.current.get(focusedTileId)
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
  }, [focusedTileId, zoomable, theatre])

  // Drag to pan while zoomed. A real drag (moved past a click threshold) sets
  // suppressClickRef so the mouseup's click doesn't unfocus the stream.
  const handlePanStart = (e) => {
    if (zoom.z === 1 || e.button !== 0) return
    dragRef.current = { sx: e.clientX, sy: e.clientY, x: zoom.x, y: zoom.y, moved: false }
  }
  const handlePanMove = (e) => {
    const d = dragRef.current
    const el = tileElsRef.current.get(focusedTileId)
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
    const el = tileElsRef.current.get(focusedTileId)
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
  // thumbnails), and a collapsed thumbnail strip pauses them entirely (with
  // nothing focused every watched stream is in the main area, so the strip
  // never hides one). When popped out, onSetStreamRoles routes this to the
  // opener window's soup instance; otherwise apply locally. Only streams the
  // user has chosen to watch are visible (consumed); everything else stays
  // paused.
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

  // Measure the main area the unfocused tiles are laid out in, and keep it current
  // as it changes: the window or sidebar resizing, fullscreen, thumbnails coming
  // or going or the strip collapsing (each moves the area's bottom edge), the
  // strip wrapping onto another row. A ResizeObserver keeps it in sync without
  // polling; the stream and strip counts re-measure straight away so the frame
  // that adds a thumbnail already has the right area. `theatre` is a dep because
  // entering/leaving it portals the stage to a new parent, which remounts the
  // nodes — the observer must follow to the new ones.
  // The width is the stage's, not the main area element's: the stage's columns
  // are fixed 200px ones that don't fill it (see .stream-tile.focused), so the
  // element stops short of the right edge, while the tiles are positioned in the
  // stage's padding box. The height is the element's: the row the thumbnails
  // leave. Measured fractionally: clientWidth rounds, so a 2247.6px stage reads
  // 2248, two width-bound tiles then need 0.4px more than there is, and the row
  // wraps into an overflowing column. Layout effect so the first painted frame
  // is already positioned.
  const hasStreams = sortedStreams.length > 0
  const stripCount = strip.length
  useLayoutEffect(() => {
    const stage = stageRef.current
    const mainEl = mainRef.current
    if (!stage || !mainEl) return
    const measure = (fromObserver) => {
      const width = stage.getBoundingClientRect().width
      const height = mainEl.getBoundingClientRect().height
      setMainArea((prev) => {
        const sameStage = prev?.stage === theatre
        const live = sameStage && (prev.live || fromObserver)
        if (sameStage && prev.width === width && prev.height === height && prev.live === live) {
          return prev
        }
        return { width, height, stage: theatre, live }
      })
    }
    measure(false)
    const ro = new ResizeObserver(() => measure(true))
    ro.observe(stage)
    ro.observe(mainEl)
    return () => ro.disconnect()
  }, [hasStreams, stripCount, thumbsShown, theatre])
  // No stage left to have measured: start over when streams come back.
  if (!hasStreams && mainArea) setMainArea(null)

  // Where the unfocused tiles go. Derived here rather than in the effect so a
  // tile that joins the main area is placed in the very render that adds it.
  // Until the area has been measured for this stage the tiles stay hidden, and
  // the layout tween stays off until the measurement has been seen again (see
  // `live` and tileLayoutGate), so they appear in place instead of sliding in
  // from the corner.
  const areaMeasured = mainArea?.stage === theatre
  const gridLayout = areaMeasured
    ? layoutUniformTiles({
        width: mainArea.width,
        height: mainArea.height,
        count: focusedStream ? 0 : main.length,
        gap: GRID_GAP
      })
    : null
  const gridTilesLive = areaMeasured && mainArea.live
  // When the tiles tween, as their layoutDependency. Every tile and media
  // wrapper is a layout node from mount, whatever its role: Motion reads the
  // `layout` prop only when the node is created, so a tile first rendered
  // without it (a grid tile before the area was measured, i.e. every tile of a
  // view opened with nothing watched) would never tween again. What is shown
  // where decides instead: Motion snapshots the tiles only in a render where
  // this changes, so a change of focus, watched set, strip contents or collapse
  // tweens every tile together, while a re-render that only re-measures the
  // area (a resize, fullscreen) is followed at once rather than chased by a
  // spring, and one that swaps a placeholder for the arrived video leaves a
  // running tween alone. Held still while the setting or reduced motion turns
  // the tween off, and until the area is live.
  const viewLayout = [
    focusedTileId,
    main.map((s) => s.tileId).join(','),
    strip.map((s) => s.tileId).join(','),
    carouselCollapsed
  ].join('|')
  const tileLayoutGate = animateFocus && gridTilesLive ? viewLayout : 'still'

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
  // screen share (we never hear our own, and a camera has no audio).
  const barAudioClientId =
    focusedStream && !focusedStream.isSelf && focusedStream.source === 'screen'
      ? focusedStream.clientId
      : null
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
            <div className="empty-share-actions">
              <button
                type="button"
                className="btn btn-primary empty-share-btn"
                onClick={() => shareControl.pickSource('screens')}
              >
                <IconScreenShare size={18} />
                Share screen
              </button>
              <button
                type="button"
                className="btn empty-share-btn secondary"
                onClick={() => shareControl.pickSource('devices')}
              >
                <IconVideo size={18} />
                Start camera
              </button>
            </div>
          )}
        </div>
      </div>
    )

  // Clicking a tile body focuses it, resuming it first if it was closed.
  const focusStream = (s) => {
    if (isStopped(s)) onSetStreamWatched?.(s.tileId, true)
    onSelect?.(s.tileId)
  }

  // Start or stop consuming a stream. Can't watch a stream big once it's
  // stopped, so stopping the focused one drops focus — unless it's the only
  // stream, which is always the focused view (it shows its placeholder). This
  // stays on canToggleFocus rather than canUnfocus: stopping the only watched
  // stream must clear the selection so the view lands on the placeholder grid.
  //
  // Starting a second stream beside the only watched one, which is the focused
  // view, is meant to put both in the main area. That focus may be an explicit
  // selection rather than the automatic one, and the two look the same, so the
  // selection is dropped for both to behave alike. With two or more already
  // watched, an explicit focus is a real choice and stays.
  const setWatched = (s, watch) => {
    onSetStreamWatched?.(s.tileId, watch)
    if (!watch && s.tileId === focusedTileId && canToggleFocus) onSelect?.(null)
    if (
      watch &&
      isStopped(s) &&
      focusedStream &&
      s.tileId !== focusedTileId &&
      !isStopped(focusedStream) &&
      watchedStreams.length === 1
    ) {
      onSelect?.(null)
    }
  }

  // The top-right watch/close button: stop consuming a stream, or resume it.
  const toggleStopped = (s, e) => {
    e.stopPropagation()
    setWatched(s, isStopped(s)) // currently stopped → play it; currently playing → stop it
  }

  // Focus toggling only exists with two or more streams: a grid tile or
  // thumbnail focuses, the focused tile goes back to the grid. The focused tile
  // only does so while that changes the view (canUnfocus): the sole stream and
  // the only watched stream have nowhere to go back to. Clicking a stream we
  // aren't watching always starts watching it — the focused (or sole) tile
  // stays focused rather than toggling back to the grid. A click that ends a
  // drag-pan, or that dismissed the menu, does none of these.
  const handleTileMouseDown = (s, e) => {
    if (e.button === 0) swallowClickRef.current = menuOpen
    if (s.tileId === focusedTileId) handlePanStart(e)
  }
  const handleTileClick = (s) => {
    const dismissedMenu = swallowClickRef.current
    swallowClickRef.current = false
    if (s.tileId === focusedTileId) {
      if (suppressClickRef.current) {
        suppressClickRef.current = false
        return
      }
      if (dismissedMenu) return
      if (isStopped(s)) onSetStreamWatched?.(s.tileId, true)
      else if (canUnfocus) onSelect?.(null)
      return
    }
    if (!dismissedMenu && canToggleFocus) focusStream(s)
  }

  const openMenu = (s, e) => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ tileId: s.tileId, pos: { x: e.clientX, y: e.clientY } })
  }

  // Speaker-off pill beside the name plate of a stream whose audio we muted.
  const muteBadge = (
    <span className="stream-mute-badge" aria-label="Stream audio muted">
      <IconVolumeOff size={13} />
    </span>
  )

  // One stream's tile, in whichever role the layout gives it: `focused` (fills
  // the main area, with zoom/pan, minimap and viewer count), `grid`
  // (one of several equal tiles sharing the main area when nothing is focused) or
  // `thumb` (everything else, in the strip). The element is the same in every
  // role — only its class changes — so the <video> inside survives a move between
  // the main area and the strip. Both the tile and its media wrapper are Motion
  // layout nodes, so the tween moves the wrapper with the tile instead of leaving
  // the media behind.
  const renderTile = (s) => {
    const isFocused = s.tileId === focusedTileId
    const role = isFocused ? 'focused' : stripTileIds.has(s.tileId) ? 'thumb' : 'grid'
    // Grid tiles are placed by hand (the area's size and tile count decide the
    // cluster); hidden until there's a place for them.
    const place = role === 'grid' ? gridLayout?.positions[main.indexOf(s)] : null
    const gridStyle =
      role !== 'grid'
        ? undefined
        : place
          ? { left: place.left, top: place.top, width: gridLayout.tileWidth }
          : { visibility: 'hidden' }
    const compact = role === 'thumb'
    // Watching is intent; the stream arrives a moment later once the consumer is
    // created. Keep showing the placeholder until it does, rather than a blank
    // <video>.
    const stopped = isStopped(s) || !s.stream
    const client = clientOf(s.clientId)
    const label = resolveLabel(s)
    // Only someone else's screen share carries the badge: our own stream is never
    // played back to us, and a camera has no audio.
    const audioMuted = !s.isSelf && s.source === 'screen' && !!streamAudio[s.clientId]?.muted
    const zoomed = isFocused && zoom.z > 1
    // The frame the minimap's outline is measured against.
    const zoomedEl = zoomed ? tileElsRef.current.get(s.tileId) : null
    return (
      <motion.div
        key={s.tileId}
        layout
        layoutDependency={tileLayoutGate}
        transition={TILE_TRANSITION}
        style={gridStyle}
        ref={(el) => {
          if (el) tileElsRef.current.set(s.tileId, el)
          else tileElsRef.current.delete(s.tileId)
        }}
        className={`stream-tile ${role}${stopped ? ' stopped' : ''}${
          (isFocused ? canUnfocus : canToggleFocus) ? ' focusable' : ''
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
        <motion.div
          layout
          layoutDependency={tileLayoutGate}
          transition={TILE_TRANSITION}
          className="stream-media"
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
        {/* Debug Information, on the main area's tiles while there's a picture
            (a strip thumbnail is too small for it). */}
        {debugInfo && !compact && !stopped && <StreamDebugOverlay store={debugStore} stream={s} />}
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
                setWatched(s, true)
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
      {hasThumbs && (
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
    const focused = s.tileId === focusedTileId
    // The volume row, like the bar's, is for someone else's screen share only.
    let audio = null
    if (!s.isSelf && s.source === 'screen') {
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
        key={`${menu.tileId}:${menu.pos.x},${menu.pos.y}`}
        label={resolveLabel(s)}
        pos={menu.pos}
        onClose={closeMenu}
        isSelf={!!s.isSelf}
        audio={audio}
        focused={focused}
        // The entry for the focused stream is "unfocus", so it follows
        // canUnfocus; for any other stream it is "focus".
        canToggleFocus={focused ? canUnfocus : canToggleFocus}
        onToggleFocus={() => (focused ? onSelect?.(null) : focusStream(s))}
        watched={!isStopped(s)}
        onSetWatched={(watch) => setWatched(s, watch)}
        onStopSharing={
          s.isSelf && onStopSharing
            ? () => {
                onStopSharing(s.source)
                if (focused && canToggleFocus) onSelect?.(null)
              }
            : undefined
        }
        shareControl={s.isSelf ? shareControl : undefined}
        source={s.isSelf ? s.source : undefined}
        onPopout={onPopout}
        theatre={theatre}
        onToggleTheatre={onToggleTheatre}
        debugInfo={debugInfo}
        onToggleDebugInfo={() => setStreamDebugInfo(!debugInfo)}
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
      {/* One stage, one tile per stream, all direct children. A grid whose first row
          (held by the main area element) is the main area and whose further rows
          are the thumbnails wrapping below it; the tiles place themselves by
          role. */}
      <div
        className={`video-stage${thumbsShown ? ' has-thumbs' : ''}${
          carouselCollapsed ? ' collapsed' : ''
        }`}
        ref={stageRef}
      >
        <div className="video-stage-main" ref={mainRef} aria-hidden="true" />
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
