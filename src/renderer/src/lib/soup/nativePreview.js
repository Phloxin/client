// The sharer's own picture of a native share (.plans/native-media-engine-m6-preview-2-client.md):
// the sidecar sends small JPEGs of what it shares (`preview` messages, through main), and
// nativeShare.js draws them on the canvas its preview stream is captured from. The pictures
// are the sharer's screen: they are never logged, stored or sent anywhere but that canvas.
// Pure parts here, so they can be tested.

// What the renderer asks for once a native share is live (X3). The most the sidecar takes
// (PROTOCOL.md): 480x270 at 5 a second was too coarse to see what is shared.
export const PREVIEW_FPS = 10
export const PREVIEW_MAX_WIDTH = 1280
export const PREVIEW_MAX_HEIGHT = 720

// The sidecar's `preview` request for `fps` pictures a second (0 stops) within the size above,
// or within `override`'s size (PYLON_NATIVE_PREVIEW in development, main's status: B5 of
// .plans/native-media-engine-preview-cost.md).
export function previewRequest(fps, override = null) {
  return {
    fps,
    max_width: override?.max_width ?? PREVIEW_MAX_WIDTH,
    max_height: override?.max_height ?? PREVIEW_MAX_HEIGHT
  }
}

// The rate asked for while the self tile is seen: PREVIEW_FPS, or override's.
export function previewFps(override = null) {
  return override?.fps ?? PREVIEW_FPS
}

// How often a change of "the self tile is seen" may reach the sidecar (B2).
export const PREVIEW_GATE_MS = 250

// Turns "the self tile is seen" into preview requests (B2): send(true) asks for pictures,
// send(false) stops them. Nothing is sent until set(true), a state equal to the last one sent is
// not sent again, and changes go out at most once in intervalMs: one that comes sooner waits,
// and the last state set by then is the one sent. close() drops a change still waiting.
//   now(), setTimer(fn, ms), clearTimer(id)   the clock, for tests
export function createPreviewGate({
  send,
  intervalMs = PREVIEW_GATE_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id)
}) {
  let sent = false
  let wanted = false
  let lastSentAt = -Infinity
  let timer = null
  let closed = false
  const flush = () => {
    timer = null
    if (closed || wanted === sent) return
    sent = wanted
    lastSentAt = now()
    send(sent)
  }
  return {
    set(seen) {
      if (closed) return
      wanted = seen === true
      if (timer != null || wanted === sent) return
      const wait = lastSentAt + intervalMs - now()
      if (wait <= 0) flush()
      else timer = setTimer(flush, wait)
    },
    close() {
      closed = true
      if (timer != null) clearTimer(timer)
      timer = null
    },
    get sent() {
      return sent
    }
  }
}

// A picture's base64 JPEG as bytes, or null when it is not base64.
export function jpegBytes(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) return null
  let binary
  try {
    binary = atob(base64)
  } catch {
    return null
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

// Draws pictures one at a time: a picture that arrives while the one before is still being
// decoded is dropped (X4), and none is drawn once canDraw() is false (X7).
//   decode(picture)  → a promise of an image
//   draw(image)      puts it on the canvas
//   release(image)   frees it, drawn or not
//   canDraw()        false once the share or its placeholder track is gone
// counts: received, drawn, dropped (one was decoding), late (canDraw() false), failed (decode).
export function createPreviewPainter({ decode, draw, release = () => {}, canDraw }) {
  let decoding = false
  const counts = { received: 0, drawn: 0, dropped: 0, late: 0, failed: 0 }
  const offer = (picture) => {
    counts.received++
    if (!canDraw()) {
      counts.late++
      return false
    }
    if (decoding) {
      counts.dropped++
      return false
    }
    decoding = true
    let decoded
    try {
      decoded = Promise.resolve(decode(picture))
    } catch (err) {
      decoded = Promise.reject(err)
    }
    decoded
      .then(
        (image) => {
          try {
            if (canDraw()) {
              draw(image)
              counts.drawn++
            } else {
              counts.late++
            }
          } finally {
            release(image)
          }
        },
        () => {
          counts.failed++
        }
      )
      .catch(() => {
        counts.failed++
      })
      .finally(() => {
        decoding = false
      })
    return true
  }
  return { offer, counts }
}
