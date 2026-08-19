import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appRoot, pickFollowTarget } from './windowFollow.js'

// A League-shaped process tree: the shell launches the Riot client, which
// launches the League client, which launches the game as a separate process.
const PROCESSES = [
  { pid: 1, ppid: 0, exe: 'explorer.exe' },
  { pid: 10, ppid: 1, exe: 'RiotClientServices.exe' },
  { pid: 11, ppid: 10, exe: 'LeagueClient.exe' },
  { pid: 12, ppid: 11, exe: 'LeagueClientUx.exe' },
  { pid: 13, ppid: 11, exe: 'League of Legends.exe' },
  // An unrelated app the user also has open.
  { pid: 20, ppid: 1, exe: 'notepad.exe' }
]

const CLIENT = 'window:100:0'
const GAME = 'window:200:0'
const NOTEPAD = 'window:300:0'

const win = (id, name, pid) => ({ id, name, pid })
const clientWindow = win(CLIENT, 'League of Legends', 12)
const gameWindow = win(GAME, 'League of Legends (TM) Client', 13)
const notepadWindow = win(NOTEPAD, 'Untitled - Notepad', 20)

// Both League processes root at the Riot client; the walk must not carry on
// up into explorer.exe, or every window on the desktop would be "related".
test('appRoot stops below the shell', () => {
  assert.equal(appRoot(12, PROCESSES), 10)
  assert.equal(appRoot(13, PROCESSES), 10)
  assert.notEqual(appRoot(20, PROCESSES), appRoot(12, PROCESSES))
  assert.equal(appRoot(9999, PROCESSES), null)
})

test('appRoot survives a parent cycle', () => {
  const cyclic = [
    { pid: 5, ppid: 6, exe: 'a.exe' },
    { pid: 6, ppid: 5, exe: 'b.exe' }
  ]
  assert.equal(appRoot(5, cyclic), 6)
})

test('stays put while the shared window is still capturable', () => {
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: 10 },
    candidates: [clientWindow, gameWindow],
    processes: PROCESSES,
    knownIds: [CLIENT, NOTEPAD]
  })
  assert.equal(target, null)
})

test('follows the game window once the client hides', () => {
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: 10 },
    candidates: [gameWindow, notepadWindow],
    processes: PROCESSES,
    knownIds: [CLIENT, NOTEPAD]
  })
  assert.deepEqual(target, {
    id: GAME,
    name: 'League of Legends (TM) Client',
    via: 'related'
  })
})

// The whole point of the knownIds guard: a window that was already open when
// the share started was not chosen by the user and must never be jumped into.
test('never jumps into a window that was already open', () => {
  const sibling = win('window:400:0', 'Second League Window', 13)
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: 10 },
    candidates: [sibling],
    processes: PROCESSES,
    knownIds: [CLIENT, sibling.id]
  })
  assert.equal(target, null)
})

test('ignores a new window from an unrelated application', () => {
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: 10 },
    candidates: [notepadWindow],
    processes: PROCESSES,
    knownIds: [CLIENT]
  })
  assert.equal(target, null)
})

test('refuses to guess between two new related windows', () => {
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: 10 },
    candidates: [gameWindow, win('window:400:0', 'League Extra', 13)],
    processes: PROCESSES,
    knownIds: [CLIENT]
  })
  assert.equal(target, null)
})

// The client was open when the share started, so only the trail can bring the
// share back to it when the game exits.
test('reverts to the client when the game window closes', () => {
  const target = pickFollowTarget({
    shared: { id: GAME, root: 10 },
    candidates: [clientWindow, notepadWindow],
    processes: PROCESSES,
    knownIds: [GAME, NOTEPAD],
    previous: [CLIENT]
  })
  assert.deepEqual(target, { id: CLIENT, name: 'League of Legends', via: 'previous' })
})

test('does not follow when the launcher process is unknown', () => {
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: null },
    candidates: [gameWindow],
    processes: PROCESSES,
    knownIds: [CLIENT]
  })
  assert.equal(target, null)
})

// The client can exit when the game starts, taking the tree with it - the root
// is recorded up front for exactly this case.
test('follows even after the launcher process has exited', () => {
  const target = pickFollowTarget({
    shared: { id: CLIENT, root: 10 },
    candidates: [gameWindow],
    processes: PROCESSES.filter((p) => p.pid !== 12),
    knownIds: [CLIENT]
  })
  assert.equal(target?.id, GAME)
})
