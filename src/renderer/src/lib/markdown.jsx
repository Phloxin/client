import { useMemo } from 'react'
import SimpleMarkdown from 'simple-markdown'
import hljs from 'highlight.js/lib/core'
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import python from 'highlight.js/lib/languages/python'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import xml from 'highlight.js/lib/languages/xml'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import sql from 'highlight.js/lib/languages/sql'
import mdLang from 'highlight.js/lib/languages/markdown'
import yaml from 'highlight.js/lib/languages/yaml'
import 'highlight.js/styles/github-dark.css'

// Discord-flavoured restricted markdown, built on simple-markdown (the same
// engine Discord's chat markdown uses). We keep only chat-appropriate rules —
// headings, bold/italic/underline/strike, inline code, fenced code blocks,
// blockquotes, and links — deliberately excluding images, tables, and raw HTML.
//
// We use simple-markdown only to *parse* (text → AST) and render the AST to
// React ourselves with real JSX. simple-markdown's own react output hand-builds
// element objects with an older React `$$typeof`, which React 19 rejects;
// rendering via JSX here goes through the app's own React 19 runtime instead.
//
// XSS-safe by construction: output is React elements (no dangerouslySetInnerHTML
// on raw user text), link targets pass through sanitizeUrl, and the one HTML
// injection — highlight.js output — is safe because hljs HTML-escapes the code.

// Register a focused language set (each also registers its own aliases, e.g.
// js → javascript, py → python, sh → bash, html → xml).
for (const [name, lang] of [
  ['javascript', javascript], ['typescript', typescript], ['python', python],
  ['json', json], ['bash', bash], ['css', css], ['xml', xml], ['rust', rust],
  ['go', go], ['java', java], ['c', c], ['cpp', cpp], ['csharp', csharp],
  ['sql', sql], ['markdown', mdLang], ['yaml', yaml]
]) {
  hljs.registerLanguage(name, lang)
}

const d = SimpleMarkdown.defaultRules

const rules = {
  // Block-level
  heading: d.heading,
  codeBlock: d.codeBlock,
  fence: d.fence,
  blockQuote: d.blockQuote,
  table: d.table,
  nptable: d.nptable,
  newline: d.newline,
  paragraph: d.paragraph,
  // Inline
  escape: d.escape,
  autolink: d.autolink,
  url: d.url,
  link: d.link,
  strong: d.strong,
  em: d.em,
  u: d.u,
  del: d.del,
  inlineCode: d.inlineCode,
  br: d.br,
  text: d.text
}

const parser = SimpleMarkdown.parserFor(rules)

// A fenced code block, syntax-highlighted when its language is known. Falls back
// to plain (React-escaped) text otherwise. Memoized so highlighting only runs
// when the code/lang change.
function CodeBlock({ code, lang }) {
  const highlighted = useMemo(() => {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        return null
      }
    }
    return null
  }, [code, lang])

  return (
    <pre>
      {highlighted != null ? (
        // Safe: hljs.highlight HTML-escapes `code`; only its own <span> wrappers
        // are added.
        <code className={`hljs language-${lang}`} dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code className="hljs">{code}</code>
      )}
    </pre>
  )
}

function renderNodes(nodes) {
  if (nodes == null) return null
  if (typeof nodes === 'string') return nodes
  return nodes.map((node, i) => renderNode(node, i))
}

