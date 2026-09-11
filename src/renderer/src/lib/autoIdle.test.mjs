import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createAutoIdleController,
  DEFAULT_AUTO_IDLE_SETTINGS,
  normalizeAutoIdleSettings
} from './autoIdle.js'

function setup(settings = DEFAULT_AUTO_IDLE_SETTINGS) {
  const controller = createAutoIdleController()
  const sent = []
  const tick = (status, idleSeconds, extra = {}) =>
    controller.tick({
      status,
      idleSeconds,
      settings,
      now: 0,
      send: (patch) => {
        sent.push(patch)
        return true
      },
      ...extra
    })
  return { controller, sent, tick }
}

test('new and malformed settings use the enabled 15-minute default', () => {
  for (const saved of [
    undefined,
    null,
    {},
    { minutes: 0 },
    { minutes: -1 },
    { minutes: 1.5 },
    { minutes: '15' },
    { minutes: Infinity },
    { minutes: 1441 }
  ]) {
    assert.deepEqual(normalizeAutoIdleSettings(saved), { enabled: true, minutes: 15 })
  }
  assert.deepEqual(normalizeAutoIdleSettings({ enabled: false, minutes: 90 }), {
    enabled: false,
    minutes: 90
  })
})

test('goes Away at 15 minutes of system inactivity and restores Online on activity', () => {
  const { tick, sent } = setup()
  tick('online', 899)
  assert.deepEqual(sent, [])
  tick('online', 900)
  tick('online', 905) // Still waiting for the server echo: no duplicate send.
  tick('away', 910)
  tick('away', 0)
  tick('away', 1) // Wait for the Online echo too.
  tick('online', 2)
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'online' }])
})

test('custom thresholds and disabling apply without restarting', () => {
  const { tick, sent } = setup({ enabled: true, minutes: 2 })
  tick('online', 119)
  assert.deepEqual(sent, [])
  tick('online', 120)
  tick('away', 121)
  tick('away', 121, { settings: { enabled: false, minutes: 2 } })
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'online' }])

  const disabled = setup({ enabled: false, minutes: 15 })
  disabled.tick('online', 10000)
  disabled.tick('away', 0)
  assert.deepEqual(disabled.sent, [])
})

test('increasing the threshold restores an automatically Away user', () => {
  const { tick, sent } = setup()
  tick('online', 900)
  tick('away', 901, { settings: { enabled: true, minutes: 30 } })
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'online' }])
})

test('manual Away, DND, Invisible and absent presence are never changed', () => {
  for (const status of ['away', 'do_not_disturb', 'offline', undefined]) {
    const { tick, sent } = setup()
    tick(status, 10000)
    tick(status, 0)
    assert.deepEqual(sent, [], status)
  }
})

test('selecting Away manually while auto-away cancels automatic restoration', () => {
  const { controller, tick, sent } = setup()
  tick('online', 900)
  tick('away', 901)
  controller.manualStatusSelected()
  tick('away', 0)
  assert.deepEqual(sent, [{ status: 'away' }])
})

test('a manual choice wins even while an automatic update is awaiting its echo', () => {
  const { controller, tick, sent } = setup()
  tick('online', 900)
  controller.manualStatusSelected()
  tick('online', 901) // A sample taken before the manual click.
  tick('away', 0) // Late echo cannot claim manual Away.
  assert.deepEqual(sent, [{ status: 'away' }])
  tick('online', 0)
  tick('online', 900)
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'away' }])
})

test('a different status from another device cancels auto-away ownership', () => {
  for (const acknowledgeFirst of [false, true]) {
    const { tick, sent } = setup()
    tick('online', 900)
    if (acknowledgeFirst) tick('away', 901)
    tick('do_not_disturb', 902)
    tick('do_not_disturb', 0)
    assert.deepEqual(sent, [{ status: 'away' }])
  }
})

test('returning to activity before the Away echo still restores Online', () => {
  const { tick, sent } = setup()
  tick('online', 900)
  tick('online', 0, { now: 20000 })
  tick('away', 1, { now: 25000 })
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'online' }])
})

test('another device going Online is respected until a new local idle period', () => {
  const { tick, sent } = setup()
  tick('online', 900)
  tick('away', 901)
  tick('online', 902)
  tick('online', 1000)
  assert.deepEqual(sent, [{ status: 'away' }])
  tick('online', 0)
  tick('online', 900)
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'away' }])
})

test('failed sends can be retried and missing echoes are rate limited', () => {
  const { tick, sent } = setup()
  tick('online', 900, { send: () => false })
  tick('away', 0)
  assert.deepEqual(sent, []) // A failed send did not take ownership of Away.
  tick('online', 900)
  tick('online', 910, { now: 10000 })
  assert.equal(sent.length, 1)
  tick('online', 915, { now: 15000 })
  assert.equal(sent.length, 2)
  tick('away', 0, { now: 20000 })
  assert.deepEqual(sent.at(-1), { status: 'online' })
})

test('invalid readings do not produce presence changes', () => {
  const { tick, sent } = setup()
  for (const idle of [undefined, null, NaN, Infinity, -1, '900']) tick('online', idle)
  assert.deepEqual(sent, [])
})

test('session reset prevents auto-away ownership leaking to a new server/account', () => {
  const { controller, tick, sent } = setup()
  tick('online', 900)
  tick('away', 901)
  controller.reset()
  tick('away', 0)
  assert.deepEqual(sent, [{ status: 'away' }])
})

test('activity while disconnected is reconciled on the next successful connection', () => {
  const { tick, sent } = setup()
  tick('online', 900)
  tick('away', 901)
  tick('away', 0, { send: () => false })
  tick('away', 5)
  assert.deepEqual(sent, [{ status: 'away' }, { status: 'online' }])
})
