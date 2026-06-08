function VideoGrid({ streams }) {
  if (!streams.length) return null

  return (
    <div className="video-grid">
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