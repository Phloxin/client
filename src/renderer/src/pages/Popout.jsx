import { useEffect, useState } from 'react'
import './Popout.css'
import VideoGrid from '../components/VideoGrid'
import TitleBar from '../components/TitleBar'
import { resolveStreamFocus } from '../lib/streamView'

// The popped-out video window. It renders the same VideoGrid as the main app,
// but its data comes from the opener window's bridge (window.opener.__videoPopout)
// rather than from its own state. Because the popout is opened same-origin via
// window.open, it shares the opener's process and can read the live MediaStream
// objects directly — they never cross an IPC boundary. Everything the grid
// changes (focus, watching, per-stream audio, bandwidth roles) is routed back
// over the bridge to the opener, which owns the state and the media.
function Popout() {
  // Resolve the opener's bridge once; it lives for the window's lifetime.
  const [bridge] = useState(
    () => (typeof window !== 'undefined' ? window.opener?.__videoPopout : null) || null
  )

  const [data, setData] = useState(
    () =>
      bridge?.getData?.() || {
        streams: [],
        clients: [],
        selectedStreamClientId: null,
        streamViewers: new Map(),
        streamAudio: {}
      }
  )

  useEffect(() => {
    if (!bridge) return
    const update = () => setData(bridge.getData())
    update()
    return bridge.subscribe(update)
  }, [bridge])

  // Escape unfocuses the focused stream, as the main window's Escape cascade
  // does there. Bubble phase, so anything above it that claims the key (the
  // stream's right-click menu closing) wins; skipped while OS-fullscreen, where
  // Escape belongs to the browser, and with a sole stream (always focused).
  useEffect(() => {
    if (!bridge) return
    const onKeyDown = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.fullscreenElement) return
      const { focusedClientId, canToggleFocus } = resolveStreamFocus({
        streams: data.streams,
        selectedStreamClientId: data.selectedStreamClientId
      })
      if (focusedClientId == null || !canToggleFocus) return
      e.preventDefault()
      bridge.select(null)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [bridge, data.streams, data.selectedStreamClientId])

  if (!bridge) {
    return <div className="popout-empty">This window must be opened from the main app.</div>
  }

  return (
    <div className="popout-root">
      {/* Frameless window: bare min/max/close, no title or icon. */}
      <TitleBar controlsOnly />
      <VideoGrid
        streams={data.streams}
        clients={data.clients}
        selectedStreamClientId={data.selectedStreamClientId}
        onSelect={(id) => bridge.select(id)}
        streamAudio={data.streamAudio}
        onSetStreamAudio={(clientId, patch) => bridge.setStreamAudio(clientId, patch)}
        onSetStreamRoles={(payload) => bridge.setStreamRoles(payload)}
        watchedStreamClientIds={data.watchedStreamClientIds}
        onSetStreamWatched={(id, watched) => bridge.setStreamWatched(id, watched)}
        onStopSharing={bridge.shareControl?.stop}
        shareControl={bridge.shareControl}
        streamViewers={data.streamViewers}
      />
    </div>
  )
}

export default Popout
