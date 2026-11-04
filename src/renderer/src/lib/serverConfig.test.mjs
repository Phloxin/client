// Where the voice signaling socket gets dialed. /voice only exists on the voice
// node, whose origin arrives with every ticket as voice_endpoint. A server that
// sends none has no reachable voice plane, so there is deliberately no API-host
// fallback any more. Getting this wrong is a voice connection that silently
// never opens, so the edges are worth pinning down.
//   node --test src/renderer/src/lib/serverConfig.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { setServerHost, voiceSocketUrl } from './serverConfig.js'

setServerHost('1.2.3.4:3000')

test('no endpoint means voice is unavailable', () => {
  assert.equal(voiceSocketUrl(undefined), null)
  assert.equal(voiceSocketUrl(null), null)
  assert.equal(voiceSocketUrl(''), null)
  assert.equal(voiceSocketUrl('   '), null)
})

test('an endpoint is dialed with the protocol version', () => {
  assert.equal(voiceSocketUrl('wss://media.example.com'), 'wss://media.example.com/voice?v=1')
  assert.equal(voiceSocketUrl('ws://127.0.0.1:3100'), 'ws://127.0.0.1:3100/voice?v=1')
})

test('surrounding space and a trailing slash do not produce a broken URL', () => {
  assert.equal(voiceSocketUrl('  wss://media.example.com/  '), 'wss://media.example.com/voice?v=1')
  assert.equal(voiceSocketUrl('wss://media.example.com//'), 'wss://media.example.com/voice?v=1')
})

test('anything that is not a bare WebSocket origin is unusable', () => {
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
    assert.equal(voiceSocketUrl(bad), null, `expected ${bad} to be ignored`)
  }
})

test('a dev override wins over the server endpoint', () => {
  globalThis.window = { api: { voiceEndpointOverride: 'ws://localhost:4100' } }
  try {
    assert.equal(voiceSocketUrl('wss://media.example.com'), 'ws://localhost:4100/voice?v=1')
    assert.equal(voiceSocketUrl(undefined), 'ws://localhost:4100/voice?v=1')
  } finally {
    delete globalThis.window
  }
})
