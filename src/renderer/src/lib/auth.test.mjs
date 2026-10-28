import assert from 'node:assert/strict'
import test from 'node:test'

import { authFetch } from './auth.js'

// The token pair and its refresh live in the main process (src/main/session.js,
// tested there); the credential is attached by the transport. What stays here
// is authFetch's retry policy, driven through a stubbed preload bridge.

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

test('authFetch refreshes a young pair once on token_expired and retries once', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  let refreshes = 0
  // Stands in for the access token main would attach: the refresh swaps it.
  let token = 'young-access'
  globalThis.window = {
    api: {
      session: {
        refresh: async () => {
          refreshes++
          calls.push('refresh')
          token = 'retried-access'
        }
      }
    }
  }
  globalThis.fetch = async () => {
    calls.push('fetch')
    if (token === 'young-access') {
      return jsonResponse({ code: 'token_expired', error: 'Token expired' }, 401)
    }
    return jsonResponse({ ok: true })
  }

  try {
    const res = await authFetch('https://example.test/server/roles')
    assert.equal(res.status, 200)
    assert.equal(refreshes, 1)
    assert.deepEqual(calls, ['fetch', 'refresh', 'fetch'])
  } finally {
    delete globalThis.window
    globalThis.fetch = originalFetch
  }
})
