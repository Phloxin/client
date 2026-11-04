import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStreamFocus } from './streamView.js'
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
    canToggleFocus: false
  })
  assert.deepEqual(resolveStreamFocus(), { focusedTileId: null, canToggleFocus: false })
})

test('a sole stream is always focused and cannot be unfocused', () => {
  for (const selectedTileId of [null, 'a:screen', 'gone:screen']) {
    assert.deepEqual(resolveStreamFocus({ streams: [stream('a')], selectedTileId }), {
      focusedTileId: 'a:screen',
      canToggleFocus: false
    })
  }
})

test('with several streams the live selection is focused', () => {
  assert.deepEqual(
    resolveStreamFocus({ streams: [stream('a'), stream('b')], selectedTileId: 'b:screen' }),
    { focusedTileId: 'b:screen', canToggleFocus: true }
  )
})

test('with several streams and no selection the grid shows', () => {
  assert.deepEqual(
    resolveStreamFocus({ streams: [stream('a'), stream('b')], selectedTileId: null }),
    { focusedTileId: null, canToggleFocus: true }
  )
})

test('a selection whose stream has gone falls back to the grid', () => {
  assert.deepEqual(
    resolveStreamFocus({
      streams: [stream('a'), stream('b'), stream('c')],
      selectedTileId: 'gone:screen'
    }),
    { focusedTileId: null, canToggleFocus: true }
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
    canToggleFocus: true
  })
  // With the camera gone, the same client's screen share does not inherit its selection.
  assert.deepEqual(
    resolveStreamFocus({
      streams: [stream('a', 'screen'), stream('b')],
      selectedTileId: 'a:camera'
    }),
    { focusedTileId: null, canToggleFocus: true }
  )
})
