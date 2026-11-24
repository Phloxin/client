// The room session's framing (docs/API.md "Room session"). Stream frames are a big-endian u32
// length, then the body. Control bodies are JSON. State bodies are a kind byte, a big-endian u32
// generation, then the activity's payload. Datagrams are a big-endian u32 seq, then the payload.
// Pure.

// The most a control frame body from the client may hold. The server closes the session over it.
export const MAX_CONTROL_BODY = 4096

const STATE_KINDS = ['snapshot', 'delta']

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function withLength(body) {
  const frame = new Uint8Array(4 + body.length)
  new DataView(frame.buffer).setUint32(0, body.length)
  frame.set(body, 4)
  return frame
}

// A control frame for `message`. Null when it does not serialize to JSON (a BigInt, a cycle, or
// undefined).
export function encodeControl(message) {
  let json
  try {
    json = JSON.stringify(message)
  } catch {
    return null
  }
  if (typeof json !== 'string') return null
  return withLength(encoder.encode(json))
}

// The JSON object in a control frame body, or null.
export function decodeControl(body) {
  try {
    const value = JSON.parse(decoder.decode(body))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

// An `action` control frame, `body` being its length without the prefix. Null when `data` is
// missing or does not serialize, since the server closes the session on an action without data.
export function encodeAction(id, data) {
  if (data === undefined) return null
  const frame = encodeControl({ t: 'action', id, data })
  if (!frame) return null
  // A nested undefined or function is dropped by JSON.stringify; the top level must survive.
  if (!('data' in (decodeControl(frame.subarray(4)) ?? {}))) return null
  return { frame, body: frame.length - 4 }
}

// Splits a byte stream into frame bodies. Fed chunks of any size, `push` returns the bodies the
// chunk completed, each a copy that owns its buffer.
export function createFrameReader() {
  const chunks = []
  let buffered = 0
  let need = null

  // The next `n` buffered bytes, consumed.
  const take = (n) => {
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const chunk = chunks[0]
      const used = Math.min(chunk.length, n - at)
      out.set(chunk.subarray(0, used), at)
      at += used
      if (used === chunk.length) chunks.shift()
      else chunks[0] = chunk.subarray(used)
    }
    buffered -= n
    return out
  }

  return {
    push(chunk) {
      if (chunk?.length) {
        chunks.push(chunk)
        buffered += chunk.length
      }
      const bodies = []
      for (;;) {
        if (need == null) {
          if (buffered < 4) break
          need = new DataView(take(4).buffer).getUint32(0)
        }
        if (buffered < need) break
        bodies.push(take(need))
        need = null
      }
      return bodies
    },
    // Bytes held toward an incomplete frame.
    get pending() {
      return buffered + (need == null ? 0 : 4)
    }
  }
}

// A state frame body as { kind, generation, payload }, or null when it is too short or of an
// unknown kind. `payload` is a copy, so it can cross postMessage without the rest of the buffer.
export function parseStateFrame(body) {
  if (!body || body.length < 5) return null
  const kind = STATE_KINDS[body[0]]
  if (!kind) return null
  const generation = new DataView(body.buffer, body.byteOffset, body.length).getUint32(1)
  return { kind, generation, payload: body.slice(5) }
}

export function encodeDatagram(seq, payload) {
  const bytes = new Uint8Array(4 + payload.length)
  new DataView(bytes.buffer).setUint32(0, seq)
  bytes.set(payload, 4)
  return bytes
}

// A datagram as { seq, payload }, or null when it is shorter than its seq.
export function decodeDatagram(bytes) {
  if (!bytes || bytes.length < 4) return null
  const seq = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(0)
  return { seq, payload: bytes.slice(4) }
}

// Whether an incoming datagram is newer than the last one taken (null before the first).
export const isNewerSeq = (last, seq) => last == null || seq > last
