// The desktop-notification gate (osNotifications.js) and the rows it reads (sounds.js).
//   node --test src/renderer/src/lib/osNotifications.test.mjs
//
// sounds.js lists its soundpack files with Vite's import.meta.glob, which plain node
// lacks. This file's loader hook swaps that one call for globalThis.__soundsGlob, set
// below to two small fake packs, so the real modules load unchanged.
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'

registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (!url.endsWith('/renderer/src/lib/sounds.js')) return result
    const source = String(result.source).replace('import.meta.glob(', 'globalThis.__soundsGlob(')
    return { ...result, format: 'module', source }
  }
})

globalThis.__soundsGlob = () => ({
  '../assets/soundpacks/default/connected.wav': 'default/connected.wav',
  '../assets/soundpacks/default/chat_message_inbound.wav': 'default/chat_message_inbound.wav',
  // A file named like a no-sound row: it must still never play.
  '../assets/soundpacks/default/dm_received.wav': 'default/dm_received.wav',
  '../assets/soundpacks/small/connected.wav': 'small/connected.wav'
})

// Counts what playUiSound would play.
const played = []
globalThis.Audio = class {
  constructor(url) {
    this.url = url
  }
  play() {
    played.push(this.url)
    return Promise.resolve()
  }
}

const sounds = await import('./sounds.js')
const os = await import('./osNotifications.js')
const {
  OS_DEFAULTS,
  OS_ROWS,
  SOUND_SECTIONS,
  isSoundsDeafened,
  playUiSound,
  sectionSounds,
  setSoundStateMap,
  setSoundsDeafened,
  soundStateOf
} = sounds
const {
  closeOsNotification,
  notifyOs,
  onOsNotificationActivate,
  osNotifyDecision,
  osNotifySupported,
  osRowOn,
  sendTestOsNotification,
  setOsNotifyDnd,
  setOsNotifyPrefs,
  setOsNotifyServer
} = os

// The preload bridge, as main would answer it.
const bridge = {
  supported: true,
  shown: [],
  closed: [],
  listeners: [],
  isSupported: async () => bridge.supported,
  show: async (payload) => {
    bridge.shown.push(payload)
    return 'shown'
  },
  close: (key) => bridge.closed.push(key),
  onActivate: (cb) => {
    bridge.listeners.push(cb)
    return () => bridge.listeners.splice(bridge.listeners.indexOf(cb), 1)
  }
}
globalThis.window = { api: { notifications: bridge } }
await osNotifySupported()

function reset() {
  bridge.shown.length = 0
  bridge.closed.length = 0
  setOsNotifyPrefs({ enabled: true, rows: {} })
  setOsNotifyDnd(false)
  setOsNotifyServer(null)
  setSoundStateMap({})
  setSoundsDeafened(false)
}

const allowed = {
  supported: true,
  masterOn: true,
  rowOs: true,
  rowState: 'on',
  deafened: false,
  dnd: false
}

// ─── The rows (sounds.js) ─────────────────────────────────────────

test('the rows that can pop up and their defaults match the plan (D4)', () => {
  assert.deepEqual(OS_DEFAULTS, {
    connection_lost: false,
    dm_received: true,
    mentioned: true,
    call_ringing: true,
    neutral_switched_tocurrentchannel: false,
    servergroup_assigned: false,
    servergroup_revoked: false,
    you_kicked_server: false,
    you_were_banned: false,
    you_were_poked: true,
    stream_started: false
  })
  assert.deepEqual(new Set(Object.keys(OS_DEFAULTS)), OS_ROWS)
})

test('a poke is Pinned by default, so it chimes and pops up while deafened; a saved choice wins', () => {
  setSoundStateMap({})
  assert.equal(soundStateOf('you_were_poked'), 'pin')
  const gate = (rowState) =>
    osNotifyDecision({
      supported: true,
      masterOn: true,
      rowOs: true,
      rowState,
      deafened: true,
      dnd: false
    })
  assert.equal(gate(soundStateOf('you_were_poked')), 'ok')
  setSoundStateMap({ you_were_poked: 'on' })
  assert.equal(soundStateOf('you_were_poked'), 'on')
  assert.equal(gate(soundStateOf('you_were_poked')), 'deafened')
  setSoundStateMap({})
})

test('the three new rows sit in Messaging with no sound and a popup on by default', () => {
  const messaging = SOUND_SECTIONS.find((section) => section.id === 'messaging')
  for (const [id, label] of [
    ['dm_received', 'Direct message'],
    ['mentioned', 'You were mentioned'],
    ['call_ringing', 'Incoming call']
  ]) {
    const row = messaging.sounds.find((s) => s.id === id)
    assert.deepEqual(row, { id, label, noSound: true, os: 'on' })
  }
  const noSound = SOUND_SECTIONS.flatMap((section) => section.sounds).filter((s) => s.noSound)
  assert.deepEqual(
    noSound.map((s) => s.id),
    ['dm_received', 'mentioned', 'call_ringing']
  )
})

