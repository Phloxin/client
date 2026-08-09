import assert from 'node:assert/strict'
import test from 'node:test'

import { clearAuthTokens, getFreshToken, setAuthTokens } from './auth.js'
import { setServerHost } from './serverConfig.js'

const futureExpiry = () => Math.floor(Date.now() / 1000) + 3600

function tokenPair(prefix, accessExpiresAt = futureExpiry()) {
  return {
    access_token: `${prefix}-access`,
    access_expires_at: accessExpiresAt,
    refresh_token: `${prefix}-refresh`,
    refresh_expires_at: futureExpiry()
  }
}

function deferredFetch() {
  let resolve
  const promise = new Promise((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('an in-flight refresh cannot overwrite a newer login', async () => {
  const originalFetch = globalThis.fetch
  const request = deferredFetch()
  globalThis.fetch = () => request.promise
  setServerHost('example.test')

  try {
    setAuthTokens(tokenPair('old', 0))
    const pendingToken = getFreshToken()

    setAuthTokens(tokenPair('new'))
    request.resolve({ ok: true, json: async () => tokenPair('stale-response') })

    assert.equal(await pendingToken, 'new-access')
    assert.equal(await getFreshToken(), 'new-access')
  } finally {
    clearAuthTokens()
    globalThis.fetch = originalFetch
  }
})

test('an in-flight refresh cannot resurrect a cleared session', async () => {
  const originalFetch = globalThis.fetch
  const request = deferredFetch()
  globalThis.fetch = () => request.promise

  try {
    setAuthTokens(tokenPair('old', 0))
    const pendingToken = getFreshToken()

    clearAuthTokens()
    request.resolve({ ok: true, json: async () => tokenPair('stale-response') })

    await assert.rejects(pendingToken, /Not authenticated/)
    await assert.rejects(getFreshToken(), /Not authenticated/)
  } finally {
    clearAuthTokens()
    globalThis.fetch = originalFetch
  }
})
