import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_CLOSED,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  activePane,
  activeTab,
  canReopen,
  canSplit,
  createLayout,
  cycleTarget,
  isGroupTab,
  moveOrder,
  openChannelRefs,
  paneOf,
  splitFits,
  tabAtIndex,
  tabKey,
  tabsReducer,
  toPersisted
} from './tabs.js'

const run = (state, ...actions) => actions.reduce(tabsReducer, state)
const open = (kind, ref, extra = {}) => ({ type: 'open', content: { kind, ref }, ...extra })
const chat = (ref, extra) => open('chat', ref, extra)

// Each pane as strings: content key, then ^ pinned, ~ preview, * active.
function view(state) {
  return state.panes.map((pane) =>
    pane.tabIds.map((id) => {
      const tab = state.tabs[id]
      return (
        tabKey(tab) +
        (tab.pinned ? '^' : '') +
        (pane.previewTabId === id ? '~' : '') +
        (pane.activeTabId === id ? '*' : '')
      )
    })
  )
}

const idOf = (state, kind, ref = null, paneIndex) => {
  const panes = paneIndex == null ? state.panes : [state.panes[paneIndex]]
  for (const pane of panes) {
    const id = pane.tabIds.find((t) => state.tabs[t].kind === kind && state.tabs[t].ref === ref)
    if (id) return id
  }
  return undefined
}

// Opens and pins one chat tab per ref, leaving the last one active.
const pinned = (state, ...refs) =>
  refs.reduce((s, ref) => {
    const next = tabsReducer(s, chat(ref))
    return tabsReducer(next, { type: 'pin', tabId: idOf(next, 'chat', ref) })
  }, state)

const connect = (state, channelId, focus) =>
  tabsReducer(state, { type: 'setConnected', channelId, focus })

// The closed stack as content key @ saved index.
const closedOf = (state) => state.closed.map((e) => `${e.kind}:${e.ref ?? ''}@${e.index}`)

test('a new layout is one empty, active pane with nothing connected', () => {
  const s = createLayout()
  assert.equal(s.panes.length, 1)
  assert.deepEqual(view(s), [[]])
  assert.equal(s.activePaneId, s.panes[0].id)
  assert.equal(s.connected, null)
  assert.equal(activeTab(s), null)
})

test('tabKey identifies content, with no ref as empty', () => {
  assert.equal(tabKey({ kind: 'chat', ref: 'a' }), 'chat:a')
  assert.equal(tabKey({ kind: 'bans', ref: null }), 'bans:')
})

test('open puts content in a preview tab and activates it', () => {
  const s = run(createLayout(), chat('a'))
  assert.deepEqual(view(s), [['chat:a~*']])
  assert.equal(activeTab(s).ref, 'a')
})

test('the next open replaces the preview in place, keeping its id and slot', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') }, chat('c'))
  const previewId = idOf(s, 'chat', 'c')
  assert.deepEqual(view(s), [['chat:a^', 'chat:c~*', 'chat:b^']])
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'b') }, open('client', 'u1'))
  assert.deepEqual(view(s), [['chat:a^', 'client:u1~*', 'chat:b^']])
  assert.equal(idOf(s, 'client', 'u1'), previewId)
})

test('opening content the pane already holds activates that tab instead', () => {
  let s = pinned(createLayout(), 'a')
  s = run(s, chat('b'), chat('a'))
  assert.deepEqual(view(s), [['chat:a^*', 'chat:b~']])
  s = run(s, chat('b'))
  assert.deepEqual(view(s), [['chat:a^', 'chat:b~*']])
  // Already active: nothing changes.
  assert.equal(run(s, chat('b')), s)
})

test('after a pin the next open makes a fresh preview right of the active tab', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') }, chat('d'))
  assert.deepEqual(view(s), [['chat:a^', 'chat:d~*', 'chat:b^', 'chat:c^']])
})

test('open with pinned pins what it opened', () => {
  let s = run(createLayout(), chat('a', { pinned: true }))
  assert.deepEqual(view(s), [['chat:a^*']])
  s = run(s, chat('b'), chat('b', { pinned: true }))
  assert.deepEqual(view(s), [['chat:a^', 'chat:b^*']])
  // A preview of other content is replaced in place, then pinned.
  s = run(s, chat('c'), open('files', 'a', { pinned: true }))
  assert.deepEqual(view(s), [['chat:a^', 'chat:b^', 'files:a^*']])
})

test('content without a ref dedupes on kind alone', () => {
  let s = run(createLayout(), open('server-traffic'))
  s = run(s, { type: 'pin', tabId: idOf(s, 'server-traffic') }, open('server-traffic', null))
  assert.deepEqual(view(s), [['server-traffic:^*']])
})

test('Connection Info is one tab per pane', () => {
  let s = run(createLayout(), open('connection-info'), open('connection-info'))
  assert.deepEqual(view(s), [['connection-info:~*']])
  s = pinned(run(s, { type: 'pin', tabId: idOf(s, 'connection-info') }), 'a')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'a'), side: 'right' })
  s = run(s, open('connection-info'))
  assert.deepEqual(view(s), [['connection-info:^*'], ['chat:a^', 'connection-info:~*']])
})

test('open ignores unknown kinds, missing content and unknown panes', () => {
  const s = run(createLayout(), chat('a'))
  assert.equal(run(s, open('nope', 'x')), s)
  assert.equal(run(s, { type: 'open' }), s)
  assert.equal(run(s, chat('b', { paneId: 'nope' })), s)
})

