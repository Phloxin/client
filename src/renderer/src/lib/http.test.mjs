import assert from 'node:assert/strict'
import test from 'node:test'

import { httpFetch, setUpdateRequiredHandler } from './http.js'
import { setServerHost } from './serverConfig.js'

test('non-development requests preserve fetch arguments and results', async () => {
  const originalFetch = globalThis.fetch
  const response = { ok: true }
  const options = { method: 'POST', body: 'payload' }
  let received
  globalThis.fetch = (...args) => {
    received = args
    return Promise.resolve(response)
  }

  try {
    assert.equal(await httpFetch(new URL('https://example.test/path'), options), response)
    assert.equal(String(received[0]), 'https://example.test/path')
    assert.equal(received[1].method, 'POST')
    assert.equal(received[1].body, 'payload')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('production failures log status without query-string secrets', async () => {
  const originalFetch = globalThis.fetch
  const originalWarn = console.warn
  const response = { ok: false, status: 503 }
  let warning
  globalThis.fetch = () => Promise.resolve(response)
  console.warn = (...args) => {
    warning = args
  }

  try {
    assert.equal(
      await httpFetch('https://example.test/path?access_token=secret', { method: 'GET' }),
      response
    )
    assert.equal(warning[0], '[HTTP] Request failed:')
    assert.deepEqual(warning[1], {
      method: 'GET',
      url: 'https://example.test/path',
      status: 503
    })
  } finally {
    globalThis.fetch = originalFetch
    console.warn = originalWarn
  }
})

test('production network failures are logged and rethrown', async () => {
  const originalFetch = globalThis.fetch
  const originalError = console.error
  const failure = new Error('connection refused')
  let logged
  globalThis.fetch = () => Promise.reject(failure)
  console.error = (...args) => {
    logged = args
  }

  try {
    await assert.rejects(httpFetch('https://example.test/path', { method: 'POST' }), failure)
    assert.equal(logged[0], '[HTTP] Network request failed:')
    assert.equal(logged[1].method, 'POST')
    assert.equal(logged[1].url, 'https://example.test/path')
    assert.equal(logged[1].error, failure)
  } finally {
    globalThis.fetch = originalFetch
    console.error = originalError
  }
})

test('requests carry the API version unless the caller set one', async () => {
  const originalFetch = globalThis.fetch
  const sent = []
  globalThis.fetch = (_input, options) => {
    sent.push(new Headers(options.headers))
    return Promise.resolve({ ok: true, status: 200 })
  }

  try {
    await httpFetch('https://example.test/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    })
    await httpFetch('https://example.test/roles', { headers: { 'pylon-api-version': '7' } })
    await httpFetch('https://example.test/roles')
    assert.equal(sent[0].get('Pylon-Api-Version'), '1')
    assert.equal(sent[0].get('Content-Type'), 'application/json')
    assert.equal(sent[1].get('Pylon-Api-Version'), '7')
    assert.equal(sent[2].get('Pylon-Api-Version'), '1')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('a 426 from the active server raises the update-required handler', async () => {
  const originalFetch = globalThis.fetch
  let raised = 0
  setServerHost('example.test')
  setUpdateRequiredHandler(() => raised++)
  globalThis.fetch = (_input, options) =>
    Promise.resolve({ ok: false, status: options.method === 'POST' ? 426 : 200 })

  try {
    await httpFetch('https://example.test/roles')
    assert.equal(raised, 0)
    const response = await httpFetch('https://example.test/auth/login', { method: 'POST' })
    assert.equal(response.status, 426)
    assert.equal(raised, 1)
  } finally {
    setUpdateRequiredHandler(null)
    setServerHost(null)
    globalThis.fetch = originalFetch
  }
})

test('a 426 from another server does not raise the update-required handler', async () => {
  const originalFetch = globalThis.fetch
  let raised = 0
  setServerHost('example.test')
  setUpdateRequiredHandler(() => raised++)
  globalThis.fetch = () => Promise.resolve({ ok: false, status: 426 })

  try {
    const response = await httpFetch('https://other.test/auth/register', { method: 'POST' })
    assert.equal(response.status, 426)
    assert.equal(raised, 0)
  } finally {
    setUpdateRequiredHandler(null)
    setServerHost(null)
    globalThis.fetch = originalFetch
  }
})
