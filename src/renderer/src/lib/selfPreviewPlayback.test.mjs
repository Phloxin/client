import assert from 'node:assert/strict'
import test from 'node:test'

import { shouldPauseSelfPreview, syncSelfPreviewPlayback } from './selfPreviewPlayback.js'

test('a self preview pauses whenever its window loses focus or visibility', () => {
  assert.equal(shouldPauseSelfPreview({ windowFocused: true, documentVisible: true }), false)
  assert.equal(shouldPauseSelfPreview({ windowFocused: false, documentVisible: true }), true)
  assert.equal(shouldPauseSelfPreview({ windowFocused: true, documentVisible: false }), true)
  assert.equal(shouldPauseSelfPreview({ windowFocused: false, documentVisible: false }), true)
})

test('preview playback only controls its local video element and absorbs play failures', async () => {
  let pauses = 0
  let plays = 0
  const video = {
    pause() {
      pauses++
    },
    play() {
      plays++
      return Promise.reject(new Error('autoplay was interrupted'))
    }
  }

  syncSelfPreviewPlayback(video, true)
  assert.equal(pauses, 1)
  assert.equal(plays, 0)

  syncSelfPreviewPlayback(video, false)
  await Promise.resolve()
  assert.equal(pauses, 1)
  assert.equal(plays, 1)
})

test('a synchronous play failure is safe during a focus transition', () => {
  assert.doesNotThrow(() =>
    syncSelfPreviewPlayback(
      {
        play() {
          throw new Error('element detached')
        }
      },
      false
    )
  )
})

// B1 of .plans/native-media-engine-preview-cost.md.
import { selfScreenTileSeen } from './selfPreviewPlayback.js'

const SEEN = { windowFocused: true, documentVisible: true }
const BLURRED = { windowFocused: false, documentVisible: true }
const HIDDEN = { windowFocused: true, documentVisible: false }
const STREAMS = [
  { tileId: 'me:camera', isSelf: true, source: 'camera' },
  { tileId: 'me:screen', isSelf: true, source: 'screen' },
  { tileId: 'you:screen', isSelf: false, source: 'screen' }
]
const base = {
  streams: STREAMS,
  watchedTileIds: new Set(['me:screen']),
  streamsShown: true,
  poppedOut: false,
  mainWindow: SEEN,
  popoutWindow: null
}

test('the self screen tile is seen when watched, shown in the main window, focused and visible', () => {
  assert.equal(selfScreenTileSeen(base), true)
})

test('it is not seen when not watched, not shown, or the window is blurred or hidden', () => {
  assert.equal(selfScreenTileSeen({ ...base, watchedTileIds: new Set() }), false)
  assert.equal(selfScreenTileSeen({ ...base, watchedTileIds: new Set(['me:camera']) }), false)
  assert.equal(selfScreenTileSeen({ ...base, watchedTileIds: new Set(['you:screen']) }), false)
  assert.equal(selfScreenTileSeen({ ...base, streamsShown: false }), false)
  assert.equal(selfScreenTileSeen({ ...base, mainWindow: BLURRED }), false)
  assert.equal(selfScreenTileSeen({ ...base, mainWindow: HIDDEN }), false)
})

test('there is nothing to see without a self screen tile', () => {
  assert.equal(
    selfScreenTileSeen({
      ...base,
      streams: STREAMS.filter((s) => s.source !== 'screen' || !s.isSelf)
    }),
    false
  )
  assert.equal(selfScreenTileSeen({ ...base, streams: [] }), false)
  assert.equal(selfScreenTileSeen({ ...base, streams: undefined }), false)
})

test('popped out, the pop-out window decides, whatever the main window shows', () => {
  const out = { ...base, poppedOut: true }
  assert.equal(selfScreenTileSeen({ ...out, popoutWindow: SEEN }), true)
  assert.equal(
    selfScreenTileSeen({ ...out, popoutWindow: SEEN, streamsShown: false, mainWindow: BLURRED }),
    true
  )
  assert.equal(selfScreenTileSeen({ ...out, popoutWindow: null }), false)
  assert.equal(selfScreenTileSeen({ ...out, popoutWindow: BLURRED }), false)
  assert.equal(selfScreenTileSeen({ ...out, popoutWindow: HIDDEN }), false)
  assert.equal(selfScreenTileSeen({ ...out, popoutWindow: SEEN, watchedTileIds: new Set() }), false)
})
