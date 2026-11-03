// Which stream the stream view focuses, kept browser-independent so the rule is
// unit-testable and shared by the views that need it (VideoGrid's layout, and
// the main/popout windows' Escape-to-unfocus).
//
// A sole stream is always the focused view: there is nothing to go back to, so
// no focus/unfocus toggle exists until a second stream appears. With two or
// more, the user's selection decides, and a selection whose stream has gone (or
// never existed) means the grid. Focus is keyed by tile (the publishing client
// and its source, see streamTiles.js), not the transient consumer id, so a
// codec fallback never drops it.
export function resolveStreamFocus({ streams = [], selectedTileId = null } = {}) {
  if (streams.length === 1) {
    return { focusedTileId: streams[0].tileId, canToggleFocus: false }
  }
  const selectedLive = selectedTileId != null && streams.some((s) => s.tileId === selectedTileId)
  return {
    focusedTileId: selectedLive ? selectedTileId : null,
    canToggleFocus: streams.length > 1
  }
}
