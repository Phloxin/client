import { useState, useEffect } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { resetScreenCodecPreference } from '../lib/soup'

// Advanced settings. Two kinds live here:
//   - Codec badge: a renderer-only appearance pref (localStorage via context).
//   - Hardware acceleration: a Chromium startup flag the MAIN process applies
//     before app 'ready', so it's persisted main-side and needs a relaunch.
function AdvancedSettings() {
  const { appearanceSettings, updateAppearanceSettings } = useSettings()

  // null while loading; the boolean once the main process answers.
  const [hwAccel, setHwAccel] = useState(null)
  // The value that's actually applied to the running process, so we can tell
  // the user a relaunch is pending when their toggle no longer matches it.
  const [appliedHwAccel, setAppliedHwAccel] = useState(null)

  useEffect(() => {
    let cancelled = false
    window.electron?.ipcRenderer
      ?.invoke('get-app-settings')
      .then((settings) => {
        if (cancelled) return
        const enabled = settings?.hardwareAcceleration !== false
        setHwAccel(enabled)
        setAppliedHwAccel(enabled)
      })
      .catch(() => {
        if (cancelled) return
        setHwAccel(true)
        setAppliedHwAccel(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const toggleHwAccel = (enabled) => {
    setHwAccel(enabled)
    window.electron?.ipcRenderer?.send('set-app-settings', { hardwareAcceleration: enabled })
    // The set of available encoders is about to change, so a previously-learned
    // "AV1 is software → prefer H.264" verdict is stale — re-probe AV1 next share.
    resetScreenCodecPreference()
  }

  const relaunch = () => window.electron?.ipcRenderer?.send('relaunch-app')

  const needsRestart = hwAccel != null && appliedHwAccel != null && hwAccel !== appliedHwAccel

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>Advanced</h2>
          <p>Hardware acceleration and diagnostic overlays.</p>
        </div>
      </div>

      <div className="settings-panel-group">
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="hw-accel-toggle">Hardware Acceleration</label>
            <p className="settings-section-desc">
              Use the GPU for video encoding and rendering. Leave on for the best screen-share
              performance. Turn off only if you see black frames, crashes, or graphical glitches —
              this forces slower software encoding. Restarts the app.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="hw-accel-toggle"
              checked={hwAccel ?? true}
              disabled={hwAccel == null}
              onChange={(e) => toggleHwAccel(e.target.checked)}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {needsRestart && (
          <div className="settings-section settings-restart-notice">
            <IconAlertTriangle size={18} stroke={2} />
            <span>Restart required to apply the hardware-acceleration change.</span>
            <button type="button" className="settings-restart-btn" onClick={relaunch}>
              Restart now
            </button>
          </div>
        )}

        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="codec-badge-toggle">Stream Codec Badge</label>
            <p className="settings-section-desc">
              Show the video codec and hardware/software encoder (e.g. “AV1 HW”) on the focused
              stream, so you can confirm what a share is actually using.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="codec-badge-toggle"
              checked={appearanceSettings.showCodecBadge !== false}
              onChange={(e) => updateAppearanceSettings({ showCodecBadge: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>
      </div>
    </div>
  )
}

export default AdvancedSettings
