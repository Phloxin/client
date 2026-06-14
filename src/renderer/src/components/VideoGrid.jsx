import './VideoGrid.css'
import { IconVideoMinus } from '@tabler/icons-react'

function VideoGrid({ streams, clients, selectedStreamId, onSelect }) {
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
    <div className="video-viewer">
      <div className="video-focus">
        <video
          autoPlay
          playsInline
          ref={(el) => { if (el) el.srcObject = selectedStream.stream }}
        />
        <div className="focus-label">
          <span>{resolveLabel(selectedStream)}</span>
        </div>
      </div>

      <div className="video-carousel">
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