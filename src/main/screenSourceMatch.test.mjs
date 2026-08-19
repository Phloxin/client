import assert from 'node:assert/strict'
import test from 'node:test'
import { matchScreenSource, screenSourceKind } from './screenSourceMatch.js'

const chrome = { id: 'window:100:0', name: 'YouTube - Google Chrome' }
const chromeReborn = { id: 'window:777:0', name: 'YouTube - Google Chrome' }
const editor = { id: 'window:200:0', name: 'index.js - pylon' }
const monitor = { id: 'screen:0:0', name: 'Screen 1' }

test('source kind comes from the id prefix', () => {
  assert.equal(screenSourceKind('screen:0:0'), 'screen')
  assert.equal(screenSourceKind('window:100:0'), 'window')
  assert.equal(screenSourceKind(null), 'window')
})

test('a surviving id wins over every name heuristic', () => {
  const stillThere = { id: 'window:100:0', name: 'Something Else Entirely' }
  assert.equal(
    matchScreenSource([chromeReborn, stillThere], { id: 'window:100:0', name: chrome.name }),
    stillThere
  )
})

test('a recreated window is found by its exact name', () => {
  assert.equal(
    matchScreenSource([editor, chromeReborn], { id: chrome.id, name: chrome.name }),
    chromeReborn
  )
})

test('name matching ignores case and surrounding whitespace', () => {
  assert.equal(
    matchScreenSource([chromeReborn], { id: chrome.id, name: '  youtube - google chrome ' }),
    chromeReborn
  )
})

test('a single window whose title contains (or is contained by) the old one matches', () => {
  const renamed = { id: 'window:778:0', name: 'Cat video - YouTube - Google Chrome' }
  assert.equal(matchScreenSource([editor, renamed], { id: chrome.id, name: chrome.name }), renamed)
  assert.equal(
    matchScreenSource([editor, chromeReborn], { id: chrome.id, name: renamed.name }),
    chromeReborn
  )
})

test('two equally good candidates are ambiguous, never a guess', () => {
  const secondChrome = { id: 'window:888:0', name: 'YouTube - Google Chrome' }
  assert.equal(
    matchScreenSource([chromeReborn, secondChrome], { id: chrome.id, name: chrome.name }),
    null
  )
  const overlapA = { id: 'window:1:0', name: 'Docs - Google Chrome' }
  const overlapB = { id: 'window:2:0', name: 'Mail - Google Chrome' }
  assert.equal(
    matchScreenSource([overlapA, overlapB], { id: chrome.id, name: 'Google Chrome' }),
    null
  )
})

test('no candidate and no usable name give up', () => {
  assert.equal(matchScreenSource([editor], { id: chrome.id, name: chrome.name }), null)
  assert.equal(matchScreenSource([chromeReborn], { id: chrome.id, name: null }), null)
  assert.equal(matchScreenSource([], { id: chrome.id, name: chrome.name }), null)
  assert.equal(matchScreenSource(undefined, { id: chrome.id, name: chrome.name }), null)
})

test('windows and screens never recover into each other', () => {
  const namesakeScreen = { id: 'screen:1:0', name: 'YouTube - Google Chrome' }
  assert.equal(
    matchScreenSource([namesakeScreen], { id: chrome.id, name: chrome.name }),
    null,
    'a window must not resume into a whole-monitor capture'
  )
  assert.equal(
    matchScreenSource([chromeReborn, monitor], { id: 'screen:9:0', name: 'Screen 1' }),
    monitor
  )
})
