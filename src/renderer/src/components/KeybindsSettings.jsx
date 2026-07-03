import { useState, useEffect, useRef } from 'react'
import { IconX } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'

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
  const capturingRef = useRef(null)
  useEffect(() => {
    capturingRef.current = capturing
  }, [capturing])

  // The global keyboard hook (main process) records the next pressed combo and
  // sends it back here. Escape cancels.
  useEffect(() => {
    const off = window.electron?.ipcRenderer?.on('keybinds:captured', (_e, combo) => {
      const action = capturingRef.current
      if (!action) return
      if (combo !== 'Escape') updateKeybindSettings({ [action]: combo })
      setCapturing(null)
    })
    return () => off?.()
  }, [updateKeybindSettings])

  const startCapture = (actionId) => {
    setCapturing(actionId)
    window.electron?.ipcRenderer?.send('keybinds:capture-start')
  }

  const cancelCapture = () => {
    setCapturing(null)
    window.electron?.ipcRenderer?.send('keybinds:capture-cancel')
  }

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>Keybinds</h2>
          <p>
            Assign global keyboard shortcuts. These work system-wide, even when the app is in the
            background, and don&apos;t block the key in other apps.
          </p>
        </div>
      </div>

      <div className="settings-panel-group">
        {ACTIONS.map((a) => (
          <div className="settings-section settings-toggle-row" key={a.id}>
            <div className="settings-toggle-copy">
              <label>{a.label}</label>
              <p className="settings-section-desc">{a.desc}</p>
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
