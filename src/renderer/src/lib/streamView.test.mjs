import assert from 'node:assert/strict'
import test from 'node:test'

import { layoutUniformTiles, partitionStreamView, resolveStreamFocus } from './streamView.js'
import { tileIdOf } from './streamTiles.js'

const stream = (clientId, source = 'screen') => ({
  clientId,
  source,
  tileId: tileIdOf(clientId, source),
  consumerId: `c-${clientId}-${source}`
})

test('no streams means nothing to focus and no toggle', () => {
  assert.deepEqual(resolveStreamFocus({ streams: [], selectedTileId: 'a:screen' }), {
    focusedTileId: null,
    canToggleFocus: false,
    canUnfocus: false
  })
  assert.deepEqual(resolveStreamFocus(), {
    focusedTileId: null,
    canToggleFocus: false,
    canUnfocus: false
  })
})

test('a sole stream is always focused and cannot be unfocused', () => {
  for (const selectedTileId of [null, 'a:screen', 'gone:screen']) {
    assert.deepEqual(resolveStreamFocus({ streams: [stream('a')], selectedTileId }), {
      focusedTileId: 'a:screen',
      canToggleFocus: false,
      canUnfocus: false
    })
  }
})

test('with several streams the live selection is focused', () => {
  assert.deepEqual(
    resolveStreamFocus({ streams: [stream('a'), stream('b')], selectedTileId: 'b:screen' }),
    { focusedTileId: 'b:screen', canToggleFocus: true, canUnfocus: true }
  )
})

test('with several streams and no selection the grid shows', () => {
  assert.deepEqual(
    resolveStreamFocus({ streams: [stream('a'), stream('b')], selectedTileId: null }),
    { focusedTileId: null, canToggleFocus: true, canUnfocus: false }
  )
})

test('a selection whose stream has gone falls back to the grid', () => {
  assert.deepEqual(
    resolveStreamFocus({
      streams: [stream('a'), stream('b'), stream('c')],
      selectedTileId: 'gone:screen'
    }),
    { focusedTileId: null, canToggleFocus: true, canUnfocus: false }
  )
})

test('focus is keyed by tile, so a new consumer id keeps it', () => {
  const streams = [{ ...stream('a'), consumerId: 'new-consumer' }, stream('b')]
  assert.equal(
    resolveStreamFocus({ streams, selectedTileId: 'a:screen' }).focusedTileId,
    'a:screen'
  )
})

test("a client's camera and screen share are separate tiles to focus", () => {
  const streams = [stream('a', 'screen'), stream('a', 'camera')]
  assert.deepEqual(resolveStreamFocus({ streams, selectedTileId: 'a:camera' }), {
    focusedTileId: 'a:camera',
    canToggleFocus: true,
    canUnfocus: true
  })
  // With the camera gone, the same client's screen share does not inherit its selection.
  assert.deepEqual(
    resolveStreamFocus({
      streams: [stream('a', 'screen'), stream('b')],
      selectedTileId: 'a:camera'
    }),
    { focusedTileId: null, canToggleFocus: true, canUnfocus: false }
  )
})

const ids = (list) => list.map((s) => s.tileId)

const watching = (...tileIds) => new Set(tileIds)

test('with no selection the only watched stream is the focused one, and stays so', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  assert.deepEqual(
    resolveStreamFocus({ streams, selectedTileId: null, watchedTileIds: watching('b:screen') }),
    { focusedTileId: 'b:screen', canToggleFocus: true, canUnfocus: false }
  )
  // Selecting it explicitly changes nothing: unfocusing would show the same view.
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: 'b:screen',
      watchedTileIds: watching('b:screen')
    }),
    { focusedTileId: 'b:screen', canToggleFocus: true, canUnfocus: false }
  )
})

test('two or more watched streams with no selection are a grid, not a focus', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: null,
      watchedTileIds: watching('a:screen', 'c:screen')
    }),
    { focusedTileId: null, canToggleFocus: true, canUnfocus: false }
  )
})

test('a selection wins over the only watched stream, and can then be unfocused', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  // Focused and unwatched, with another stream watched: unfocusing lands on that one.
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: 'a:screen',
      watchedTileIds: watching('b:screen')
    }),
    { focusedTileId: 'a:screen', canToggleFocus: true, canUnfocus: true }
  )
  // Focused and unwatched, with two others watched: unfocusing lands on their grid.
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: 'a:screen',
      watchedTileIds: watching('b:screen', 'c:screen')
    }),
    { focusedTileId: 'a:screen', canToggleFocus: true, canUnfocus: true }
  )
})

test('a focused stream among several watched ones can be unfocused', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: 'a:screen',
      watchedTileIds: watching('a:screen', 'b:screen')
    }),
    { focusedTileId: 'a:screen', canToggleFocus: true, canUnfocus: true }
  )
})

