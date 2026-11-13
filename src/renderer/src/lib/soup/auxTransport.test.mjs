// SendAux helpers for the native screen share.
//   node --test src/renderer/src/lib/soup/auxTransport.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import { engineDtlsParameters, requestAuxTransport } from './auxTransport.js'
import { VoiceRequestError, createRequestMatcher, decodeMessage } from './protocol.js'

const PARAMETERS = { id: 't2', ice_parameters: {}, ice_candidates: [], dtls_parameters: {} }

// The real matcher, with the node's answers given per message type, in order.
function nodeHarness(answers) {
  const sent = []
  let matcher = null
  matcher = createRequestMatcher({
    transmit: (frame) => {
      const message = JSON.parse(frame)
      sent.push(message)
      const [type] = Object.keys(message)
      const answer = answers[type]?.shift()
      if (answer) queueMicrotask(() => matcher.handle(decodeMessage(JSON.stringify(answer))))
    },
    onTimeout: () => {},
    onProtocolError: (err) => {
      throw err
    },
    setTimer: () => ({}),
    clearTimer: () => {}
  })
  return { request: (message) => matcher.request(message), sent, matcher }
}

const exists = {
  Error: {
    object: { Transport: 'SendAux' },
    code: 'InvalidState',
    message: 'transport already exists'
  }
}

test('SendAux is asked for once when the node makes it', async () => {
  const { request, sent } = nodeHarness({
    CreateTransport: [{ Transport: { direction: 'SendAux', parameters: PARAMETERS } }]
  })
  const answer = await requestAuxTransport(request)
  assert.deepEqual(answer.parameters, PARAMETERS)
  assert.deepEqual(sent, [{ CreateTransport: { direction: 'SendAux' } }])
})

test('a SendAux left open on the node is closed and asked for once more', async () => {
  const { request, sent, matcher } = nodeHarness({
    CreateTransport: [exists, { Transport: { direction: 'SendAux', parameters: PARAMETERS } }],
    CloseTransport: [{ TransportClosed: { direction: 'SendAux' } }]
  })
  const answer = await requestAuxTransport(request)
  assert.deepEqual(answer.parameters, PARAMETERS)
  assert.deepEqual(sent, [
    { CreateTransport: { direction: 'SendAux' } },
    { CloseTransport: { direction: 'SendAux' } },
    { CreateTransport: { direction: 'SendAux' } }
  ])
  assert.equal(matcher.size, 0)
})

test('a close that finds no transport still asks once more', async () => {
  const { request, sent } = nodeHarness({
    CreateTransport: [exists, { Transport: { direction: 'SendAux', parameters: PARAMETERS } }],
    CloseTransport: [
      {
        Error: {
          object: { Transport: 'SendAux' },
          code: 'NotFound',
          message: 'transport not created'
        }
      }
    ]
  })
  const answer = await requestAuxTransport(request)
  assert.deepEqual(answer.parameters, PARAMETERS)
  assert.equal(sent.length, 3)
})

test('only once: a second refusal is the caller error', async () => {
  const { request, sent } = nodeHarness({
    CreateTransport: [exists, exists],
    CloseTransport: [{ TransportClosed: { direction: 'SendAux' } }]
  })
  const err = await requestAuxTransport(request).catch((e) => e)
  assert.ok(err instanceof VoiceRequestError)
  assert.equal(err.code, 'InvalidState')
  assert.equal(sent.length, 3)
})

test('other refusals are not retried', async () => {
  const { request, sent } = nodeHarness({
    CreateTransport: [
      {
        Error: {
          object: { Transport: 'SendAux' },
          code: 'Internal',
          message: 'worker failed'
        }
      }
    ]
  })
  const err = await requestAuxTransport(request).catch((e) => e)
  assert.equal(err.code, 'Internal')
  assert.deepEqual(sent, [{ CreateTransport: { direction: 'SendAux' } }])
  // A failure that is not the node's answer is not retried either.
  const calls = []
  const broken = async (message) => {
    calls.push(message)
    throw new Error('Voice socket not open')
  }
  await assert.rejects(requestAuxTransport(broken), /Voice socket not open/)
  assert.equal(calls.length, 1)
})

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
