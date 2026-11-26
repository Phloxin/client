// The shell's side of the activity bridge: the srcdoc a bundle runs in, and the checks on what
// a bundle posts. Pure.

import { MAX_CONTROL_BODY, encodeAction } from './frames.js'

// The bundle document's own policy: no network, inline code only, images from anywhere.
export const BUNDLE_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src http: https: data:"

// The client's CSS variables (CSS-ARCHITECTURE.md) the bundles use, sent as `theme`. The bundle
// test keeps this list and the bundles' CSS in step.
export const THEME_VARS = [
  '--color-background',
  '--color-background-soft',
  '--color-background-mute',
  '--color-surface',
  '--color-text',
  '--color-text-secondary',
  '--color-text-tertiary',
  '--color-primary',
  '--color-primary-hover',
  '--color-success',
  '--color-danger',
  '--color-border',
  '--color-border-light',
  '--font-family-primary',
  '--border-radius-sm',
  '--border-radius-md'
]

const MAX_ID = 2 ** 32 - 1

const ASSET_TAG =
  /<link\s+rel="stylesheet"\s+href="([^"]+)"\s*\/?>|<script\s+src="([^"]+)"\s*><\/script>/g

// The srcdoc for a bundle: its index.html with every stylesheet link and script it references
// inlined from `files` (path as written in index.html -> text), and the CSP meta tag first in
// <head>. Throws on a reference `files` lacks, on a file that would close its own tag, and on an
// index.html without <head>.
export function buildSrcdoc(html, files) {
  if (!/<head>/i.test(html)) throw new Error('A bundle index.html needs a <head>')
  const inlined = html.replace(ASSET_TAG, (_tag, css, js) => {
    const path = css ?? js
    const text = files[path]
    if (typeof text !== 'string') throw new Error(`The bundle does not ship ${path}`)
    const tag = css ? 'style' : 'script'
    if (new RegExp(`</${tag}`, 'i').test(text)) throw new Error(`${path} contains </${tag}`)
    return `<${tag}>${text}</${tag}>`
  })
  return inlined.replace(
    /<head>/i,
    () => `<head><meta http-equiv="Content-Security-Policy" content="${BUNDLE_CSP}">`
  )
}

const drop = (why) => ({ type: 'drop', why })

// The ops of the `player` capability, and the limits they are checked against.
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/
const MAX_POSITION_MS = 86_400_000
const RATES = new Set([25, 50, 75, 100, 125, 150, 175, 200])
const isPosition = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_POSITION_MS
const isLength = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0
const isVideoId = (v) => typeof v === 'string' && VIDEO_ID.test(v)
const isId = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_ID

function readPlayerOp(data) {
  const player = (fields) => ({ type: 'player', op: data.op, ...fields })
  switch (data.op) {
    case 'place': {
      if (data.rect === null) return player({ rect: null })
      const r = data.rect
      if (!r || typeof r !== 'object' || ![r.x, r.y, r.width, r.height].every(isLength)) {
        return drop('player place rect is not null or four finite numbers that are not negative')
      }
      return player({ rect: { x: r.x, y: r.y, width: r.width, height: r.height } })
    }
    case 'load':
      if (!isVideoId(data.videoId)) return drop('player load videoId is not a video id')
      if (!isPosition(data.startMs)) return drop('player load startMs is not a position')
      if (typeof data.play !== 'boolean') return drop('player load play is not a boolean')
      return player({ videoId: data.videoId, startMs: data.startMs, play: data.play })
    case 'play':
    case 'pause':
    case 'unload':
      return player({})
    case 'seek':
      if (!isPosition(data.positionMs)) return drop('player seek positionMs is not a position')
      return player({ positionMs: data.positionMs })
    case 'volume':
      if (!isLength(data.volume) || data.volume > 100) return drop('player volume is not 0 to 100')
      if (typeof data.muted !== 'boolean') return drop('player volume muted is not a boolean')
      return player({ volume: data.volume, muted: data.muted })
    case 'rate':
      if (!RATES.has(data.rate)) return drop('player rate is not one of the eight')
      return player({ rate: data.rate })
    case 'captions':
      if (typeof data.on !== 'boolean') return drop('player captions on is not a boolean')
      return player({ on: data.on })
    case 'describe':
      if (!isId(data.id)) return drop('player describe id is not an integer from 0 to 2^32 - 1')
      if (!isVideoId(data.videoId)) return drop('player describe videoId is not a video id')
      return player({ id: data.id, videoId: data.videoId })
    default:
      return drop(`unknown player op ${String(data.op).slice(0, 40)}`)
  }
}

// The `export` capability: a PNG the bundle made, to save or share under a plain name.
export const MAX_EXPORT_BYTES = 8 * 1024 * 1024
const EXPORT_OPS = new Set(['save', 'share'])
const PNG_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,95}\.png$/
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

// An export the shell can answer, as it is, or with `refused` saying which check it failed.
function readExport(data) {
  if (!isId(data.id)) return drop('export id is not an integer from 0 to 2^32 - 1')
  const refuse = (why) => ({ type: 'export', id: data.id, refused: why })
  if (!EXPORT_OPS.has(data.op)) return refuse('export op is not save or share')
  if (typeof data.name !== 'string' || !PNG_NAME.test(data.name)) {
    return refuse('export name is not a plain .png name')
  }
  if (!(data.data instanceof Uint8Array)) return refuse('export data is not a Uint8Array')
  if (data.data.length > MAX_EXPORT_BYTES) return refuse('export data is over 8 MiB')
  if (!PNG_SIGNATURE.every((byte, i) => data.data[i] === byte)) {
    return refuse('export data is not a PNG')
  }
  return { type: 'export', op: data.op, id: data.id, name: data.name, data: data.data }
}

// A message a bundle with `capabilities` posted, checked: { type: 'ready' | 'action' | 'input' |
// 'status' | 'player' | 'fullscreen' | 'export', ... }, or { type: 'drop', why } for anything
// malformed, which the shell drops with a warning.
export function readUiMessage(data, capabilities = []) {
  if (!data || typeof data !== 'object') return drop('not an object')
  switch (data.type) {
    case 'ready':
      return { type: 'ready' }
    case 'action':
      if (!Number.isInteger(data.id) || data.id < 0 || data.id > MAX_ID) {
        return drop('action id is not an integer from 0 to 2^32 - 1')
      }
      if (!encodeAction(0, data.data)) return drop('action data is not a JSON value')
      return { type: 'action', id: data.id, data: data.data }
    case 'input':
      if (!(data.data instanceof Uint8Array)) return drop('input data is not a Uint8Array')
      return { type: 'input', data: data.data }
    case 'status':
      if (typeof data.busy !== 'boolean') return drop('status busy is not a boolean')
      return { type: 'status', busy: data.busy }
    case 'player':
      return readPlayerOp(data)
    case 'fullscreen':
      if (typeof data.on !== 'boolean') return drop('fullscreen on is not a boolean')
      return { type: 'fullscreen', on: data.on }
    case 'export':
      if (!capabilities.includes('export')) {
        return drop('export from a bundle without the capability')
      }
      return readExport(data)
    default:
      return drop(`unknown type ${String(data.type).slice(0, 40)}`)
  }
}

// The control frame for an action under the shell's own id, { frame } or { tooLarge: true } when
// its body is over what the server takes.
export function actionFrame(wireId, data) {
  const action = encodeAction(wireId, data)
  if (!action) return null
  return action.body > MAX_CONTROL_BODY ? { tooLarge: true } : { frame: action.frame }
}

// Room client ids as the bridge's [{ id, name, avatar }], from the roster.
export function bridgeClients(ids, roster) {
  return (ids || []).map((id) => {
    const c = roster?.find((x) => String(x.id) === String(id))
    return { id: String(id), name: c?.name || 'Unknown', avatar: c?.avatar || null }
  })
}

// The THEME_VARS values from a computed style's getPropertyValue.
export function themeValues(getPropertyValue) {
  return Object.fromEntries(THEME_VARS.map((name) => [name, getPropertyValue(name).trim()]))
}
