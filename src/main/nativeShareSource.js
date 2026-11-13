// Which source a native screen share uses, from PYLON_NATIVE_SHARE and the "Native screen
// share" setting (.plans/native-media-engine-setting.md, T3 and T4). Kept apart from
// mediaEngine.js, which imports Electron, so it can be tested.
//
// PYLON_NATIVE_SHARE wins when it is set:
//   screen                         the real screen, on Wayland and Windows only
//   file:<absolute path>           an Annex-B H264 file (IVF for AV1)
//   pattern:<width>x<height>@<fps> the sidecar's test pattern
//   off                            no native share, whatever the setting says
// Any other value is off, as before the setting existed. Unset (or empty), the setting on
// means the screen, where the screen can be shared natively.

// Whether the setting can do anything on this system: Windows, and Linux on Wayland (T3).
export function nativeShareSettingApplies({ platform, sessionType }) {
  return platform === 'win32' || (platform === 'linux' && sessionType === 'wayland')
}

// { screen: true }, { file }, { pattern: { width, height, fps } }, or null (no native share).
//   env         the value of PYLON_NATIVE_SHARE (undefined when unset)
//   platform    process.platform
//   sessionType XDG_SESSION_TYPE
//   setting     the stored setting (true only when on)
export function nativeShareSource({ env, platform, sessionType, setting, isAbsolute }) {
  const raw = typeof env === 'string' ? env.trim() : ''
  const screen = nativeShareSettingApplies({ platform, sessionType }) ? { screen: true } : null
  if (raw === '') return setting === true ? screen : null
  if (raw === 'off') return null
  if (raw === 'screen') return screen
  if (raw.startsWith('file:')) {
    const path = raw.slice('file:'.length)
    return path && isAbsolute(path) ? { file: path } : null
  }
  const pattern = /^pattern:([1-9]\d*)x([1-9]\d*)@([1-9]\d*)$/.exec(raw)
  if (!pattern) return null
  const [width, height, fps] = pattern.slice(1).map(Number)
  return { pattern: { width, height, fps } }
}

// The source's kind as the renderer is told it: 'screen', 'file', 'pattern' or null.
export function nativeShareSourceKind(source) {
  if (source?.screen) return 'screen'
  if (source?.file) return 'file'
  if (source?.pattern) return 'pattern'
  return null
}
