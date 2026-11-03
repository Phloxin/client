import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clientIdOfTile,
  preferredTileOf,
  sortTiles,
  sourceOfProducedType,
  tileIdOf
} from './streamTiles.js'

const tile = (clientId, source, extra = {}) => ({
  clientId,
  source,
  tileId: tileIdOf(clientId, source),
  ...extra
})
const ids = (streams) => streams.map((s) => s.tileId)

test('a produced type maps to its tile source', () => {
  assert.equal(sourceOfProducedType('ScreenShare'), 'screen')
  assert.equal(sourceOfProducedType('Camera'), 'camera')
  assert.equal(sourceOfProducedType('ScreenShareAudio'), null)
  assert.equal(sourceOfProducedType(undefined), null)
})

test('a tile id joins the client and the source, and gives the client back', () => {
  assert.equal(tileIdOf('123', 'screen'), '123:screen')
  assert.equal(tileIdOf('123', 'camera'), '123:camera')
  assert.equal(clientIdOfTile('123:camera'), '123')
  assert.equal(clientIdOfTile(tileIdOf('a:b', 'screen')), 'a:b')
})

test('something that is not a tile id has no client', () => {
  assert.equal(clientIdOfTile('123'), null)
  assert.equal(clientIdOfTile(null), null)
  assert.equal(clientIdOfTile(undefined), null)
})

test("a client's preferred tile is its screen share, else its camera", () => {
  const camera = tile('a', 'camera')
  const screen = tile('a', 'screen')
  const other = tile('b', 'screen')
  assert.equal(preferredTileOf([camera, other, screen], 'a'), 'a:screen')
  assert.equal(preferredTileOf([camera, other], 'a'), 'a:camera')
})

test('a client without a tile has no preferred tile', () => {
  assert.equal(preferredTileOf([tile('b', 'screen')], 'a'), null)
  assert.equal(preferredTileOf([], 'a'), null)
})

test('remote tiles sort before our own, otherwise in their order', () => {
  const self = tile('me', 'screen', { isSelf: true })
  const sorted = sortTiles([self, tile('b', 'screen'), tile('a', 'camera')])
  assert.deepEqual(ids(sorted), ['b:screen', 'a:camera', 'me:screen'])
})

test("a client's tiles sit together where its first was, screen before camera", () => {
  const sorted = sortTiles([tile('a', 'camera'), tile('b', 'screen'), tile('a', 'screen')])
  assert.deepEqual(ids(sorted), ['a:screen', 'a:camera', 'b:screen'])
})

test('our own camera follows our own screen share, after every remote tile', () => {
  const sorted = sortTiles([
    tile('me', 'camera', { isSelf: true }),
    tile('b', 'camera'),
    tile('me', 'screen', { isSelf: true })
  ])
  assert.deepEqual(ids(sorted), ['b:camera', 'me:screen', 'me:camera'])
})

test('sorting leaves its input alone', () => {
  const streams = [tile('me', 'screen', { isSelf: true }), tile('b', 'screen')]
  sortTiles(streams)
  assert.deepEqual(ids(streams), ['me:screen', 'b:screen'])
  assert.deepEqual(sortTiles([]), [])
})
