import assert from 'node:assert/strict'
import test from 'node:test'

import { formatResetCode, inviteLink, normalizeCode, parseInviteInput } from './invite.js'

test('normalizeCode uppercases and strips dashes, spaces and tabs', () => {
  assert.equal(normalizeCode('abcde-fghjk'), 'ABCDEFGHJK')
  assert.equal(normalizeCode(' ab cd\tef '), 'ABCDEF')
})

test('normalizeCode rejects symbols outside the alphabet and empty input', () => {
  for (const text of ['ABC0', 'ABCO', 'ABC1', 'ABCI', 'ABCL', 'abc!', 'straße', '', ' - ', null]) {
    assert.equal(normalizeCode(text), null, String(text))
  }
})

test('parseInviteInput accepts a bare code', () => {
  assert.deepEqual(parseInviteInput('  abcde-fghjk '), { code: 'ABCDEFGHJK' })
  assert.equal(parseInviteInput('not a code'), null)
})

test('parseInviteInput reads host and code from a pylon://join link', () => {
  assert.deepEqual(parseInviteInput('pylon://join?host=1.2.3.4%3A3000&code=abcdefghjk'), {
    host: '1.2.3.4:3000',
    code: 'ABCDEFGHJK'
  })
  assert.deepEqual(parseInviteInput('pylon://join?code=ABCDEFGHJK'), { code: 'ABCDEFGHJK' })
})

test('parseInviteInput rejects other links and links without a valid code', () => {
  for (const text of [
    'pylon://other?host=h&code=ABCDEFGHJK',
    'pylon://join?host=h',
    'pylon://join?host=h&code=0000',
    'https://join?host=h&code=ABCDEFGHJK',
    'pylon://'
  ]) {
    assert.equal(parseInviteInput(text), null, text)
  }
})

test('inviteLink round-trips through parseInviteInput', () => {
  const link = inviteLink('chat.example.com:3000', 'ABCDEFGHJK')
  assert.ok(link.startsWith('pylon://join?'))
  assert.deepEqual(parseInviteInput(link), { host: 'chat.example.com:3000', code: 'ABCDEFGHJK' })
})

test('formatResetCode groups by four', () => {
  assert.equal(formatResetCode('abcdefgh2345'), 'ABCD-EFGH-2345')
  assert.equal(formatResetCode('ABCD-EFGH-2345'), 'ABCD-EFGH-2345')
})
