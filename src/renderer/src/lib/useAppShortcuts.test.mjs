import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APP_SHORTCUT_ACTIONS,
  DEFAULT_APP_SHORTCUTS,
  appShortcutConflicts,
  isTextField,
  resolveAppShortcut
} from './useAppShortcuts.js'

test('defaults cover every action, Ctrl+1..8 for the numbered tabs and Ctrl+9 for the last', () => {
  assert.deepEqual(
    APP_SHORTCUT_ACTIONS.map((a) => a.id),
    Object.keys(DEFAULT_APP_SHORTCUTS)
  )
  assert.equal(DEFAULT_APP_SHORTCUTS.nextTab, 'Ctrl+Tab')
  assert.equal(DEFAULT_APP_SHORTCUTS.prevTab, 'Ctrl+Shift+Tab')
  assert.equal(DEFAULT_APP_SHORTCUTS.closeTab, 'Ctrl+W')
  assert.equal(DEFAULT_APP_SHORTCUTS.reopenTab, 'Ctrl+Shift+T')
  assert.equal(APP_SHORTCUT_ACTIONS[3].id, 'reopenTab')
  assert.equal(DEFAULT_APP_SHORTCUTS.tab1, 'Ctrl+1')
  assert.equal(DEFAULT_APP_SHORTCUTS.tab8, 'Ctrl+8')
  assert.equal(DEFAULT_APP_SHORTCUTS.lastTab, 'Ctrl+9')
})

test('a combo resolves to the action holding it', () => {
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+Tab', false), 'nextTab')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+3', false), 'tab3')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+9', false), 'lastTab')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+Q', false), null)
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, null, false), null)
  assert.equal(resolveAppShortcut(undefined, 'Ctrl+Tab', false), null)
})

test('a cleared shortcut does nothing', () => {
  const settings = { ...DEFAULT_APP_SHORTCUTS, closeTab: null }
  assert.equal(resolveAppShortcut(settings, 'Ctrl+W', false), null)
})

test('in a text field only next, previous, close and reopen tab fire', () => {
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+Tab', true), 'nextTab')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+Shift+Tab', true), 'prevTab')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+W', true), 'closeTab')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+Shift+T', true), 'reopenTab')
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+1', true), null)
  assert.equal(resolveAppShortcut(DEFAULT_APP_SHORTCUTS, 'Ctrl+9', true), null)
})

test('a shared combo belongs to the earlier action, even where that one is ignored', () => {
  const settings = { ...DEFAULT_APP_SHORTCUTS, tab2: 'Ctrl+W', closeTab: 'Ctrl+1' }
  assert.equal(resolveAppShortcut(settings, 'Ctrl+1', false), 'closeTab')
  const typing = { ...DEFAULT_APP_SHORTCUTS, tab1: 'Alt+X', lastTab: 'Alt+X' }
  assert.equal(resolveAppShortcut(typing, 'Alt+X', false), 'tab1')
  assert.equal(resolveAppShortcut(typing, 'Alt+X', true), null)
})

test('conflicts name the earlier owner on the later action only', () => {
  assert.deepEqual(appShortcutConflicts(DEFAULT_APP_SHORTCUTS), {})
  const settings = { ...DEFAULT_APP_SHORTCUTS, tab4: 'Ctrl+Tab', lastTab: 'Ctrl+Tab', tab8: null }
  assert.deepEqual(appShortcutConflicts(settings), { tab4: 'Next Tab', lastTab: 'Next Tab' })
  assert.deepEqual(appShortcutConflicts(undefined), {})
})

test('text fields are text inputs, textareas and contenteditable', () => {
  assert.equal(isTextField(null), false)
  assert.equal(isTextField({ tagName: 'TEXTAREA' }), true)
  assert.equal(isTextField({ tagName: 'DIV', isContentEditable: true }), true)
  assert.equal(isTextField({ tagName: 'DIV' }), false)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'search' }), true)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'TEXT' }), true)
  assert.equal(isTextField({ tagName: 'INPUT' }), true)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'checkbox' }), false)
  assert.equal(isTextField({ tagName: 'INPUT', type: 'range' }), false)
})
