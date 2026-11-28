// Desktop notifications in main (osNotifications.js), with a fake Notification class.
//   node --test src/main/osNotifications.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { checkPayload, createOsNotifier } from './osNotifications.js'

// Stands in for Electron's Notification: records what it was made with and what
// was done to it, and emits only what a test tells it to.
function fakeNotificationClass({ supported = true } = {}) {
  const made = []
  class FakeNotification {
    static activationHandler = null
    static isSupported() {
      return supported
    }
    static handleActivation(cb) {
      FakeNotification.activationHandler = cb
    }
    constructor(options) {
      this.options = options
      this.listeners = {}
      this.shown = 0
      this.closed = 0
      made.push(this)
    }
    on(event, cb) {
      ;(this.listeners[event] ||= []).push(cb)
      return this
    }
    emit(event, ...args) {
      for (const cb of this.listeners[event] || []) cb(...args)
    }
    show() {
      this.shown++
    }
    close() {
      this.closed++
    }
  }
  return { FakeNotification, made }
}

function setup({ platform = 'linux', focused = false, supported, testMode = false } = {}) {
  const { FakeNotification, made } = fakeNotificationClass({ supported })
  const activations = []
  const state = { focused }
  const notifier = createOsNotifier({
    Notification: FakeNotification,
    anyWindowFocused: () => state.focused,
    onActivate: (target) => activations.push(target),
    platform,
    icon: '/app/resources/icon.png',
    testMode
  })
  return { notifier, made, activations, state, FakeNotification }
}

const dm = { kind: 'dm', channelId: '42', authorId: '7', server: 'pylon.example:443' }
const popup = (key = 'dm:42', extra = {}) => ({ key, title: 'Alice', body: 'hi', ...extra })

test('a popup is shown only while no Pylon window has focus, unless forced', () => {
  const { notifier, made, state } = setup({ focused: true })
  assert.equal(notifier.show(popup()), 'focused')
  assert.equal(made.length, 0)
  assert.equal(notifier.show(popup('test', { force: true })), 'shown')
  assert.equal(made.length, 1)
  state.focused = false
  assert.equal(notifier.show(popup()), 'shown')
  assert.equal(made.length, 2)
  assert.equal(made[1].shown, 1)
})

test('no notification service: nothing is made', () => {
  const { notifier, made } = setup({ supported: false })
  assert.equal(notifier.supported(), false)
  assert.equal(notifier.show(popup()), 'unsupported')
  assert.equal(made.length, 0)
})

test('the payload is checked at the boundary', () => {
  const { notifier, made } = setup()
  const invalid = [
    null,
    'dm:42',
    [],
    {},
    { title: 'Alice' },
    popup(''),
    popup(42),
    popup('k'.repeat(101)),
    { key: 'dm:42' },
    popup('dm:42', { title: '' }),
    popup('dm:42', { title: 'A'.repeat(121) }),
    popup('dm:42', { body: 5 }),
    popup('dm:42', { force: 'yes' }),
    popup('dm:42', { urgency: 'critical' }),
    popup('dm:42', { target: 'dm' }),
    popup('dm:42', { target: { ...dm, kind: 'server' } }),
    popup('dm:42', { target: { kind: 'dm' } }),
    popup('dm:42', { target: { ...dm, channelId: { id: 42 } } }),
    popup('dm:42', { target: { ...dm, authorId: ['7'] } }),
    popup('dm:42', { target: { ...dm, server: 443 } }),
    popup('dm:42', { target: { ...dm, url: 'https://example.com' } })
  ]
  for (const payload of invalid) {
    assert.equal(notifier.show(payload), 'invalid', JSON.stringify(payload))
  }
  assert.equal(made.length, 0)

  // The limits themselves pass; a title counts an emoji as one character.
  assert.equal(notifier.show(popup('k'.repeat(100), { title: 'A'.repeat(120) })), 'shown')
  assert.equal(notifier.show(popup('emoji', { title: '👍🏽'.repeat(120) })), 'shown')
  assert.equal(notifier.show(popup('no-body', { body: undefined })), 'shown')
  assert.equal(notifier.show(popup('null-body', { body: null })), 'shown')
  assert.equal(made.at(-1).options.body, '')
  assert.equal(
    notifier.show(popup('channel', { target: { kind: 'channel', channelId: 9 } })),
    'shown'
  )
})

