// Browser-style tab layout for the content canvas: one or two panes of tabs,
// each with a VS Code style preview slot, plus the connected group (the joined
// channel's Chat and Streams tabs). Pure; Main holds it with useReducer.
// Invariants: a tab is unpinned exactly when it is its pane's preview, a pane
// with tabs always has an active one, and no pane is empty while two remain.

export const TAB_KINDS = [
  'chat',
  'streams',
  'client',
  'channel-details',
  'server-traffic',
  'server-summary',
  'files',
  'bans',
  'connection-info'
]
export const MAX_PANES = 2
export const MIN_SPLIT_RATIO = 0.25
export const MAX_SPLIT_RATIO = 0.75
export const MAX_CLOSED = 20
// A pane is never squeezed below these, so a split needs room for two.
export const MIN_PANE_WIDTH = 320
export const MIN_PANE_HEIGHT = 240

const SPLIT_SIDES = {
  left: { direction: 'row', before: true },
  right: { direction: 'row', before: false },
  top: { direction: 'column', before: true },
  bottom: { direction: 'column', before: false }
}

// Whether a canvas of `width` x `height` has room for a split toward `side`:
// two panes side by side (left/right) or stacked (top/bottom).
export function splitFits(side, width, height) {
  const spec = SPLIT_SIDES[side]
  if (!spec) return false
  return spec.direction === 'row' ? width >= 2 * MIN_PANE_WIDTH : height >= 2 * MIN_PANE_HEIGHT
}

const newPane = (id) => ({ id, tabIds: [], activeTabId: null, previewTabId: null })

export function createLayout() {
  return {
    panes: [newPane('p1')],
    splitDirection: 'row',
    splitRatio: 0.5,
    activePaneId: 'p1',
    tabs: {},
    // { channelId, chatTabId, streamsTabId, restorePinned } while in a voice
    // channel or DM call; restorePinned: the Chat tab was pinned before it
    // folded into the group.
    connected: null,
    // Tabs the user closed, { kind, ref, paneId, index }, most recent last,
    // for reopen. Never persisted.
    closed: [],
    // Next numeric suffix for tab and pane ids.
    seq: 2
  }
}

// Stable identity of a tab's content, e.g. for keying its view.
export const tabKey = (tab) => `${tab.kind}:${tab.ref ?? ''}`

const sameContent = (tab, content) =>
  !!tab && tab.kind === content.kind && (tab.ref ?? null) === (content.ref ?? null)

const clampRatio = (r) => Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, r))

export function isGroupTab(state, tabId) {
  const c = state.connected
  return !!c && tabId != null && (c.chatTabId === tabId || c.streamsTabId === tabId)
}

export function paneOf(state, tabId) {
  return state.panes.find((p) => p.tabIds.includes(tabId)) ?? null
}

export function activePane(state) {
  return state.panes.find((p) => p.id === state.activePaneId)
}

export function activeTab(state) {
  const pane = activePane(state)
  return pane.activeTabId != null ? state.tabs[pane.activeTabId] : null
}

// Channel ids with a chat, channel-details or files tab open in any pane,
// not counting chat tabs of `joinedChannelId`.
export function openChannelRefs(state, joinedChannelId = null) {
  const refs = new Set()
  for (const tab of Object.values(state.tabs)) {
    const counts =
      tab.kind === 'chat'
        ? tab.ref !== joinedChannelId
        : tab.kind === 'channel-details' || tab.kind === 'files'
    if (counts) refs.add(tab.ref)
  }
  return refs
}

// The tab Ctrl+Tab (delta 1) or Ctrl+Shift+Tab (delta -1) moves to in the
// active pane, wrapping; null when the pane has no tabs.
export function cycleTarget(state, delta) {
  const { tabIds, activeTabId } = activePane(state)
  if (!tabIds.length) return null
  const i = tabIds.indexOf(activeTabId)
  return tabIds[(i + delta + tabIds.length) % tabIds.length]
}

// The active pane's tab at `index` (0-based; -1 is the last), or null.
export function tabAtIndex(state, index) {
  const { tabIds } = activePane(state)
  return (index < 0 ? tabIds[tabIds.length - 1] : tabIds[index]) ?? null
}

