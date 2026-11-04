import { useEffect, useRef } from 'react'
import { keyboardEventToAccelerator } from '../../../shared/keybinds.js'

// In-app shortcuts: active only while a Pylon window is focused, so unlike the
// global keybinds they never reach the main process.

// In priority order: a combo assigned to two actions belongs to the earlier one.
export const APP_SHORTCUT_ACTIONS = [
  { id: 'nextTab', label: 'Next Tab', desc: 'Switch to the next tab in the active pane.' },
  { id: 'prevTab', label: 'Previous Tab', desc: 'Switch to the previous tab in the active pane.' },
  {
    id: 'closeTab',
    label: 'Close Tab',
    desc: 'Close the active tab. Does nothing on the call or channel you are in.'
  },
  { id: 'reopenTab', label: 'Reopen Closed Tab', desc: 'Reopen the most recently closed tab.' },
  ...Array.from({ length: 8 }, (_, i) => ({
    id: `tab${i + 1}`,
    label: `Go to Tab ${i + 1}`,
    desc: `Switch to tab ${i + 1} in the active pane.`
  })),
  { id: 'lastTab', label: 'Go to Last Tab', desc: 'Switch to the last tab in the active pane.' }
]

export const DEFAULT_APP_SHORTCUTS = {
  nextTab: 'Ctrl+Tab',
  prevTab: 'Ctrl+Shift+Tab',
  closeTab: 'Ctrl+W',
  reopenTab: 'Ctrl+Shift+T',
  ...Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`tab${i + 1}`, `Ctrl+${i + 1}`])),
  lastTab: 'Ctrl+9'
}

// The only actions that still fire while typing in a text field.
const WHILE_TYPING = new Set(['nextTab', 'prevTab', 'closeTab', 'reopenTab'])

const TEXT_INPUT_TYPES = new Set([
  '',
  'text',
  'search',
  'url',
  'email',
  'password',
  'tel',
  'number'
])

export function isTextField(target) {
  if (!target) return false
  if (target.isContentEditable) return true
  if (target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((target.type || '').toLowerCase())
}

// The action `combo` triggers, or null. The first action holding the combo
// owns it even when it is one that ignores text fields.
export function resolveAppShortcut(settings, combo, inTextField) {
  if (!combo) return null
  const action = APP_SHORTCUT_ACTIONS.find((a) => settings?.[a.id] === combo)
  if (!action || (inTextField && !WHILE_TYPING.has(action.id))) return null
  return action.id
}

// Action id -> label of the earlier action that already owns its combo.
export function appShortcutConflicts(settings) {
  const owners = new Map()
  const conflicts = {}
  for (const action of APP_SHORTCUT_ACTIONS) {
    const combo = settings?.[action.id]
    if (!combo) continue
    if (owners.has(combo)) conflicts[action.id] = owners.get(combo).label
    else owners.set(combo, action)
  }
  return conflicts
}

// One window keydown listener dispatching to `handlers[actionId]`. A matched
// combo is always claimed (preventDefault), so Ctrl+Tab never runs Chromium's
// focus traversal even when there is no tab to move to.
export function useAppShortcuts(settings, handlers, enabled) {
  const latest = useRef({ settings, handlers })
  useEffect(() => {
    latest.current = { settings, handlers }
  })
  useEffect(() => {
    if (!enabled) return undefined
    const onKeyDown = (e) => {
      if (e.defaultPrevented) return
      const { settings: current, handlers: actions } = latest.current
      const id = resolveAppShortcut(current, keyboardEventToAccelerator(e), isTextField(e.target))
      if (!id) return
      e.preventDefault()
      actions[id]?.()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [enabled])
}