test('the body is trimmed and cut to 300 characters', () => {
  assert.equal(checkPayload(popup('k', { body: '  hello  ' })).body, 'hello')
  assert.equal(checkPayload(popup('k', { body: 'x'.repeat(400) })).body.length, 300)
  assert.equal(checkPayload(popup('k')).target, null)
  assert.deepEqual(checkPayload(popup('k', { target: dm })).target, dm)
})

test('options are silent and never ask to break through Do Not Disturb', () => {
  const forbidden = ['urgency', 'toastXml', 'timeoutType', 'actions', 'hasReply', 'sound']
  for (const platform of ['linux', 'win32', 'darwin']) {
    const { notifier, made } = setup({ platform })
    notifier.show(popup('dm:42', { target: dm }))
    notifier.show(popup('test', { force: true }))
    for (const n of made) {
      assert.equal(n.options.silent, true, platform)
      for (const field of forbidden) assert.equal(field in n.options, false, `${platform} ${field}`)
      assert.equal(n.options.title, 'Alice')
      assert.equal(n.options.body, 'hi')
    }
  }
})

test('Linux: the icon is set, there is no id, and a same-key popup closes the old one', () => {
  const { notifier, made } = setup({ platform: 'linux' })
  notifier.show(popup())
  assert.equal(made[0].options.icon, '/app/resources/icon.png')
  assert.equal('id' in made[0].options, false)
  notifier.show(popup('dm:42', { body: 'second' }))
  assert.equal(made[0].closed, 1)
  assert.equal(made[1].closed, 0)
  // The old one is gone from the map: closing the key closes only the new one.
  notifier.close('dm:42')
  assert.equal(made[0].closed, 1)
  assert.equal(made[1].closed, 1)
})

test('Windows and macOS: the id replaces in place, the old one is not closed, no icon', () => {
  for (const platform of ['win32', 'darwin']) {
    const { notifier, made } = setup({ platform })
    notifier.show(popup())
    notifier.show(popup('dm:42', { body: 'second' }))
    assert.equal(made[0].options.id, 'pylon-dm:42', platform)
    assert.equal(made[1].options.id, 'pylon-dm:42', platform)
    assert.equal('icon' in made[0].options, false, platform)
    assert.equal(made[0].closed, 0, platform)
    // A late event from the replaced one leaves the new one referenced.
    made[0].emit('close')
    notifier.close('dm:42')
    assert.equal(made[1].closed, 1, platform)
  }
})

test('a click activates with the target and drops the reference', () => {
  const { notifier, made, activations } = setup()
  notifier.show(popup('dm:42', { target: dm }))
  notifier.show(popup('server:connection'))
  made[0].emit('click')
  made[1].emit('click')
  assert.deepEqual(activations, [dm, null])
  notifier.close('dm:42')
  notifier.close('server:connection')
  assert.equal(made[0].closed, 0)
  assert.equal(made[1].closed, 0)
})

test('close and failed events drop the reference', () => {
  const { notifier, made } = setup()
  notifier.show(popup('a'))
  notifier.show(popup('b'))
  made[0].emit('close')
  made[1].emit('failed', {}, 'no service')
  notifier.close('a')
  notifier.close('b')
  assert.equal(made[0].closed, 0)
  assert.equal(made[1].closed, 0)
})

test('our own close drops the reference though no close event ever comes (Linux)', () => {
  const { notifier, made } = setup({ platform: 'linux' })
  notifier.show(popup())
  notifier.close('dm:42')
  assert.equal(made[0].closed, 1)
  // The fake never emitted 'close', yet the key is free: a second close does nothing,
  // and a new popup on the key does not close the old one again.
  notifier.close('dm:42')
  assert.equal(made[0].closed, 1)
  notifier.show(popup())
  assert.equal(made[0].closed, 1)
  notifier.closeAll()
  assert.equal(made[1].closed, 1)
  notifier.closeAll()
  assert.equal(made[1].closed, 1)
})