test('rows with no sound always show; other rows only with a file in the pack', () => {
  const messaging = SOUND_SECTIONS.find((section) => section.id === 'messaging')
  const connections = SOUND_SECTIONS.find((section) => section.id === 'connections')
  assert.deepEqual(
    sectionSounds('small', messaging).map((s) => [s.id, s.filename]),
    [
      ['dm_received', null],
      ['mentioned', null],
      ['call_ringing', null]
    ]
  )
  assert.deepEqual(
    sectionSounds('default', messaging).map((s) => [s.id, s.filename]),
    [
      ['chat_message_inbound', 'chat_message_inbound.wav'],
      ['dm_received', null],
      ['mentioned', null],
      ['call_ringing', null]
    ]
  )
  assert.deepEqual(
    sectionSounds('small', connections).map((s) => s.id),
    ['connected']
  )
  assert.deepEqual(sectionSounds('missing-pack', connections), [])
})

test('a row with no sound never plays, even with a file by its name', () => {
  reset()
  played.length = 0
  playUiSound('dm_received', undefined, true)
  playUiSound('dm_received')
  playUiSound('mentioned', undefined, true)
  playUiSound('connected', undefined, true)
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.deepEqual(played, ['default/connected.wav'])
  })
})

test('the getters read the same state the chimes use', () => {
  reset()
  assert.equal(soundStateOf('dm_received'), 'on')
  assert.equal(soundStateOf('mic_muted'), 'pin')
  setSoundStateMap({ dm_received: 'off', mic_muted: 'on' })
  assert.equal(soundStateOf('dm_received'), 'off')
  assert.equal(soundStateOf('mic_muted'), 'on')
  assert.equal(isSoundsDeafened(), false)
  setSoundsDeafened(true)
  assert.equal(isSoundsDeafened(), true)
  reset()
})

test('a row toggle falls back to its default; rows without one are never on', () => {
  assert.equal(osRowOn({}, 'dm_received'), true)
  assert.equal(osRowOn({}, 'stream_started'), false)
  assert.equal(osRowOn({ dm_received: false, stream_started: true }, 'dm_received'), false)
  assert.equal(osRowOn({ stream_started: true }, 'stream_started'), true)
  assert.equal(osRowOn({ dm_received: 'nope' }, 'dm_received'), true)
  assert.equal(osRowOn({ chat_message_inbound: true }, 'chat_message_inbound'), false)
  assert.equal(osRowOn(undefined, 'mentioned'), true)
})

// ─── The gate ─────────────────────────────────────────────────────

test('the decision table', () => {
  const cases = [
    [{}, 'ok'],
    [{ supported: false }, 'unsupported'],
    [{ masterOn: false }, 'master-off'],
    [{ rowOs: false }, 'row-os-off'],
    [{ rowState: 'off' }, 'row-off'],
    [{ rowState: 'on' }, 'ok'],
    [{ rowState: 'pin' }, 'ok'],
    // Deafen: Off stays off, Enabled is held back, Pinned gets through (D1).
    [{ rowState: 'off', deafened: true }, 'row-off'],
    [{ rowState: 'on', deafened: true }, 'deafened'],
    [{ rowState: 'pin', deafened: true }, 'ok'],
    // Pylon's Do Not Disturb beats Pinned (D2).
    [{ rowState: 'on', dnd: true }, 'dnd'],
    [{ rowState: 'pin', dnd: true }, 'dnd'],
    [{ rowState: 'pin', dnd: true, deafened: true }, 'dnd'],
    [{ rowState: 'off', dnd: true }, 'row-off']
  ]
  for (const [change, expected] of cases) {
    assert.equal(osNotifyDecision({ ...allowed, ...change }), expected, JSON.stringify(change))
  }
})

test('the gate checks in order: support, master, row toggle, row state, DND, deafen', () => {
  const everythingOff = {
    supported: false,
    masterOn: false,
    rowOs: false,
    rowState: 'off',
    deafened: true,
    dnd: true
  }
  const order = ['unsupported', 'master-off', 'row-os-off', 'row-off', 'dnd', 'deafened', 'ok']
  const fixes = [
    { supported: true },
    { masterOn: true },
    { rowOs: true },
    { rowState: 'on' },
    { dnd: false },
    { deafened: false }
  ]
  let input = everythingOff
  for (let i = 0; i < order.length; i++) {
    assert.equal(osNotifyDecision(input), order[i])
    input = { ...input, ...fixes[i] }
  }
})

// ─── notifyOs ─────────────────────────────────────────────────────

