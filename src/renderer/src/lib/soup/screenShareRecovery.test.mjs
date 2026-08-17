import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SCREEN_RECOVERY_BACKOFF_MS,
  SCREEN_RECOVERY_MAX_ATTEMPTS,
  nextRecoveryDelay,
  screenRecoveryDecision,
  shouldRecoverOnMuteStall
} from './screenShareRecovery.js'

const liveScreenShare = { active: true, type: 'screen', sourceId: 'window:100:0' }

test('a live screen share with a known source recovers', () => {
  assert.equal(screenRecoveryDecision(liveScreenShare), 'recover')
})

test('a stopped or superseded context does nothing', () => {
  assert.equal(screenRecoveryDecision({ ...liveScreenShare, active: false }), 'ignore')
  assert.equal(screenRecoveryDecision({}), 'ignore')
})

test('a recovery already in flight is not re-entered', () => {
  assert.equal(screenRecoveryDecision({ ...liveScreenShare, recovering: true }), 'ignore')
})

test('cameras keep the plain "track ended = share over" contract', () => {
  assert.equal(screenRecoveryDecision({ ...liveScreenShare, type: 'camera' }), 'final-stop')
})

test('a portal share without a source id never re-opens getDisplayMedia', () => {
  // On Wayland, retrying would pop the OS picker dialog unprompted.
  assert.equal(screenRecoveryDecision({ ...liveScreenShare, sourceId: null }), 'final-stop')
  assert.equal(screenRecoveryDecision({ ...liveScreenShare, sourceId: undefined }), 'final-stop')
})

test('the attempt budget is bounded', () => {
  for (let attempts = 0; attempts < SCREEN_RECOVERY_MAX_ATTEMPTS; attempts++) {
    assert.equal(screenRecoveryDecision({ ...liveScreenShare, attempts }), 'recover')
  }
  assert.equal(
    screenRecoveryDecision({ ...liveScreenShare, attempts: SCREEN_RECOVERY_MAX_ATTEMPTS }),
    'final-stop'
  )
  assert.equal(screenRecoveryDecision({ ...liveScreenShare, attempts: 99 }), 'final-stop')
})

test('backoff grows and then runs out with the budget', () => {
  assert.deepEqual(SCREEN_RECOVERY_BACKOFF_MS.length, SCREEN_RECOVERY_MAX_ATTEMPTS)
  assert.deepEqual([0, 1, 2, 3].map(nextRecoveryDelay), [...SCREEN_RECOVERY_BACKOFF_MS, null])
  assert.equal(nextRecoveryDelay(0), 0, 'the first retry is immediate')
})

test('a share that stabilised (attempts reset to 0) can recover again', () => {
  const exhausted = { ...liveScreenShare, attempts: SCREEN_RECOVERY_MAX_ATTEMPTS }
  assert.equal(screenRecoveryDecision(exhausted), 'final-stop')
  assert.equal(screenRecoveryDecision({ ...exhausted, attempts: 0 }), 'recover')
})

test('the mute watchdog only fires for a still-muted, still-live screen share', () => {
  assert.equal(shouldRecoverOnMuteStall({ muted: true, ...liveScreenShare }), true)
  // Track unmuted before the timer ran, so frames came back on their own.
  assert.equal(shouldRecoverOnMuteStall({ muted: false, ...liveScreenShare }), false)
  assert.equal(shouldRecoverOnMuteStall({ ...liveScreenShare }), false)
  assert.equal(shouldRecoverOnMuteStall({ muted: true, ...liveScreenShare, active: false }), false)
  // An exhausted attempt budget leaves the share alone instead of stopping it.
  assert.equal(
    shouldRecoverOnMuteStall({
      muted: true,
      ...liveScreenShare,
      attempts: SCREEN_RECOVERY_MAX_ATTEMPTS
    }),
    false
  )
  assert.equal(shouldRecoverOnMuteStall({ muted: true, ...liveScreenShare, sourceId: null }), false)
})
