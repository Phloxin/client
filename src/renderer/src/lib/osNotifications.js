// ─── Desktop (OS) notifications ──────────────────────────────────
// Popups from the operating system's notification service while Pylon isn't
// focused. Main shows them (src/main/osNotifications.js) through the preload
// bridge, window.api.notifications; a build without it (web) has none, and every
// call here is then a no-op.
//
// Whether an event pops up is decided here, before main is asked, from:
//   • the master switch and the row's desktop toggle (Settings → Notifications,
//     mirrored in from SettingsContext by setOsNotifyPrefs);
//   • the row's three-way state, the same one its sound has (sounds.js):
//     Off = no popup, Enabled = not while deafened, Pinned = even while deafened;
//   • Pylon's own Do Not Disturb status (setOsNotifyDnd, from Main), which beats
//     Pinned as it does for the message, poke and call chimes.
// Main then holds a popup back while any Pylon window has focus, and the OS holds
// it back during its own Do Not Disturb or Focus, since we never ask to break
// through.
import { OS_DEFAULTS, OS_ROWS, isSoundsDeafened, soundStateOf } from './sounds.js'

const TEST_TITLE = 'Pylon'
const TEST_BODY = 'This is a test notification.'

// Master switch (absent = on) and per-row toggles (row id -> boolean; absent =
// the row's default). Pushed in from SettingsContext.
let prefs = { enabled: true, rows: {} }
let dnd = false
// The connected server's host (Main's connectedHost), carried in each popup's
// target so a click on a popup from an earlier server only focuses Pylon.
let server = null

export function setOsNotifyPrefs({ enabled, rows } = {}) {
  prefs = { enabled: enabled !== false, rows: { ...rows } }
}

export function setOsNotifyDnd(value) {
  dnd = !!value
}

export function setOsNotifyServer(key) {
  server = key ?? null
}

// Whether row `id`'s desktop toggle is on in `rows` (row id -> boolean), falling
// back to the row's default. Rows without a toggle (no `os` field) are never on.
export function osRowOn(rows, id) {
  if (!OS_ROWS.has(id)) return false
  const value = rows?.[id]
  return typeof value === 'boolean' ? value : OS_DEFAULTS[id] === true
}

// The gate. Checked in this order; the first that applies wins:
//   'unsupported'  no notification service (or no bridge)
//   'master-off'   Desktop notifications is off
//   'row-os-off'   the row's desktop toggle is off (or it has none)
//   'row-off'      the row's state is Off
//   'dnd'          Pylon's Do Not Disturb, Pinned included
//   'deafened'     deafened, and the row is not Pinned
//   'ok'
// Focus and the OS's own Do Not Disturb are applied later, by main and the OS.
export function osNotifyDecision({ supported, masterOn, rowOs, rowState, deafened, dnd }) {
  if (!supported) return 'unsupported'
  if (!masterOn) return 'master-off'
  if (!rowOs) return 'row-os-off'
  if (rowState === 'off') return 'row-off'
  if (dnd) return 'dnd'
  if (deafened && rowState !== 'pin') return 'deafened'
  return 'ok'
}

function bridge() {
  return (typeof window !== 'undefined' && window.api?.notifications) || null
}

// Main's answer to whether this system has a notification service: null until
// it is known. A popup asked for before then goes to main, which checks again.
let supportedKnown = null
let supportedAsk = null

// Resolves true when popups can be shown. Asked of main once and cached; false
// without the bridge.
export function osNotifySupported() {
  const api = bridge()
  if (!api) return Promise.resolve(false)
  supportedAsk ??= Promise.resolve()
    .then(() => api.isSupported())
    .then(
      (value) => (supportedKnown = value === true),
      () => (supportedKnown = false)
    )
  return supportedAsk
}

function isSupportedNow() {
  if (!bridge()) return false
  if (supportedKnown === null) osNotifySupported()
  return supportedKnown !== false
}

// Pops up row `rowId`'s notification if the gate allows it. `key` names the
// popup: a new one with the same key replaces the old one, and
// closeOsNotification(key) takes it away. `target` ({ kind: 'dm' | 'channel',
// channelId, authorId }) is what a click opens; the connected server is added to
// it. Returns the gate's decision, so a caller can see why nothing showed.
export function notifyOs(rowId, { key, title, body, target } = {}) {
  const decision = osNotifyDecision({
    supported: isSupportedNow(),
    masterOn: prefs.enabled,
    rowOs: osRowOn(prefs.rows, rowId),
    rowState: soundStateOf(rowId),
    deafened: isSoundsDeafened(),
    dnd
  })
  if (decision !== 'ok') return decision
  const payload = { key, title, body }
  if (target) payload.target = { ...target, server }
  // Sent now, not after an await, so a close asked for right after reaches main
  // after this show.
  try {
    Promise.resolve(bridge().show(payload)).catch(warnShowFailed)
  } catch (err) {
    warnShowFailed(err)
  }
  return decision
}

function warnShowFailed(err) {
  console.warn('[osNotify] show failed:', err)
}

export function closeOsNotification(key) {
  bridge()?.close(key)
}

// `cb(target)` runs when a popup is clicked: `target` is the one it was shown
// with (server included), or null when only Pylon should come forward. Returns
// the unsubscribe.
export function onOsNotificationActivate(cb) {
  return bridge()?.onActivate(cb) ?? (() => {})
}

// Settings' "Send test": skips the row gates and the focus rule, but still goes
// through the OS, so the OS's Do Not Disturb or Focus holds it back like any
// other popup. Resolves with the gate's decision when it stops the test, else
// with main's answer ('shown', 'unsupported', …).
export async function sendTestOsNotification() {
  const decision = osNotifyDecision({
    supported: await osNotifySupported(),
    masterOn: prefs.enabled,
    rowOs: true,
    rowState: 'pin',
    deafened: false,
    dnd
  })
  if (decision !== 'ok') return decision
  try {
    return await bridge().show({ key: 'test', title: TEST_TITLE, body: TEST_BODY, force: true })
  } catch (err) {
    console.warn('[osNotify] test failed:', err)
    return 'failed'
  }
}
