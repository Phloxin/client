// A share's stream is handed back to the backend (op 11, EndStream) once (smooth A5.2). Kept
// apart from soup/screenShare.js so it can be tested on its own.
//   node --test src/renderer/src/lib/soup/shareStream.test.mjs
//
// A native share stopped right after its stream was created reaches both stopShareContext and
// its start's catch, and both hand the stream back. The context remembers the key it handed
// back, so the second is a no-op. A new stream on the same context (the share fell back to
// Chromium's path, which asks for its own) is handed back once in its turn.

// The share's new stream key (op 12). The marker of the key handed back goes with the old one,
// so a key the backend issues again is handed back again (fix C6).
export function setShareStreamKey(ctx, key) {
  ctx.streamKey = key
  ctx.releasedStreamKey = null
}

// Calls `release(ctx.streamKey)` unless that key was handed back already. True when it did.
export function releaseShareStream(ctx, release) {
  const key = ctx?.streamKey
  if (key == null || ctx.releasedStreamKey === key) return false
  ctx.releasedStreamKey = key
  release(key)
  return true
}