test('a new preview never lands inside the connected group', () => {
  let s = connect(pinned(createLayout(), 'x'), 'v', 'chat')
  assert.equal(activeTab(s).kind, 'chat')
  s = run(s, chat('y'))
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:y~*', 'chat:x^']])
})

test('opening Streams focuses the group tab of that channel, and nothing else', () => {
  const plain = run(createLayout(), chat('a'))
  assert.equal(run(plain, open('streams', 'v')), plain)
  let s = connect(plain, 'v')
  assert.equal(run(s, open('streams', 'other')), s)
  s = run(s, open('streams', 'v'))
  assert.equal(activeTab(s).kind, 'streams')
})

test('pin clears the preview slot; pinning twice or a missing tab is a no-op', () => {
  let s = run(createLayout(), chat('a'))
  const id = idOf(s, 'chat', 'a')
  s = run(s, { type: 'pin', tabId: id })
  assert.deepEqual(view(s), [['chat:a^*']])
  assert.equal(s.panes[0].previewTabId, null)
  assert.equal(run(s, { type: 'pin', tabId: id }), s)
  assert.equal(run(s, { type: 'pin', tabId: 'nope' }), s)
})

test('unpin makes the tab the preview, closing the old preview first', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, chat('c'))
  s = run(s, { type: 'unpin', tabId: idOf(s, 'chat', 'a') })
  // The old preview was active, so its right neighbour takes over.
  assert.deepEqual(view(s), [['chat:a~', 'chat:b^*']])
  // With no other preview it just becomes the preview.
  s = run(
    s,
    { type: 'pin', tabId: idOf(s, 'chat', 'a') },
    { type: 'unpin', tabId: idOf(s, 'chat', 'b') }
  )
  assert.deepEqual(view(s), [['chat:a^', 'chat:b~*']])
})

test('unpin leaves unpinned, missing and connected-group tabs alone', () => {
  let s = run(createLayout(), chat('a'))
  assert.equal(run(s, { type: 'unpin', tabId: idOf(s, 'chat', 'a') }), s)
  assert.equal(run(s, { type: 'unpin', tabId: 'nope' }), s)
  s = connect(s, 'v')
  assert.equal(run(s, { type: 'unpin', tabId: s.connected.chatTabId }), s)
})

test('closing the active tab activates its right neighbour, else its left', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'b') })
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'b') })
  assert.deepEqual(view(s), [['chat:a^', 'chat:c^*']])
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'c') })
  assert.deepEqual(view(s), [['chat:a^*']])
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'a') })
  assert.deepEqual(view(s), [[]])
  assert.deepEqual(s.tabs, {})
  assert.equal(activeTab(s), null)
})

test('closing an inactive tab keeps the active one; closing the preview frees the slot', () => {
  let s = pinned(createLayout(), 'a')
  s = run(s, chat('b'), { type: 'activate', tabId: idOf(s, 'chat', 'a') })
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'b') })
  assert.deepEqual(view(s), [['chat:a^*']])
  assert.equal(s.panes[0].previewTabId, null)
})

test('close leaves connected-group tabs and unknown ids alone', () => {
  const s = connect(createLayout(), 'v')
  assert.equal(run(s, { type: 'close', tabId: s.connected.chatTabId }), s)
  assert.equal(run(s, { type: 'close', tabId: s.connected.streamsTabId }), s)
  assert.equal(run(s, { type: 'close', tabId: 'nope' }), s)
})

test('close others keeps the target and the group, and activates the target', () => {
  let s = connect(pinned(createLayout(), 'a', 'b'), 'v', 'chat')
  s = run(s, chat('c'))
  s = run(s, { type: 'closeOthers', tabId: idOf(s, 'chat', 'a') })
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:a^*']])
  assert.equal(run(s, { type: 'closeOthers', tabId: 'nope' }), s)
})

test('close to the right drops later tabs; an active casualty hands over to the target', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, { type: 'closeToRight', tabId: idOf(s, 'chat', 'a') })
  assert.deepEqual(view(s), [['chat:a^*']])
  // From inside the group, the group itself survives.
  s = connect(pinned(createLayout(), 'a'), 'v', 'chat')
  s = run(s, { type: 'closeToRight', tabId: s.connected.chatTabId })
  assert.deepEqual(view(s), [['chat:v^*', 'streams:v^']])
  assert.equal(run(s, { type: 'closeToRight', tabId: 'nope' }), s)
  // Nothing to the right: unchanged.
  assert.equal(run(s, { type: 'closeToRight', tabId: s.connected.streamsTabId }), s)
})

test('closing pushes the tab with its pane and index; reopen restores it pinned and active', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, chat('d'))
  const p = s.panes[0].id
  s = run(
    s,
    { type: 'close', tabId: idOf(s, 'chat', 'b') },
    { type: 'close', tabId: idOf(s, 'chat', 'd') }
  )
  assert.deepEqual(s.closed, [
    { kind: 'chat', ref: 'b', paneId: p, index: 1 },
    { kind: 'chat', ref: 'd', paneId: p, index: 2 }
  ])
  // The closed preview comes back pinned.
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') }, { type: 'reopen' })
  assert.deepEqual(view(s), [['chat:a^', 'chat:c^', 'chat:d^*']])
  s = run(s, { type: 'reopen' })
  assert.deepEqual(view(s), [['chat:a^', 'chat:b^*', 'chat:c^', 'chat:d^']])
  assert.deepEqual(s.closed, [])
  assert.equal(run(s, { type: 'reopen' }), s)
})

