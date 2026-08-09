import assert from 'node:assert/strict'
import test from 'node:test'

import { audioOptionsFor } from './captureOptions.js'

const values = (options) => options.map(({ value }) => value)

test('unavailable capture exposes legacy loopback only on Windows', () => {
  assert.deepEqual(values(audioOptionsFor('screens', null)), ['none'])
  assert.deepEqual(values(audioOptionsFor('screens', { backend: 'none', platform: 'linux' })), [
    'none'
  ])
  assert.deepEqual(values(audioOptionsFor('screens', { backend: 'none', platform: 'win32' })), [
    'system-legacy',
    'none'
  ])
})

test('Linux window capture prefers per-app audio and retains system fallback', () => {
  assert.deepEqual(
    values(
      audioOptionsFor('windows', {
        backend: 'pipewire',
        platform: 'linux',
        perApp: true,
        excludeSelf: true
      })
    ),
    ['app', 'system-exclude-self', 'none']
  )
})

test('Linux screen capture prefers system audio', () => {
  assert.deepEqual(
    values(
      audioOptionsFor('screens', {
        backend: 'pipewire',
        platform: 'linux',
        perApp: true,
        system: true
      })
    ),
    ['system', 'app', 'none']
  )
})

test('other platforms preserve per-app and legacy fallbacks', () => {
  assert.deepEqual(
    values(audioOptionsFor('windows', { backend: 'native', platform: 'win32', perApp: true })),
    ['app', 'none']
  )
  assert.deepEqual(values(audioOptionsFor('screens', { backend: 'native', platform: 'darwin' })), [
    'system-legacy',
    'none'
  ])
})
