import assert from 'node:assert/strict'
import test from 'node:test'
import { captureTarget } from './captureTarget.js'

const left = { id: 'screen:0:0', name: 'Screen 1', display_id: '2528732444' }
const right = { id: 'screen:1:0', name: 'Screen 2', display_id: '2779098405' }
const editor = { id: 'window:132456:0', name: 'index.js - pylon', display_id: '' }
// Physical pixels: a 1920x1080 at 125% beside a 2560x1440 at 100%.
const displays = [
  { id: 2528732444, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
  { id: 2779098405, bounds: { x: 1920, y: -200, width: 2560, height: 1440 } }
]
const sources = [left, right, editor]

test('a window id gives its handle as a number', () => {
  assert.deepEqual(captureTarget({ sourceId: editor.id, sources, displays }), {
    target: { window: 132456 }
  })
})

test('a window id with another trailing number still gives the handle', () => {
  const tab = { id: 'window:65810:1', name: 'Other' }
  assert.deepEqual(captureTarget({ sourceId: tab.id, sources: [tab], displays }), {
    target: { window: 65810 }
  })
})

test('a screen gives the centre of its display, in physical pixels', () => {
  assert.deepEqual(captureTarget({ sourceId: left.id, sources, displays }), {
    target: { monitor: { x: 960, y: 540 } }
  })
  assert.deepEqual(captureTarget({ sourceId: right.id, sources, displays }), {
    target: { monitor: { x: 3200, y: 520 } }
  })
})

test('an odd sized display gives a point inside it', () => {
  const odd = [{ id: 7, bounds: { x: -1365, y: 0, width: 1365, height: 767 } }]
  const screen = { id: 'screen:3:0', display_id: '7' }
  assert.deepEqual(captureTarget({ sourceId: screen.id, sources: [screen], displays: odd }), {
    target: { monitor: { x: -683, y: 383 } }
  })
})

test('a screen whose display is missing on a one display machine gives no target', () => {
  const lonely = [displays[0]]
  assert.deepEqual(captureTarget({ sourceId: right.id, sources, displays: lonely }), {
    target: null
  })
  const noDisplayId = { id: 'screen:0:0', display_id: '' }
  assert.deepEqual(
    captureTarget({ sourceId: noDisplayId.id, sources: [noDisplayId], displays: lonely }),
    { target: null }
  )
})

test('a screen whose display is missing among several fails', () => {
  const gone = { id: 'screen:2:0', display_id: '999' }
  assert.throws(() => captureTarget({ sourceId: gone.id, sources: [gone], displays }), /no display/)
  const noDisplayId = { id: 'screen:0:0', display_id: '' }
  assert.throws(
    () => captureTarget({ sourceId: noDisplayId.id, sources: [noDisplayId], displays }),
    /no display/
  )
})

test('a screen with no displays at all fails', () => {
  assert.throws(() => captureTarget({ sourceId: left.id, sources, displays: [] }), /no display/)
})

test('no source id fails', () => {
  assert.throws(() => captureTarget({ sourceId: null, sources, displays }), /no source/)
  assert.throws(() => captureTarget({ sourceId: '', sources, displays }), /no source/)
  assert.throws(() => captureTarget({ sources, displays }), /no source/)
})

test('an id that is not in the list fails', () => {
  assert.throws(
    () => captureTarget({ sourceId: 'window:999:0', sources, displays }),
    /not among the enumerated/
  )
  assert.throws(
    () => captureTarget({ sourceId: left.id, sources: undefined, displays }),
    /not among the enumerated/
  )
})

test('a bad id fails even when it is in the list', () => {
  for (const id of [
    'window:abc:0',
    'window:0:0',
    'window:-5:0',
    'screen:x',
    'webcam:1',
    'window:1'
  ]) {
    const odd = { id, display_id: '2528732444' }
    assert.throws(() => captureTarget({ sourceId: id, sources: [odd], displays }), Error, id)
  }
})