// Whether `tabId` can split off into a second pane: there is only one pane and
// the tab is not its last (the emptied pane would be removed).
export function canSplit(state, tabId) {
  const pane = paneOf(state, tabId)
  return !!pane && state.panes.length < MAX_PANES && pane.tabIds.length >= 2
}

// The destination pane's tab order a `move` would produce, for previewing a
// drop. Unlike `move` it keeps a destination copy of the same content.
export function moveOrder(state, { tabId, toPaneId, index }) {
  const pane = state.panes.find((p) => p.id === toPaneId)
  return pane ? placeIn(state, pane, tabId, index).tabIds : []
}

// Pinned tabs per pane (the connected group and previews excluded) with the
// index of the active one (null when that tab is not saved), plus the split,
// as saved per server host.
export function toPersisted(state) {
  return {
    panes: state.panes
      .map((p) => {
        const ids = p.tabIds.filter((id) => !isGroupTab(state, id) && state.tabs[id].pinned)
        const at = ids.indexOf(p.activeTabId)
        return {
          tabs: ids.map((id) => ({ kind: state.tabs[id].kind, ref: state.tabs[id].ref })),
          active: at < 0 ? null : at
        }
      })
      .filter((p) => p.tabs.length > 0),
    splitDirection: state.splitDirection,
    splitRatio: state.splitRatio
  }
}

const withPane = (state, pane) => ({
  ...state,
  panes: state.panes.map((p) => (p.id === pane.id ? pane : p))
})

// Group tabs lead whichever pane holds them, Chat before Streams, so the group
// renders as one segment at the left edge.
function groupFirst(state, tabIds) {
  const c = state.connected
  if (!c) return tabIds
  const lead = [c.chatTabId, c.streamsTabId].filter((id) => tabIds.includes(id))
  if (!lead.length) return tabIds
  const next = [...lead, ...tabIds.filter((id) => !lead.includes(id))]
  return next.every((id, i) => id === tabIds[i]) ? tabIds : next
}

const groupCount = (state, tabIds) => {
  let n = 0
  while (n < tabIds.length && isGroupTab(state, tabIds[n])) n++
  return n
}

function activateIn(state, paneId, tabId) {
  const pane = state.panes.find((p) => p.id === paneId)
  if (pane.activeTabId === tabId && state.activePaneId === paneId) return state
  return { ...withPane(state, { ...pane, activeTabId: tabId }), activePaneId: paneId }
}

function activate(state, tabId) {
  const pane = paneOf(state, tabId)
  return pane ? activateIn(state, pane.id, tabId) : state
}

// Take `ids` out of their panes (records kept). A removed active tab hands over
// to the nearest survivor on its right, else its left.
function detach(state, ids) {
  const gone = new Set(ids)
  const panes = state.panes.map((pane) => {
    if (!pane.tabIds.some((id) => gone.has(id))) return pane
    const tabIds = pane.tabIds.filter((id) => !gone.has(id))
    let activeTabId = pane.activeTabId
    if (gone.has(activeTabId)) {
      const at = pane.tabIds.indexOf(activeTabId)
      const right = pane.tabIds.slice(at + 1).find((id) => !gone.has(id))
      const left = pane.tabIds
        .slice(0, at)
        .reverse()
        .find((id) => !gone.has(id))
      activeTabId = right ?? left ?? null
    }
    const previewTabId = gone.has(pane.previewTabId) ? null : pane.previewTabId
    return { ...pane, tabIds, activeTabId, previewTabId }
  })
  return { ...state, panes }
}

// An emptied pane goes while another pane remains.
function dropEmptyPanes(state) {
  if (state.panes.length < 2 || state.panes.every((p) => p.tabIds.length)) return state
  const kept = state.panes.filter((p) => p.tabIds.length)
  const panes = kept.length ? kept : [activePane(state)]
  const activePaneId = panes.some((p) => p.id === state.activePaneId)
    ? state.activePaneId
    : panes[0].id
  return { ...state, panes, activePaneId }
}

// `ids` must be existing tabs.
function removeTabs(state, ids) {
  const next = detach(state, ids)
  const tabs = { ...next.tabs }
  for (const id of ids) delete tabs[id]
  return dropEmptyPanes({ ...next, tabs })
}

