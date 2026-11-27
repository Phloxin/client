// The words in a desktop notification (lib/osNotifications.js): a message's
// preview for the body, and the title for each kind of event. Pure.
//
// The preview strips the same inline markdown the chat renders (lib/markdown.jsx),
// by parsing with the same simple-markdown rules and keeping only the text, so a
// marker is dropped exactly when the chat would draw it and kept when it would
// show it as is (snake_case stays snake_case). Block syntax (headings, quotes,
// tables) is left as written, apart from fenced code.
import SimpleMarkdown from 'simple-markdown'

const d = SimpleMarkdown.defaultRules

// Main refuses a longer title (src/main/osNotifications.js), so titles are cut to it.
export const TITLE_MAX = 120

// `<@id>` and bare `@everyone`, matched as markdown.jsx matches them.
const mention = {
  order: d.autolink.order - 0.5,
  match: SimpleMarkdown.inlineRegex(/^<@(\d+)>/),
  parse: (capture, _parse, state) => ({
    name: state.nameOf?.(capture[1]) || 'unknown'
  })
}

const everyone = {
  order: mention.order,
  match: (source, _state, prevCapture) =>
    /(?:^|\s)$/.test(prevCapture) ? /^@everyone(?=\s|$)/.exec(source) : null,
  parse: () => ({})
}

// The inline rules of markdown.jsx.
const parseInline = SimpleMarkdown.parserFor({
  mention,
  everyone,
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
})

// A fenced code block, as simple-markdown's fence rule opens and closes one.
const FENCE = /^ *(`{3,}|~{3,}) *(?:(\S+) *)?\n[\s\S]+?\n?\1 *(?=\n|$)/gm

function plainText(nodes) {
  if (nodes == null) return ''
  if (typeof nodes === 'string') return nodes
  return nodes
    .map((node) => {
      switch (node.type) {
        case 'mention':
          return `@${node.name}`
        case 'everyone':
          return '@everyone'
        case 'br':
          return '\n'
        default:
          return typeof node.content === 'string' ? node.content : plainText(node.content)
      }
    })
    .join('')
}

const graphemes = (() => {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    return (text) => Array.from(segmenter.segment(text), (part) => part.segment)
  }
  return (text) => Array.from(text)
})()

// `text` cut to at most `max` characters (whole characters, so an emoji is never
// split), ending in "…" when it was cut.
export function clipText(text, max) {
  const chars = graphemes(text)
  if (chars.length <= max) return text
  return `${chars
    .slice(0, Math.max(0, max - 1))
    .join('')
    .trimEnd()}…`
}

// A message's text for a popup body: `<@id>` as `@name` (`nameOf(id)`, unknown ids
// as `@unknown`), fenced code as "[code]" and Mermaid as "[diagram]", inline
// markdown removed, whitespace collapsed, cut at `max` with "…". No text but
// `attachments` (an array or a count) reads "Sent a file" / "Sent N files".
export function messagePreview(content, { nameOf, attachments, max = 120 } = {}) {
  const source = String(content ?? '').replace(FENCE, (_block, _fence, lang) =>
    lang?.toLowerCase() === 'mermaid' ? '[diagram]' : '[code]'
  )
  const text = plainText(parseInline(source, { inline: true, nameOf }))
    .replace(/\s+/g, ' ')
    .trim()
  if (text) return clipText(text, max)
  const files = Array.isArray(attachments) ? attachments.length : Number(attachments) || 0
  if (files === 1) return 'Sent a file'
  if (files > 1) return `Sent ${files} files`
  return ''
}

const who = (name) => (typeof name === 'string' && name.trim() ? name : 'Someone')
const title = (text) => clipText(text, TITLE_MAX)

// Direct message: the author, or `author in <group>` for a named group DM.
export const dmTitle = (author, groupName) =>
  title(groupName ? `${who(author)} in ${groupName}` : who(author))

// Mention in a server channel; `everyone` for an @everyone.
export const mentionTitle = (author, channelName, { everyone = false } = {}) =>
  title(
    `${who(author)} mentioned ${everyone ? '@everyone' : 'you'} in ${
      channelName ? `#${channelName}` : 'a channel'
    }`
  )

export const pokeTitle = (author) => title(`${who(author)} poked you`)

// Incoming DM call: title, and the body (the group's name, else "Direct call").
export const callTitle = (caller) => title(`${who(caller)} is calling you`)
export const callBody = (groupName) => groupName || 'Direct call'

// Kicked (`banned` false) or banned from the server.
export const removedTitle = (serverName, { banned = false } = {}) =>
  title(`You were ${banned ? 'banned' : 'kicked'} from ${serverName || 'the server'}`)

// The events connection dropped: title, and the body naming the server.
export const CONNECTION_LOST_TITLE = 'Connection lost'
export const connectionLostBody = (serverName) => `Reconnecting to ${serverName || 'the server'}…`

export const channelJoinTitle = (name, channelName) =>
  title(`${who(name)} joined ${channelName || 'your channel'}`)

export const streamStartedTitle = (name) => title(`${who(name)} started streaming`)

// A server group (role) given to us (`given` true) or taken away.
export const roleTitle = (roleName, { given }) => {
  if (given) return title(`You were given ${roleName || 'a server group'}`)
  return title(`${roleName || 'A server group'} was removed from you`)
}