test('at most 50 are referenced; the oldest is dropped without being closed', () => {
  const { notifier, made } = setup()
  for (let i = 0; i < 51; i++) notifier.show(popup(`k${i}`))
  assert.equal(made[0].closed, 0)
  notifier.close('k0')
  assert.equal(made[0].closed, 0)
  notifier.close('k1')
  assert.equal(made[1].closed, 1)
  notifier.closeAll()
  assert.equal(
    made.slice(2).every((n) => n.closed === 1),
    true
  )
})

test('a replaced key counts as the newest', () => {
  const { notifier, made } = setup({ platform: 'win32' })
  for (let i = 0; i < 50; i++) notifier.show(popup(`k${i}`))
  notifier.show(popup('k0'))
  notifier.show(popup('k50'))
  // k1 was the oldest by then, so it went; k0's replacement is still referenced.
  notifier.close('k1')
  assert.equal(made[1].closed, 0)
  notifier.close('k0')
  assert.equal(made[50].closed, 1)
})

test('Windows: an activation after the object is gone only brings Pylon forward', () => {
  const { activations, FakeNotification } = setup({ platform: 'win32' })
  assert.equal(typeof FakeNotification.activationHandler, 'function')
  FakeNotification.activationHandler({ arguments: '' })
  assert.deepEqual(activations, [null])
  assert.equal(setup({ platform: 'linux' }).FakeNotification.activationHandler, null)
})

test('test mode records popups and shows nothing', () => {
  const { notifier, made, state } = setup({ testMode: true, supported: false, focused: true })
  assert.equal(notifier.supported(), true)
  assert.equal(notifier.show(popup('dm:42', { target: dm })), 'focused')
  notifier.setAssumeUnfocused(true)
  assert.equal(notifier.show(popup('dm:42', { target: dm })), 'recorded')
  assert.equal(notifier.show(popup('test', { force: true })), 'recorded')
  assert.equal(notifier.show({ key: 'bad' }), 'invalid')
  notifier.setAssumeUnfocused(false)
  state.focused = false
  assert.equal(notifier.show(popup('call:5', { body: '' })), 'recorded')
  assert.equal(made.length, 0)
  const records = notifier.recorded()
  assert.deepEqual(records, [
    { key: 'dm:42', title: 'Alice', body: 'hi', target: dm, force: false },
    { key: 'test', title: 'Alice', body: 'hi', target: null, force: true },
    { key: 'call:5', title: 'Alice', body: '', target: null, force: false }
  ])
  // A copy: changing it leaves the record alone.
  records[0].target.channelId = 'x'
  assert.equal(notifier.recorded()[0].target.channelId, '42')
  notifier.close('dm:42')
  notifier.closeAll()
})

test('test mode records a close only for a recorded popup still up', () => {
  const { notifier, made } = setup({ testMode: true })
  notifier.close('dm:42')
  assert.deepEqual(notifier.recorded(), [], 'nothing shown, nothing closed')
  notifier.show(popup('dm:42', { target: dm }))
  notifier.show(popup('call:5'))
  notifier.show(popup('roles'))
  notifier.close('dm:42')
  notifier.close('dm:42')
  notifier.close('mention:42')
  notifier.closeAll()
  notifier.show(popup('dm:42'))
  assert.deepEqual(
    notifier.recorded().map((r) => (r.closed ? `close ${r.key}` : r.key)),
    ['dm:42', 'call:5', 'roles', 'close dm:42', 'close call:5', 'close roles', 'dm:42']
  )
  assert.deepEqual(notifier.recorded()[3], { key: 'dm:42', closed: true })
  assert.equal(made.length, 0)
})

test('outside test mode there are no test controls', () => {
  const { notifier } = setup()
  assert.equal('recorded' in notifier, false)
  assert.equal('setAssumeUnfocused' in notifier, false)
})
