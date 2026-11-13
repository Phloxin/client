// Helpers for the session's third transport (SendAux), which carries a native
// screen share (soup/nativeShare.js). Kept apart from soup/index.js so they can
// be tested on their own.
//   node --test src/renderer/src/lib/soup/auxTransport.test.mjs
import { Direction, ErrorCode, Request, VoiceRequestError } from './protocol.js'

function transportExists(err) {
  return (
    err instanceof VoiceRequestError &&
    err.code === ErrorCode.InvalidState &&
    err.object?.Transport === Direction.SendAux
  )
}

// Asks the node for SendAux with `request` (the matcher's), and resolves with
// its answer. A SendAux left open on the node (a stop while the socket was
// detached, or a CloseTransport lost with it) is closed and asked for once more.
export async function requestAuxTransport(request) {
  try {
    return await request(Request.createTransport(Direction.SendAux))
  } catch (err) {
    if (!transportExists(err)) throw err
  }
  console.log('[Soup] SendAux was still open on the voice node, closing it first')
  try {
    await request(Request.closeTransport(Direction.SendAux))
  } catch (err) {
    // Gone meanwhile is as good as closed.
    if (!(err instanceof VoiceRequestError)) throw err
  }
  return request(Request.createTransport(Direction.SendAux))
}

const SHA256_FINGERPRINT = /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){31}$/

// The sidecar's DTLS parameters as ConnectTransport sends them, or a throw when
// they are not what the node can parse: a message it cannot parse ends the
// whole voice session. Role client, one or more sha-256 fingerprints of 32
// bytes in colon separated hex, nothing else.
export function engineDtlsParameters(dtls) {
  if (dtls?.role !== 'client') {
    throw new Error('media engine sent DTLS parameters without role client')
  }
  const fingerprints = dtls.fingerprints
  if (!Array.isArray(fingerprints) || fingerprints.length === 0) {
    throw new Error('media engine sent no DTLS fingerprint')
  }
  for (const fingerprint of fingerprints) {
    if (
      fingerprint?.algorithm !== 'sha-256' ||
      typeof fingerprint.value !== 'string' ||
      !SHA256_FINGERPRINT.test(fingerprint.value)
    ) {
      throw new Error('media engine sent a DTLS fingerprint that is not sha-256')
    }
  }
  return {
    role: 'client',
    fingerprints: fingerprints.map(({ algorithm, value }) => ({ algorithm, value }))
  }
}
