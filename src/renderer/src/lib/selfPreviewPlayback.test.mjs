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
