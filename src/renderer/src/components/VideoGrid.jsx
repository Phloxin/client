import { useState, useRef, useEffect } from 'react'
import './VideoGrid.css'
import {
  IconVideoMinus,
  IconMaximize,
  IconMinimize,
  IconChevronDown,
  IconChevronUp,
  IconVolume,
  IconVolume2,
  IconVolume3,
  IconVolume4,
  IconVolumeOff,
  IconExternalLink
} from '@tabler/icons-react'
import { setFocusedScreenAudio, setVideoStreamRoles } from '../lib/soup'

function VideoGrid({ streams, clients, selectedStreamId, onSelect, onPopout, onFocusAudio, onSetStreamRoles, volume, muted, onVolumeChange, onMutedChange }) {
  const viewerRef = useRef(null)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [carouselCollapsed, setCarouselCollapsed] = useState(false)

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
  const allVisible = !selectedStream || !carouselCollapsed
  const visibleStreamKey = allVisible ? sortedStreams.map((s) => s.consumerId).join(',') : ''
  useEffect(() => {
    const applyRoles = onSetStreamRoles || setVideoStreamRoles
    applyRoles({
      focusedConsumerId: selectedStream?.consumerId ?? null,
      visibleConsumerIds: allVisible ? sortedStreams.map((s) => s.consumerId) : [],
    })
  }, [selectedStream?.consumerId, allVisible, visibleStreamKey])

  // When the grid goes away entirely (switch to chat view, or the popout
  // closes) nobody is watching any stream, so pause every video consumer. The
  // role effect above re-applies focus/thumbnail layers when the grid remounts.
  // Separate from that effect so it only fires on unmount, not on every change.
  useEffect(() => {
    const applyRoles = onSetStreamRoles || setVideoStreamRoles
    return () => applyRoles({ focusedConsumerId: null, visibleConsumerIds: [] })
  }, [])

  if (!streams.length) return (
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

  const VolumeIcon = muted || volume === 0 ? IconVolumeOff : volume < 10 ? IconVolume4 : volume <= 50 ? IconVolume2 : IconVolume

  return (
    <div className={`video-viewer${isFullscreen ? ' fullscreen' : ''}`} ref={viewerRef}>
      {selectedStream ? (
        <>
          {/* Clicking the focused video (anywhere but the controls) unfocuses it. */}
          <div
            className="video-focus focusable"
            onClick={() => onSelect?.(null)}
            title="Click to unfocus"
          >
            <video
              autoPlay
              playsInline
              ref={(el) => { if (el && el.srcObject !== selectedStream.stream) el.srcObject = selectedStream.stream }}
            />
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
              onClick={(e) => { e.stopPropagation(); setCarouselCollapsed((prev) => !prev) }}
              title={carouselCollapsed ? 'Show stream list' : 'Hide stream list'}
            >
              {carouselCollapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
            </button>
          </div>

          <div className={`video-carousel${carouselCollapsed ? ' collapsed' : ''}`}>
            {sortedStreams.map((s) => (
              <button
                key={s.consumerId}
                type="button"
                className={`video-thumbnail ${selectedStream.consumerId === s.consumerId ? 'selected' : ''}`}
                onClick={() => onSelect?.(s.consumerId)}
              >
                <video
                  autoPlay
                  playsInline
                  muted
                  ref={(el) => { if (el && el.srcObject !== s.stream) el.srcObject = s.stream }}
                />
                <div className="thumb-label">
                  {resolveLabel(s)}
                </div>
              </button>
            ))}
          </div>
        </>
      ) : (
        /* No stream focused: spread every stream across the whole grid area.
           Click a tile to focus it. */
        <div className="video-grid-layout">
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
          {sortedStreams.map((s) => (
            <button
              key={s.consumerId}
              type="button"
              className="video-grid-tile"
              onClick={() => onSelect?.(s.consumerId)}
            >
              <video
                autoPlay
                playsInline
                muted
                ref={(el) => { if (el && el.srcObject !== s.stream) el.srcObject = s.stream }}
              />
              <div className="tile-label">
                {resolveLabel(s)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default VideoGrid