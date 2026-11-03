import assert from 'node:assert/strict'
import test, { beforeEach } from 'node:test'

import { fitAttachments, formatBytes, previewKind, setServerLimits } from './attachments.js'

const MB = 1024 * 1024
// Today's advertised values (GET /server `limits`).
const MAX_ATTACHMENT_BYTES = 25 * MB
const MAX_MESSAGE_UPLOAD_BYTES = 100 * MB
const MAX_ATTACHMENTS_PER_MESSAGE = 10

beforeEach(() =>
  setServerLimits({
    attachment_bytes: MAX_ATTACHMENT_BYTES,
    message_upload_bytes: MAX_MESSAGE_UPLOAD_BYTES,
    attachments_per_message: MAX_ATTACHMENTS_PER_MESSAGE
  })
)
const file = (name, size) => ({ name, size })
const pending = (...sizes) => sizes.map((size, i) => ({ file: file(`p${i}`, size) }))

test('formatBytes picks a readable unit', () => {
  assert.equal(formatBytes(512), '512 B')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(25 * MB), '25.0 MB')
  assert.equal(formatBytes(151.9 * MB), '152 MB')
  assert.equal(formatBytes(undefined), '')
})

test('fitAttachments rejects a file over the per-file limit', () => {
  const big = file('archive.zip', 151.9 * MB)
  const { accepted, rejected } = fitAttachments([], [big])
  assert.deepEqual(accepted, [])
  assert.equal(rejected.length, 1)
  assert.match(rejected[0].reason, /archive\.zip is 152 MB; files can be at most 25\.0 MB/)
})

test('fitAttachments accepts a file exactly at the per-file limit', () => {
  const edge = file('edge.bin', MAX_ATTACHMENT_BYTES)
  assert.deepEqual(fitAttachments([], [edge]).accepted, [edge])
})

test('fitAttachments counts pending attachments toward the message total', () => {
  const sizes = Array(4).fill(MAX_ATTACHMENT_BYTES)
  const { accepted, rejected } = fitAttachments(pending(...sizes), [file('one-more', 1)])
  assert.equal(4 * MAX_ATTACHMENT_BYTES, MAX_MESSAGE_UPLOAD_BYTES)
  assert.deepEqual(accepted, [])
  assert.match(rejected[0].reason, /upload limit/)
})

test('fitAttachments caps the file count and keeps what fits', () => {
  const existing = pending(...Array(MAX_ATTACHMENTS_PER_MESSAGE - 1).fill(1))
  const { accepted, rejected } = fitAttachments(existing, [file('a', 1), file('b', 1)])
  assert.deepEqual(
    accepted.map((f) => f.name),
    ['a']
  )
  assert.equal(rejected[0].file.name, 'b')
})

test('previewKind recognises markdown and text by extension or type', () => {
  assert.equal(previewKind('README.md', 'application/octet-stream'), 'markdown')
  assert.equal(previewKind('notes', 'text/markdown; charset=utf-8'), 'markdown')
  assert.equal(previewKind('notes.TXT', ''), 'text')
  assert.equal(previewKind('main.rs', 'application/octet-stream'), 'text')
  assert.equal(previewKind('data', 'application/json'), 'text')
  assert.equal(previewKind('archive.zip', 'application/zip'), null)
  assert.equal(previewKind('photo.png', 'image/png'), null)
})