// Where a new tab goes in `pane`: right of the active tab but never inside the
// connected group's segment; at the end when nothing is active.
function insertIndex(state, pane) {
  const at = pane.tabIds.indexOf(pane.activeTabId)
  if (at < 0) return pane.tabIds.length
  return Math.max(at + 1, groupCount(state, pane.tabIds))
}

function open(state, { paneId, content, pinned = false }) {
  if (!content || !TAB_KINDS.includes(content.kind)) return state
  const ref = content.ref ?? null
  // Only the connected group owns a Streams tab; opening one means focusing it.
  if (content.kind === 'streams') {
    const c = state.connected
    return c && c.channelId === ref ? activate(state, c.streamsTabId) : state
  }
  const pane = paneId != null ? state.panes.find((p) => p.id === paneId) : activePane(state)
  if (!pane) return state
  const target = { kind: content.kind, ref }
  let next
  let id = pane.tabIds.find((tid) => sameContent(state.tabs[tid], target))
  if (id != null) {
    next = activateIn(state, pane.id, id)
  } else if (pane.previewTabId != null) {
    id = pane.previewTabId
    next = activateIn(
      { ...state, tabs: { ...state.tabs, [id]: { ...state.tabs[id], ...target } } },
      pane.id,
      id
    )
  } else {
    id = `t${state.seq}`
    const tabIds = [...pane.tabIds]
    tabIds.splice(insertIndex(state, pane), 0, id)
    next = {
      ...withPane(state, { ...pane, tabIds, activeTabId: id, previewTabId: id }),
      activePaneId: pane.id,
      tabs: { ...state.tabs, [id]: { id, ...target, pinned: false } },
      seq: state.seq + 1
    }
  }
  return pinned ? pin(next, id) : next
}

function pin(state, tabId) {
  const tab = state.tabs[tabId]
  if (!tab || tab.pinned) return state
  const pane = paneOf(state, tabId)
  const next = { ...state, tabs: { ...state.tabs, [tabId]: { ...tab, pinned: true } } }
  return withPane(next, { ...pane, previewTabId: null })
}

function unpin(state, tabId) {
  const tab = state.tabs[tabId]
  if (!tab || !tab.pinned || isGroupTab(state, tabId)) return state
  let next = state
  const old = paneOf(state, tabId).previewTabId
  if (old != null && old !== tabId) next = removeTabs(next, [old])
  const pane = paneOf(next, tabId)
  return withPane(
    { ...next, tabs: { ...next.tabs, [tabId]: { ...tab, pinned: false } } },
    { ...pane, previewTabId: tabId }
  )
}

// A user's close: remove `ids` and push them onto the closed stack in strip
// order, each with its index at the moment it goes, so reopening them last
// first puts every one back where it was.
function closeTabs(state, ids) {
  const gone = new Set(ids.filter((id) => state.tabs[id]))
  if (!gone.size) return state
  const entries = []
  for (const pane of state.panes) {
    let removed = 0
    pane.tabIds.forEach((id, i) => {
      if (!gone.has(id)) return
      const { kind, ref } = state.tabs[id]
      entries.push({ kind, ref, paneId: pane.id, index: i - removed++ })
    })
  }
  return {
    ...removeTabs(state, [...gone]),
    closed: [...state.closed, ...entries].slice(-MAX_CLOSED)
  }
}

function close(state, tabId) {
  if (isGroupTab(state, tabId)) return state
  return closeTabs(state, [tabId])
}

function closeOthers(state, tabId) {
  const pane = paneOf(state, tabId)
  if (!pane) return state
  const ids = pane.tabIds.filter((id) => id !== tabId && !isGroupTab(state, id))
  return activate(closeTabs(state, ids), tabId)
}

function closeToRight(state, tabId) {
  const pane = paneOf(state, tabId)
  if (!pane) return state
  const ids = pane.tabIds
    .slice(pane.tabIds.indexOf(tabId) + 1)
    .filter((id) => !isGroupTab(state, id))
  return closeTabs(state, ids)
}

// Whether `reopen` would bring a tab back: some closed entry's content
// `exists` still accepts.
export function canReopen(state, exists = () => true) {
  return state.closed.some((e) => exists({ kind: e.kind, ref: e.ref }))
}

