import assert from 'node:assert/strict'
import test, { mock } from 'node:test'

import {
  authFetch,
  clearAuthTokens,
  getFreshToken,
  setAuthTokens,
  setOnSessionExpired
} from './auth.js'
import { setServerHost } from './serverConfig.js'

const futureExpiry = () => Date.now() + 3_600_000

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
    const pendingToken = getFreshToken({ force: true })

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
    const pendingToken = getFreshToken({ force: true })

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
    await assert.rejects(getFreshToken({ force: true }), (error) => error.transient === true)
    assert.equal(expirations, 0)
    assert.equal(await getFreshToken({ force: true }), 'rotated-access')
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
    await assert.rejects(getFreshToken({ force: true }), /invalid refresh token/)
    assert.equal(expirations, 1)
    await assert.rejects(getFreshToken(), /Not authenticated/)
  } finally {
    clearAuthTokens()
    setOnSessionExpired(null)
    globalThis.fetch = originalFetch
  }
})

test('a forced refresh rotates a token that is not near expiry', async () => {
  const originalFetch = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return { ok: true, status: 200, json: async () => tokenPair('forced') }
  }
  setServerHost('example.test')

  try {
    setAuthTokens(tokenPair('current'))
    assert.equal(await getFreshToken(), 'current-access')
    assert.equal(calls, 0)
    // The server refused it (event-socket 4002): refresh anyway.
    assert.equal(await getFreshToken({ force: true }), 'forced-access')
    assert.equal(calls, 1)
  } finally {
    clearAuthTokens()
    globalThis.fetch = originalFetch
  }
})

// ─── Clock skew and refresh cadence ───────────────────────────────
// These drive auth.js's module-level proactive timer with fake Date and
// setTimeout. setImmediate stays real so pending fetch/json promises can
// settle between ticks.

const SECOND = 1_000
const MINUTE = 60 * SECOND
const ACCESS_TTL_MS = 15 * MINUTE
const REFRESH_EARLY_MS = 90 * SECOND
const MIN_REFRESH_INTERVAL_MS = 30 * SECOND
const CLIENT_AHEAD_MS = 3 * 60 * MINUTE // dual boot: Windows clock 3 h ahead
const FAKE_NOW = Date.UTC(2026, 9, 25, 12)

const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve))
}

// A pair as the server would issue it at `serverNow` (its own clock).
function serverPair(
  prefix,
  serverNow,
  { accessTtlMs = ACCESS_TTL_MS, withServerTime = true } = {}
) {
  return {
    access_token: `${prefix}-access`,
    access_expires_at: serverNow + accessTtlMs,
    refresh_token: `${prefix}-refresh`,
    refresh_expires_at: serverNow + 30 * 24 * 60 * MINUTE,
    ...(withServerTime ? { server_time: serverNow } : {})
  }
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

// Installs fake timers and a refresh endpoint that issues pairs from
// `issue(serverNow)`, where the server clock trails the local one by `skewMs`.
function withFakeRefreshServer({ skewMs, issue }) {
  const originalFetch = globalThis.fetch
  const state = { calls: 0 }
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: FAKE_NOW })
  setServerHost('example.test')
  globalThis.fetch = async () => {
    state.calls++
    return jsonResponse(issue(`r${state.calls}`, Date.now() - skewMs))
  }
  state.restore = () => {
    clearAuthTokens()
    mock.timers.reset()
    globalThis.fetch = originalFetch
  }
  return state
}

test('a skewed clock with server_time keeps a fresh pair for its full lifetime', async () => {
  const server = withFakeRefreshServer({
    skewMs: CLIENT_AHEAD_MS,
    issue: (prefix, serverNow) => serverPair(prefix, serverNow)
  })

  try {
    setAuthTokens(serverPair('skewed', Date.now() - CLIENT_AHEAD_MS))
    assert.equal(await getFreshToken(), 'skewed-access')
    assert.equal(server.calls, 0)

    const deadline = ACCESS_TTL_MS - REFRESH_EARLY_MS
    mock.timers.tick(deadline - 1)
    await settle()
    assert.equal(server.calls, 0, 'proactive refresh fired before the local deadline')

    mock.timers.tick(2)
    await settle()
    assert.equal(server.calls, 1)
    assert.equal(await getFreshToken(), 'r1-access')
    assert.equal(server.calls, 1)
  } finally {
    server.restore()
  }
})

