// ─── Dev Mode ───────────────────────────────────────────────────
export const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'

// ─── Mock Data ──────────────────────────────────────────────────
export const MOCK_TOKEN = 'mock-token-dev'

export const MOCK_CLIENT = {
  id: 1,
  name: 'DevUser'
}

export const MOCK_CHANNELS = [
  { id: 1, name: 'Voice Channel 1', clients: [1, 2] },
  { id: 2, name: 'Voice Channel 2', clients: [] },
  { id: 3, name: 'Voice Channel 3', clients: [3] },
]

export const MOCK_CLIENTS = [
  { id: 1, name: 'DevUser', channel_id: 1 },
  { id: 2, name: 'Chris', channel_id: 1 },
  { id: 3, name: 'John', channel_id: 3 },
  { id: 4, name: 'Tim', channel_id: null },
]

// ─── Mock Video Streams ─────────────────────────────────────────
// Real streams carry a live MediaStream from the SFU. To exercise the
// video grid in dev mode we synthesize canvas-backed streams so each
// thumbnail renders something visibly "live" (an animated bar + clock).
const MOCK_STREAM_DEFS = [
  { consumerId: 'mock-1', clientId: 2, fallbackLabel: 'Chris', color: '#2563eb' },
  { consumerId: 'mock-2', clientId: 3, fallbackLabel: 'John', color: '#059669' },
  { consumerId: 'mock-3', clientId: 1, fallbackLabel: 'DevUser', color: '#d97706', isSelf: true },
]

// Build the mock streams. Each returned object matches the shape the SFU
// path produces, plus a `_stopMock()` to cancel its animation loop on cleanup.
export function createMockStreams() {
  return MOCK_STREAM_DEFS.map((def) => {
    const canvas = document.createElement('canvas')
    canvas.width = 640
    canvas.height = 360
    const ctx = canvas.getContext('2d')
    const start = performance.now()
    let raf

    const draw = (now) => {
      const t = (now - start) / 1000
      ctx.fillStyle = def.color
      ctx.fillRect(0, 0, canvas.width, canvas.height)

      // A bar that sweeps left-to-right so the feed is obviously animating
      const x = ((Math.sin(t) + 1) / 2) * (canvas.width - 80)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.fillRect(x, canvas.height / 2 - 20, 80, 40)

      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.font = 'bold 32px sans-serif'
      ctx.fillText(def.fallbackLabel, canvas.width / 2, 56)
      ctx.font = '20px monospace'
      ctx.fillText(`${t.toFixed(1)}s`, canvas.width / 2, canvas.height - 28)

      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)

    return {
      consumerId: def.consumerId,
      clientId: def.clientId,
      isSelf: !!def.isSelf,
      fallbackLabel: def.fallbackLabel,
      stream: canvas.captureStream(30),
      _stopMock: () => cancelAnimationFrame(raf)
    }
  })
}