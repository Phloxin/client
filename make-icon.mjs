// ponytail: one-off icon generator, no deps (Node zlib + hand-rolled PNG/ICO).
// Run: node make-icon.mjs   ->  writes build/icon.ico
import { deflateSync } from 'node:zlib'
import { writeFileSync } from 'node:fs'

const S = 256

// --- draw pixels (RGBA) ---
const px = Buffer.alloc(S * S * 4)
const set = (x, y, r, g, b, a) => {
  const i = (y * S + x) * 4
  px[i] = r
  px[i + 1] = g
  px[i + 2] = b
  px[i + 3] = a
}
const lerp = (a, b, t) => Math.round(a + (b - a) * t)
const R = 48 // corner radius
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    // rounded-rect alpha mask
    const dx = Math.max(R - x, x - (S - 1 - R), 0)
    const dy = Math.max(R - y, y - (S - 1 - R), 0)
    const dist = Math.hypot(dx, dy)
    const a = dist > R ? 0 : 255
    // diagonal gradient (indigo -> teal)
    const t = (x + y) / (2 * S)
    const r = lerp(99, 16, t),
      g = lerp(102, 185, t),
      b = lerp(241, 178, t)
    set(x, y, r, g, b, a)
    // a simple white chevron mark in the center
    const cx = x - S / 2,
      cy = y - S / 2
    const onMark =
      Math.abs(Math.abs(cx) - (cy + 30)) < 16 && cy > -60 && cy < 70 && Math.abs(cx) < 70
    if (a && onMark) set(x, y, 255, 255, 255, 255)
  }
}

// --- encode PNG ---
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td) >>> 0)
  return Buffer.concat([len, td, crc])
}
function crc32(buf) {
  let c = ~0
  for (const byte of buf) {
    c ^= byte
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8
ihdr[9] = 6 // 8-bit RGBA
// add filter byte (0) per scanline
const raw = Buffer.alloc(S * (S * 4 + 1))
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  px.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4)
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
])

// --- wrap PNG in ICO ---
const ico = Buffer.alloc(6 + 16)
ico.writeUInt16LE(0, 0)
ico.writeUInt16LE(1, 2)
ico.writeUInt16LE(1, 4)
ico[6] = 0
ico[7] = 0 // 0 = 256px
ico[8] = 0
ico[9] = 0
ico.writeUInt16LE(1, 10)
ico.writeUInt16LE(32, 12)
ico.writeUInt32LE(png.length, 14)
ico.writeUInt32LE(6 + 16, 18)
writeFileSync('build/icon.ico', Buffer.concat([ico, png]))
writeFileSync('resources/icon.png', png) // dev-mode BrowserWindow icon
console.log('wrote build/icon.ico + resources/icon.png (256x256)')
