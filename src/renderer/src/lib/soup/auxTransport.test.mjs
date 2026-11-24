// Helpers for the native screen share's own send transport.
//   node --test src/renderer/src/lib/soup/auxTransport.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { engineDtlsParameters } from './auxTransport.js'

const FINGERPRINT = Array.from({ length: 32 }, (_, i) =>
  i.toString(16).padStart(2, '0').toUpperCase()
).join(':')

test('the engine DTLS parameters the node can parse go through, and only their fields', () => {
  const dtls = {
    role: 'client',
    fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT, extra: 1 }],
    extra: true
  }
  assert.deepEqual(engineDtlsParameters(dtls), {
    role: 'client',
    fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT }]
  })
  assert.deepEqual(
    engineDtlsParameters({
      role: 'client',
      fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT.toLowerCase() }]
    }).fingerprints.length,
    1
  )
})

test('badly formed engine DTLS parameters are refused', () => {
  const good = { algorithm: 'sha-256', value: FINGERPRINT }
  const bad = [
    null,
    undefined,
    'client',
    {},
    { role: 'server', fingerprints: [good] },
    { role: 'auto', fingerprints: [good] },
    { role: 'client' },
    { role: 'client', fingerprints: [] },
    { role: 'client', fingerprints: {} },
    { role: 'client', fingerprints: [null] },
    { role: 'client', fingerprints: [{ algorithm: 'sha-1', value: FINGERPRINT }] },
    { role: 'client', fingerprints: [{ algorithm: 'SHA-256', value: FINGERPRINT }] },
    { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT.slice(3) }] },
    { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: `${FINGERPRINT}:00` }] },
    {
      role: 'client',
      fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT.replace(/:/g, '') }]
    },
    { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: `${FINGERPRINT}\n` }] },
    {
      role: 'client',
      fingerprints: [{ algorithm: 'sha-256', value: FINGERPRINT.replace('00', 'G0') }]
    },
    { role: 'client', fingerprints: [{ algorithm: 'sha-256', value: 32 }] },
    { role: 'client', fingerprints: [good, { algorithm: 'sha-512', value: FINGERPRINT }] }
  ]
  for (const dtls of bad) {
    assert.throws(() => engineDtlsParameters(dtls), Error, JSON.stringify(dtls))
  }
})
