// Generates the Windows system-tray state icons (mic idle/talking/muted +
// headphones/deafened) as 32x32 RGBA PNGs, with no image dependencies — pure
// SDF rasterization + a minimal zlib-backed PNG encoder. Re-run after tweaking
// shapes/colours:  node scripts/gen-tray-icons.mjs
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const SIZE = 32
const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'tray')

// ── tiny vector helpers ──────────────────────────────────────────────
const len = (x, y) => Math.hypot(x, y)
// Signed distance to an axis-aligned rounded rectangle.
function sdRoundRect(px, py, cx, cy, hx, hy, r) {
  const qx = Math.abs(px - cx) - (hx - r)
  const qy = Math.abs(py - cy) - (hy - r)
  return len(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
// Distance to a line segment a→b.
function sdSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax
  const dy = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)))
  return len(px - (ax + t * dx), py - (ay + t * dy))
}
// ~1px anti-aliased coverage from a signed distance (negative = inside).
const cover = (d) => Math.min(1, Math.max(0, 0.5 - d))

// ── glyph signed-distance fields (32px space) ────────────────────────
// Modelled on the Tabler "microphone" glyph (hollow capsule + pickup arc +
// stem + base, all stroked), scaled to fill the 32px frame. T = half stroke.
const T = 1.7
function micDist(x, y, filled = false) {
  // capsule head — solid when `filled` (talking), else a hollow outline
  const box = sdRoundRect(x, y, 16, 10.5, 4.35, 7.95, 4.35)
  const capsule = filled ? box - T : Math.abs(box) - T
  // U-shaped pickup arc: bottom half of a ring under the capsule
  let arc = Math.abs(len(x - 16, y - 14) - 10.1) - T
  if (y < 14) arc = 1e9
  const stem = sdSegment(x, y, 16, 24.1, 16, 30) - T // neck
  const base = sdSegment(x, y, 10.2, 30, 21.8, 30) - T // foot
  return Math.min(capsule, arc, stem, base)
}
function headphoneDist(x, y) {
  // Headband: top half of a ring; cups: rounded rects at each end.
  let band = Math.abs(len(x - 16, y - 16) - 11) - T
  if (y > 16) band = 1e9
  const leftCup = sdRoundRect(x, y, 6.5, 20, 2.4, 6, 2.4)
  const rightCup = sdRoundRect(x, y, 25.5, 20, 2.4, 6, 2.4)
  return Math.min(band, leftCup, rightCup)
}

// ── compositing ──────────────────────────────────────────────────────
function over(dst, i, r, g, b, a) {
  // straight-alpha "source over" onto dst[i..i+3]
  const da = dst[i + 3] / 255
  const oa = a + da * (1 - a)
  if (oa <= 0) return
  dst[i] = (r * a + dst[i] * da * (1 - a)) / oa
  dst[i + 1] = (g * a + dst[i + 1] * da * (1 - a)) / oa
  dst[i + 2] = (b * a + dst[i + 2] * da * (1 - a)) / oa
  dst[i + 3] = oa * 255
}

function render({ glyph, color, slash }) {
  const buf = new Uint8ClampedArray(SIZE * SIZE * 4) // transparent
  const [cr, cg, cb] = color
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4
      const px = x + 0.5
      const py = y + 0.5
      const gc = cover(glyph(px, py))
      if (gc > 0) over(buf, i, cr, cg, cb, gc)
      if (slash) {
        // dark outline first so the slash reads against the glyph, then the
        // coloured cut on top.
        const seg = sdSegment(px, py, 6, 6, 26, 26)
        over(buf, i, 24, 24, 30, cover(seg - 2.6))
        over(buf, i, cr, cg, cb, cover(seg - 1.3))
      }
    }
  }
  return Buffer.from(buf.buffer)
}

// ── minimal PNG encoder (RGBA, no filtering) ─────────────────────────
const CRC = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return (buf) => {
    let c = 0xffffffff
    for (const b of buf) c = t[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
})()
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(CRC(body))
  return Buffer.concat([len, body, crc])
}
function encodePng(rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type RGBA
  // raw scanlines, each prefixed with filter byte 0
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  for (let y = 0; y < SIZE; y++) {
    raw[y * (SIZE * 4 + 1)] = 0
    rgba.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ── the four state icons ─────────────────────────────────────────────
const IDLE = [200, 204, 212]
const GREEN = [59, 165, 93]
const RED = [237, 66, 69]
const icons = {
  'tray-idle': { glyph: micDist, color: IDLE },
  'tray-talking': { glyph: (x, y) => micDist(x, y, true), color: GREEN },
  'tray-muted': { glyph: micDist, color: RED, slash: true },
  'tray-deafened': { glyph: headphoneDist, color: RED, slash: true }
}

mkdirSync(OUT_DIR, { recursive: true })
for (const [name, spec] of Object.entries(icons)) {
  writeFileSync(join(OUT_DIR, `${name}.png`), encodePng(render(spec)))
  console.log('wrote', join(OUT_DIR, `${name}.png`))
}
