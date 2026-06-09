function VideoGrid({ streams, selectedStreamId, onSelect }) {
  if (!streams.length) return (
    <div className="video-grid empty">
      <div className="empty-message">No active video streams</div>
    </div>
  )

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
          ref={(el) => {
            if (el) el.srcObject = selectedStream.stream
          }}
        />
        <div className="focus-label">
          <span>{selectedStream.label || `Stream ${selectedStream.consumerId}`}</span>
          <span>{selectedStream.channelName || ''}</span>
        </div>
      </div>

      <div className="video-gallery">
        {sortedStreams.map(({ stream, consumerId, label, channelName }, index) => (
          <button
            key={consumerId}
            type="button"
            className={`video-thumbnail ${selectedStream.consumerId === consumerId ? 'selected' : ''}`}
            onClick={() => onSelect?.(consumerId)}
          >
            <video
              autoPlay
              playsInline
              muted
              ref={(el) => {
                if (el) el.srcObject = stream
              }}
            />
            <div className="thumb-label">
              {label || `Stream ${index + 1}`}{channelName ? ` • ${channelName}` : ''}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default VideoGrid