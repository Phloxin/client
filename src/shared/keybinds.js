// Canonical accelerator names shared by the focused renderer capture, the
// passive uIOhook backend, and Electron's globalShortcut API.
const CODE_TO_KEY = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  Backquote: '`',
  Backslash: '\\',
  BracketLeft: '[',
  BracketRight: ']',
  Comma: ',',
  Equal: '=',
  Minus: '-',
  NumpadAdd: 'numadd',
  NumpadDecimal: 'numdec',
  NumpadDivide: 'numdiv',
  NumpadEnter: 'Enter',
  NumpadMultiply: 'nummult',
  NumpadSubtract: 'numsub',
  Period: '.',
  Quote: '"',
  Semicolon: ';',
  Slash: '/'
}

const EVENT_KEY_TO_KEY = {
  AudioVolumeDown: 'VolumeDown',
  AudioVolumeMute: 'VolumeMute',
  AudioVolumeUp: 'VolumeUp',
  MediaPlayPause: 'MediaPlayPause',
  MediaStop: 'MediaStop',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack'
}

const MODIFIER_CODES = new Set([
  'AltLeft',
  'AltRight',
  'ControlLeft',
  'ControlRight',
  'MetaLeft',
  'MetaRight',
  'ShiftLeft',
  'ShiftRight'
])

const LEGACY_KEY_NAMES = {
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  NumpadAdd: 'numadd',
  NumpadDecimal: 'numdec',
  NumpadDivide: 'numdiv',
  NumpadMultiply: 'nummult',
  NumpadSubtract: 'numsub',
  NumpadEnd: 'num1',
  NumpadArrowDown: 'num2',
  NumpadPageDown: 'num3',
  NumpadArrowLeft: 'num4',
  NumpadArrowRight: 'num6',
  NumpadHome: 'num7',
  NumpadArrowUp: 'num8',
  NumpadPageUp: 'num9',
  NumpadInsert: 'num0',
  NumpadDelete: 'numdec',
  ...Object.fromEntries(
    Array.from({ length: 10 }, (_, digit) => [`Numpad${digit}`, `num${digit}`])
  ),
  ...CODE_TO_KEY
}

function keyFromCode(code, key) {
  if (EVENT_KEY_TO_KEY[key]) return EVENT_KEY_TO_KEY[key]
  if (/^Key[A-Z]$/.test(code)) return code.slice(3)
  if (/^Digit[0-9]$/.test(code)) return code.slice(5)
  if (/^F(?:[1-9]|1[0-9]|2[0-4])$/.test(code)) return code
  if (/^Numpad[0-9]$/.test(code)) return `num${code.slice(-1)}`
  if (CODE_TO_KEY[code]) return CODE_TO_KEY[code]

  const namedKeys = new Set([
    'Backspace',
    'CapsLock',
    'Delete',
    'End',
    'Enter',
    'Escape',
    'Home',
    'Insert',
    'NumLock',
    'PageDown',
    'PageUp',
    'PrintScreen',
    'ScrollLock',
    'Space',
    'Tab'
  ])
  return namedKeys.has(code) ? code : null
}

// Convert a focused DOM KeyboardEvent into an Electron Accelerator string.
// Returns null while the user is holding only modifier keys, or for a key that
// Electron's globalShortcut API cannot represent.
export function keyboardEventToAccelerator(event) {
  if (MODIFIER_CODES.has(event.code)) return null

  const key = keyFromCode(event.code, event.key)
  if (!key) return null

  const parts = []
  const altGraph = event.getModifierState?.('AltGraph') === true
  if (altGraph) parts.push('AltGr')
  else {
    if (event.ctrlKey) parts.push('Ctrl')
    if (event.altKey) parts.push('Alt')
  }
  if (event.shiftKey) parts.push('Shift')
  if (event.metaKey) parts.push('Meta')
  parts.push(key)
  return parts.join('+')
}

// Older saved values and uIOhook use names such as ArrowLeft and Semicolon.
// Normalize those to key names accepted by Electron's Accelerator parser.
export function normalizeAccelerator(accelerator) {
  if (typeof accelerator !== 'string' || !accelerator.trim()) return null
  const parts = accelerator.split('+')
  if (parts.length === 0) return null

  const key = parts.pop()
  const normalizedKey = LEGACY_KEY_NAMES[key] || key
  return [...parts, normalizedKey].join('+')
}

export function uiohookKeyNameToAccelerator(keyName) {
  return LEGACY_KEY_NAMES[keyName] || keyName
}
