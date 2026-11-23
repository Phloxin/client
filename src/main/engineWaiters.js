// The requests waiting on a sidecar's answers (mediaEngine.js): one waiter per answer name
// (hello, opened, capture_ready, capture_cancelled) in `engine.waiting`. Kept apart from the
// process handling so it can be tested under node.
//
// A sidecar that is gone answers nothing, so every request fails at once when it exits, and
// a waiter made after that fails at once too (smooth A5.1): a capture must never wait on a
// sidecar that died right after its hello, however its exit and its last lines are ordered.

// The error requests fail with once `engine` is gone: its exit's own, set by mediaEngine.js.
function goneError(engine) {
  return engine.exitError ?? new Error('media engine exited')
}

// Waits for the answer `name`. Rejects at once when the engine is gone already.
export function waitFor(engine, name) {
  if (engine.gone) return Promise.reject(goneError(engine))
  return new Promise((resolve, reject) => engine.waiting.set(name, { resolve, reject }))
}

// Settles the waiter for `name`, if there is one: rejected with `error`, else resolved with
// `value`. An answer nobody waits for is dropped.
export function settleWaiter(engine, name, error, value) {
  const waiter = engine.waiting.get(name)
  if (!waiter) return
  engine.waiting.delete(name)
  if (error) waiter.reject(error)
  else waiter.resolve(value)
}

// Fails every waiter of `engine` with `error`.
export function failWaiters(engine, error) {
  for (const name of [...engine.waiting.keys()]) settleWaiter(engine, name, error)
}

// The sidecar exited: `engine` is gone, and every waiter fails with `error`, now and later.
export function engineGone(engine, error) {
  engine.gone = true
  engine.exitError = error
  failWaiters(engine, error)
}