test('close others and close to the right push in strip order and reopen right to left', () => {
  let s = connect(pinned(createLayout(), 'a', 'b', 'c', 'd'), 'v', 'chat')
  s = run(s, { type: 'closeOthers', tabId: idOf(s, 'chat', 'b') })
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:b^*']])
  assert.deepEqual(closedOf(s), ['chat:a@2', 'chat:c@3', 'chat:d@3'])
  s = run(s, { type: 'reopen' }, { type: 'reopen' }, { type: 'reopen' })
  assert.deepEqual(view(s), [
    ['chat:v^', 'streams:v^', 'chat:a^*', 'chat:b^', 'chat:c^', 'chat:d^']
  ])
  s = run(s, { type: 'closeToRight', tabId: idOf(s, 'chat', 'a') })
  assert.deepEqual(closedOf(s), ['chat:b@3', 'chat:c@3', 'chat:d@3'])
  s = run(s, { type: 'reopen' }, { type: 'reopen' }, { type: 'reopen' })
  assert.deepEqual(view(s), [
    ['chat:v^', 'streams:v^', 'chat:a^', 'chat:b^*', 'chat:c^', 'chat:d^']
  ])
})

test('pruning, a replaced or displaced preview and leaving the group push nothing', () => {
  let s = pinned(createLayout(), 'a')
  // b is replaced in place by c, and c goes when a is unpinned.
  s = run(s, chat('b'), chat('c'), { type: 'unpin', tabId: idOf(s, 'chat', 'a') })
  s = run(s, { type: 'pin', tabId: idOf(s, 'chat', 'a') }, chat('d'))
  s = run(s, { type: 'pruneBy', predicate: (t) => t.ref === 'd' })
  s = connect(connect(s, 'v'), null)
  assert.deepEqual(view(s), [['chat:v~', 'chat:a^*']])
  assert.deepEqual(s.closed, [])
})

test(`the closed stack keeps the ${MAX_CLOSED} most recent`, () => {
  const refs = Array.from({ length: MAX_CLOSED + 2 }, (_, i) => `c${i}`)
  let s = pinned(createLayout(), ...refs)
  s = run(s, { type: 'closeOthers', tabId: idOf(s, 'chat', refs.at(-1)) })
  assert.equal(s.closed.length, MAX_CLOSED)
  assert.equal(s.closed[0].ref, 'c1')
  assert.equal(s.closed.at(-1).ref, refs.at(-2))
})

test('the closed stack is never persisted and starts over on reset and hydrate', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'a') })
  assert.equal(s.closed.length, 1)
  assert.equal('closed' in toPersisted(s), false)
  assert.deepEqual(run(s, { type: 'reset' }).closed, [])
  assert.deepEqual(run(s, { type: 'hydrate', persisted: toPersisted(s) }).closed, [])
})

test('reopen discards every entry it skips, reopening nothing when none is left', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c', 'd')
  for (const ref of ['a', 'b', 'c']) s = run(s, { type: 'close', tabId: idOf(s, 'chat', ref) })
  s = run(s, { type: 'reopen', exists: (content) => content.ref !== 'c' })
  assert.deepEqual(view(s), [['chat:b^*', 'chat:d^']])
  assert.deepEqual(closedOf(s), ['chat:a@0'])
  const none = run(s, { type: 'reopen', exists: () => false })
  assert.deepEqual(view(none), view(s))
  assert.deepEqual(none.closed, [])
  // An empty stack: unchanged.
  assert.equal(run(none, { type: 'reopen' }), none)
})

test('canReopen says whether some closed entry still exists', () => {
  let s = pinned(createLayout(), 'a', 'b')
  assert.equal(canReopen(s), false)
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'a') })
  assert.equal(canReopen(s), true)
  assert.equal(
    canReopen(s, (content) => content.kind === 'chat' && content.ref === 'a'),
    true
  )
  assert.equal(
    canReopen(s, () => false),
    false
  )
})

test('reopening content that is open again activates it where it is', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'close', tabId: idOf(s, 'chat', 'a') }, chat('a'))
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'b') }, { type: 'reopen' })
  assert.deepEqual(view(s), [['chat:b^', 'chat:a~*']])
  assert.deepEqual(s.closed, [])
  // Open in the other pane: activated there, and that pane becomes active.
  let t = pinned(createLayout(), 'a', 'b', 'c')
  t = run(t, { type: 'close', tabId: idOf(t, 'chat', 'a') })
  t = run(t, { type: 'splitWith', tabId: idOf(t, 'chat', 'c'), side: 'right' }, chat('a'))
  t = run(t, { type: 'activate', tabId: idOf(t, 'chat', 'b') }, { type: 'reopen' })
  assert.deepEqual(view(t), [['chat:b^*'], ['chat:c^', 'chat:a~*']])
  assert.equal(t.activePaneId, t.panes[1].id)
})

test('reopen keeps clear of the group, and a lost pane reopens right of the active tab', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = connect(run(s, { type: 'close', tabId: idOf(s, 'chat', 'a') }), 'v')
  s = run(s, { type: 'reopen' })
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:a^*', 'chat:b^']])
  let t = pinned(createLayout(), 'a', 'b', 'c')
  t = run(t, { type: 'splitWith', tabId: idOf(t, 'chat', 'c'), side: 'right' })
  t = run(t, { type: 'close', tabId: idOf(t, 'chat', 'c') })
  assert.equal(t.panes.length, 1)
  t = run(connect(t, 'v', 'chat'), { type: 'reopen' })
  assert.deepEqual(view(t), [['chat:v^', 'streams:v^', 'chat:c^*', 'chat:a^', 'chat:b^']])
})

