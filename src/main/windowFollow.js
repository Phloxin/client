// Decides which window a share should move to when the window it was started
// on is replaced by another window of the same application: a game that opens
// in its own window and hides the client it launched from, and the client
// coming back when that game exits.
//
// The rule is deliberately narrow - a share only ever moves once the window
// it was capturing has stopped being capturable. Chasing a new window while
// the shared one is still on screen would let a share wander off on its own
// into a window the user never picked.
//
// Kept free of Electron and the native addon so the policy can be unit tested.

// Walking parent processes all the way up would root everything the user
// launched at explorer.exe, which would make every window "related" to every
// other one. Stop the walk at the shell, the service hosts and the usual
// script hosts instead.
const ROOT_EXES = new Set([
  'system',
  'idle',
  'explorer.exe',
  'services.exe',
  'svchost.exe',
  'wininit.exe',
  'winlogon.exe',
  'userinit.exe',
  'runtimebroker.exe',
  'dllhost.exe',
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'windowsterminal.exe',
  'conhost.exe'
])

// Cap on the parent walk, so a pid-reuse cycle or an unusually deep launcher
// chain can't turn into a long loop.
const MAX_DEPTH = 8

function indexProcesses(processes) {
  const byPid = new Map()
  for (const entry of processes ?? []) {
    if (typeof entry?.pid === 'number') byPid.set(entry.pid, entry)
  }
  return byPid
}

// The oldest ancestor of `pid` that still looks like part of the same
// application. Two windows count as the same app when their roots match, so
// League's client (LeagueClientUx.exe) and its game (League of Legends.exe)
// both root at the Riot client that launched them. Returns null when the
// process isn't running.
export function appRoot(pid, processes) {
  if (!pid) return null
  const byPid = indexProcesses(processes)
  let current = byPid.get(pid)
  if (!current) return null

  const seen = new Set([current.pid])
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const parent = byPid.get(current.ppid)
    // A parent that has already exited, or whose pid has been reused further
    // down the chain, ends the walk here.
    if (!parent || seen.has(parent.pid)) break
    if (ROOT_EXES.has(String(parent.exe ?? '').toLowerCase())) break
    seen.add(parent.pid)
    current = parent
  }
  return current.pid
}

// Picks the window the share should move to, or null to stay put.
//
//   shared     the window being captured: { id, root } where root is the
//              app root recorded when the share started, so a launcher that
//              exits on game start doesn't take the trail with it
//   candidates currently capturable windows: [{ id, name, pid }]
//   processes  [{ pid, ppid, exe }] from the native addon
//   knownIds   window ids that existed when the share started or last moved
//   previous   ids this share has already come from, oldest first
//
// The returned `via` tells the caller which rule fired, so it can keep the
// trail of previous windows straight.
export function pickFollowTarget({
  shared,
  candidates = [],
  processes = [],
  knownIds = [],
  previous = []
} = {}) {
  const windows = candidates.filter((candidate) => typeof candidate?.id === 'string')

  // Still capturing something real: nothing to do. This is the common case on
  // every poll, so it comes first.
  if (!shared?.id || windows.some((candidate) => candidate.id === shared.id)) return null

  // The window we came from is capturable again - the game exited and put the
  // client back. Prefer this over the process-tree rule below: it's an exact
  // id match, and it's the only rule that can return to a window that was
  // already on screen when the share started.
  const trail = new Set(previous)
  for (let i = previous.length - 1; i >= 0; i--) {
    const back = windows.find((candidate) => candidate.id === previous[i])
    if (back) return { id: back.id, name: back.name, via: 'previous' }
  }

  // Otherwise look for a window that appeared after the share started and
  // belongs to the same application. Windows that were already there are
  // excluded on purpose - jumping into a window the user had open all along
  // would show them something they never chose to share.
  const root = shared.root ?? null
  if (root == null) return null
  const seen = new Set(knownIds)
  const related = windows.filter(
    (candidate) =>
      !seen.has(candidate.id) &&
      !trail.has(candidate.id) &&
      appRoot(candidate.pid, processes) === root
  )

  // An ambiguous match is treated as no match, the same way source matching
  // does it: capturing the wrong window would expose its contents.
  return related.length === 1 ? { id: related[0].id, name: related[0].name, via: 'related' } : null
}
