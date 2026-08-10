import assert from 'node:assert/strict'
import test from 'node:test'

import { clearAuthTokens, getFreshToken, setAuthTokens, setOnSessionExpired } from './auth.js'
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

test('a transient refresh response preserves the session for a later retry', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  let expirations = 0
  globalThis.fetch = async () => {
    calls++
    if (calls === 1) {
      return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    return new Response(JSON.stringify(tokenPair('rotated')), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    })
  }
  setOnSessionExpired(() => expirations++)

  try {
    setAuthTokens(tokenPair('old', 0))
    await assert.rejects(getFreshToken(), (error) => error.transient === true)
    assert.equal(expirations, 0)
    assert.equal(await getFreshToken(), 'rotated-access')
  } finally {
    clearAuthTokens()
    setOnSessionExpired(null)
    globalThis.fetch = originalFetch
  }
})

test('an explicit refresh rejection expires the local session', async () => {
  const originalFetch = globalThis.fetch
  let expirations = 0
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'invalid refresh token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' }
    })
  setOnSessionExpired(() => expirations++)

  try {
    setAuthTokens(tokenPair('rejected', 0))
    await assert.rejects(getFreshToken(), /invalid refresh token/)
    assert.equal(expirations, 1)
    await assert.rejects(getFreshToken(), /Not authenticated/)
  } finally {
    clearAuthTokens()
    setOnSessionExpired(null)
    globalThis.fetch = originalFetch
  }
})