test('activate selects the tab and its pane; repeats and unknown ids are no-ops', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') })
  assert.equal(activeTab(s).ref, 'a')
  assert.equal(run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') }), s)
  assert.equal(run(s, { type: 'activate', tabId: 'nope' }), s)
})

test('move reorders within a pane and activates the moved tab', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  const p = s.panes[0].id
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'a'), toPaneId: p, index: 2 })
  assert.deepEqual(view(s), [['chat:b^', 'chat:c^', 'chat:a^*']])
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'c'), toPaneId: p, index: -5 })
  assert.deepEqual(view(s), [['chat:c^*', 'chat:b^', 'chat:a^']])
  // Dropped where it already is: only activated.
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'b'), toPaneId: p, index: 1 })
  assert.deepEqual(view(s), [['chat:c^', 'chat:b^*', 'chat:a^']])
})

test('move keeps the connected group as the leading segment', () => {
  let s = connect(pinned(createLayout(), 'a', 'b'), 'v', 'chat')
  const p = s.panes[0].id
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'b'), toPaneId: p, index: 0 })
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:b^*', 'chat:a^']])
  s = run(s, { type: 'move', tabId: s.connected.chatTabId, toPaneId: p, index: 9 })
  assert.deepEqual(view(s), [['chat:v^*', 'streams:v^', 'chat:b^', 'chat:a^']])
})

test('reordering a pane without group tabs works while connected', () => {
  let s = connect(pinned(createLayout(), 'a', 'b', 'c'), 'v', 'chat')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'b'), side: 'right' })
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'c'), toPaneId: s.panes[1].id, index: 1 })
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'c'), toPaneId: s.panes[1].id, index: 0 })
  assert.deepEqual(view(s), [
    ['chat:v^*', 'streams:v^', 'chat:a^'],
    ['chat:c^*', 'chat:b^']
  ])
})

test('move ignores unknown tabs and panes', () => {
  const s = pinned(createLayout(), 'a')
  assert.equal(run(s, { type: 'move', tabId: 'nope', toPaneId: s.panes[0].id, index: 0 }), s)
  assert.equal(run(s, { type: 'move', tabId: idOf(s, 'chat', 'a'), toPaneId: 'nope', index: 0 }), s)
})

test('canSplit needs a single pane and a tab that is not its last', () => {
  const lone = pinned(createLayout(), 'a')
  assert.equal(canSplit(lone, idOf(lone, 'chat', 'a')), false)
  const two = pinned(createLayout(), 'a', 'b')
  assert.equal(canSplit(two, idOf(two, 'chat', 'b')), true)
  assert.equal(canSplit(two, 'nope'), false)
  const split = run(two, { type: 'splitWith', tabId: idOf(two, 'chat', 'b'), side: 'right' })
  assert.equal(canSplit(split, idOf(split, 'chat', 'a')), false)
})

test('moveOrder previews the order a move produces, group segment included', () => {
  let s = connect(pinned(createLayout(), 'a', 'b', 'c'), 'v', 'chat')
  const keys = (ids) => ids.map((id) => tabKey(s.tabs[id]))
  const p = s.panes[0].id
  const c = idOf(s, 'chat', 'c')
  const toFront = { tabId: c, toPaneId: p, index: 0 }
  assert.deepEqual(keys(moveOrder(s, toFront)), [
    'chat:v',
    'streams:v',
    'chat:c',
    'chat:a',
    'chat:b'
  ])
  assert.deepEqual(moveOrder(s, toFront), run(s, { type: 'move', ...toFront }).panes[0].tabIds)
  // A group tab stays inside the group segment of its pane.
  const streamsLast = { tabId: s.connected.streamsTabId, toPaneId: p, index: 9 }
  assert.deepEqual(moveOrder(s, streamsLast), s.panes[0].tabIds)
  s = run(s, { type: 'splitWith', tabId: c, side: 'right' })
  const right = s.panes[1].id
  const a = idOf(s, 'chat', 'a')
  assert.deepEqual(keys(moveOrder(s, { tabId: a, toPaneId: right, index: 0 })), [
    'chat:a',
    'chat:c'
  ])
  // Past the end appends, as a drop on a pane's body does.
  const append = { tabId: a, toPaneId: right, index: Infinity }
  assert.deepEqual(keys(moveOrder(s, append)), ['chat:c', 'chat:a'])
  assert.deepEqual(view(run(s, { type: 'move', ...append })), [
    ['chat:v^*', 'streams:v^', 'chat:b^'],
    ['chat:c^', 'chat:a^*']
  ])
  const streams = { tabId: s.connected.streamsTabId, toPaneId: right, index: 1 }
  assert.deepEqual(keys(moveOrder(s, streams)), ['streams:v', 'chat:c'])
  assert.deepEqual(moveOrder(s, { tabId: a, toPaneId: 'nope', index: 0 }), [])
})

test('splitFits needs room for two minimum panes in the split direction', () => {
  const w = 2 * MIN_PANE_WIDTH
  const h = 2 * MIN_PANE_HEIGHT
  for (const side of ['left', 'right']) {
    assert.equal(splitFits(side, w, 0), true)
    assert.equal(splitFits(side, w - 1, 9999), false)
  }
  for (const side of ['top', 'bottom']) {
    assert.equal(splitFits(side, 0, h), true)
    assert.equal(splitFits(side, 9999, h - 1), false)
  }
  assert.equal(splitFits('up', 9999, 9999), false)
})

