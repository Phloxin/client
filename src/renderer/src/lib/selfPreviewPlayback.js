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
