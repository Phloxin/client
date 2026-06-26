import { ipcMain, BrowserWindow } from 'electron'
import { uIOhook, UiohookKey } from 'uiohook-napi'

// Global, *passive* keybinds (Discord/TeamSpeak style). uIOhook observes every
// keystroke OS-wide without consuming it, so a bound key still types normally in
// other apps — it just also fires our action. This is why we can't use Electron's
// globalShortcut (that one is exclusive and swallows the key).

// keycode -> readable name, the inverse of UiohookKey. Used to build combo
// strings that match what the renderer stores (e.g. "Ctrl+Shift+M").
const CODE_TO_NAME = Object.fromEntries(
  Object.entries(UiohookKey).map(([name, code]) => [code, name])
)

const MODIFIER_CODES = new Set([
  UiohookKey.Ctrl,
  UiohookKey.CtrlRight,
  UiohookKey.Alt,
  UiohookKey.AltRight,
  UiohookKey.Shift,
  UiohookKey.ShiftRight,
  UiohookKey.Meta,
  UiohookKey.MetaRight
])

// Build a combo string from a uIOhook keydown event, or null while only modifier
// keys are held (so capture waits for a real key before committing).
function eventToCombo(e) {
  if (MODIFIER_CODES.has(e.keycode)) return null
  const parts = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  parts.push(CODE_TO_NAME[e.keycode] || `Key${e.keycode}`)
  return parts.join('+')
}

let binds = {} // { actionId: combo }
let capturing = false // true while the settings UI is recording a new combo
let started = false

function firstWindow() {
  return BrowserWindow.getAllWindows()[0] || null
}

export function setupGlobalKeybinds() {
  // Renderer pushes the current binds whenever they change.
  ipcMain.on('keybinds:set', (_e, next) => {
    binds = next || {}
  })
  ipcMain.on('keybinds:capture-start', () => {
    capturing = true
  })
  ipcMain.on('keybinds:capture-cancel', () => {
    capturing = false
  })

  uIOhook.on('keydown', (e) => {
    const combo = eventToCombo(e)
    if (!combo) return // waiting on a non-modifier key

    const win = firstWindow()
    if (!win || win.isDestroyed()) return

    if (capturing) {
      capturing = false
      win.webContents.send('keybinds:captured', combo)
      return // a key pressed during capture only records; it doesn't trigger
    }

    for (const [action, bound] of Object.entries(binds)) {
      if (bound && bound === combo) {
        win.webContents.send('keybinds:trigger', action)
        break
      }
    }
  })

  try {
    uIOhook.start()
    started = true
  } catch (err) {
    console.error('[keybinds] failed to start global hook:', err)
  }
}

export function stopGlobalKeybinds() {
  if (!started) return
  try {
    uIOhook.stop()
  } catch (err) {
    console.error('[keybinds] failed to stop global hook:', err)
  }
}
