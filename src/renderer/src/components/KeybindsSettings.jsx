import { useState, useEffect } from 'react'
import { IconX } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { keyboardEventToAccelerator } from '../../../shared/keybinds'
import { APP_SHORTCUT_ACTIONS, appShortcutConflicts } from '../lib/useAppShortcuts'

const ACTIONS = [
  {
    id: 'toggleMicMute',
    label: 'Toggle Microphone Mute',
    desc: 'Mute or unmute your microphone.'
  },
  {
    id: 'toggleSoundMute',
    label: 'Toggle Sound Mute (Deafen)',
    desc: 'Silence everyone you hear (also mutes your mic).'
  }
]

function KeybindsSettings() {
  const { keybindSettings, updateKeybindSettings, appShortcutSettings, updateAppShortcutSettings } =
    useSettings()
  // The row listening for a combo: { scope: 'global' | 'app', id }, or null.
  const [capturing, setCapturing] = useState(null)
  const [registration, setRegistration] = useState(null)

  // Capture locally while this window is focused. This is deliberately separate
  // from the global backend: Wayland does not expose arbitrary keyboard events
  // to applications, even when an X11 compatibility hook is running.
  useEffect(() => {
    if (!capturing) return undefined

    const captureKey = (event) => {
      event.preventDefault()
      event.stopPropagation()
      if (event.repeat) return
      if (event.code === 'Escape') {
        setCapturing(null)
        return
      }

      const combo = keyboardEventToAccelerator(event)
      if (!combo) return // wait through modifier-only/unsupported key presses
      const update = capturing.scope === 'app' ? updateAppShortcutSettings : updateKeybindSettings
      update({ [capturing.id]: combo })
      setCapturing(null)
    }
    window.addEventListener('keydown', captureKey, true)
    return () => window.removeEventListener('keydown', captureKey, true)
  }, [capturing, updateKeybindSettings, updateAppShortcutSettings])

  useEffect(() => {
    let mounted = true
    window.electron?.ipcRenderer
      ?.invoke('keybinds:get-status')
      .then((status) => {
        if (mounted) setRegistration(status)
      })
      .catch(() => {})
    const off = window.electron?.ipcRenderer?.on('keybinds:status', (_e, status) => {
      setRegistration(status)
    })
    return () => {
      mounted = false
      off?.()
    }
  }, [])

  const isCapturing = (scope, id) => capturing?.scope === scope && capturing.id === id
  const toggleCapture = (scope, id) => setCapturing(isCapturing(scope, id) ? null : { scope, id })

  const statusFor = (actionId) => registration?.actions?.[actionId]
  const conflicts = appShortcutConflicts(appShortcutSettings)

  // The capture button and clear button shared by both groups.
  const controls = (scope, id, combo, onClear) => (
    <div className="keybind-controls">
      <button
        type="button"
        className={`keybind-capture${isCapturing(scope, id) ? ' capturing' : ''}`}
        onClick={() => toggleCapture(scope, id)}
      >
        {isCapturing(scope, id) ? 'Press keys… (Esc to cancel)' : combo || 'Unassigned'}
      </button>
      {combo && (
        <button type="button" className="keybind-clear" title="Clear shortcut" onClick={onClear}>
          <IconX size={16} />
        </button>
      )}
    </div>
  )

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>Keybinds</h2>
          <p>
            Assign global keyboard shortcuts. These work system-wide, even when the app is in the
            background. On Wayland, shortcuts are registered with and controlled by your desktop.
          </p>
        </div>
      </div>

      <div className="settings-panel-group">
        {ACTIONS.map((a) => (
          <div className="settings-section settings-toggle-row" key={a.id}>
            <div className="settings-toggle-copy">
              <label>{a.label}</label>
              <p className="settings-section-desc">{a.desc}</p>
              {keybindSettings[a.id] && statusFor(a.id)?.registered && (
                <p className="settings-section-desc keybind-registration-success">
                  Registered globally.
                </p>
              )}
              {keybindSettings[a.id] && statusFor(a.id)?.registered === false && (
                <p className="settings-section-desc keybind-registration-error">
                  {statusFor(a.id).message || 'Global registration failed.'}
                </p>
              )}
            </div>
            {controls('global', a.id, keybindSettings[a.id], () =>
              updateKeybindSettings({ [a.id]: null })
            )}
          </div>
        ))}
      </div>

      <div className="theme-switcher-header">
        <h3>In-app shortcuts</h3>
        <p className="theme-switcher-description">Work while Pylon is focused.</p>
      </div>

      <div className="settings-panel-group">
        {APP_SHORTCUT_ACTIONS.map((a) => (
          <div className="settings-section settings-toggle-row" key={a.id}>
            <div className="settings-toggle-copy">
              <label>{a.label}</label>
              <p className="settings-section-desc">{a.desc}</p>
              {conflicts[a.id] && (
                <p className="settings-section-desc keybind-registration-error">
                  Conflicts with {conflicts[a.id]}
                </p>
              )}
            </div>
            {controls('app', a.id, appShortcutSettings[a.id], () =>
              updateAppShortcutSettings({ [a.id]: null })
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

export default KeybindsSettings
