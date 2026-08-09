import assert from 'node:assert/strict'
import test from 'node:test'

import { httpFetch } from './http.js'

test('non-development requests take the direct fetch path unchanged', async () => {
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