// Reopen the most recently closed tab whose content `exists` still accepts,
// discarding every entry it skips. Content already open is activated
// where it is; otherwise it comes back pinned at its saved place (or right of
// the active tab when its pane is gone).
function reopen(state, exists = () => true) {
  for (let n = state.closed.length - 1; n >= 0; n--) {
    const entry = state.closed[n]
    const content = { kind: entry.kind, ref: entry.ref }
    if (!exists(content)) continue
    const next = { ...state, closed: state.closed.slice(0, n) }
    const saved = state.panes.find((p) => p.id === entry.paneId)
    for (const pane of saved ? [saved, ...state.panes.filter((p) => p !== saved)] : state.panes) {
      const id = pane.tabIds.find((tid) => sameContent(state.tabs[tid], content))
      if (id != null) return activateIn(next, pane.id, id)
    }
    const id = `t${state.seq}`
    const withTab = {
      ...next,
      tabs: { ...state.tabs, [id]: { id, ...content, pinned: true } },
      seq: state.seq + 1
    }
    const pane = saved ?? activePane(state)
    const index = saved ? entry.index : insertIndex(state, pane)
    return { ...withPane(withTab, placeIn(withTab, pane, id, index)), activePaneId: pane.id }
  }
  return state.closed.length ? { ...state, closed: [] } : state
}

// Insert `tabId` into `pane` at `index`, clamped so the group stays the
// leading segment, and make it the pane's active tab.
function placeIn(state, pane, tabId, index) {
  const rest = pane.tabIds.filter((id) => id !== tabId)
  const lead = groupCount(state, rest)
  const at = Math.min(Math.max(index, 0), rest.length)
  const clamped = isGroupTab(state, tabId) ? Math.min(at, lead) : Math.max(at, lead)
  rest.splice(clamped, 0, tabId)
  return { ...pane, tabIds: groupFirst(state, rest), activeTabId: tabId }
}

// `index` counts the destination's tabs other than the moved one.
function move(state, { tabId, toPaneId, index }) {
  const from = paneOf(state, tabId)
  const to = state.panes.find((p) => p.id === toPaneId)
  if (!from || !to) return state
  if (from.id === to.id) {
    const placed = placeIn(state, from, tabId, index)
    const unchanged = placed.tabIds.every((id, i) => id === from.tabIds[i])
    return unchanged
      ? activateIn(state, from.id, tabId)
      : { ...withPane(state, placed), activePaneId: from.id }
  }
  const tab = state.tabs[tabId]
  // The destination already shows this content: keep that one, unless the
  // moved tab belongs to the connected group, which always survives.
  const dup = to.tabIds.find((id) => sameContent(state.tabs[id], tab))
  let next = state
  if (dup != null) {
    if (!isGroupTab(state, tabId)) return activate(removeTabs(state, [tabId]), dup)
    next = removeTabs(state, [dup])
  }
  // A preview dragged to another pane is pinned there (each pane keeps at most
  // one preview, and the drag is a deliberate act).
  next = detach(next, [tabId])
  if (!tab.pinned) next = { ...next, tabs: { ...next.tabs, [tabId]: { ...tab, pinned: true } } }
  const dest = next.panes.find((p) => p.id === toPaneId)
  return dropEmptyPanes({
    ...withPane(next, placeIn(next, dest, tabId, index)),
    activePaneId: toPaneId
  })
}

function splitWith(state, { tabId, side }) {
  const spec = SPLIT_SIDES[side]
  if (!spec || !canSplit(state, tabId)) return state
  const pane = newPane(`p${state.seq}`)
  const panes = spec.before ? [pane, ...state.panes] : [...state.panes, pane]
  return move(
    { ...state, panes, splitDirection: spec.direction, seq: state.seq + 1 },
    { tabId, toPaneId: pane.id, index: 0 }
  )
}

function setSplitRatio(state, ratio) {
  if (!Number.isFinite(ratio)) return state
  const r = clampRatio(ratio)
  return r === state.splitRatio ? state : { ...state, splitRatio: r }
}

