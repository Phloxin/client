// Capture presets shared by the source picker and the stream view's quick
// settings menu — both offer the same resolutions and audio modes.

export const RESOLUTIONS = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 }
  // 4K omitted from the picker — restore when the encoder/bitrate ladder is
  // tuned for it.
  // { label: '4K',    width: 3840, height: 2160 },
]

// Linux needs an explicit audio-source choice. X11 can use the selected window
// title to suggest a matching PipeWire playback app, but Wayland's portal does
// not expose the selected window's owning PID, so the audio app is selected
// independently. Other platforms keep the simpler On/Off control.
export function audioOptionsFor(tab, caps) {
  const off = { value: 'none', label: 'Off' }
  if (!caps) return [off]
  if (caps.backend === 'none') {
    // Electron's display-media `loopback` source is currently Windows-only.
    // Offering it on Linux/macOS produced a video-only stream while the picker
    // misleadingly said audio was enabled.
    return caps.platform === 'win32' ? [{ value: 'system-legacy', label: 'On' }, off] : [off]
  }

  if (caps.platform === 'linux') {
    const app = { value: 'app', label: 'Selected app(s) only' }
    const system = caps.excludeSelf
      ? { value: 'system-exclude-self', label: 'Entire system (except Pylon)' }
      : caps.system
        ? { value: 'system', label: 'Entire system' }
        : null

    const nativeOptions = [system, caps.perApp ? app : null].filter(Boolean)

    // A window share defaults to per-app audio. Screen shares (and Wayland,
    // where the portal has not picked a source yet) default to system audio.
    return tab === 'windows' && caps.perApp
      ? [app, ...(system ? [system] : []), off]
      : [...nativeOptions, off]
  }

  const onValue =
    tab === 'windows' && caps.perApp
      ? 'app'
      : caps.excludeSelf
        ? 'system-exclude-self'
        : caps.system
          ? 'system'
          : 'system-legacy'
  return [{ value: onValue, label: 'On' }, off]
}
