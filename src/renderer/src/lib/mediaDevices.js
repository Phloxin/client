// Audio device observation, shared by the mic publish ladder and the playback
// context. Device loss is the failure this exists for. A USB/Bluetooth
// headset is one device with two halves, so when it drops the client loses
// capture and playback in the same instant. Nothing in the app noticed this
// before, because there was no devicechange listener anywhere in the renderer.

// Which device ids the user has actually selected. Read through getters rather
// than pushed in, so the log line always describes the live selection instead
// of whatever it was when this module loaded.
let getSelectedInputId = () => null
let getSelectedOutputId = () => null

export function configureMediaDevices(dependencies = {}) {
  if (dependencies.getSelectedInputId) getSelectedInputId = dependencies.getSelectedInputId
  if (dependencies.getSelectedOutputId) getSelectedOutputId = dependencies.getSelectedOutputId
}

// Device ids are long opaque hashes; a prefix is enough to correlate a
// selection with an enumeration across log lines without filling the export.
export function shortDeviceId(deviceId) {
  if (!deviceId) return 'none'
  if (deviceId === 'default' || deviceId === 'communications') return deviceId
  return `${String(deviceId).slice(0, 8)}…`
}

// The audio device ids currently enumerated, or null when enumeration itself
// failed — callers must not read "not enumerated" as "device is gone".
export async function audioDeviceIds() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices()
    const inputIds = new Set()
    const outputIds = new Set()
    for (const device of devices) {
      if (device.kind === 'audioinput') inputIds.add(device.deviceId)
      else if (device.kind === 'audiooutput') outputIds.add(device.deviceId)
    }
    return { inputIds, outputIds }
  } catch (err) {
    console.warn('[Devices] enumerateDevices failed:', err)
    return null
  }
}

const deviceChangeListeners = new Set()

// Fires after every OS device change. Returns an unsubscribe. Listeners run
// isolated: a throwing subscriber must not stop the others from recovering.
export function subscribeDeviceChange(listener) {
  deviceChangeListeners.add(listener)
  return () => deviceChangeListeners.delete(listener)
}

async function handleDeviceChange() {
  const ids = await audioDeviceIds()
  const selectedInput = getSelectedInputId()
  const selectedOutput = getSelectedOutputId()
  const presence = (deviceId, available) => {
    if (!deviceId || deviceId === 'default') return 'default'
    if (!available) return 'unknown'
    return available.has(deviceId) ? 'present' : 'missing'
  }
  console.warn(
    `[Devices] devicechange inputs=${ids?.inputIds.size ?? '?'} outputs=${ids?.outputIds.size ?? '?'} ` +
      `input=${shortDeviceId(selectedInput)}:${presence(selectedInput, ids?.inputIds)} ` +
      `output=${shortDeviceId(selectedOutput)}:${presence(selectedOutput, ids?.outputIds)}`
  )
  for (const listener of [...deviceChangeListeners]) {
    try {
      listener(ids)
    } catch (err) {
      console.error('[Devices] devicechange listener failed:', err)
    }
  }
}

// Bound once for the life of the renderer. Device loss can happen before a join
// and be discovered by it, so this is not scoped to a voice session.
if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void handleDeviceChange()
  })
}