// Remove a pane and its tabs; connected-group tabs move to the remaining pane,
// since only leaving the call removes them.
function closePane(state, paneId) {
  const pane = state.panes.find((p) => p.id === paneId)
  if (!pane || state.panes.length < 2) return state
  const keep = pane.tabIds.filter((id) => isGroupTab(state, id))
  const drop = pane.tabIds.filter((id) => !isGroupTab(state, id))
  const other = state.panes.find((p) => p.id !== paneId)
  // The remaining pane's own copy of an incoming group tab's content goes.
  const dups = other.tabIds.filter((id) =>
    keep.some((k) => !isGroupTab(state, id) && sameContent(state.tabs[id], state.tabs[k]))
  )
  const tabs = { ...state.tabs }
  for (const id of [...drop, ...dups]) delete tabs[id]
  const tabIds = groupFirst(state, [...keep, ...other.tabIds.filter((id) => !dups.includes(id))])
  const activeTabId = dups.includes(other.activeTabId) ? tabIds[0] : other.activeTabId
  const previewTabId = dups.includes(other.previewTabId) ? null : other.previewTabId
  return {
    ...state,
    tabs,
    panes: [{ ...other, tabIds, activeTabId, previewTabId }],
    activePaneId: other.id
  }
}

// Drop every tab (the connected group excepted) for which `predicate` is true.
// With `fallback: 'first'` (the first prune after a restore) a pane whose
// active tab went lands on its first remaining tab instead of a neighbour.
function pruneBy(state, predicate, fallback) {
  const ids = Object.values(state.tabs)
    .filter((tab) => !isGroupTab(state, tab.id) && predicate(tab))
    .map((tab) => tab.id)
  if (!ids.length) return state
  const next = removeTabs(state, ids)
  if (fallback !== 'first') return next
  const lostActive = new Set(
    state.panes.filter((p) => ids.includes(p.activeTabId)).map((p) => p.id)
  )
  return {
    ...next,
    panes: next.panes.map((p) => {
      if (!lostActive.has(p.id) || !p.tabIds.length) return p
      const first = p.tabIds.find((id) => !isGroupTab(next, id)) ?? p.tabIds[0]
      return { ...p, activeTabId: first }
    })
  }
}

// Install, swap or remove the connected group. A chat tab of the joined
// channel in the group's pane folds into the group. Installing lands on Chat
// only when that folded tab was active or the pane was empty; `focus`
// ('chat' or 'streams') lands on that group tab regardless.
function setConnected(state, { channelId, focus }) {
  const cur = state.connected
  const focusId = (c) => (focus === 'streams' ? c.streamsTabId : c.chatTabId)
  if (channelId == null) return cur ? leaveGroup(state, cur) : state
  const chat = { kind: 'chat', ref: channelId }
  if (cur && cur.channelId === channelId) return focus ? activate(state, focusId(cur)) : state
  if (cur) {
    const pane = paneOf(state, cur.chatTabId)
    const dup = pane.tabIds.find((id) => id !== cur.chatTabId && sameContent(state.tabs[id], chat))
    const dupActive = dup != null && pane.activeTabId === dup
    let seq = state.seq
    const tabs = {
      ...state.tabs,
      [cur.chatTabId]: { ...state.tabs[cur.chatTabId], ref: channelId },
      [cur.streamsTabId]: { ...state.tabs[cur.streamsTabId], ref: channelId }
    }
    let tabIds = pane.tabIds
    // A pinned tab of the channel being left survives the visit, right after
    // the group.
    if (cur.restorePinned) {
      const id = `t${seq++}`
      tabs[id] = { id, kind: 'chat', ref: cur.channelId, pinned: true }
      tabIds = [...tabIds]
      tabIds.splice(groupCount(state, tabIds), 0, id)
    }
    const restorePinned = dup != null && state.tabs[dup].pinned
    let next = withPane(
      { ...state, seq, tabs, connected: { ...cur, channelId, restorePinned } },
      { ...pane, tabIds }
    )
    if (dup != null) next = removeTabs(next, [dup])
    if (dupActive) next = activate(next, cur.chatTabId)
    return focus ? activate(next, focusId(cur)) : next
  }
  const pane = activePane(state)
  const fold = pane.tabIds.find((id) => sameContent(state.tabs[id], chat))
  let seq = state.seq
  const chatTabId = fold ?? `t${seq++}`
  const streamsTabId = `t${seq++}`
  const restorePinned = fold != null && state.tabs[fold].pinned
  const connected = { channelId, chatTabId, streamsTabId, restorePinned }
  const next = {
    ...state,
    seq,
    connected,
    tabs: {
      ...state.tabs,
      [chatTabId]: { id: chatTabId, ...chat, pinned: true },
      [streamsTabId]: { id: streamsTabId, kind: 'streams', ref: channelId, pinned: true }
    }
  }
  const tabIds = [chatTabId, streamsTabId, ...pane.tabIds.filter((id) => id !== chatTabId)]
  const previewTabId = pane.previewTabId === chatTabId ? null : pane.previewTabId
  const landOnChat = pane.activeTabId == null || pane.activeTabId === fold
  const activeTabId = focus ? focusId(connected) : landOnChat ? chatTabId : pane.activeTabId
  return {
    ...withPane(next, { ...pane, tabIds, previewTabId, activeTabId }),
    activePaneId: pane.id
  }
}

