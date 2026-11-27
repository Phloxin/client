// Which stream the stream view focuses, kept browser-independent so the rule is
// unit-testable and shared by the views that need it (VideoGrid's layout, and
// the main/popout windows' Escape-to-unfocus).
//
// A sole stream is always the focused view: there is nothing to go back to, so
// no focus/unfocus toggle exists until a second stream appears. With two or
// more, the user's selection decides, and a selection whose stream has gone (or
// never existed) is no selection. With no selection the one watched stream, if
// there is exactly one, is the focused view too: showing it alone in the main
// area is what focusing it would do, so a separate "unfocused" look for it would
// differ only in size and chrome and make the click that toggles it a dead one.
// Two or more watched streams share the main area as a grid instead. Focus is
// keyed by tile (the publishing client and its source, see streamTiles.js), not
// the transient consumer id, so a codec fallback never drops it.
//
// canToggleFocus says there are other streams to focus. canUnfocus says dropping
// the selection would change what is shown: false for a sole stream and for the
// only watched stream, which stays the focused view whatever is selected. Stale
// ids in watchedTileIds (streams that have gone) are not counted.
export function resolveStreamFocus({
  streams = [],
  selectedTileId = null,
  watchedTileIds = new Set()
} = {}) {
  if (streams.length === 0) {
    return { focusedTileId: null, canToggleFocus: false, canUnfocus: false }
  }
  if (streams.length === 1) {
    return { focusedTileId: streams[0].tileId, canToggleFocus: false, canUnfocus: false }
  }
  const watched = streams.filter((s) => watchedTileIds.has(s.tileId))
  const selectedLive = selectedTileId != null && streams.some((s) => s.tileId === selectedTileId)
  const focusedTileId = selectedLive
    ? selectedTileId
    : watched.length === 1
      ? watched[0].tileId
      : null
  const onlyWatched = watched.length === 1 && watched[0].tileId === focusedTileId
  return {
    focusedTileId,
    canToggleFocus: true,
    canUnfocus: focusedTileId != null && !onlyWatched
  }
}

// Which streams fill the main area and which wait in the thumbnail strip below
// it. The main area shows what you are looking at: the focused stream alone, or
// with nothing focused every watched stream side by side. Everything else is a
// thumbnail, so a stream nobody is watching never costs a full tile's room. The
// exception is a view with nothing focused and nothing watched: no tile is
// competing for room, and the placeholders' big Play buttons are the right call
// to action, so they all stay in the main area and there is no strip. Both
// lists keep the input order.
export function partitionStreamView({
  streams = [],
  watchedTileIds = new Set(),
  focusedTileId = null
} = {}) {
  if (focusedTileId != null) {
    return {
      main: streams.filter((s) => s.tileId === focusedTileId),
      strip: streams.filter((s) => s.tileId !== focusedTileId)
    }
  }
  const main = streams.filter((s) => watchedTileIds.has(s.tileId))
  if (!main.length) return { main: [...streams], strip: [] }
  return { main, strip: streams.filter((s) => !watchedTileIds.has(s.tileId)) }
}

// Gap (px) between the multi-watch tiles.
export const GRID_GAP = 12
const TILE_AR = 16 / 9

// Where `count` uniform 16:9 tiles go inside a width×height area so the whole set
// is on screen at once, as large as they can be. Tries every column count and,
// for each, takes the tile size capped by both the available width (per column)
// and height (per row), keeping the biggest: all tiles stay equal AND scale down
// together, which flex-wrap alone can't do. The cluster is centred on both axes
// and a partial last row centres under the others, rather than stretching to fill
// the height. Positions are relative to the area's top-left, in input order.
//
// The columns actually laid out are however many tiles of the chosen width fit
// across (never more than `count`), which is never fewer than the search assumed,
// so the rows always fit. Offsets are floored so a tile never pokes past the
// area's far edge, at the cost of a sub-pixel off-centre.
export function layoutUniformTiles({ width, height, count, gap = GRID_GAP } = {}) {
  const n = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  const none = { tileWidth: 0, positions: Array.from({ length: n }, () => ({ left: 0, top: 0 })) }
  if (!n || !(width > 0) || !(height > 0)) return none
  let best = 0
  for (let c = 1; c <= n; c++) {
    const r = Math.ceil(n / c)
    const wByWidth = (width - (c - 1) * gap) / c
    const wByHeight = ((height - (r - 1) * gap) / r) * TILE_AR
    const w = Math.min(wByWidth, wByHeight)
    if (w > best) best = w
  }
  const tileWidth = Math.floor(best)
  if (tileWidth <= 0) return none
  const tileHeight = tileWidth / TILE_AR
  const cols = Math.min(n, Math.max(1, Math.floor((width + gap) / (tileWidth + gap))))
  const rows = Math.ceil(n / cols)
  const top0 = Math.floor((height - (rows * tileHeight + (rows - 1) * gap)) / 2)
  const positions = []
  for (let r = 0; r < rows; r++) {
    const inRow = Math.min(cols, n - r * cols)
    const left0 = Math.floor((width - (inRow * tileWidth + (inRow - 1) * gap)) / 2)
    for (let c = 0; c < inRow; c++) {
      positions.push({
        left: left0 + c * (tileWidth + gap),
        top: top0 + r * (tileHeight + gap)
      })
    }
  }
  return { tileWidth, positions }
}
