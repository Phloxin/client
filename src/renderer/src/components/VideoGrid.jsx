import { useState, useRef, useEffect } from 'react'
import './VideoGrid.css'
import { IconVideoMinus, IconMaximize, IconMinimize, IconChevronDown, IconChevronUp } from '@tabler/icons-react'

function VideoGrid({ streams, clients, selectedStreamId, onSelect }) {
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

  if (!streams.length) return (
    <div className="video-grid empty">
      <div className="empty-message">
        <IconVideoMinus size={100} />
        No Active Streams
      </div>
    </div>
  )

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

  const selectedStream = sortedStreams.find((s) => s.consumerId === selectedStreamId) || sortedStreams[0]

  return (
    <div className={`video-viewer${isFullscreen ? ' fullscreen' : ''}`} ref={viewerRef}>
      <div className="video-focus">
        <video
          autoPlay
          playsInline
          ref={(el) => { if (el) el.srcObject = selectedStream.stream }}
        />
        <div className="focus-label">
          <span>{resolveLabel(selectedStream)}</span>
        </div>
        <div className="video-controls">
          <button
            type="button"
            className="control-btn"
            onClick={() => setCarouselCollapsed((prev) => !prev)}
            title={carouselCollapsed ? 'Show stream list' : 'Hide stream list'}
          >
            {carouselCollapsed ? <IconChevronUp size={18} /> : <IconChevronDown size={18} />}
          </button>
          <button
            type="button"
            className="control-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {isFullscreen ? <IconMinimize size={18} /> : <IconMaximize size={18} />}
          </button>
        </div>
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
              ref={(el) => { if (el) el.srcObject = s.stream }}
            />
            <div className="thumb-label">
              {resolveLabel(s)}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default VideoGrid