function renderNode(node, key) {
  switch (node.type) {
    case 'text':
      return node.content
    case 'strong':
      return <strong key={key}>{renderNodes(node.content)}</strong>
    case 'em':
      return <em key={key}>{renderNodes(node.content)}</em>
    case 'u':
      return <u key={key}>{renderNodes(node.content)}</u>
    case 'del':
      return <del key={key}>{renderNodes(node.content)}</del>
    case 'inlineCode':
      return <code key={key} className="chat-inline-code">{node.content}</code>
    case 'br':
      return <br key={key} />
    case 'newline':
      return null
    case 'heading': {
      // Discord caps headings at three sizes.
      const level = Math.min(node.level || 1, 3)
      return (
        <div key={key} className={`chat-md-heading chat-md-h${level}`}>
          {renderNodes(node.content)}
        </div>
      )
    }
    case 'link':
      return (
        <a
          key={key}
          href={SimpleMarkdown.sanitizeUrl(node.target) ?? '#'}
          target="_blank"
          rel="noreferrer noopener"
          className="chat-link"
        >
          {renderNodes(node.content)}
        </a>
      )
    case 'codeBlock':
      return <CodeBlock key={key} code={node.content} lang={node.lang} />
    case 'blockQuote':
      return <blockquote key={key}>{renderNodes(node.content)}</blockquote>
    case 'table':
      return (
        <table key={key} className="chat-md-table">
          <thead>
            <tr>
              {node.header.map((cell, ci) => (
                <th key={ci} style={node.align[ci] ? { textAlign: node.align[ci] } : undefined}>
                  {renderNodes(cell)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {node.cells.map((row, ri) => (
              <tr key={ri}>
                {row.map((cell, ci) => (
                  <td key={ci} style={node.align[ci] ? { textAlign: node.align[ci] } : undefined}>
                    {renderNodes(cell)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
    case 'paragraph':
      return (
        <div key={key} className="paragraph">
          {renderNodes(node.content)}
        </div>
      )
    default:
      return typeof node.content === 'string' ? node.content : renderNodes(node.content)
  }
}

// Which block construct (if any) a line starts. Headings cap at 3 '#'s (Discord),
// and require either a space, end-of-line, or a non-'#' char after them.
function blockKind(line) {
  if (/^ *#{1,3}(?: |$|[^#])/.test(line)) return 'heading'
  if (/^ *>/.test(line)) return 'quote'
  return null
}

// A table's alignment/separator row, e.g. `| --- | :--: |` or `--- | ---`.
function isTableSeparator(line) {
  return /^ *\|?[ :|-]*-[ :|-]*\|? *$/.test(line) && line.includes('-')
}

// Discord treats a single newline before a block construct (heading, blockquote)
// as a block boundary, but CommonMark/simple-markdown require a blank line. Bridge
// the gap by inserting blank lines around those constructs — skipping fenced code
// so code contents are never touched. Consecutive blockquote lines stay grouped.
function normalizeBlocks(source) {
  const lines = source.split('\n')
  const out = []
  let inFence = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }

    let kind = blockKind(line)
    const next = i + 1 < lines.length ? lines[i + 1] : null
    const prevKind = i > 0 ? blockKind(lines[i - 1]) : null
    const blankAbove = out.length === 0 || out[out.length - 1].trim() === ''
    // A table's first line is its header — detected by the separator row beneath.
    if (!kind && line.includes('|') && next !== null && isTableSeparator(next)) {
      kind = 'tableStart'
    }

    if (kind === 'heading') {
      if (!blankAbove) out.push('')
      out.push(line)
      if (next !== null && next.trim() !== '') out.push('')
    } else if (kind === 'tableStart') {
      // Only the boundary before the table needs adding; its rows follow inline.
      if (!blankAbove) out.push('')
      out.push(line)
    } else if (kind === 'quote') {
      // Only pad the start/end of a quote group, so multi-line quotes stay intact.
      if (!blankAbove && prevKind !== 'quote') out.push('')
      out.push(line)
      if (next !== null && next.trim() !== '' && blockKind(next) !== 'quote') out.push('')
    } else {
      out.push(line)
    }
  }

  return out.join('\n')
}

// Parse a message string into React nodes. Soft (single) newlines are preserved
// by the .chat-message-text { white-space: pre-wrap } styling; blank lines split
// paragraphs.
export function renderMarkdown(source) {
  if (!source) return null
  // Normalize block spacing (Discord-style), then add the trailing blank line
  // simple-markdown's block grammar expects.
  const tree = parser(`${normalizeBlocks(source)}\n\n`, { inline: false })
  return renderNodes(tree)
}
