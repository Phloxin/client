import { useEffect, useState } from 'react'
import './Popout.css'
import VideoGrid from '../components/VideoGrid'

// The popped-out video window. It renders the same VideoGrid as the main app,
// but its data comes from the opener window's bridge (window.opener.__videoPopout)
// rather than from its own state. Because the popout is opened same-origin via
// window.open, it shares the opener's process and can read the live MediaStream
// objects directly — they never cross an IPC boundary.
function Popout() {
  // Resolve the opener's bridge once; it lives for the window's lifetime.
  const [bridge] = useState(
    () => (typeof window !== 'undefined' ? window.opener?.__videoPopout : null) || null
  )

  const [data, setData] = useState(
    () => bridge?.getData?.() || { streams: [], clients: [], selectedStreamClientId: null }
  )

  useEffect(() => {
    if (!bridge) return
    const update = () => setData(bridge.getData())
    update()
    return bridge.subscribe(update)
  }, [bridge])

  if (!bridge) {
    return <div className="popout-empty">This window must be opened from the main app.</div>
  }

  return (
    <div className="popout-root">
      <VideoGrid
        streams={data.streams}
        clients={data.clients}
        selectedStreamClientId={data.selectedStreamClientId}
        onSelect={(id) => bridge.select(id)}
        volume={data.volume}
        muted={data.muted}
        onVolumeChange={(v) => bridge.setVolume(v)}
        onMutedChange={(m) => bridge.setMuted(m)}
        onFocusAudio={(clientId, opts) => bridge.setFocusedAudio(clientId, opts)}
        onSetStreamRoles={(payload) => bridge.setStreamRoles(payload)}
        watchedStreamClientIds={data.watchedStreamClientIds}
        onSetStreamWatched={(id, watched) => bridge.setStreamWatched(id, watched)}
      />
    </div>
  )
}

export default Popout
