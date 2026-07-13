import { ipcMain, BrowserWindow, globalShortcut } from 'electron'
import { normalizeAccelerator, uiohookKeyNameToAccelerator } from '../shared/keybinds'

// X11, Windows, and macOS use a passive uIOhook listener. Wayland intentionally
// prevents that kind of global input observation, so it uses Electron's
// compositor-managed GlobalShortcuts portal instead.

// Build a combo string from a uIOhook keydown event, or null while only modifier
// keys are held.
function eventToCombo(e) {
  if (passiveModifierCodes.has(e.keycode)) return null

  const parts = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  const keyName = passiveCodeToName[e.keycode]
  if (!keyName) return null
  parts.push(uiohookKeyNameToAccelerator(keyName))
  return parts.join('+')
}

let binds = {} // { actionId: combo }
let started = false
let passiveHook = null
let passiveCodeToName = {}
let passiveModifierCodes = new Set()
let backend = 'starting'
let registrationStatus = {}
const portalRegistrations = new Map() // actionId -> Electron accelerator

const isWayland = process.platform === 'linux' && process.env.XDG_SESSION_TYPE === 'wayland'

function firstWindow() {
  return BrowserWindow.getAllWindows()[0] || null
}

function sendToRenderer(channel, ...args) {
  const win = firstWindow()
  if (!win || win.isDestroyed()) return
  win.webContents.send(channel, ...args)
}

function statusPayload() {
  return { backend, actions: registrationStatus }
}

function publishStatus(target = null) {
  const payload = statusPayload()
  if (target && !target.isDestroyed()) target.send('keybinds:status', payload)
  else sendToRenderer('keybinds:status', payload)
}

function trigger(action) {
  sendToRenderer('keybinds:trigger', action)
}

function unregisterPortalAction(action) {
  const accelerator = portalRegistrations.get(action)
  if (!accelerator) return
  globalShortcut.unregister(accelerator)
  portalRegistrations.delete(action)
}

function updatePortalBinds(next) {
  const desired = Object.fromEntries(
    Object.entries(next).map(([action, combo]) => [action, normalizeAccelerator(combo)])
  )

  // Remove changed bindings first so swapping two action shortcuts works.
  for (const [action, accelerator] of portalRegistrations) {
    if (desired[action] !== accelerator) unregisterPortalAction(action)
  }

  const claimed = new Map()
  registrationStatus = {}
  for (const [action, accelerator] of Object.entries(desired)) {
    if (!accelerator) {
      registrationStatus[action] = { registered: false, reason: 'unassigned' }
      continue
    }
    if (claimed.has(accelerator)) {
      registrationStatus[action] = {
        registered: false,
        reason: 'duplicate',
        message: `Already assigned to ${claimed.get(accelerator)}.`
      }
      unregisterPortalAction(action)
      continue
    }
    claimed.set(accelerator, action)

    if (portalRegistrations.get(action) === accelerator) {
      registrationStatus[action] = { registered: true }
      continue
    }

    try {
      const registered = globalShortcut.register(accelerator, () => trigger(action))
      if (registered) {
        portalRegistrations.set(action, accelerator)
        registrationStatus[action] = { registered: true }
      } else {
        registrationStatus[action] = {
          registered: false,
          reason: 'unavailable',
          message: 'The compositor rejected this shortcut or it is already in use.'
        }
      }
    } catch (err) {
      console.error(`[keybinds] failed to register ${accelerator}:`, err)
      registrationStatus[action] = {
        registered: false,
        reason: 'error',
        message: 'This shortcut is not supported by the desktop.'
      }
    }
  }

  publishStatus()
}

async function startPassiveHook() {
  try {
    const { uIOhook, UiohookKey } = await import('uiohook-napi')
    passiveHook = uIOhook
    passiveCodeToName = Object.fromEntries(
      Object.entries(UiohookKey).map(([name, code]) => [code, name])
    )
    passiveModifierCodes = new Set([
      UiohookKey.Ctrl,
      UiohookKey.CtrlRight,
      UiohookKey.Alt,
      UiohookKey.AltRight,
      UiohookKey.Shift,
      UiohookKey.ShiftRight,
      UiohookKey.Meta,
      UiohookKey.MetaRight
    ])
    uIOhook.on('keydown', (e) => {
      const combo = eventToCombo(e)
      if (!combo) return

      for (const [action, bound] of Object.entries(binds)) {
        if (bound && normalizeAccelerator(bound) === combo) {
          trigger(action)
          break
        }
      }
    })

    uIOhook.start()
    started = true
    backend = 'passive-hook'
    registrationStatus = Object.fromEntries(
      Object.entries(binds).map(([action, combo]) => [
        action,
        combo ? { registered: true } : { registered: false, reason: 'unassigned' }
      ])
    )
    publishStatus()
  } catch (err) {
    backend = 'unavailable'
    registrationStatus = Object.fromEntries(
      Object.entries(binds).map(([action, combo]) => [
        action,
        combo
          ? {
              registered: false,
              reason: 'error',
              message: 'The operating-system keyboard hook could not be started.'
            }
          : { registered: false, reason: 'unassigned' }
      ])
    )
    console.error('[keybinds] failed to start global hook:', err)
    publishStatus()
  }
}

export function setupGlobalKeybinds() {
  // Renderer pushes the current binds whenever they change.
  ipcMain.on('keybinds:set', (e, next) => {
    binds = next || {}
    if (isWayland) updatePortalBinds(binds)
    else if (started) {
      registrationStatus = Object.fromEntries(
        Object.entries(binds).map(([action, combo]) => [
          action,
          combo ? { registered: true } : { registered: false, reason: 'unassigned' }
        ])
      )
      publishStatus(e.sender)
    }
  })
  ipcMain.handle('keybinds:get-status', () => statusPayload())

  if (isWayland) {
    backend = 'wayland-portal'
  } else {
    startPassiveHook()
  }
}

export function stopGlobalKeybinds() {
  for (const action of [...portalRegistrations.keys()]) unregisterPortalAction(action)
  if (started && passiveHook) {
    try {
      passiveHook.stop()
    } catch (err) {
      console.error('[keybinds] failed to stop global hook:', err)
    }
  }
  ipcMain.removeHandler('keybinds:get-status')
}