test('a focused unwatched stream with nothing watched unfocuses to the placeholder grid', () => {
  const streams = [stream('a'), stream('b')]
  for (const watchedTileIds of [undefined, watching(), watching('gone:screen')]) {
    assert.deepEqual(resolveStreamFocus({ streams, selectedTileId: 'a:screen', watchedTileIds }), {
      focusedTileId: 'a:screen',
      canToggleFocus: true,
      canUnfocus: true
    })
  }
})

test('stale watched ids for gone streams are not counted', () => {
  const streams = [stream('a'), stream('b')]
  // The one live watched stream is still the only one, whatever else is listed.
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: null,
      watchedTileIds: watching('gone:screen', 'a:screen', 'other:camera')
    }),
    { focusedTileId: 'a:screen', canToggleFocus: true, canUnfocus: false }
  )
  // Only stale ids means nothing is watched: no focus, grid.
  assert.deepEqual(
    resolveStreamFocus({
      streams,
      selectedTileId: null,
      watchedTileIds: watching('gone:screen')
    }),
    { focusedTileId: null, canToggleFocus: true, canUnfocus: false }
  )
  // A stale id beside a focused, watched stream does not make it unfocusable.
  assert.equal(
    resolveStreamFocus({
      streams,
      selectedTileId: 'a:screen',
      watchedTileIds: watching('gone:screen', 'a:screen')
    }).canUnfocus,
    false
  )
})

test('a sole stream stays focused and fixed whatever is watched', () => {
  for (const watchedTileIds of [watching(), watching('a:screen'), watching('gone:screen')]) {
    assert.deepEqual(resolveStreamFocus({ streams: [stream('a')], watchedTileIds }), {
      focusedTileId: 'a:screen',
      canToggleFocus: false,
      canUnfocus: false
    })
  }
})

test('the only watched stream, focused automatically, fills the main area alone', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  const watchedTileIds = watching('b:screen')
  const { focusedTileId } = resolveStreamFocus({ streams, selectedTileId: null, watchedTileIds })
  const { main, strip } = partitionStreamView({ streams, watchedTileIds, focusedTileId })
  assert.deepEqual(ids(main), ['b:screen'])
  assert.deepEqual(ids(strip), ['a:screen', 'c:screen'])
})

test('with nothing focused and nothing watched every stream is in the main area', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  const { main, strip } = partitionStreamView({
    streams,
    watchedTileIds: new Set(),
    focusedTileId: null
  })
  assert.deepEqual(ids(main), ['a:screen', 'b:screen', 'c:screen'])
  assert.deepEqual(strip, [])
})

test('with nothing focused the watched streams share the main area and the rest go below', () => {
  const streams = [stream('a'), stream('b'), stream('c'), stream('d')]
  const { main, strip } = partitionStreamView({
    streams,
    watchedTileIds: new Set(['d:screen', 'b:screen']),
    focusedTileId: null
  })
  assert.deepEqual(ids(main), ['b:screen', 'd:screen'])
  assert.deepEqual(ids(strip), ['a:screen', 'c:screen'])
})

test('a focused stream is alone in the main area, watched or not', () => {
  const streams = [stream('a'), stream('b'), stream('c')]
  for (const watchedTileIds of [new Set(), new Set(['b:screen'])]) {
    const { main, strip } = partitionStreamView({
      streams,
      watchedTileIds,
      focusedTileId: 'b:screen'
    })
    assert.deepEqual(ids(main), ['b:screen'])
    assert.deepEqual(ids(strip), ['a:screen', 'c:screen'])
  }
})

test('with a focus, watched streams are thumbnails too', () => {
  const streams = [stream('a'), stream('b'), stream('c'), stream('d')]
  const { main, strip } = partitionStreamView({
    streams,
    watchedTileIds: new Set(['a:screen', 'c:screen']),
    focusedTileId: 'c:screen'
  })
  assert.deepEqual(ids(main), ['c:screen'])
  assert.deepEqual(ids(strip), ['a:screen', 'b:screen', 'd:screen'])
})

test('a sole stream is always in the main area, watched or not', () => {
  const sole = [stream('a')]
  for (const watchedTileIds of [new Set(), new Set(['a:screen'])]) {
    const { focusedTileId } = resolveStreamFocus({ streams: sole, selectedTileId: null })
    const { main, strip } = partitionStreamView({ streams: sole, watchedTileIds, focusedTileId })
    assert.deepEqual(ids(main), ['a:screen'])
    assert.deepEqual(strip, [])
  }
})

test('the partition keeps input order and covers every stream once', () => {
  const streams = [stream('a'), stream('b', 'camera'), stream('c'), stream('d'), stream('e')]
  const watchedTileIds = new Set(['e:screen', 'b:camera'])
  for (const focusedTileId of [null, 'c:screen']) {
    const { main, strip } = partitionStreamView({ streams, watchedTileIds, focusedTileId })
    assert.equal(main.length + strip.length, streams.length)
    assert.deepEqual(
      ids([...main, ...strip]).sort(),
      ids(streams).sort(),
      'every stream lands in exactly one list'
    )
    for (const list of [main, strip]) {
      const order = list.map((s) => streams.indexOf(s))
      assert.deepEqual(
        order,
        [...order].sort((x, y) => x - y)
      )
    }
  }
})

