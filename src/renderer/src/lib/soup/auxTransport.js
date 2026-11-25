// Helpers for the native screen share's own send transport (soup/nativeShare.js).
// Kept apart from soup/index.js so they can be tested on their own.
//   node --test src/renderer/src/lib/soup/auxTransport.test.mjs

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
