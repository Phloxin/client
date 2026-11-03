// Stream tile identity, kept browser-independent so the rules are unit-testable.
// A tile is one published video source: a client's screen share and camera are
// two tiles, keyed `${clientId}:${source}`. Neither part changes across a codec
// fallback, so focus and watch intent keyed by tile survive the new producer.

const SOURCE_BY_PRODUCED_TYPE = { ScreenShare: 'screen', Camera: 'camera' }

// 'screen' | 'camera' for a video producer's produced type; null for anything else.
export function sourceOfProducedType(producedType) {
  return SOURCE_BY_PRODUCED_TYPE[producedType] ?? null
}

export function tileIdOf(clientId, source) {
  return `${clientId}:${source}`
}

export function clientIdOfTile(tileId) {
  if (typeof tileId !== 'string') return null
  const separator = tileId.lastIndexOf(':')
  return separator < 0 ? null : tileId.slice(0, separator)
}

// The tile a click on a client (sidebar, DM strip) lands on: their screen
// share's, else their camera's, else null.
export function preferredTileOf(streams, clientId) {
  const own = streams.filter((s) => s.clientId === clientId)
  const tile = own.find((s) => s.source === 'screen') ?? own.find((s) => s.source === 'camera')
  return tile?.tileId ?? null
}

// Remote tiles before our own; a client's tiles side by side where its first
// one was, screen before camera; everything else keeps its order.
export function sortTiles(streams) {
  const clientOrder = new Map()
  streams.forEach((s, index) => {
    if (!clientOrder.has(s.clientId)) clientOrder.set(s.clientId, index)
  })
  const rank = (s) => (s.source === 'screen' ? 0 : 1)
  return [...streams].sort(
    (a, b) =>
      Number(!!a.isSelf) - Number(!!b.isSelf) ||
      clientOrder.get(a.clientId) - clientOrder.get(b.clientId) ||
      rank(a) - rank(b)
  )
}