test('split right puts the tab in a new pane after the source, side by side', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'b'), side: 'right' })
  assert.deepEqual(view(s), [['chat:a^*'], ['chat:b^*']])
  assert.equal(s.splitDirection, 'row')
  assert.equal(s.activePaneId, s.panes[1].id)
  assert.equal(activeTab(s).ref, 'b')
})

test('split left, top and bottom choose the order and direction', () => {
  const base = pinned(createLayout(), 'a', 'b')
  const b = idOf(base, 'chat', 'b')
  const left = run(base, { type: 'splitWith', tabId: b, side: 'left' })
  assert.deepEqual(view(left), [['chat:b^*'], ['chat:a^*']])
  assert.equal(left.splitDirection, 'row')
  const top = run(base, { type: 'splitWith', tabId: b, side: 'top' })
  assert.deepEqual(view(top), [['chat:b^*'], ['chat:a^*']])
  assert.equal(top.splitDirection, 'column')
  const bottom = run(base, { type: 'splitWith', tabId: b, side: 'bottom' })
  assert.deepEqual(view(bottom), [['chat:a^*'], ['chat:b^*']])
  assert.equal(bottom.splitDirection, 'column')
})

test('split refuses a lone tab, a third pane, unknown tabs and unknown sides', () => {
  const lone = pinned(createLayout(), 'a')
  assert.equal(
    run(lone, { type: 'splitWith', tabId: idOf(lone, 'chat', 'a'), side: 'right' }),
    lone
  )
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'c'), side: 'right' })
  assert.equal(run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'b'), side: 'bottom' }), s)
  assert.equal(run(lone, { type: 'splitWith', tabId: 'nope', side: 'right' }), lone)
  assert.equal(run(lone, { type: 'splitWith', tabId: idOf(lone, 'chat', 'a'), side: 'up' }), lone)
})

test('a preview split or moved into another pane is pinned there', () => {
  let s = pinned(createLayout(), 'a')
  s = run(s, chat('b'))
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'b'), side: 'right' })
  assert.deepEqual(view(s), [['chat:a^*'], ['chat:b^*']])
  assert.equal(s.panes[0].previewTabId, null)
})

test('moving across panes activates in the destination; the source falls to a neighbour', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'c'), side: 'right' })
  const [left, right] = s.panes.map((p) => p.id)
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'b') })
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'b'), toPaneId: right, index: 0 })
  assert.deepEqual(view(s), [['chat:a^*'], ['chat:b^*', 'chat:c^']])
  assert.equal(s.activePaneId, right)
  // Moving the last tab out removes its pane.
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'a'), toPaneId: right, index: 5 })
  assert.deepEqual(view(s), [['chat:b^', 'chat:c^', 'chat:a^*']])
  assert.equal(s.activePaneId, right)
  assert.equal(
    s.panes.some((p) => p.id === left),
    false
  )
})

test('moving onto content the destination already holds keeps that copy', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'b'), side: 'right' })
  const right = s.panes[1].id
  s = run(s, chat('b', { paneId: s.panes[0].id }))
  assert.deepEqual(view(s), [['chat:a^', 'chat:b~*'], ['chat:b^*']])
  const kept = idOf(s, 'chat', 'b', 1)
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'b', 0), toPaneId: right, index: 0 })
  assert.deepEqual(view(s), [['chat:a^*'], ['chat:b^*']])
  assert.equal(idOf(s, 'chat', 'b', 1), kept)
  assert.equal(s.activePaneId, right)
})

test('the Streams tab can move to the other pane and the group re-forms when it returns', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v', 'chat')
  s = run(s, { type: 'splitWith', tabId: s.connected.streamsTabId, side: 'right' })
  assert.deepEqual(view(s), [['chat:v^*', 'chat:a^'], ['streams:v^*']])
  const [left, right] = s.panes.map((p) => p.id)
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'a'), toPaneId: right, index: 0 })
  // A group tab leads whichever pane it is in.
  assert.deepEqual(view(s), [['chat:v^*'], ['streams:v^', 'chat:a^*']])
  s = run(s, { type: 'move', tabId: s.connected.streamsTabId, toPaneId: left, index: 0 })
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^*'], ['chat:a^*']])
})

test('a group tab moved onto its own content replaces the copy there', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v', 'chat')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'a'), side: 'right' })
  const right = s.panes[1].id
  s = run(s, chat('v', { paneId: right }))
  const { chatTabId } = s.connected
  s = run(s, { type: 'move', tabId: chatTabId, toPaneId: right, index: 3 })
  assert.deepEqual(view(s), [['streams:v^*'], ['chat:v^*', 'chat:a^']])
  assert.equal(s.connected.chatTabId, chatTabId)
  assert.equal(s.tabs[chatTabId].kind, 'chat')
})

test("closePane hands group tabs over in place of the remaining pane's copy", () => {
  let s = connect(pinned(createLayout(), 'a'), 'v', 'chat')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'a'), side: 'right' })
  const [left, right] = s.panes.map((p) => p.id)
  s = run(s, chat('v', { paneId: right }))
  assert.deepEqual(view(s), [
    ['chat:v^*', 'streams:v^'],
    ['chat:a^', 'chat:v~*']
  ])
  const closed = run(s, { type: 'closePane', paneId: left })
  assert.deepEqual(view(closed), [['chat:v^*', 'streams:v^', 'chat:a^']])
  assert.equal(Object.keys(closed.tabs).length, 3)
  // A copy that was neither active nor the preview just goes.
  s = run(s, { type: 'pin', tabId: idOf(s, 'chat', 'v', 1) })
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') })
  const kept = run(s, { type: 'closePane', paneId: left })
  assert.deepEqual(view(kept), [['chat:v^', 'streams:v^', 'chat:a^*']])
})