test('a skewed clock without server_time refreshes at most once per interval', async () => {
  const server = withFakeRefreshServer({
    skewMs: CLIENT_AHEAD_MS,
    issue: (prefix, serverNow) => serverPair(prefix, serverNow, { withServerTime: false })
  })

  try {
    // Old server: the deadline is taken as-is and already looks expired.
    setAuthTokens(serverPair('old-server', Date.now() - CLIENT_AHEAD_MS, { withServerTime: false }))
    for (let elapsed = 0; elapsed < 5 * MINUTE; elapsed += SECOND) {
      mock.timers.tick(SECOND)
      await settle()
    }
    assert.ok(server.calls >= 1, 'the expired-looking pair is still refreshed eventually')
    assert.ok(
      server.calls <= (5 * MINUTE) / MIN_REFRESH_INTERVAL_MS,
      `expected at most 10 refreshes in 5 min, got ${server.calls}`
    )
  } finally {
    server.restore()
  }
})

test('getFreshToken does not rotate a young pair whose local deadline looks expired', async () => {
  const server = withFakeRefreshServer({
    skewMs: CLIENT_AHEAD_MS,
    issue: (prefix, serverNow) => serverPair(prefix, serverNow, { withServerTime: false })
  })

  try {
    setAuthTokens(serverPair('old-server', Date.now() - CLIENT_AHEAD_MS, { withServerTime: false }))
    assert.equal(await getFreshToken(), 'old-server-access')
    assert.equal(server.calls, 0)

    // Advance the clock without firing the proactive timer, so only
    // getFreshToken's own guard decides.
    mock.timers.setTime(FAKE_NOW + MIN_REFRESH_INTERVAL_MS - 1)
    assert.equal(await getFreshToken(), 'old-server-access')
    assert.equal(server.calls, 0)

    mock.timers.setTime(FAKE_NOW + MIN_REFRESH_INTERVAL_MS)
    assert.equal(await getFreshToken(), 'r1-access')
    assert.equal(server.calls, 1)
  } finally {
    server.restore()
  }
})

test('a pair capped near absolute expiry is not refreshed again within the interval', async () => {
  const server = withFakeRefreshServer({
    skewMs: 0,
    issue: (prefix, serverNow) => serverPair(prefix, serverNow, { accessTtlMs: 10 * SECOND })
  })

  try {
    // Correct clock, but access_expires_at is inside the refresh-early window.
    setAuthTokens(serverPair('capped', Date.now(), { accessTtlMs: 10 * SECOND }))
    assert.equal(await getFreshToken(), 'capped-access')

    mock.timers.tick(MIN_REFRESH_INTERVAL_MS - 1)
    await settle()
    assert.equal(server.calls, 0)
    assert.equal(await getFreshToken(), 'capped-access')
    assert.equal(server.calls, 0)

    mock.timers.tick(1)
    await settle()
    assert.equal(server.calls, 1)
  } finally {
    server.restore()
  }
})

test('authFetch refreshes a young pair once on token_expired and retries once', async () => {
  const originalFetch = globalThis.fetch
  const apiAuthHeaders = []
  let refreshes = 0
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith('/auth/refresh')) {
      refreshes++
      return jsonResponse(serverPair('retried', Date.now()))
    }
    apiAuthHeaders.push(options.headers.Authorization)
    if (apiAuthHeaders.length === 1) {
      return jsonResponse({ code: 'token_expired', error: 'Token expired' }, 401)
    }
    return jsonResponse({ ok: true })
  }
  setServerHost('example.test')

  try {
    setAuthTokens(serverPair('young', Date.now()))
    const res = await authFetch('https://example.test/server/roles')
    assert.equal(res.status, 200)
    assert.equal(refreshes, 1)
    assert.deepEqual(apiAuthHeaders, ['Bearer young-access', 'Bearer retried-access'])
  } finally {
    clearAuthTokens()
    globalThis.fetch = originalFetch
  }
})