const dm = { kind: 'dm', channelId: '42', authorId: '7' }

test('notifyOs asks main to show only when the gate says ok, with the server in the target', () => {
  reset()
  setOsNotifyServer('pylon.example:443')
  assert.equal(
    notifyOs('dm_received', { key: 'dm:42', title: 'Alice', body: 'hi', target: dm }),
    'ok'
  )
  assert.deepEqual(bridge.shown, [
    {
      key: 'dm:42',
      title: 'Alice',
      body: 'hi',
      target: { ...dm, server: 'pylon.example:443' }
    }
  ])
  // No target: none is sent.
  setOsNotifyPrefs({ enabled: true, rows: { connection_lost: true } })
  assert.equal(
    notifyOs('connection_lost', { key: 'server:connection', title: 'Connection lost' }),
    'ok'
  )
  assert.deepEqual(bridge.shown[1], {
    key: 'server:connection',
    title: 'Connection lost',
    body: undefined
  })
})

test('notifyOs reads the master switch, the row toggle and default, the row state, DND and deafen', () => {
  const popup = { key: 'dm:42', title: 'Alice', body: 'hi', target: dm }
  const blocked = [
    [() => setOsNotifyPrefs({ enabled: false, rows: {} }), 'dm_received', 'master-off'],
    [
      () => setOsNotifyPrefs({ enabled: true, rows: { dm_received: false } }),
      'dm_received',
      'row-os-off'
    ],
    [() => {}, 'stream_started', 'row-os-off'],
    [() => {}, 'chat_message_inbound', 'row-os-off'],
    [() => setSoundStateMap({ dm_received: 'off' }), 'dm_received', 'row-off'],
    [() => setOsNotifyDnd(true), 'dm_received', 'dnd'],
    [
      () => {
        setSoundStateMap({ dm_received: 'pin' })
        setOsNotifyDnd(true)
      },
      'dm_received',
      'dnd'
    ],
    [() => setSoundsDeafened(true), 'dm_received', 'deafened']
  ]
  for (const [arrange, row, expected] of blocked) {
    reset()
    arrange()
    assert.equal(notifyOs(row, popup), expected, `${row} ${expected}`)
    assert.equal(bridge.shown.length, 0, `${row} ${expected}`)
  }

  reset()
  setSoundsDeafened(true)
  setSoundStateMap({ dm_received: 'pin' })
  assert.equal(notifyOs('dm_received', popup), 'ok')
  reset()
  setOsNotifyPrefs({ enabled: true, rows: { stream_started: true } })
  assert.equal(
    notifyOs('stream_started', { key: 'stream:3', title: 'Bob started streaming' }),
    'ok'
  )
  assert.equal(bridge.shown.length, 1)
})

test('without a notification service, or without the bridge, nothing is asked', async () => {
  reset()
  const saved = globalThis.window
  globalThis.window = {}
  assert.equal(notifyOs('dm_received', { key: 'dm:1', title: 'A', target: dm }), 'unsupported')
  assert.equal(await osNotifySupported(), false)
  assert.equal(await sendTestOsNotification(), 'unsupported')
  closeOsNotification('dm:1')
  const off = onOsNotificationActivate(() => {})
  off()
  globalThis.window = saved
  assert.equal(bridge.shown.length, 0)
  assert.equal(bridge.closed.length, 0)
})

test('close and activate go through the bridge', () => {
  reset()
  closeOsNotification('dm:42')
  assert.deepEqual(bridge.closed, ['dm:42'])
  const seen = []
  const off = onOsNotificationActivate((target) => seen.push(target))
  bridge.listeners.forEach((cb) => cb({ ...dm, server: 'x' }))
  off()
  bridge.listeners.forEach((cb) => cb(null))
  assert.deepEqual(seen, [{ ...dm, server: 'x' }])
})

test('Send test skips the row gates and the focus rule', async () => {
  reset()
  setSoundsDeafened(true)
  setSoundStateMap({ dm_received: 'off' })
  assert.equal(await sendTestOsNotification(), 'shown')
  assert.equal(bridge.shown.length, 1)
  assert.equal(bridge.shown[0].key, 'test')
  assert.equal(bridge.shown[0].force, true)
  assert.equal(typeof bridge.shown[0].title, 'string')
  assert.equal('target' in bridge.shown[0], false)
  // The master switch and Pylon's Do Not Disturb still apply.
  setOsNotifyPrefs({ enabled: false, rows: {} })
  assert.equal(await sendTestOsNotification(), 'master-off')
  setOsNotifyPrefs({ enabled: true, rows: {} })
  setOsNotifyDnd(true)
  assert.equal(await sendTestOsNotification(), 'dnd')
  assert.equal(bridge.shown.length, 1)
})
