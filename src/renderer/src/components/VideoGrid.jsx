import { useState, useRef, useEffect } from 'react'
import './VideoGrid.css'
import {
  IconVideoMinus,
  IconVideoOff,
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
  IconPlayerStopFilled
} from '@tabler/icons-react'
import { setFocusedScreenAudio, setVideoStreamRoles } from '../lib/soup'

// Stable empty default so the role effect doesn't churn when no watched set is
// passed (e.g. the popout's first render before the bridge data arrives).
const EMPTY_WATCHED = new Set()

// Gap (px) between grid tiles — must match the `gap` in .video-grid-layout.
const GRID_GAP = 12
const TILE_AR = 16 / 9

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

function VideoGrid({
  streams,
  clients,
  selectedStreamId,
  onSelect,
  onPopout,
  onFocusAudio,
  onSetStreamRoles,
  watchedStreamIds = EMPTY_WATCHED,
  onSetStreamWatched,
  volume,
  muted,
  onVolumeChange,
  onMutedChange
}) {
  const viewerRef = useRef(null)
  const gridRef = useRef(null)
  const focusRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [carouselCollapsed, setCarouselCollapsed] = useState(false)
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

  // Resolve the display label from the live clients list so a stream's
  // name stays correct even if it arrived before the clients list caught
  // up with that client's channel move.
  const resolveLabel = (s) =>
    clients?.find((c) => c.id === s.clientId)?.name || s.fallbackLabel || `Stream ${s.consumerId}`

  const sortedStreams = [...streams].sort((a, b) => {
    if (a.isSelf && !b.isSelf) return 1
    if (!a.isSelf && b.isSelf) return -1
    return 0
  })

  // No fallback: when nothing is selected, selectedStream is null and we render
  // the spread-out grid view instead of the single-focus view.
  const selectedStream = sortedStreams.find((s) => s.consumerId === selectedStreamId) || null

  // Reset the zoom whenever focus moves (or clears) so returning to a stream
  // always starts at the normal fit view — zoom is never persisted.
  useEffect(() => {
    setView({ z: 1, x: 0, y: 0 })
  }, [selectedStream?.consumerId])

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

  // Only the focused stream's screen-share audio should be audible -
  // re-apply whenever the focus changes or the volume/mute state changes.
  // When popped out, onFocusAudio routes this to the opener window's soup
  // instance (which owns the actual audio playback); otherwise apply locally.
  useEffect(() => {
    const applyFocusAudio = onFocusAudio || setFocusedScreenAudio
    applyFocusAudio(selectedStream?.clientId ?? null, { volume: volume / 100, muted })
  }, [selectedStream?.clientId, volume, muted])

  // Ration video bandwidth: the focused stream gets full quality, the rest get
  // a cheaper layer (medium in grid view, tiny in the carousel), and a collapsed
  // carousel pauses them entirely. Grid tiles are always visible regardless of
  // the (focus-only) carousel-collapsed state. When popped out, onSetStreamRoles
  // routes this to the opener window's soup instance; otherwise apply locally.
  // Only streams the user has chosen to watch are visible (consumed); everything
  // else stays paused. The carousel-collapsed state additionally hides the
  // non-focused streams in focus view.
  const allVisible = !selectedStream || !carouselCollapsed
  const visibleIds = allVisible
    ? sortedStreams.filter((s) => watchedStreamIds.has(s.consumerId)).map((s) => s.consumerId)
    : []
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
  }, [gridShown, gridTileCount])

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

  const VolumeIcon =
    muted || volume === 0
      ? IconVolumeOff
      : volume < 10
        ? IconVolume4
        : volume <= 50
          ? IconVolume2
          : IconVolume

  const isStopped = (s) => !watchedStreamIds.has(s.consumerId)

  // The top-right watch/close button: stop consuming a stream, or resume it.
  const toggleStopped = (s, e) => {
    e.stopPropagation()
    const watch = isStopped(s) // currently stopped → play it; currently playing → stop it
    onSetStreamWatched?.(s.consumerId, watch)
    // Can't watch a stream big once it's stopped — drop focus if it was focused.
    if (!watch && selectedStream?.consumerId === s.consumerId) onSelect?.(null)
  }

  // Clicking a tile body focuses it (resuming it first if it was closed).
  const focusStream = (s) => {
    if (isStopped(s)) onSetStreamWatched?.(s.consumerId, true)
    onSelect?.(s.consumerId)
  }

  // A carousel thumbnail or grid tile. Shows live video (or a "stopped"
  // placeholder), the watch/close toggle, and the label.
  const renderTile = (s, variant) => {
    const stopped = isStopped(s)
    const selected = variant === 'thumbnail' && selectedStream?.consumerId === s.consumerId
    const tileClass = variant === 'thumbnail' ? 'video-thumbnail' : 'video-grid-tile'
    const labelClass = variant === 'thumbnail' ? 'thumb-label' : 'tile-label'
    return (
      <div
        key={s.consumerId}
        className={`${tileClass}${selected ? ' selected' : ''}${stopped ? ' stopped' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => focusStream(s)}
      >
        {stopped ? (
          <div className="stream-stopped">
            <IconVideoOff size={variant === 'thumbnail' ? 22 : 32} />
          </div>
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
        <button
          type="button"
          className={`stream-toggle-btn ${stopped ? 'play' : 'stop'}`}
          title={stopped ? 'Watch stream' : 'Close stream'}
          onClick={(e) => toggleStopped(s, e)}
        >
          {stopped ? <IconPlayerPlayFilled size={15} /> : <IconPlayerStopFilled size={15} />}
        </button>
        <div className={labelClass}>{resolveLabel(s)}</div>
      </div>
    )
  }

  return (
    <div className={`video-viewer${isFullscreen ? ' fullscreen' : ''}`} ref={viewerRef}>
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
              style={
                view.z > 1
                  ? {
                      transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
                      transformOrigin: '0 0'
                    }
                  : undefined
              }
              ref={(el) => {
                if (el && el.srcObject !== selectedStream.stream)
                  el.srcObject = selectedStream.stream
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
            <div className="focus-label">
              <span>{resolveLabel(selectedStream)}</span>
            </div>
            <div className="video-controls" onClick={(e) => e.stopPropagation()}>
              <div className="volume-control">
                <input
                  type="range"
                  className="volume-slider"
                  min={0}
                  max={100}
                  value={muted ? 0 : volume}
                  onChange={handleVolumeChange}
                  title="Volume"
                />
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
                <button
                  type="button"
                  className="vid-btn"
                  onClick={onPopout}
                  title="Pop out to window"
                >
                  <IconExternalLink size={18} />
                </button>
              )}
              <button
                type="button"
                className="vid-btn"
                onClick={toggleFullscreen}
                title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {isFullscreen ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
              </button>
            </div>
            <button
              type="button"
              className="carousel-toggle"
              onClick={(e) => {
                e.stopPropagation()
                setCarouselCollapsed((prev) => !prev)
              }}
              title={carouselCollapsed ? 'Show stream list' : 'Hide stream list'}
            >
              {carouselCollapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
            </button>
          </div>

          <div className={`video-carousel${carouselCollapsed ? ' collapsed' : ''}`}>
            {sortedStreams.map((s) => renderTile(s, 'thumbnail'))}
          </div>
        </>
      ) : (
        /* No stream focused: spread every stream across the whole grid area.
           Click a tile to focus it. */
        <div
          className="video-grid-layout"
          ref={gridRef}
          style={gridTileWidth ? { '--grid-tile-width': `${gridTileWidth}px` } : undefined}
        >
          <div className="video-grid-controls">
            {onPopout && (
              <button
                type="button"
                className="vid-btn"
                onClick={onPopout}
                title="Pop out to window"
              >
                <IconExternalLink size={18} />
              </button>
            )}
            <button
              type="button"
              className="vid-btn"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            >
              {isFullscreen ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
            </button>
          </div>
          {sortedStreams.map((s) => renderTile(s, 'grid'))}
        </div>
      )}
    </div>
  )
}

export default VideoGrid
