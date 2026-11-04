import { useEffect, useState, useSyncExternalStore } from 'react'

// ```mermaid fenced blocks in messages, rendered to SVG. Mermaid itself is
// imported on the first diagram so the chat bundle doesn't carry it.

const CACHE_LIMIT = 200
// `${themeId}\n${code}` → the SVG string, or the pending render's promise.
const cache = new Map()
let mermaidModule = null
let configuredTheme = null
let nextId = 0
// Renders run one at a time so a theme's initialize() can't land mid-render.
let queue = Promise.resolve()

const readTheme = () => document.documentElement.getAttribute('data-theme')
const themeListeners = new Set()
new MutationObserver(() => themeListeners.forEach((notify) => notify())).observe(
  document.documentElement,
  { attributeFilter: ['data-theme'] }
)
const subscribeTheme = (notify) => {
  themeListeners.add(notify)
  return () => themeListeners.delete(notify)
}

// WCAG relative luminance of a #rrggbb colour.
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function mermaidConfig() {
  const css = getComputedStyle(document.documentElement)
  const v = (name) => css.getPropertyValue(name).trim()
  const canvas = v('--color-background-soft')
  const node = v('--color-background-mute')
  const surface = v('--color-surface')
  const text = v('--color-text')
  const border = v('--hairline-strong')
  const line = v('--color-text-tertiary')
  const fontFamily = v('--font-family-primary')
  return {
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    layout: 'dagre',
    fontFamily,
    themeVariables: {
      background: canvas,
      edgeLabelBackground: canvas,
      tertiaryColor: canvas,
      primaryColor: node,
      mainBkg: node,
      nodeBkg: node,
      secondaryColor: surface,
      clusterBkg: surface,
      primaryTextColor: text,
      textColor: text,
      nodeTextColor: text,
      primaryBorderColor: border,
      nodeBorder: border,
      clusterBorder: border,
      lineColor: line,
      signalColor: line,
      fontFamily,
      darkMode: luminance(canvas) < 0.5
    }
  }
}

async function draw(code) {
  const { default: mermaid } = await (mermaidModule ??= import('mermaid'))
  const theme = readTheme()
  if (configuredTheme !== theme) {
    mermaid.initialize(mermaidConfig())
    configuredTheme = theme
  }
  const id = `mermaid-${++nextId}`
  try {
    return (await mermaid.render(id, code)).svg
  } catch (err) {
    // On a syntax error Mermaid leaves its error graphic in <body>.
    document.getElementById(`d${id}`)?.remove()
    document.getElementById(id)?.remove()
    throw err
  }
}

// family → data: URL of its latin woff2, for SVGs shown outside the page.
const embeddedFonts = new Map()

async function loadFontDataUrl(family) {
  for (const sheet of document.styleSheets) {
    let rules
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    for (const rule of rules) {
      if (!(rule instanceof CSSFontFaceRule)) continue
      if (rule.style.getPropertyValue('font-family').replace(/["']/g, '') !== family) continue
      const range = rule.style.getPropertyValue('unicode-range')
      if (range && !range.startsWith('U+0000') && !range.startsWith('U+0-')) continue
      const src = /url\(["']?([^"')]+)/.exec(rule.style.getPropertyValue('src'))?.[1]
      if (!src) continue
      const res = await fetch(new URL(src, sheet.href ?? document.baseURI))
      if (!res.ok) throw new Error(`${res.status} for ${src}`)
      return `data:font/woff2;base64,${new Uint8Array(await res.arrayBuffer()).toBase64()}`
    }
  }
  throw new Error(`No latin @font-face for ${family}`)
}

function fontDataUrl(family) {
  if (!embeddedFonts.has(family)) {
    const pending = loadFontDataUrl(family)
    pending.catch(() => embeddedFonts.delete(family))
    embeddedFonts.set(family, pending)
  }
  return embeddedFonts.get(family)
}

// An <img> or a downloaded file can't reach the page's web fonts, and a
// fallback font overflows the label boxes Mermaid measured, so embed the UI font.
async function standaloneSvg(svg) {
  const family = /font-family:([^,;}]+)/
    .exec(svg)?.[1]
    .trim()
    .replace(/^["']|["']$/g, '')
  try {
    const font = await fontDataUrl(family)
    return svg.replace(
      '<style>',
      `<style>@font-face{font-family:"${family}";src:url(${font}) format('woff2');font-weight:100 900;}`
    )
  } catch {
    return svg
  }
}

const cacheKey = (themeId, code) => `${themeId}\n${code}`

function diagramSvg(themeId, code) {
  const key = cacheKey(themeId, code)
  if (cache.has(key)) return cache.get(key)
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
  const pending = queue
    .then(() => draw(code))
    .then(
      (svg) => {
        // Rendered after a theme switch: right SVG, wrong colours for this key.
        if (cache.get(key) === pending) {
          if (readTheme() === themeId) cache.set(key, svg)
          else cache.delete(key)
        }
        return svg
      },
      (err) => {
        if (cache.get(key) === pending) cache.delete(key)
        throw err
      }
    )
  queue = pending.catch(() => {})
  cache.set(key, pending)
  return pending
}

// eslint-disable-next-line react/prop-types -- The renderer does not use runtime PropTypes.
export function MermaidBlock({ code, onOpen }) {
  const themeId = useSyncExternalStore(subscribeTheme, readTheme)
  const key = cacheKey(themeId, code)
  // { key, svg } or { key, failed: true } once this block's render settles.
  const [result, setResult] = useState(null)
  const cached = cache.get(key)
  const svg = typeof cached === 'string' ? cached : result?.key === key ? result.svg : null

  useEffect(() => {
    if (typeof cache.get(key) === 'string') return
    let cancelled = false
    diagramSvg(themeId, code).then(
      (svg) => !cancelled && setResult({ key, svg }),
      () => !cancelled && setResult({ key, failed: true })
    )
    return () => {
      cancelled = true
    }
  }, [key, themeId, code])

  if (svg) {
    const open = async () => {
      const standalone = await standaloneSvg(svg)
      onOpen({
        url: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(standalone)}`,
        name: 'diagram.svg'
      })
    }
    return (
      <div
        className={`chat-mermaid${onOpen ? ' zoomable' : ''}`}
        onClick={onOpen ? open : undefined}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    )
  }
  return (
    <>
      <pre>
        <code className="hljs">{code}</code>
      </pre>
      {result?.key === key && result.failed && (
        <div className="chat-mermaid-error">Couldn&apos;t render diagram</div>
      )}
    </>
  )
}
