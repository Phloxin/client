export function shouldPauseSelfPreview({ windowFocused, documentVisible }) {
  return !windowFocused || !documentVisible
}

export function syncSelfPreviewPlayback(video, paused) {
  if (!video) return

  if (paused) {
    video.pause?.()
    return
  }

  try {
    const playing = video.play?.()
    if (playing && typeof playing.catch === 'function') playing.catch(() => {})
  } catch {
    return
  }
}

// Whether the sharer's own screen tile is being seen (.plans/native-media-engine-preview-cost.md,
// B1): the self screen's tile is watched (not "Stop Preview"d), a grid that shows it is mounted
// (the streams view in the main window, or the pop-out while it is open), and that window is
// focused and visible by shouldPauseSelfPreview's rule.
//   streams           the video streams, each { tileId, isSelf, source }
//   watchedTileIds    the Set of watched tile ids
//   streamsShown      the main window shows the streams view
//   poppedOut         the grid lives in the pop-out instead
//   mainWindow        { windowFocused, documentVisible } of the main window
//   popoutWindow      the same of the pop-out, or null before it has said
export function selfScreenTileSeen({
  streams,
  watchedTileIds,
  streamsShown,
  poppedOut,
  mainWindow,
  popoutWindow
}) {
  const tile = (streams ?? []).find((s) => s?.isSelf && s.source === 'screen')
  if (!tile || !watchedTileIds?.has?.(tile.tileId)) return false
  const window = poppedOut ? popoutWindow : streamsShown ? mainWindow : null
  return window != null && !shouldPauseSelfPreview(window)
}