test('a stale watched id for a gone stream does not count as watching', () => {
  const streams = [stream('a'), stream('b')]
  const { main, strip } = partitionStreamView({
    streams,
    watchedTileIds: new Set(['gone:screen']),
    focusedTileId: null
  })
  assert.deepEqual(ids(main), ['a:screen', 'b:screen'])
  assert.deepEqual(strip, [])
})

test('no streams partition to nothing', () => {
  assert.deepEqual(partitionStreamView({ streams: [] }), { main: [], strip: [] })
})

// Every tile must sit inside the area, never overlap another, and be 16:9.
const checkFits = (width, height, count, gap = 12) => {
  const { tileWidth, positions } = layoutUniformTiles({ width, height, count, gap })
  assert.equal(positions.length, count)
  const h = (tileWidth * 9) / 16
  const eps = 1e-6
  for (const p of positions) {
    assert.ok(p.left >= 0 && p.top >= 0, `tile starts inside ${JSON.stringify(p)}`)
    assert.ok(p.left + tileWidth <= width + eps, `right edge in ${width}x${height} n=${count}`)
    assert.ok(p.top + h <= height + eps, `bottom edge in ${width}x${height} n=${count}`)
  }
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      const a = positions[i]
      const b = positions[j]
      const apart =
        Math.abs(a.left - b.left) >= tileWidth - eps || Math.abs(a.top - b.top) >= h - eps
      assert.ok(apart, `tiles ${i} and ${j} overlap`)
    }
  }
  return { tileWidth, positions }
}

test('one tile is as large as the area allows and centred', () => {
  const { tileWidth, positions } = checkFits(1000, 400, 1)
  // Height-bound: 400px of height is a 711px-wide 16:9 tile.
  assert.equal(tileWidth, 711)
  assert.equal(positions[0].left, Math.floor((1000 - 711) / 2))
  assert.equal(positions[0].top, Math.floor((400 - (711 * 9) / 16) / 2))
})

test('two tiles in a wide area share one row, centred', () => {
  const { tileWidth, positions } = checkFits(1600, 500, 2)
  assert.equal(positions[0].top, positions[1].top)
  assert.equal(positions[1].left - positions[0].left, tileWidth + 12)
  const used = 2 * tileWidth + 12
  assert.equal(positions[0].left, Math.floor((1600 - used) / 2))
})

test('two tiles in a tall area stack in one column, centred', () => {
  const { tileWidth, positions } = checkFits(500, 1600, 2)
  assert.equal(positions[0].left, positions[1].left)
  assert.equal(positions[0].left, Math.floor((500 - tileWidth) / 2))
  assert.ok(positions[1].top > positions[0].top)
})

test('a partial last row is centred under the full ones', () => {
  // 3 tiles in an area that favours two columns: two on top, one beneath.
  const { tileWidth, positions } = checkFits(700, 500, 3)
  assert.equal(positions[0].top, positions[1].top)
  assert.ok(positions[2].top > positions[0].top)
  const cluster = 2 * tileWidth + 12
  assert.equal(positions[0].left, Math.floor((700 - cluster) / 2))
  assert.equal(positions[2].left, Math.floor((700 - tileWidth) / 2))
})

test('the cluster is centred vertically too', () => {
  const { tileWidth, positions } = checkFits(1000, 1000, 2)
  const h = (tileWidth * 9) / 16
  const clusterH = 2 * h + 12
  assert.equal(positions[0].top, Math.floor((1000 - clusterH) / 2))
})

test('tiles never overflow the area across sizes and counts', () => {
  for (const [w, h] of [
    [1280, 720],
    [2247.6, 900],
    [333, 1200],
    [1200, 120],
    [400, 300]
  ]) {
    for (let n = 1; n <= 12; n++) checkFits(w, h, n)
  }
})

test('degenerate sizes give a safe empty layout', () => {
  for (const area of [
    { width: 0, height: 500 },
    { width: 500, height: 0 },
    { width: NaN, height: 500 },
    { width: undefined, height: undefined },
    { width: 10, height: 10 }
  ]) {
    const { tileWidth, positions } = layoutUniformTiles({ ...area, count: 3 })
    assert.equal(tileWidth, 0)
    assert.equal(positions.length, 3)
    for (const p of positions) assert.deepEqual(p, { left: 0, top: 0 })
  }
  assert.deepEqual(layoutUniformTiles({ width: 500, height: 500, count: 0 }), {
    tileWidth: 0,
    positions: []
  })
  assert.deepEqual(layoutUniformTiles(), { tileWidth: 0, positions: [] })
})
