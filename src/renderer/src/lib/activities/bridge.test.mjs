import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BUNDLE_CSP,
  THEME_VARS,
  actionFrame,
  bridgeClients,
  buildSrcdoc,
  readUiMessage,
  themeValues
} from './bridge.js'
import { MAX_CONTROL_BODY, decodeControl, encodeAction } from './frames.js'

const INDEX = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <link rel="stylesheet" href="../shared/base.css" />
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <main id="app"></main>
    <script src="../shared/bridge.js"></script>
    <script src="main.js"></script>
  </body>
</html>`

const FILES = {
  '../shared/base.css': 'body { margin: 0 }',
  'style.css': '#app { color: red }',
  '../shared/bridge.js': 'window.B = 1',
  'main.js': 'const s = "$& $1 $$"'
}

test('the srcdoc carries the CSP meta tag as the first thing in head', () => {
  const doc = buildSrcdoc(INDEX, FILES)
  const head = doc.slice(doc.indexOf('<head>') + '<head>'.length)
  assert.ok(
    head.startsWith(`<meta http-equiv="Content-Security-Policy" content="${BUNDLE_CSP}">`),
    head.slice(0, 120)
  )
  assert.equal(doc.match(/Content-Security-Policy/g).length, 1)
  assert.equal(
    BUNDLE_CSP,
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src http: https: data:"
  )
})

test('the srcdoc inlines every stylesheet and script, in place and verbatim', () => {
  const doc = buildSrcdoc(INDEX, FILES)
  assert.ok(!/<link|src=/.test(doc), doc)
  const order = [
    'body { margin: 0 }',
    '#app { color: red }',
    'window.B = 1',
    'const s = "$& $1 $$"'
  ]
  const at = order.map((s) => doc.indexOf(s))
  assert.ok(
    at.every((i) => i > 0),
    'every file is in'
  )
  assert.deepEqual(
    [...at].sort((a, b) => a - b),
    at,
    'in the order index.html names them'
  )
  assert.ok(doc.includes('<style>body { margin: 0 }</style>'))
  assert.ok(doc.includes('<script>const s = "$& $1 $$"</script>'))
  assert.ok(doc.indexOf('<style>') < doc.indexOf('</head>'))
  assert.ok(doc.indexOf('<main id="app">') < doc.indexOf('<script>'))
})

test('a reference the bundle does not ship, a file that closes its tag, or no head throws', () => {
  assert.throws(
    () => buildSrcdoc(INDEX, { ...FILES, 'main.js': undefined }),
    /does not ship main\.js/
  )
  assert.throws(
    () => buildSrcdoc(INDEX, { ...FILES, 'main.js': 'x = "</script>"' }),
    /contains <\/script/
  )
  assert.throws(
    () => buildSrcdoc(INDEX, { ...FILES, 'style.css': '/* </STYLE> */' }),
    /contains <\/style/
  )
  assert.throws(() => buildSrcdoc('<body></body>', FILES), /needs a <head>/)
})

test('ready, status and input are read as they are', () => {
  assert.deepEqual(readUiMessage({ type: 'ready' }), { type: 'ready' })
  assert.deepEqual(readUiMessage({ type: 'status', busy: true }), { type: 'status', busy: true })
  assert.deepEqual(readUiMessage({ type: 'status', busy: false }), { type: 'status', busy: false })
  const data = new Uint8Array([1, 2])
  assert.deepEqual(readUiMessage({ type: 'input', data }), { type: 'input', data })
})

test('an action needs an integer id from 0 to 2^32 - 1', () => {
  const ok = (id) => readUiMessage({ type: 'action', id, data: { type: 'sit' } })
  assert.deepEqual(ok(0), { type: 'action', id: 0, data: { type: 'sit' } })
  assert.equal(ok(4294967295).type, 'action')
  for (const bad of [-1, 4294967296, 1.5, '1', null, undefined, NaN, Infinity]) {
    assert.equal(ok(bad).type, 'drop', String(bad))
  }
})

test('an action needs data that is a JSON value', () => {
  assert.equal(readUiMessage({ type: 'action', id: 1, data: null }).type, 'action')
  assert.equal(readUiMessage({ type: 'action', id: 1, data: 0 }).type, 'action')
  assert.equal(readUiMessage({ type: 'action', id: 1 }).type, 'drop')
  assert.equal(readUiMessage({ type: 'action', id: 1, data: 1n }).type, 'drop')
  const cycle = {}
  cycle.self = cycle
  assert.equal(readUiMessage({ type: 'action', id: 1, data: cycle }).type, 'drop')
})

test('anything else is dropped with a reason', () => {
  for (const bad of [
    null,
    'ready',
    42,
    {},
    { type: 'init' },
    { type: 'state' },
    { type: 'status' },
    { type: 'status', busy: 'yes' },
    { type: 'input', data: [1, 2] },
    { type: 'input', data: new ArrayBuffer(2) }
  ]) {
    const read = readUiMessage(bad)
    assert.equal(read.type, 'drop', JSON.stringify(bad))
    assert.equal(typeof read.why, 'string')
  }
})

test('player ops are read as the player protocol gives them', () => {
  const read = (fields) => readUiMessage({ type: 'player', ...fields })
  assert.deepEqual(
    read({ op: 'place', rect: { x: 0, y: 10.5, width: 640, height: 360, extra: 1 } }),
    {
      type: 'player',
      op: 'place',
      rect: { x: 0, y: 10.5, width: 640, height: 360 }
    }
  )
  assert.deepEqual(read({ op: 'place', rect: null }), { type: 'player', op: 'place', rect: null })
  assert.deepEqual(read({ op: 'load', videoId: 'M7lc1UVf-VE', startMs: 0, play: false }), {
    type: 'player',
    op: 'load',
    videoId: 'M7lc1UVf-VE',
    startMs: 0,
    play: false
  })
  assert.equal(
    read({ op: 'load', videoId: 'a_b-c_d-e_f', startMs: 86_400_000, play: true }).type,
    'player'
  )
  for (const op of ['play', 'pause', 'unload'])
    assert.deepEqual(read({ op }), { type: 'player', op })
  assert.deepEqual(read({ op: 'seek', positionMs: 1500 }), {
    type: 'player',
    op: 'seek',
    positionMs: 1500
  })
  assert.deepEqual(read({ op: 'volume', volume: 37.5, muted: true }), {
    type: 'player',
    op: 'volume',
    volume: 37.5,
    muted: true
  })
  assert.equal(read({ op: 'volume', volume: 0, muted: false }).type, 'player')
  assert.equal(read({ op: 'volume', volume: 100, muted: false }).type, 'player')
  for (const rate of [25, 50, 75, 100, 125, 150, 175, 200]) {
    assert.deepEqual(read({ op: 'rate', rate }), { type: 'player', op: 'rate', rate })
  }
  assert.deepEqual(read({ op: 'describe', id: 4294967295, videoId: 'M7lc1UVf-VE' }), {
    type: 'player',
    op: 'describe',
    id: 4294967295,
    videoId: 'M7lc1UVf-VE'
  })
})

test('a malformed player op is dropped with a reason', () => {
  const rect = { x: 0, y: 0, width: 10, height: 10 }
  for (const bad of [
    {},
    { op: 'teleport' },
    { op: 'place' },
    { op: 'place', rect: { ...rect, x: -1 } },
    { op: 'place', rect: { ...rect, width: Infinity } },
    { op: 'place', rect: { ...rect, height: NaN } },
    { op: 'place', rect: { ...rect, y: '0' } },
    { op: 'place', rect: { x: 0, y: 0, width: 10 } },
    { op: 'load', videoId: 'M7lc1UVf-V', startMs: 0, play: true },
    { op: 'load', videoId: 'M7lc1UVf-VEx', startMs: 0, play: true },
    { op: 'load', videoId: 'M7lc1UVf+VE', startMs: 0, play: true },
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: -1, play: true },
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 1.5, play: true },
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 86_400_001, play: true },
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 0, play: 'yes' },
    { op: 'load', videoId: 'M7lc1UVf-VE', startMs: 0 },
    { op: 'seek' },
    { op: 'seek', positionMs: -5 },
    { op: 'seek', positionMs: 86_400_001 },
    { op: 'volume', volume: 101, muted: false },
    { op: 'volume', volume: -1, muted: false },
    { op: 'volume', volume: 50 },
    { op: 'volume', volume: NaN, muted: false },
    { op: 'rate', rate: 110 },
    { op: 'rate', rate: '100' },
    { op: 'rate', rate: 1.5 },
    { op: 'describe', id: -1, videoId: 'M7lc1UVf-VE' },
    { op: 'describe', id: 1.5, videoId: 'M7lc1UVf-VE' },
    { op: 'describe', id: 2 ** 32, videoId: 'M7lc1UVf-VE' },
    { op: 'describe', id: 1, videoId: 'nope' }
  ]) {
    const read = readUiMessage({ type: 'player', ...bad })
    assert.equal(read.type, 'drop', JSON.stringify(bad))
    assert.equal(typeof read.why, 'string')
  }
})

test('fullscreen needs on as a boolean', () => {
  assert.deepEqual(readUiMessage({ type: 'fullscreen', on: true }), {
    type: 'fullscreen',
    on: true
  })
  assert.deepEqual(readUiMessage({ type: 'fullscreen', on: false }), {
    type: 'fullscreen',
    on: false
  })
  for (const bad of [{}, { on: 1 }, { on: 'true' }, { on: null }]) {
    assert.equal(readUiMessage({ type: 'fullscreen', ...bad }).type, 'drop', JSON.stringify(bad))
  }
})

test('an action frame goes out under the wire id with the data as is', () => {
  const { frame } = actionFrame(99, { type: 'place', cell: 4 })
  assert.deepEqual(decodeControl(frame.subarray(4)), {
    t: 'action',
    id: 99,
    data: { type: 'place', cell: 4 }
  })
  assert.equal(actionFrame(1, undefined), null)
})

test('an action over the server limit is too large, one at it is not', () => {
  const overhead = encodeAction(7, '').body
  const at = 'x'.repeat(MAX_CONTROL_BODY - overhead)
  assert.ok(actionFrame(7, at).frame)
  assert.deepEqual(actionFrame(7, at + 'x'), { tooLarge: true })
})

test('room clients come out with the roster name and avatar, ids as strings', () => {
  const roster = [
    { id: '1', name: 'Alice', avatar: 'https://h/files/a' },
    { id: '2', name: 'Bob', avatar: null }
  ]
  assert.deepEqual(bridgeClients(['1', '2', '3'], roster), [
    { id: '1', name: 'Alice', avatar: 'https://h/files/a' },
    { id: '2', name: 'Bob', avatar: null },
    { id: '3', name: 'Unknown', avatar: null }
  ])
  assert.deepEqual(bridgeClients(undefined, roster), [])
})

test('theme values are read for the fixed variable list, trimmed', () => {
  const values = themeValues((name) => ` ${name}-value `)
  assert.deepEqual(Object.keys(values), THEME_VARS)
  assert.equal(values['--color-primary'], '--color-primary-value')
})

const UI = new URL('../../activities/ui/', import.meta.url)
const STYLES = new URL('../../styles/', import.meta.url)
const read = (base, path) => readFileSync(new URL(path, base), 'utf8')
// The shared layers each bundle loads, in order. Uno has no duel; Watch Together has no seats
// layer and has the player.
const DUEL_LAYERS = ['bridge', 'room', 'seats', 'duel']
const LAYERS = {
  tic_tac_toe: DUEL_LAYERS,
  connect4: DUEL_LAYERS,
  chess: DUEL_LAYERS,
  uno: ['bridge', 'room', 'seats'],
  watch_together: ['bridge', 'room', 'player']
}
const BUNDLES = Object.keys(LAYERS)
// A bundle's own scripts loaded between the shared layers and main.js: chess's pieces, Watch
// Together's sync, icons and scene.
const OWN_SCRIPTS = { chess: ['pieces.js'], watch_together: ['sync.js', 'icons.js', 'scene.js'] }
const ownScripts = (id) => OWN_SCRIPTS[id] ?? []
const bundleFiles = (id) => ({
  '../shared/base.css': read(UI, 'shared/base.css'),
  ...Object.fromEntries(
    LAYERS[id].map((name) => [`../shared/${name}.js`, read(UI, `shared/${name}.js`)])
  ),
  ...Object.fromEntries(ownScripts(id).map((name) => [name, read(UI, `${id}/${name}`)])),
  'style.css': read(UI, `${id}/style.css`),
  'main.js': read(UI, `${id}/main.js`)
})
// The bundles' own variables, not the client's: the board's gap and fall, Connect 4's discs,
// chess's squares, picker edge and marks, Uno's cards and their sizes, Watch Together's house
// palette and its layout sizes.
const BUNDLE_OWN_VARS = new Set([
  '--gap',
  '--fall',
  '--disc-red',
  '--disc-yellow',
  '--square-light',
  '--square-dark',
  '--picker-edge',
  '--mark-last',
  '--mark-selected',
  '--mark-target',
  '--mark-check',
  '--uno-red',
  '--uno-yellow',
  '--uno-green',
  '--uno-blue',
  '--uno-black',
  '--uno-back',
  '--uno-edge',
  '--uno-crown',
  '--card-w',
  '--w',
  '--ring',
  '--house',
  '--curtain',
  '--curtain-fold',
  '--gold',
  '--seat-taken',
  '--seat-empty',
  '--house-text',
  '--screen-w',
  '--screen-h',
  '--seat',
  '--lift',
  '--fill',
  '--fill-wood',
  '--fill-carpet',
  '--bar-h',
  '--d'
])

for (const id of BUNDLES) {
  test(`the ${id} bundle builds into one document with nothing left to fetch`, () => {
    const doc = buildSrcdoc(read(UI, `${id}/index.html`), bundleFiles(id))
    assert.ok(!/<link|<script\s+src/.test(doc))
    assert.equal(doc.match(/<script>/g).length, LAYERS[id].length + ownScripts(id).length + 1)
    // Two stylesheets; a script may carry `<style>` as text (Watch Together's scene markup).
    const inScripts = ownScripts(id)
      .map((name) => read(UI, `${id}/${name}`).split('<style>').length - 1)
      .reduce((a, b) => a + b, 0)
    assert.equal(doc.match(/<style>/g).length, 2 + inScripts)
  })

  test(`the ${id} bundle loads the shared layers in order, before its own scripts`, () => {
    const html = read(UI, `${id}/index.html`)
    const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1])
    assert.deepEqual(order, [
      ...LAYERS[id].map((n) => `../shared/${n}.js`),
      ...ownScripts(id),
      'main.js'
    ])
  })
}

test('THEME_VARS is exactly the client variables the bundles use, and the client defines each', () => {
  const css = BUNDLES.map((id) => bundleFiles(id)['style.css'])
    .concat(read(UI, 'shared/base.css'))
    .join('\n')
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  for (const name of BUNDLE_OWN_VARS) used.delete(name)
  assert.deepEqual([...used].sort(), [...THEME_VARS].sort())
  const client = read(STYLES, 'themes.css') + read(STYLES, 'base.css')
  for (const name of THEME_VARS) assert.ok(client.includes(`${name}:`), name)
})
