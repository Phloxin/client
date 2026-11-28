import { debugInfoRows } from '../lib/streamDebugInfo'
import { useStreamDebugRow } from '../lib/useStreamDebugInfo'

// A stream tile's "Debug Information" overlay (toggled from the stream's
// right-click menu): codec and coder, size, frame rate, bitrate, and the health
// numbers for its direction, top-left of the tile. It subscribes to its own
// stats row, so the once-a-second refresh re-renders only this.
/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
function StreamDebugOverlay({ store, stream }) {
  const row = useStreamDebugRow(store, stream.producerId)
  const lines = debugInfoRows(stream, row)
  return (
    <div className="stream-debug-overlay" aria-label="Stream debug information">
      {lines.map((line) => (
        <div key={line.label} className="stream-debug-line">
          <span className="stream-debug-label">{line.label}</span>
          <span className={`stream-debug-value${line.tone ? ` ${line.tone}` : ''}`}>
            {line.value}
            {line.chip && (
              <span className={`stream-debug-chip ${line.chip.tone}`}>{line.chip.label}</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

export default StreamDebugOverlay
