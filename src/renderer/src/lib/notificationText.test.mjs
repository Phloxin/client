// The words in a desktop notification (notificationText.js).
//   node --test src/renderer/src/lib/notificationText.test.mjs
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONNECTION_LOST_TITLE,
  TITLE_MAX,
  callBody,
  callTitle,
  channelJoinTitle,
  clipText,
  connectionLostBody,
  dmTitle,
  mentionTitle,
  messagePreview,
  pokeTitle,
  removedTitle,
  roleTitle,
  streamStartedTitle
} from './notificationText.js'

const names = { 1: 'Alice', 22: 'Bob' }
const nameOf = (id) => names[id]

test('mentions read as names, an unknown id as @unknown', () => {
  assert.equal(messagePreview('hey <@1> and <@22>', { nameOf }), 'hey @Alice and @Bob')
  assert.equal(messagePreview('ping <@999>', { nameOf }), 'ping @unknown')
  assert.equal(messagePreview('ping <@1>'), 'ping @unknown')
  assert.equal(messagePreview('@everyone look', { nameOf }), '@everyone look')
})

test('a name is not read as markdown', () => {
  const odd = { 5: '__init__' }
  assert.equal(messagePreview('hi <@5>', { nameOf: (id) => odd[id] }), 'hi @__init__')
})

test('the inline markdown the chat draws is removed', () => {
  assert.equal(messagePreview('**bold** *em* _em_ __under__ ~~gone~~', {}), 'bold em em under gone')
  assert.equal(messagePreview('run `npm test` now'), 'run npm test now')
  assert.equal(messagePreview('see [the docs](https://example.com/docs)'), 'see the docs')
  assert.equal(messagePreview('<https://example.com>'), 'https://example.com')
  assert.equal(messagePreview('a \\*literal\\* star'), 'a *literal* star')
  assert.equal(messagePreview('***both***'), 'both')
})

test('markers the chat shows as written stay', () => {
  assert.equal(messagePreview('snake_case_name'), 'snake_case_name')
  assert.equal(messagePreview('a ~ b'), 'a ~ b')
  assert.equal(messagePreview('# Heading'), '# Heading')
  assert.equal(messagePreview('> quoted'), '> quoted')
})

test('code blocks and diagrams read as one word', () => {
  assert.equal(messagePreview('look:\n```js\nconst a = 1\n```\nok'), 'look: [code] ok')
  assert.equal(messagePreview('```\nplain\n```'), '[code]')
  assert.equal(messagePreview('~~~py\nx = 1\n~~~'), '[code]')
  assert.equal(messagePreview('```mermaid\ngraph TD\nA-->B\n```'), '[diagram]')
  assert.equal(messagePreview('```Mermaid\ngraph TD\n```'), '[diagram]')
  assert.equal(
    messagePreview('one\n```\na\n```\ntwo\n```mermaid\nb\n```'),
    'one [code] two [diagram]'
  )
})

test('whitespace collapses', () => {
  assert.equal(messagePreview('  line one\n\n  line two\tend  '), 'line one line two end')
  assert.equal(messagePreview('soft  \nbreak'), 'soft break')
})

test('long text is cut at a character boundary with an ellipsis', () => {
  const long = 'word '.repeat(60)
  const cut = messagePreview(long)
  assert.equal(cut.endsWith('…'), true)
  assert.equal(Array.from(cut).length <= 120, true)
  assert.equal(messagePreview('x'.repeat(120)), 'x'.repeat(120))
  assert.equal(messagePreview('x'.repeat(121)), `${'x'.repeat(119)}…`)
  // Emoji (with a skin tone, one character as a person sees it) are never split.
  const thumbs = '👍🏽'.repeat(10)
  assert.equal(messagePreview(thumbs, { max: 5 }), `${'👍🏽'.repeat(4)}…`)
  assert.equal(clipText('abc', 3), 'abc')
  assert.equal(clipText('abcd', 3), 'ab…')
})

test('a message with only files says how many', () => {
  assert.equal(messagePreview('', { attachments: [{ id: 1 }] }), 'Sent a file')
  assert.equal(messagePreview('   ', { attachments: [{}, {}, {}] }), 'Sent 3 files')
  assert.equal(messagePreview(null, { attachments: 2 }), 'Sent 2 files')
  // Text wins over the files.
  assert.equal(messagePreview('look', { attachments: [{}] }), 'look')
})

test('an empty message (a poke without text) has an empty preview', () => {
  assert.equal(messagePreview(''), '')
  assert.equal(messagePreview(undefined), '')
  assert.equal(messagePreview('', { attachments: [] }), '')
  assert.equal(pokeTitle('Alice'), 'Alice poked you')
})

test('titles for each event', () => {
  assert.equal(dmTitle('Alice'), 'Alice')
  assert.equal(dmTitle('Alice', 'Game night'), 'Alice in Game night')
  assert.equal(mentionTitle('Alice', 'general'), 'Alice mentioned you in #general')
  assert.equal(
    mentionTitle('Alice', 'general', { everyone: true }),
    'Alice mentioned @everyone in #general'
  )
  assert.equal(callTitle('Bob'), 'Bob is calling you')
  assert.equal(callBody('Game night'), 'Game night')
  assert.equal(callBody(''), 'Direct call')
  assert.equal(removedTitle('Pylon HQ'), 'You were kicked from Pylon HQ')
  assert.equal(removedTitle('Pylon HQ', { banned: true }), 'You were banned from Pylon HQ')
  assert.equal(CONNECTION_LOST_TITLE, 'Connection lost')
  assert.equal(connectionLostBody('Pylon HQ'), 'Reconnecting to Pylon HQ…')
  assert.equal(channelJoinTitle('Bob', 'Lobby'), 'Bob joined Lobby')
  assert.equal(streamStartedTitle('Bob'), 'Bob started streaming')
  assert.equal(roleTitle('Moderator', { given: true }), 'You were given Moderator')
  assert.equal(roleTitle('Moderator', { given: false }), 'Moderator was removed from you')
})

test('titles stand in for missing names and stay within the limit', () => {
  assert.equal(dmTitle(undefined), 'Someone')
  assert.equal(pokeTitle(''), 'Someone poked you')
  assert.equal(mentionTitle('Alice', undefined), 'Alice mentioned you in a channel')
  const long = mentionTitle('A'.repeat(200), 'general')
  assert.equal(Array.from(long).length, TITLE_MAX)
  assert.equal(long.endsWith('…'), true)
})
