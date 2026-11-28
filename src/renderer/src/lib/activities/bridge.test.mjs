import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  BUNDLE_SOUNDS,
  BUNDLE_CSP,
  MAX_EXPORT_BYTES,
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
  for (const on of [true, false]) {
    assert.deepEqual(read({ op: 'captions', on }), { type: 'player', op: 'captions', on })
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
    { op: 'captions' },
    { op: 'captions', on: 'true' },
    { op: 'captions', on: 1 },
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

test('a sound is read for a bundle with the capability, by a name the shell has a sound for', () => {
  for (const name of Object.keys(BUNDLE_SOUNDS)) {
    assert.deepEqual(readUiMessage({ type: 'sound', name }, ['sound']), { type: 'sound', name })
  }
  const packs = new URL('../../assets/soundpacks/', import.meta.url)
  for (const id of Object.values(BUNDLE_SOUNDS)) {
    assert.ok(readFileSync(new URL(`default/${id}.wav`, packs)).length > 44, id)
  }
  for (const capabilities of [undefined, [], ['player', 'export']]) {
    assert.equal(readUiMessage({ type: 'sound', name: 'deal' }, capabilities).type, 'drop')
  }
  const others = ['connected', 'activity_card_deal', 'activity_card_place', 'toString', '', 7]
  for (const name of [...others, null, undefined]) {
    assert.equal(readUiMessage({ type: 'sound', name }, ['sound']).type, 'drop', String(name))
  }
})

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const pngOf = (length) => {
  const data = new Uint8Array(length)
  data.set(PNG.subarray(0, 8))
  return data
}
const readExport = (fields, capabilities = ['export']) =>
  readUiMessage(
    { type: 'export', op: 'save', id: 7, name: 'whiteboard.png', data: PNG, ...fields },
    capabilities
  )

test('an export from a bundle with the capability is read as it is', () => {
  assert.deepEqual(readExport({}), {
    type: 'export',
    op: 'save',
    id: 7,
    name: 'whiteboard.png',
    data: PNG
  })
  assert.equal(readExport({ op: 'share', id: 0 }).op, 'share')
  assert.equal(readExport({ id: 4294967295 }).id, 4294967295)
  for (const name of [
    'whiteboard-2026-11-24-0930.png',
    'a.png',
    'My board 2.png',
    'x'.repeat(96) + '.png'
  ]) {
    assert.equal(readExport({ name }).name, name)
  }
  const most = readExport({ data: pngOf(MAX_EXPORT_BYTES) })
  assert.equal(most.refused, undefined)
  assert.equal(most.data.length, 8 * 1024 * 1024)
})

test('an export without the capability or a valid id is dropped', () => {
  const message = { type: 'export', op: 'save', id: 7, name: 'whiteboard.png', data: PNG }
  for (const read of [
    readUiMessage(message),
    readUiMessage(message, []),
    readUiMessage(message, ['player'])
  ]) {
    assert.equal(read.type, 'drop')
    assert.equal(typeof read.why, 'string')
  }
  for (const id of [-1, 2 ** 32, 1.5, '7', null, undefined]) {
    assert.equal(readExport({ id }).type, 'drop', String(id))
  }
})

test('an export with a valid id that fails a check is refused, so the shell can answer it', () => {
  for (const bad of [
    { op: 'print' },
    { op: undefined },
    { name: 'a/b.png' },
    { name: 'a\\b.png' },
    { name: '../b.png' },
    { name: '.png' },
    { name: '.hidden.png' },
    { name: 'b.PNG' },
    { name: 'b.png.exe' },
    { name: 'b' },
    { name: 'x'.repeat(97) + '.png' },
    { name: 'café.png' },
    { name: 'a\u0000.png' },
    { name: 5 },
    { data: [...PNG] },
    { data: PNG.buffer },
    { data: PNG.subarray(0, 4) },
    { data: new Uint8Array(12) },
    { data: pngOf(MAX_EXPORT_BYTES + 1) }
  ]) {
    const read = readExport(bad)
    const label = JSON.stringify(bad).slice(0, 60)
    assert.deepEqual(Object.keys(read), ['type', 'id', 'refused'], label)
    assert.equal(read.type, 'export', label)
    assert.equal(read.id, 7, label)
    assert.equal(typeof read.refused, 'string', label)
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
// The shared layers each bundle loads, in order. Watch Together has no seats layer and has the
// player; blackjack, poker, Lucky Seven and Uno have the casino cards and no seats layer; the
// whiteboard has the bridge and room only.
const DUEL_LAYERS = ['bridge', 'room', 'seats', 'duel']
const LAYERS = {
  tic_tac_toe: DUEL_LAYERS,
  connect4: DUEL_LAYERS,
  chess: DUEL_LAYERS,
  uno: ['bridge', 'room', 'cards'],
  watch_together: ['bridge', 'room', 'player'],
  blackjack: ['bridge', 'room', 'cards'],
  poker: ['bridge', 'room', 'cards'],
  whiteboard: ['bridge', 'room'],
  lucky_seven: ['bridge', 'room', 'cards']
}
const BUNDLES = Object.keys(LAYERS)
// The shared stylesheets a bundle loads after base.css.
const SHARED_CSS = {
  blackjack: ['casino'],
  poker: ['casino'],
  lucky_seven: ['casino'],
  uno: ['casino']
}
const sharedCss = (id) => SHARED_CSS[id] ?? []
// A bundle's own scripts loaded between the shared layers and main.js: chess's pieces, Watch
// Together's sync, icons and scene, the whiteboard's net layer, icons, stamps, engine, board and
// widgets, Lucky Seven's and Uno's card faces and steps.
const OWN_SCRIPTS = {
  chess: ['pieces.js'],
  uno: ['faces.js', 'steps.js'],
  watch_together: ['sync.js', 'icons.js', 'scene.js'],
  whiteboard: ['net.js', 'icons.js', 'stamps.js', 'engine.js', 'board.js', 'widgets.js'],
  lucky_seven: ['faces.js', 'steps.js']
}
const ownScripts = (id) => OWN_SCRIPTS[id] ?? []
const bundleFiles = (id) => ({
  '../shared/base.css': read(UI, 'shared/base.css'),
  ...Object.fromEntries(
    sharedCss(id).map((name) => [`../shared/${name}.css`, read(UI, `shared/${name}.css`)])
  ),
  ...Object.fromEntries(
    LAYERS[id].map((name) => [`../shared/${name}.js`, read(UI, `shared/${name}.js`)])
  ),
  ...Object.fromEntries(ownScripts(id).map((name) => [name, read(UI, `${id}/${name}`)])),
  'style.css': read(UI, `${id}/style.css`),
  'main.js': read(UI, `${id}/main.js`)
})
// The bundles' own variables, not the client's: the board's gap and fall, Connect 4's discs,
// chess's squares, picker edge and marks, Watch Together's house palette and its layout sizes, the
// casino table's fixed colours and its sizes on the table unit.
const BUNDLE_OWN_VARS = new Set([
  '--loan-chip',
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
  '--card-w',
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
  '--d',
  '--cs-felt',
  '--cs-felt-deep',
  '--cs-felt-line',
  '--cs-rail',
  '--cs-rail-light',
  '--cs-rail-dark',
  '--cs-brass',
  '--cs-gold',
  '--cs-ink',
  '--cs-ink-soft',
  '--cs-plate',
  '--cs-plate-edge',
  '--cs-card',
  '--cs-card-edge',
  '--cs-card-red',
  '--cs-card-black',
  '--cs-back',
  '--cs-back-deep',
  '--cs-win',
  '--cs-lose',
  '--cs-push',
  '--u',
  '--tw',
  '--th',
  '--rail',
  '--chip',
  '--av',
  '--fs-name',
  '--fs-small',
  '--fs-tiny',
  '--felt-radius',
  '--cloth-radius',
  '--line',
  '--c',
  '--ci',
  '--cd',
  '--ring-w',
  '--actions-h',
  '--card-base',
  '--bet-h',
  '--spot-w',
  '--hand-gap',
  '--hand-w',
  '--fan',
  '--step',
  '--n',
  '--r',
  '--k',
  '--s',
  '--hands',
  '--spread',
  '--room',
  '--x',
  '--y',
  '--board-card',
  '--my-card',
  '--pod-w',
  '--bx',
  '--by'
])
// A bundle may instead give all its own variables its prefix, each one it reads set by its
// stylesheet or its scripts: the whiteboard's start with `--wb-`, Lucky Seven's with `--l7-`,
// Uno's with `--uno-`.
const OWN_PREFIXES = { whiteboard: '--wb-', lucky_seven: '--l7-', uno: '--uno-' }
const hasOwnPrefix = (name) => Object.values(OWN_PREFIXES).some((p) => name.startsWith(p))

for (const id of BUNDLES) {
  test(`the ${id} bundle builds into one document with nothing left to fetch`, () => {
    const doc = buildSrcdoc(read(UI, `${id}/index.html`), bundleFiles(id))
    assert.ok(!/<link|<script\s+src/.test(doc))
    assert.equal(doc.match(/<script>/g).length, LAYERS[id].length + ownScripts(id).length + 1)
    // base.css, the shared stylesheets and style.css; a script may carry `<style>` as text (Watch
    // Together's scene markup).
    const inScripts = ownScripts(id)
      .map((name) => read(UI, `${id}/${name}`).split('<style>').length - 1)
      .reduce((a, b) => a + b, 0)
    assert.equal(doc.match(/<style>/g).length, 2 + sharedCss(id).length + inScripts)
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
    .concat(
      Object.values(SHARED_CSS)
        .flat()
        .map((name) => read(UI, `shared/${name}.css`))
    )
    .join('\n')
  const used = new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]))
  for (const name of BUNDLE_OWN_VARS) used.delete(name)
  for (const name of used) if (hasOwnPrefix(name)) used.delete(name)
  assert.deepEqual([...used].sort(), [...THEME_VARS].sort())
  const client = read(STYLES, 'themes.css') + read(STYLES, 'base.css')
  for (const name of THEME_VARS) assert.ok(client.includes(`${name}:`), name)
})

for (const [id, prefix] of Object.entries(OWN_PREFIXES)) {
  test(`every ${prefix} variable the ${id} bundle reads is one it sets`, () => {
    const css = read(UI, `${id}/style.css`)
    const scripts = [...ownScripts(id), 'main.js'].map((name) => read(UI, `${id}/${name}`))
    const name = `${prefix}[a-z0-9-]+`
    const reads = new Set([...css.matchAll(new RegExp(`var\\((${name})`, 'g'))].map((m) => m[1]))
    const sets = new Set([
      ...[...css.matchAll(new RegExp(`(${name})\\s*:`, 'g'))].map((m) => m[1]),
      ...scripts.flatMap((js) => [...js.matchAll(new RegExp(`'(${name})'`, 'g'))].map((m) => m[1]))
    ])
    assert.ok(reads.size > 0)
    assert.deepEqual(
      [...reads].filter((n) => !sets.has(n)),
      []
    )
  })
}
