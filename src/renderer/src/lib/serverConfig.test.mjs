// Where the voice signaling socket gets dialed. A server that runs its SFU as a
// separate process hands out a voice_endpoint alongside every ticket; one that
// does not (the default, and every older server) sends nothing and we stay on
// the API host. Getting this wrong is a voice connection that silently never
// opens, so the fallbacks are worth pinning down.
//   node --test src/renderer/src/lib/serverConfig.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { setServerHost, voiceSocketUrl, wsBase } from './serverConfig.js'

setServerHost('1.2.3.4:3000')

test('no endpoint means the API host, which is the default deployment', () => {
  assert.equal(voiceSocketUrl(undefined), `${wsBase()}/voice`)
  assert.equal(voiceSocketUrl(null), `${wsBase()}/voice`)
  // An older server simply omits the field; a newer one may send it empty.
  assert.equal(voiceSocketUrl(''), `${wsBase()}/voice`)
  assert.equal(voiceSocketUrl('   '), `${wsBase()}/voice`)
})

test('an endpoint sends us to the voice host instead', () => {
  assert.equal(voiceSocketUrl('wss://media.example.com'), 'wss://media.example.com/voice')
  assert.equal(voiceSocketUrl('ws://127.0.0.1:3100'), 'ws://127.0.0.1:3100/voice')
})

test('surrounding space and a trailing slash do not produce a broken URL', () => {
  assert.equal(voiceSocketUrl('  wss://media.example.com/  '), 'wss://media.example.com/voice')
  assert.equal(voiceSocketUrl('wss://media.example.com//'), 'wss://media.example.com/voice')
})

test('anything that is not a bare WebSocket origin falls back to the API host', () => {
  for (const bad of [
    'https://media.example.com', // not a WebSocket scheme
    'media.example.com', // no scheme at all
    'wss://media.example.com/voice', // we append the path ourselves
    'wss://media.example.com/a/b',
    'wss://media.example.com?x=1',
    'wss://media.example.com#frag',
    'wss://', // no host
    42 // not a string
  ]) {
    assert.equal(voiceSocketUrl(bad), `${wsBase()}/voice`, `expected ${bad} to be ignored`)
  }
})
