import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStreamFocus } from './streamView.js'

const stream = (clientId) => ({ clientId, consumerId: `c-${clientId}` })

test('no streams means nothing to focus and no toggle', () => {
  assert.deepEqual(resolveStreamFocus({ streams: [], selectedStreamClientId: 'a' }), {
    focusedClientId: null,
    canToggleFocus: false
  })
  assert.deepEqual(resolveStreamFocus(), { focusedClientId: null, canToggleFocus: false })
})

test('a sole stream is always focused and cannot be unfocused', () => {
  for (const selectedStreamClientId of [null, 'a', 'gone']) {
    assert.deepEqual(resolveStreamFocus({ streams: [stream('a')], selectedStreamClientId }), {
      focusedClientId: 'a',
      canToggleFocus: false
    })
  }
})

test('with several streams the live selection is focused', () => {
  assert.deepEqual(
    resolveStreamFocus({ streams: [stream('a'), stream('b')], selectedStreamClientId: 'b' }),
    { focusedClientId: 'b', canToggleFocus: true }
  )
})

test('with several streams and no selection the grid shows', () => {
  assert.deepEqual(
    resolveStreamFocus({ streams: [stream('a'), stream('b')], selectedStreamClientId: null }),
    { focusedClientId: null, canToggleFocus: true }
  )
})

test('a selection whose stream has gone falls back to the grid', () => {
  assert.deepEqual(
    resolveStreamFocus({
      streams: [stream('a'), stream('b'), stream('c')],
      selectedStreamClientId: 'gone'
    }),
    { focusedClientId: null, canToggleFocus: true }
  )
})

test('focus is keyed by client, so a new consumer id keeps it', () => {
  const streams = [{ clientId: 'a', consumerId: 'new-consumer' }, stream('b')]
  assert.equal(resolveStreamFocus({ streams, selectedStreamClientId: 'a' }).focusedClientId, 'a')
})
