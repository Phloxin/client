// One room session (docs/API.md "Room session"): a WebTransport session to `url`, the control
// stream this side opens and joins on, the state stream the server opens after `joined`, and
// datagrams both ways. Reports through `handlers` and never retries; sessionStore owns that.
//
// handlers: onControl(message) for each control frame object, onState({ kind, generation,
// payload }), onVolatile(payload) for each datagram newer than the last one taken, and onEnd(error)
// once, when the session is over for any reason.

import {
  createFrameReader,
  decodeControl,
  decodeDatagram,
  encodeControl,
  encodeDatagram,
  isNewerSeq,
  parseStateFrame
} from './frames.js'

// How long a `leave` gets to reach the server before the session is closed from this side.
const LEAVE_TIMEOUT_MS = 1000

async function readFrames(readable, onBody) {
  const reader = readable.getReader()
  const frames = createFrameReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      for (const body of frames.push(value)) onBody(body)
    }
  } finally {
    reader.releaseLock()
  }
}

export function openRoomSession(url, ticket, handlers, certHashes = []) {
  let ended = false
  let wt = null
  let control = null
  let datagrams = null
  let outSeq = 0
  let inSeq = null

  const end = (error) => {
    if (ended) return
    ended = true
    handlers.onEnd?.(error ?? null)
  }
  const close = () => {
    try {
      wt?.close()
    } catch {
      // Already closed.
    }
  }

  try {
    wt = new WebTransport(
      url,
      certHashes.length ? { serverCertificateHashes: certHashes } : undefined
    )
  } catch (error) {
    queueMicrotask(() => end(error))
    return { send() {}, sendDatagram() {}, leave() {}, close() {} }
  }
  wt.closed.then(
    () => end(null),
    (error) => end(error)
  )

  const start = async () => {
    await wt.ready
    const stream = await wt.createBidirectionalStream()
    control = stream.writable.getWriter()
    await control.write(encodeControl({ t: 'join', ticket }))
    datagrams = wt.datagrams.writable.getWriter()

    // The control stream ending is the end of the session, whatever the transport says.
    readFrames(stream.readable, (body) => {
      const message = decodeControl(body)
      if (message) handlers.onControl?.(message)
    }).then(close, close)

    const streams = wt.incomingUnidirectionalStreams.getReader()
    ;(async () => {
      for (;;) {
        const { value, done } = await streams.read()
        if (done) return
        readFrames(value, (body) => {
          const frame = parseStateFrame(body)
          if (frame) handlers.onState?.(frame)
        }).catch(close)
      }
    })().catch(() => {})

    const incoming = wt.datagrams.readable.getReader()
    ;(async () => {
      for (;;) {
        const { value, done } = await incoming.read()
        if (done) return
        const datagram = decodeDatagram(value)
        if (!datagram || !isNewerSeq(inSeq, datagram.seq)) continue
        inSeq = datagram.seq
        handlers.onVolatile?.(datagram.payload)
      }
    })().catch(() => {})
  }
  start().catch((error) => {
    end(error)
    close()
  })

  return {
    // An encoded control frame, in order behind the ones before it.
    send(frame) {
      if (ended || !control) return
      control.write(frame).catch(close)
    },
    // A datagram payload. Lossy: dropped when it cannot go now.
    sendDatagram(payload) {
      if (ended || !datagrams) return
      outSeq += 1
      datagrams.write(encodeDatagram(outSeq, payload)).catch(() => {})
    },
    // Leaves the room at once, then closes the session once the server has, or after a moment.
    leave() {
      if (ended || !control) return close()
      control
        .write(encodeControl({ t: 'leave' }))
        .then(() => control.close())
        .catch(() => {})
      const timeout = new Promise((resolve) => setTimeout(resolve, LEAVE_TIMEOUT_MS))
      Promise.race([wt.closed.catch(() => {}), timeout]).then(close)
    },
    close
  }
}
