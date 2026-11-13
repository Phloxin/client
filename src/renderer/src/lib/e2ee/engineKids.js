// Kids for native encoders, which seal this client's frames with its own sender key
// (.plans/native-media-engine.md, decision 11). Kid 0 is the worker's own transforms. A kid is
// never handed out twice under one sending key, so a (key, kid, counter) triple is never reused
// even when an encoder restarts or a key comes back. Keys are known here only by
// sendingKeyHash, never by their bytes.
//   node --test src/renderer/src/lib/e2ee/engineKids.test.mjs

export const ENGINE_KID_MIN = 1
export const ENGINE_KID_MAX = 255

const FNV_OFFSET = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn

// 64 bit FNV-1a of a byte sequence, as 16 hex digits.
export function fnv1a64(bytes) {
  let hash = FNV_OFFSET
  for (const byte of bytes) hash = ((hash ^ BigInt(byte & 0xff)) * FNV_PRIME) & MASK_64
  return hash.toString(16).padStart(16, '0')
}

// The hash of format and epoch (each as 4 bytes, little endian) and the key bytes, or null for
// no key. What the worker compares and indexes sending keys by.
export function sendingKeyHash(current) {
  if (!current) return null
  const bytes = new Uint8Array(8 + current.key.length)
  const view = new DataView(bytes.buffer)
  view.setUint32(0, Number(current.format) >>> 0, true)
  view.setUint32(4, Number(current.epoch) >>> 0, true)
  bytes.set(current.key, 8)
  const hash = fnv1a64(bytes)
  bytes.fill(0)
  return hash
}

export function createEngineKids() {
  const registered = new Map() // engine -> kid
  // Key hash -> kids handed out under that key, released ones included, for the worker's life.
  const usedByKey = new Map()
  const usedUnder = (keyHash) => {
    let used = usedByKey.get(keyHash)
    if (!used) {
      used = new Set()
      usedByKey.set(keyHash, used)
    }
    return used
  }

  return {
    // The kid for a new engine under the key `keyHash`, or null when every kid is used under it.
    take(engine, keyHash) {
      if (registered.has(engine)) return registered.get(engine)
      if (keyHash == null) return null
      const used = usedUnder(keyHash)
      for (let kid = ENGINE_KID_MIN; kid <= ENGINE_KID_MAX; kid++) {
        if (used.has(kid)) continue
        used.add(kid)
        registered.set(engine, kid)
        return kid
      }
      return null
    },
    // The engine is gone. Its kid stays used under every key it was used under.
    release(engine) {
      registered.delete(engine)
    },
    // The sending key is now `keyHash`: the registered engines carry on with their kids under it.
    keyChanged(keyHash) {
      if (keyHash == null || registered.size === 0) return
      const used = usedUnder(keyHash)
      for (const kid of registered.values()) used.add(kid)
    },
    kidOf(engine) {
      return registered.get(engine) ?? null
    },
    engines() {
      return [...registered.keys()]
    }
  }
}
