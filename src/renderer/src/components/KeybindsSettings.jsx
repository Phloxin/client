import { useState, useEffect } from 'react'
import { IconX } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { keyboardEventToAccelerator } from '../../../shared/keybinds'

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
  const { keybindSettings, updateKeybindSettings } = useSettings()
  const [capturing, setCapturing] = useState(null) // action id currently listening
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
      updateKeybindSettings({ [capturing]: combo })
      setCapturing(null)
    }
    window.addEventListener('keydown', captureKey, true)
    return () => window.removeEventListener('keydown', captureKey, true)
  }, [capturing, updateKeybindSettings])

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

  const startCapture = (actionId) => {
    setCapturing(actionId)
  }

  const cancelCapture = () => {
    setCapturing(null)
  }

  const statusFor = (actionId) => registration?.actions?.[actionId]

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
            <div className="keybind-controls">
              <button
                type="button"
                className={`keybind-capture${capturing === a.id ? ' capturing' : ''}`}
                onClick={() => (capturing === a.id ? cancelCapture() : startCapture(a.id))}
              >
                {capturing === a.id
                  ? 'Press keys… (Esc to cancel)'
                  : keybindSettings[a.id] || 'Unassigned'}
              </button>
              {keybindSettings[a.id] && (
                <button
                  type="button"
                  className="keybind-clear"
                  title="Clear shortcut"
                  onClick={() => updateKeybindSettings({ [a.id]: null })}
                >
                  <IconX size={16} />
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default KeybindsSettings