test('setSplitRatio clamps to 0.25..0.75 and ignores non-numbers and repeats', () => {
  let s = run(createLayout(), { type: 'setSplitRatio', ratio: 0.9 })
  assert.equal(s.splitRatio, 0.75)
  s = run(s, { type: 'setSplitRatio', ratio: 0.1 })
  assert.equal(s.splitRatio, 0.25)
  s = run(s, { type: 'setSplitRatio', ratio: 0.4 })
  assert.equal(s.splitRatio, 0.4)
  assert.equal(run(s, { type: 'setSplitRatio', ratio: 0.4 }), s)
  assert.equal(run(s, { type: 'setSplitRatio', ratio: Number.NaN }), s)
  assert.equal(run(s, { type: 'setSplitRatio' }), s)
})

test('closePane drops its tabs but hands connected-group tabs to the remaining pane', () => {
  let s = connect(pinned(createLayout(), 'a', 'b'), 'v', 'chat')
  s = run(s, { type: 'splitWith', tabId: s.connected.streamsTabId, side: 'right' })
  s = run(s, { type: 'move', tabId: idOf(s, 'chat', 'b'), toPaneId: s.panes[1].id, index: 1 })
  const [left, right] = s.panes.map((p) => p.id)
  s = run(s, { type: 'closePane', paneId: right })
  assert.deepEqual(view(s), [['chat:v^*', 'streams:v^', 'chat:a^']])
  assert.equal(s.activePaneId, left)
  assert.equal(idOf(s, 'chat', 'b'), undefined)
  assert.equal(run(s, { type: 'closePane', paneId: left }), s)
  assert.equal(run(s, { type: 'closePane', paneId: 'nope' }), s)
})

test('pruneBy drops matching tabs, never the connected group', () => {
  let s = connect(pinned(createLayout(), 'a', 'b'), 'v', 'chat')
  s = run(s, chat('c'))
  assert.equal(run(s, { type: 'pruneBy', predicate: () => false }), s)
  s = run(s, { type: 'pruneBy', predicate: (t) => t.kind === 'chat' })
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^*']])
  assert.equal(Object.keys(s.tabs).length, 2)
})

test('pruning every tab of one pane removes it, and of both keeps the active one empty', () => {
  let s = pinned(createLayout(), 'a', 'b')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'b'), side: 'right' })
  const right = s.panes[1].id
  const one = run(s, { type: 'pruneBy', predicate: (t) => t.ref === 'b' })
  assert.deepEqual(view(one), [['chat:a^*']])
  assert.equal(one.activePaneId, s.panes[0].id)
  const none = run(s, { type: 'pruneBy', predicate: () => true })
  assert.deepEqual(view(none), [[]])
  assert.equal(none.panes[0].id, right)
  assert.equal(none.activePaneId, right)
})

test('joining installs Chat and Streams pinned at the left edge without moving the focus', () => {
  let s = pinned(createLayout(), 'a')
  s = connect(s, 'v')
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:a^*']])
  assert.deepEqual(s.connected, {
    channelId: 'v',
    chatTabId: idOf(s, 'chat', 'v'),
    streamsTabId: idOf(s, 'streams', 'v'),
    restorePinned: false
  })
  assert.equal(isGroupTab(s, s.connected.chatTabId), true)
  assert.equal(isGroupTab(s, s.connected.streamsTabId), true)
  assert.equal(isGroupTab(s, idOf(s, 'chat', 'a')), false)
  assert.equal(isGroupTab(createLayout(), 't1'), false)
})

test('joining from an empty pane lands on Chat', () => {
  assert.deepEqual(view(connect(createLayout(), 'v')), [['chat:v^*', 'streams:v^']])
})

test('joining folds the active preview of the same channel and lands on Chat', () => {
  let s = pinned(createLayout(), 'a')
  s = run(s, chat('v'))
  const previewId = idOf(s, 'chat', 'v')
  s = connect(s, 'v')
  assert.deepEqual(view(s), [['chat:v^*', 'streams:v^', 'chat:a^']])
  assert.equal(s.connected.chatTabId, previewId)
  assert.equal(s.connected.restorePinned, false)
  assert.equal(s.panes[0].previewTabId, null)
})

test('joining folds an inactive pinned tab without moving the focus', () => {
  let s = pinned(createLayout(), 'a', 'v')
  s = run(s, chat('p'))
  s = connect(s, 'v')
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^', 'chat:a^', 'chat:p~*']])
  assert.equal(s.connected.restorePinned, true)
})

test('focus lands the join, or an existing group, on the named group tab', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v', 'streams')
  assert.deepEqual(view(s), [['chat:v^', 'streams:v^*', 'chat:a^']])
  assert.equal(connect(s, 'v'), s)
  s = connect(s, 'v', 'chat')
  assert.equal(activeTab(s).kind, 'chat')
  s = connect(pinned(createLayout(), 'a'), 'v', 'chat')
  assert.deepEqual(view(s), [['chat:v^*', 'streams:v^', 'chat:a^']])
})

test('switching channels swaps the group in place and keeps the active tab', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v')
  const { chatTabId, streamsTabId } = s.connected
  s = connect(s, 'w')
  assert.deepEqual(view(s), [['chat:w^', 'streams:w^', 'chat:a^*']])
  assert.deepEqual(s.connected, { channelId: 'w', chatTabId, streamsTabId, restorePinned: false })
  s = connect(s, 'x', 'streams')
  assert.equal(activeTab(s).kind, 'streams')
})

