import test from 'node:test'
import assert from 'node:assert/strict'
import { posix, win32 } from 'node:path'
import { mediaEngineHostName, mediaEngineHostPath } from './mediaEngineHost.js'

// The two systems the sidecar is built for, and one it is not (the name is the same there).
const SYSTEMS = {
  linux: {
    platform: 'linux',
    join: posix.join,
    resourcesPath: '/opt/Pylon/resources',
    appPath: '/nix/store/abc-pylon/share/pylon/app',
    name: 'pylon-media-host'
  },
  windows: {
    platform: 'win32',
    join: win32.join,
    resourcesPath: 'C:\\Program Files\\Pylon\\resources',
    appPath: 'C:\\Users\\T\\pylon\\client',
    name: 'pylon-media-host.exe'
  },
  macos: {
    platform: 'darwin',
    join: posix.join,
    resourcesPath: '/Applications/Pylon.app/Contents/Resources',
    appPath: '/Users/t/pylon/client',
    name: 'pylon-media-host'
  }
}

const lookup = (system, fields) =>
  mediaEngineHostPath({
    platform: system.platform,
    join: system.join,
    resourcesPath: system.resourcesPath,
    appPath: system.appPath,
    env: undefined,
    isPackaged: false,
    exists: () => false,
    ...fields
  })

for (const [kind, system] of Object.entries(SYSTEMS)) {
  const resources = system.join(system.resourcesPath, 'media-engine', system.name)
  const beside = system.join(system.appPath, 'media-engine', system.name)
  const workspace = system.join(system.appPath, 'native/media-engine/target/release', system.name)

  test(`${kind}: the name`, () => {
    assert.equal(mediaEngineHostName(system.platform), system.name)
  })

  for (const isPackaged of [false, true]) {
    for (const present of [false, true]) {
      test(`${kind}, ${isPackaged ? 'packaged' : 'not packaged'}, files ${present ? 'there' : 'missing'}: PYLON_MEDIA_HOST wins, whether or not it exists`, () => {
        const asked = []
        const exists = (path) => (asked.push(path), present)
        const found = lookup(system, { env: '  /somewhere/host  ', isPackaged, exists })
        assert.equal(found, '/somewhere/host')
        assert.deepEqual(asked, [])
      })
    }
  }

  const only =
    (...present) =>
    (path) =>
      present.includes(path)

  test(`${kind}, packaged, only the resources file: that one`, () => {
    assert.equal(lookup(system, { isPackaged: true, exists: only(resources) }), resources)
  })

  test(`${kind}, packaged, only the file beside the app: that one`, () => {
    assert.equal(lookup(system, { isPackaged: true, exists: only(beside) }), beside)
  })

  test(`${kind}, packaged, both: the resources one`, () => {
    assert.equal(lookup(system, { isPackaged: true, exists: only(resources, beside) }), resources)
  })

  test(`${kind}, packaged, neither: the resources one, for the log line`, () => {
    const asked = []
    const exists = (path) => (asked.push(path), false)
    assert.equal(lookup(system, { isPackaged: true, exists }), resources)
    assert.deepEqual(asked, [resources, beside])
  })

  test(`${kind}, packaged: never the workspace build`, () => {
    for (const exists of [only(workspace), only(workspace, beside), () => false]) {
      assert.notEqual(lookup(system, { isPackaged: true, exists }), workspace)
    }
  })

  test(`${kind}, not packaged, a sidecar beside the app: that one`, () => {
    assert.equal(lookup(system, { exists: only(beside) }), beside)
    assert.equal(lookup(system, { exists: only(beside, workspace) }), beside)
  })

  test(`${kind}, not packaged, only the workspace build: that one`, () => {
    assert.equal(lookup(system, { exists: only(workspace) }), workspace)
  })

  test(`${kind}, not packaged, neither: the place beside the app, for the log line`, () => {
    const asked = []
    const exists = (path) => (asked.push(path), false)
    assert.equal(lookup(system, { exists }), beside)
    assert.deepEqual(asked, [beside, workspace])
  })

  test(`${kind}, not packaged: never the resources`, () => {
    for (const exists of [only(resources), only(resources, workspace), () => false]) {
      assert.notEqual(lookup(system, { exists }), resources)
    }
  })
}

test('PYLON_MEDIA_HOST unset, empty or blanks counts as unset', () => {
  const system = SYSTEMS.linux
  const workspace = posix.join(system.appPath, 'native/media-engine/target/release', system.name)
  for (const env of [undefined, '', '   ']) {
    assert.equal(
      lookup(system, { env, exists: (path) => path === workspace }),
      workspace,
      JSON.stringify(env)
    )
  }
})

test('the default join is node:path', () => {
  const found = mediaEngineHostPath({
    env: undefined,
    platform: process.platform,
    isPackaged: true,
    resourcesPath: 'res',
    appPath: 'app',
    exists: () => false
  })
  assert.match(found, /^res[\\/]media-engine[\\/]pylon-media-host(\.exe)?$/)
})
