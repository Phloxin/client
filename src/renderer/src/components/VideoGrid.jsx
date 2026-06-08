function VideoGrid({ streams }) {
  if (!streams.length) return (
    <div className="video-grid empty">
      <div className="empty-message">No active video streams</div>
    </div>
  )

  // Calculate optimal grid layout
  const count = streams.length
  let cols = 1
  let rows = 1

  if (count === 1) {
    cols = 1
    rows = 1
  } else if (count === 2) {
    cols = 2
    rows = 1
  } else if (count === 3 || count === 4) {
    cols = 2
    rows = 2
  } else if (count === 5 || count === 6) {
    cols = 3
    rows = 2
  } else if (count === 7 || count === 8 || count === 9) {
    cols = 3
    rows = 3
  } else {
    cols = Math.ceil(Math.sqrt(count))
    rows = Math.ceil(count / cols)
  }

  return (
    <div className="video-grid" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
      {streams.map(({ stream, consumerId }) => (
        <div key={consumerId} className="video-tile">
          <video
            autoPlay
            playsInline
            ref={(el) => {
              if (el) el.srcObject = stream
            }}
          />
        </div>
      ))}
    </div>
  )
}

export default VideoGrid