test('switching folds a tab of the new channel; if it was active the group Chat takes over', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v')
  s = run(s, chat('w'))
  s = connect(s, 'w')
  assert.deepEqual(view(s), [['chat:w^*', 'streams:w^', 'chat:a^']])
  // An inactive one folds without moving the focus, and remembers its pin.
  s = pinned(s, 'x')
  s = run(s, { type: 'activate', tabId: idOf(s, 'chat', 'a') })
  s = connect(s, 'x')
  assert.deepEqual(view(s), [['chat:x^', 'streams:x^', 'chat:a^*']])
  assert.equal(s.connected.restorePinned, true)
})

test('switching away from a channel that was pinned leaves its tab pinned after the group', () => {
  let s = pinned(createLayout(), 'a', 'v')
  s = connect(s, 'v')
  assert.equal(s.connected.restorePinned, true)
  s = connect(s, 'w')
  assert.deepEqual(view(s), [['chat:w^*', 'streams:w^', 'chat:v^', 'chat:a^']])
  assert.equal(s.connected.restorePinned, false)
})

test('leaving drops Streams; an unpinned Chat stays as the preview, replacing the old one', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v')
  s = run(s, chat('p'), { type: 'activate', tabId: idOf(s, 'chat', 'a') })
  s = connect(s, null)
  assert.deepEqual(view(s), [['chat:v~', 'chat:a^*']])
  assert.equal(s.connected, null)
  assert.equal(isGroupTab(s, idOf(s, 'chat', 'v')), false)
  assert.equal(connect(s, null), s)
})

test('leaving keeps a Chat that was pinned before the join pinned', () => {
  let s = pinned(createLayout(), 'v', 'a')
  s = run(s, chat('p'))
  s = connect(s, 'v')
  s = connect(s, null)
  assert.deepEqual(view(s), [['chat:v^', 'chat:a^', 'chat:p~*']])
})

test('leaving from the Streams tab lands on the tab after the group, else on Chat', () => {
  let s = connect(pinned(createLayout(), 'a'), 'v', 'streams')
  assert.deepEqual(view(connect(s, null)), [['chat:v~', 'chat:a^*']])
  s = connect(createLayout(), 'v', 'streams')
  assert.deepEqual(view(connect(s, null)), [['chat:v~*']])
})

test('toPersisted keeps pinned tabs, the saved active index and the split', () => {
  let s = connect(pinned(createLayout(), 'a', 'b'), 'v')
  s = run(
    s,
    { type: 'activate', tabId: idOf(s, 'chat', 'a') },
    { type: 'setSplitRatio', ratio: 0.6 }
  )
  assert.deepEqual(toPersisted(s), {
    panes: [
      {
        tabs: [
          { kind: 'chat', ref: 'a' },
          { kind: 'chat', ref: 'b' }
        ],
        active: 0
      }
    ],
    splitDirection: 'row',
    splitRatio: 0.6
  })
  // An active preview or group tab is not saved, so nothing is marked active.
  assert.equal(toPersisted(run(s, open('client', 'u1'))).panes[0].active, null)
  assert.equal(toPersisted(connect(s, 'v', 'streams')).panes[0].active, null)
  assert.deepEqual(toPersisted(createLayout()).panes, [])
})

test('hydrate restores pinned tabs per pane on their saved active tab', () => {
  let s = pinned(createLayout(), 'a', 'b', 'c')
  s = run(s, { type: 'splitWith', tabId: idOf(s, 'chat', 'c'), side: 'bottom' })
  s = run(
    s,
    { type: 'activate', tabId: idOf(s, 'chat', 'b') },
    { type: 'setSplitRatio', ratio: 0.3 }
  )
  const saved = toPersisted(s)
  const h = run(createLayout(), { type: 'hydrate', persisted: saved })
  assert.deepEqual(view(h), [['chat:a^', 'chat:b^*'], ['chat:c^*']])
  assert.equal(h.splitDirection, 'column')
  assert.equal(h.splitRatio, 0.3)
  assert.equal(h.activePaneId, h.panes[0].id)
  assert.deepEqual(toPersisted(h), saved)
  // Fresh ids keep coming after the restored ones.
  const next = run(h, chat('d'))
  assert.equal(Object.keys(next.tabs).length, 4)
})

test('hydrate drops invalid, streams and duplicate entries, empty and extra panes', () => {
  const h = run(createLayout(), {
    type: 'hydrate',
    persisted: {
      panes: [
        {
          tabs: [
            { kind: 'chat', ref: 'a' },
            { kind: 'chat', ref: 'a' },
            { kind: 'streams', ref: 'v' },
            { kind: 'files', ref: 'a' }
          ],
          // The saved active entry was a duplicate: land on the first tab.
          active: 1
        },
        {
          tabs: [
            null,
            'x',
            { kind: 'nope' },
            { kind: 'bans' },
            { kind: 'connection-info' },
            { kind: 'connection-info', ref: null }
          ],
          active: 7
        },
        'junk',
        [{ kind: 'chat', ref: 'y' }],
        { tabs: [{ kind: 'bans' }] },
        { tabs: [{ kind: 'chat', ref: 'z' }] }
      ],
      splitDirection: 'diagonal',
      splitRatio: 2
    }
  })
  assert.deepEqual(view(h), [
    ['chat:a^*', 'files:a^'],
    ['bans:^*', 'connection-info:^']
  ])
  assert.equal(h.splitDirection, 'row')
  assert.equal(h.splitRatio, 0.75)
})

