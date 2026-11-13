import test from 'node:test'
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import {
  nativeShareSettingApplies,
  nativeShareSource,
  nativeShareSourceKind
} from './nativeShareSource.js'

// The platform kinds of T3: where the screen can be shared natively, and where not.
const PLATFORMS = {
  windows: { platform: 'win32', sessionType: undefined, isAbsolute: win32.isAbsolute },
  wayland: { platform: 'linux', sessionType: 'wayland', isAbsolute: posix.isAbsolute },
  x11: { platform: 'linux', sessionType: 'x11', isAbsolute: posix.isAbsolute },
  macos: { platform: 'darwin', sessionType: undefined, isAbsolute: posix.isAbsolute }
}
const SCREEN_PLATFORMS = new Set(['windows', 'wayland'])

const FILE = { windows: 'C:\\clips\\test.h264', other: '/clips/test.h264' }
const fileFor = (kind) => (kind === 'windows' ? FILE.windows : FILE.other)

// The variable's values: what each gives whatever the setting says (null: no native share).
// `screen` gives the screen only where it can be shared.
const VARIABLE = [
  ['off', () => null],
  [' off ', () => null],
  ['screen', (kind) => (SCREEN_PLATFORMS.has(kind) ? { screen: true } : null)],
  ['file:<absolute>', (kind) => ({ file: fileFor(kind) })],
  ['file:relative.h264', () => null],
  ['file:', () => null],
  ['pattern:1280x720@30', () => ({ pattern: { width: 1280, height: 720, fps: 30 } })],
  ['pattern:0x720@30', () => null],
  ['pattern:1280x720', () => null],
  ['on', () => null],
  ['SCREEN', () => null]
]

const envValue = (value, kind) => (value === 'file:<absolute>' ? `file:${fileFor(kind)}` : value)

for (const [kind, system] of Object.entries(PLATFORMS)) {
  for (const setting of [false, true]) {
    for (const [value, expected] of VARIABLE) {
      test(`${kind}, setting ${setting ? 'on' : 'off'}, PYLON_NATIVE_SHARE=${value}`, () => {
        const source = nativeShareSource({ ...system, env: envValue(value, kind), setting })
        assert.deepEqual(source, expected(kind))
      })
    }
    for (const unset of [undefined, '', '  ']) {
      test(`${kind}, setting ${setting ? 'on' : 'off'}, PYLON_NATIVE_SHARE ${JSON.stringify(unset)}`, () => {
        const source = nativeShareSource({ ...system, env: unset, setting })
        const screen = setting && SCREEN_PLATFORMS.has(kind) ? { screen: true } : null
        assert.deepEqual(source, screen)
      })
    }
  }
}

test('only a stored true turns the setting on', () => {
  for (const setting of [undefined, null, 'true', 1, {}]) {
    assert.equal(nativeShareSource({ ...PLATFORMS.wayland, env: undefined, setting }), null)
  }
})

test('nativeShareSettingApplies: Windows and Wayland only', () => {
  for (const [kind, system] of Object.entries(PLATFORMS)) {
    assert.equal(nativeShareSettingApplies(system), SCREEN_PLATFORMS.has(kind), kind)
  }
  assert.equal(nativeShareSettingApplies({ platform: 'linux', sessionType: undefined }), false)
})

test('nativeShareSourceKind names each source', () => {
  assert.equal(nativeShareSourceKind({ screen: true }), 'screen')
  assert.equal(nativeShareSourceKind({ file: '/a.h264' }), 'file')
  assert.equal(nativeShareSourceKind({ pattern: { width: 2, height: 2, fps: 1 } }), 'pattern')
  assert.equal(nativeShareSourceKind(null), null)
  assert.equal(nativeShareSourceKind({}), null)
})
