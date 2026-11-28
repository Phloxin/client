// Desktop (OS) notifications, shown with Electron's main-process Notification
// (the renderer decides whether an event pops up: renderer/src/lib/osNotifications.js).
// Kept free of Electron so it can be tested under node; index.js hands in the
// Notification class and the window checks.
//
// We never ask the OS to break through its Do Not Disturb or Focus: no urgency,
// toastXml, timeoutType, actions, hasReply or sound, and always silent (the
// soundpack chimes are the only sound). So the OS holds our popups back by itself.

const KEY_MAX = 100
const TITLE_MAX = 120
const BODY_MAX = 300
// Live notifications kept referenced so they are not garbage collected before
// their click. The oldest reference is dropped past this, without closing it.
const LIVE_MAX = 50

const TARGET_KINDS = new Set(['dm', 'channel'])
const TARGET_FIELDS = new Set(['kind', 'channelId', 'authorId', 'server'])
const PAYLOAD_FIELDS = new Set(['key', 'title', 'body', 'target', 'force'])

// Lengths count characters as a person sees them (an emoji is one), the way the
// renderer cuts its text (renderer/src/lib/notificationText.js).
const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const characters = (text) => Array.from(segmenter.segment(text), (part) => part.segment)

const isId = (value) => typeof value === 'string' || typeof value === 'number'
const isPlainObject = (value) => value != null && typeof value === 'object' && !Array.isArray(value)

// What a click opens: { kind: 'dm' | 'channel', channelId, authorId?, server? }
// with string/number ids. Absent (null/undefined) is fine: such a popup only
// brings Pylon forward.
function checkTarget(target) {
  if (target == null) return { ok: true, target: null }
  if (!isPlainObject(target)) return { ok: false }
  if (Object.keys(target).some((field) => !TARGET_FIELDS.has(field))) return { ok: false }
  if (!TARGET_KINDS.has(target.kind) || !isId(target.channelId)) return { ok: false }
  if (target.authorId != null && !isId(target.authorId)) return { ok: false }
  if (target.server != null && typeof target.server !== 'string') return { ok: false }
  const clean = { kind: target.kind, channelId: target.channelId }
  if (target.authorId != null) clean.authorId = target.authorId
  if (target.server != null) clean.server = target.server
  return { ok: true, target: clean }
}

// The payload from the renderer, checked at the IPC boundary: { key, title,
// body?, target?, force? }. Returns the cleaned payload, or null when invalid.
export function checkPayload(payload) {
  if (!isPlainObject(payload)) return null
  if (Object.keys(payload).some((field) => !PAYLOAD_FIELDS.has(field))) return null
  const { key, title, force = false } = payload
  const body = payload.body ?? ''
  if (typeof key !== 'string' || !key || key.length > KEY_MAX) return null
  if (typeof title !== 'string' || !title || characters(title).length > TITLE_MAX) return null
  if (typeof body !== 'string') return null
  if (typeof force !== 'boolean') return null
  const target = checkTarget(payload.target)
  if (!target.ok) return null
  const text = characters(body.trim()).slice(0, BODY_MAX).join('')
  return { key, title, body: text, target: target.target, force }
}

// `Notification`: Electron's class (or a fake in tests). `anyWindowFocused()`:
// whether any Pylon window has OS focus. `onActivate(target)`: a popup was
// clicked (target null = only bring Pylon forward). `platform`: process.platform.
// `icon`: the app icon's path, used on Linux only (Windows and macOS show the
// app's own icon). `testMode`: record popups instead of showing them.
export function createOsNotifier({
  Notification,
  anyWindowFocused,
  onActivate,
  platform,
  icon,
  testMode = false
}) {
  // key -> Notification, oldest first.
  const live = new Map()
  const records = []
  // Test mode: the keys of recorded popups not closed since, so a close is recorded
  // ({ key, closed: true }) exactly when a shown popup would have been taken away.
  const recordedLive = new Set()
  let assumeUnfocused = false

  // Drops the reference for `key` if it is still `notification`, so a late event
  // from a replaced popup leaves its replacement alone.
  function drop(key, notification) {
    if (live.get(key) === notification) live.delete(key)
  }

  function keep(key, notification) {
    live.delete(key)
    live.set(key, notification)
    while (live.size > LIVE_MAX) live.delete(live.keys().next().value)
  }

  // On Windows a click can also arrive after the Notification object is gone (an
  // entry left in the notification center); those only bring Pylon forward.
  if (platform === 'win32' && !testMode && typeof Notification.handleActivation === 'function') {
    Notification.handleActivation(() => onActivate(null))
  }

  function supported() {
    return testMode || Notification.isSupported() === true
  }

  // 'shown' | 'focused' | 'unsupported' | 'invalid' | 'recorded'
  function show(payload) {
    const checked = checkPayload(payload)
    if (!checked) return 'invalid'
    const { key, title, body, target, force } = checked
    if (!supported()) return 'unsupported'
    if (!force && !(testMode && assumeUnfocused) && anyWindowFocused()) return 'focused'
    if (testMode) {
      records.push({ key, title, body, target, force })
      recordedLive.add(key)
      return 'recorded'
    }

    const options = { title, body, silent: true }
    if (platform === 'linux' && icon) options.icon = icon
    // Windows and macOS replace a notification with the same id in place, in the
    // notification center too.
    const replacesById = platform === 'win32' || platform === 'darwin'
    if (replacesById) options.id = `pylon-${key}`

    const previous = live.get(key)
    if (previous) {
      live.delete(key)
      // Linux has no replace-by-id here, so the old popup is closed first. No
      // 'close' event comes back for a close we ask for, hence the delete above.
      if (!replacesById) previous.close()
    }

    const notification = new Notification(options)
    notification.on('click', () => {
      drop(key, notification)
      onActivate(target)
    })
    notification.on('close', () => drop(key, notification))
    notification.on('failed', (_event, error) => {
      drop(key, notification)
      console.warn('[osNotify] notification failed:', error)
    })
    keep(key, notification)
    notification.show()
    return 'shown'
  }

  // Our own close: on Linux Electron fires no 'close' event for it, so the
  // reference is dropped here rather than in the listener.
  function close(key) {
    if (testMode) {
      if (recordedLive.delete(key)) records.push({ key, closed: true })
      return
    }
    const notification = live.get(key)
    if (!notification) return
    live.delete(key)
    notification.close()
  }

  function closeAll() {
    if (testMode) {
      for (const key of [...recordedLive]) close(key)
      return
    }
    const all = [...live.values()]
    live.clear()
    for (const notification of all) notification.close()
  }

  const notifier = { supported, show, close, closeAll }
  if (testMode) {
    // Popups ({ key, title, body, target, force }) and closes ({ key, closed: true }),
    // in the order they happened.
    notifier.recorded = () =>
      records.map((record) =>
        record.closed ? { ...record } : { ...record, target: record.target && { ...record.target } }
      )
    notifier.setAssumeUnfocused = (value) => {
      assumeUnfocused = value === true
    }
  }
  return notifier
}
