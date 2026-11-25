// What the native media engine's sidecar captures on Windows: the `target` of its
// `capture` request (native/media-engine/PROTOCOL.md), worked out from the source the
// app's own picker chose for this share. Main decides this from what it holds itself,
// never from a value the renderer sends with the capture.
//
// Kept free of Electron so it can be unit tested. The caller passes:
//   sourceId   the share's source (selectedScreenSourceId): 'window:<HWND>:<n>' or
//              'screen:<n>:<n>', or null
//   sources    the picker's last enumeration (cachedScreenSources), with display_id
//   displays   every display as { id, bounds }, bounds in physical pixels of the
//              virtual screen (screen.dipToScreenRect of each display's bounds)
//
// Returns { target }: { window: <HWND> }, { monitor: { x, y } } (the centre of the
// display), or null when the machine has one display and the screen's display is not
// found (the sidecar then takes the primary monitor). Throws when there is nothing it
// may capture, which sends the share to Chromium.
export function captureTarget({ sourceId, sources, displays }) {
  if (typeof sourceId !== 'string' || !sourceId) {
    throw new Error('The share has no source to capture')
  }
  const source = (sources ?? []).find((candidate) => candidate?.id === sourceId)
  if (!source) throw new Error('The share source is not among the enumerated sources')

  const windowMatch = /^window:(\d+):\d+$/.exec(sourceId)
  if (windowMatch) {
    const handle = Number(windowMatch[1])
    if (!Number.isSafeInteger(handle) || handle <= 0) {
      throw new Error('The share source has no usable window handle')
    }
    return { target: { window: handle } }
  }

  if (!/^screen:\d+:\d+$/.test(sourceId)) throw new Error('The share source id is not understood')
  const all = displays ?? []
  const display = source.display_id
    ? all.find((candidate) => String(candidate?.id) === String(source.display_id))
    : null
  const bounds = display?.bounds
  if (bounds) {
    return {
      target: {
        monitor: {
          x: Math.floor(bounds.x + bounds.width / 2),
          y: Math.floor(bounds.y + bounds.height / 2)
        }
      }
    }
  }
  if (all.length === 1) return { target: null }
  throw new Error('The shared screen matches no display')
}