test('hydrate of nothing usable is a fresh layout', () => {
  for (const persisted of [undefined, null, 'x', {}, { panes: [{ tabs: [] }, null] }]) {
    const h = run(createLayout(), { type: 'hydrate', persisted })
    assert.deepEqual(view(h), [[]])
    assert.equal(h.splitRatio, 0.5)
  }
})

test('hydrate re-installs a live connected group on top', () => {
  const live = connect(createLayout(), 'v')
  const h = run(live, {
    type: 'hydrate',
    persisted: {
      panes: [
        {
          tabs: [
            { kind: 'chat', ref: 'v' },
            { kind: 'files', ref: 'v' }
          ],
          active: 0
        }
      ]
    }
  })
  assert.deepEqual(view(h), [['chat:v^*', 'streams:v^', 'files:v^']])
  assert.equal(h.connected.channelId, 'v')
  assert.equal(h.connected.restorePinned, true)
})

test('the first prune after a restore lands a pane on its first remaining tab', () => {
  const saved = {
    panes: [
      {
        tabs: [
          { kind: 'chat', ref: 'a' },
          { kind: 'chat', ref: 'b' },
          { kind: 'chat', ref: 'c' }
        ],
        active: 1
      }
    ]
  }
  const h = run(createLayout(), { type: 'hydrate', persisted: saved })
  const gone = (t) => t.ref === 'b'
  assert.deepEqual(view(run(h, { type: 'pruneBy', predicate: gone, fallback: 'first' })), [
    ['chat:a^*', 'chat:c^']
  ])
  // Later prunes hand over to a neighbour as usual.
  assert.deepEqual(view(run(h, { type: 'pruneBy', predicate: gone })), [['chat:a^', 'chat:c^*']])
  // A pane that kept its active tab is left alone, and the group is skipped.
  const kept = run(h, { type: 'pruneBy', predicate: (t) => t.ref === 'c', fallback: 'first' })
  assert.deepEqual(view(kept), [['chat:a^', 'chat:b^*']])
  const joined = connect(h, 'v')
  assert.deepEqual(view(run(joined, { type: 'pruneBy', predicate: gone, fallback: 'first' })), [
    ['chat:v^', 'streams:v^', 'chat:a^*', 'chat:c^']
  ])
  const onlyGroup = run(connect(run(createLayout(), chat('b')), 'w'), {
    type: 'pruneBy',
    predicate: gone,
    fallback: 'first'
  })
  assert.deepEqual(view(onlyGroup), [['chat:w^*', 'streams:w^']])
  const emptied = run(h, { type: 'pruneBy', predicate: () => true, fallback: 'first' })
  assert.deepEqual(view(emptied), [[]])
})

test('reset returns a fresh layout; unknown actions change nothing', () => {
  const s = connect(pinned(createLayout(), 'a'), 'v', 'chat')
  assert.deepEqual(run(s, { type: 'reset' }), createLayout())
  assert.equal(run(s, { type: 'nope' }), s)
})

test('activePane and paneOf find panes; activeTab is null for an empty pane', () => {
  const s = pinned(createLayout(), 'a')
  assert.equal(activePane(s), s.panes[0])
  assert.equal(paneOf(s, idOf(s, 'chat', 'a')), s.panes[0])
  assert.equal(paneOf(s, 'nope'), null)
  assert.equal(activeTab(run(s, { type: 'close', tabId: idOf(s, 'chat', 'a') })), null)
})

test('openChannelRefs lists channels with a tab open, minus the joined channel chat', () => {
  let s = connect(createLayout(), 'v')
  s = pinned(s, 'a')
  s = run(s, open('channel-details', 'b'))
  s = run(s, { type: 'pin', tabId: idOf(s, 'channel-details', 'b') }, open('files', 'c'))
  s = run(s, { type: 'pin', tabId: idOf(s, 'files', 'c') })
  s = run(s, open('client', 'u1'), open('server-summary'), open('connection-info'))
  assert.deepEqual([...openChannelRefs(s)].sort(), ['a', 'b', 'c', 'v'])
  assert.deepEqual([...openChannelRefs(s, 'v')].sort(), ['a', 'b', 'c'])
  // Details or files of the joined channel still count.
  s = run(s, open('channel-details', 'v'))
  assert.deepEqual([...openChannelRefs(s, 'v')].sort(), ['a', 'b', 'c', 'v'])
  s = run(s, open('files', 'v'))
  assert.deepEqual([...openChannelRefs(s, 'v')].sort(), ['a', 'b', 'c', 'v'])
})

test('cycleTarget wraps within the active pane', () => {
  assert.equal(cycleTarget(createLayout(), 1), null)
  let s = pinned(createLayout(), 'a', 'b', 'c')
  const [a, b, c] = s.panes[0].tabIds
  assert.equal(cycleTarget(s, 1), a)
  assert.equal(cycleTarget(s, -1), b)
  s = run(s, { type: 'activate', tabId: a })
  assert.equal(cycleTarget(s, -1), c)
})

test('tabAtIndex picks the nth tab of the active pane, -1 for the last', () => {
  const s = pinned(createLayout(), 'a', 'b', 'c')
  const [a, , c] = s.panes[0].tabIds
  assert.equal(tabAtIndex(s, 0), a)
  assert.equal(tabAtIndex(s, -1), c)
  assert.equal(tabAtIndex(s, 7), null)
  assert.equal(tabAtIndex(createLayout(), -1), null)
})
