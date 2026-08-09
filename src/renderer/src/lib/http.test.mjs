import assert from 'node:assert/strict'
import test from 'node:test'

import { httpFetch } from './http.js'

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
    assert.equal(received[1], options)
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