// Leaving drops the Streams tab. The Chat tab stays: pinned again if it was
// pinned before the join, otherwise as its pane's preview (replacing any
// other preview there).
function leaveGroup(state, cur) {
  let next = { ...removeTabs(state, [cur.streamsTabId]), connected: null }
  if (cur.restorePinned) return next
  const old = paneOf(next, cur.chatTabId).previewTabId
  if (old != null) next = removeTabs(next, [old])
  const pane = paneOf(next, cur.chatTabId)
  return withPane(
    {
      ...next,
      tabs: { ...next.tabs, [cur.chatTabId]: { ...next.tabs[cur.chatTabId], pinned: false } }
    },
    { ...pane, previewTabId: cur.chatTabId }
  )
}

const validContent = (t) =>
  !!t && typeof t === 'object' && TAB_KINDS.includes(t.kind) && t.kind !== 'streams'

// Rebuild from a saved layout: its tabs come back pinned, each pane on its
// saved active tab (its first when that one is gone). A live connected group
// is re-installed on top.
function hydrate(state, persisted) {
  let next = createLayout()
  const saved = Array.isArray(persisted?.panes) ? persisted.panes : []
  const lists = saved.filter((p) => Array.isArray(p?.tabs))
  const panes = []
  const tabs = {}
  let seq = next.seq
  for (const list of lists.slice(0, MAX_PANES)) {
    const tabIds = []
    let activeTabId = null
    list.tabs.forEach((content, index) => {
      if (!validContent(content)) return
      const target = { kind: content.kind, ref: content.ref ?? null }
      if (tabIds.some((id) => sameContent(tabs[id], target))) return
      const id = `t${seq++}`
      tabs[id] = { id, ...target, pinned: true }
      tabIds.push(id)
      if (index === list.active) activeTabId = id
    })
    if (tabIds.length) {
      panes.push({
        id: `p${seq++}`,
        tabIds,
        activeTabId: activeTabId ?? tabIds[0],
        previewTabId: null
      })
    }
  }
  if (panes.length) next = { ...next, panes, activePaneId: panes[0].id, tabs }
  next.seq = seq
  if (persisted?.splitDirection === 'row' || persisted?.splitDirection === 'column') {
    next.splitDirection = persisted.splitDirection
  }
  if (Number.isFinite(persisted?.splitRatio)) next.splitRatio = clampRatio(persisted.splitRatio)
  return state.connected ? setConnected(next, { channelId: state.connected.channelId }) : next
}

export function tabsReducer(state, action) {
  switch (action.type) {
    case 'open':
      return open(state, action)
    case 'pin':
      return pin(state, action.tabId)
    case 'unpin':
      return unpin(state, action.tabId)
    case 'close':
      return close(state, action.tabId)
    case 'closeOthers':
      return closeOthers(state, action.tabId)
    case 'closeToRight':
      return closeToRight(state, action.tabId)
    case 'reopen':
      return reopen(state, action.exists)
    case 'activate':
      return activate(state, action.tabId)
    case 'move':
      return move(state, action)
    case 'splitWith':
      return splitWith(state, action)
    case 'setSplitRatio':
      return setSplitRatio(state, action.ratio)
    case 'closePane':
      return closePane(state, action.paneId)
    case 'pruneBy':
      return pruneBy(state, action.predicate, action.fallback)
    case 'setConnected':
      return setConnected(state, action)
    case 'hydrate':
      return hydrate(state, action.persisted)
    case 'reset':
      return createLayout()
    default:
      return state
  }
}
