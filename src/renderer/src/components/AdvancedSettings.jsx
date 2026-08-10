import { useState, useEffect } from 'react'
import { IconAlertTriangle, IconCircleCheck, IconDownload } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { resetCameraCodecPreference, resetScreenCodecPreference } from '../lib/soup'

// The keep-awake blocker is only wired up for Windows and Linux in main.
const supportsIdleInhibitor = window.api?.platform === 'win32' || window.api?.platform === 'linux'

// Last-loaded main-process settings, kept module-side so remounting the panel
// (e.g. switching back to the Advanced tab) seeds the toggles from the known
// values instead of null — otherwise the async load flashes the `?? fallback`
// state for a frame before it resolves. Updated on every successful load/toggle.
let cachedSettings = null

// Advanced settings. Two kinds live here:
//   - Codec badge: a renderer-only appearance pref (localStorage via context).
//   - Hardware acceleration: a Chromium startup flag the MAIN process applies
//     before app 'ready', so it's persisted main-side and needs a relaunch.
//   - Keep system awake: a power-save blocker main starts/stops on the fly.
function AdvancedSettings() {
  const { appearanceSettings, updateAppearanceSettings } = useSettings()

  // Seed from the cache so a remount shows the right state immediately; null
  // only on the very first mount, before the main process has ever answered.
  const seedHwAccel = cachedSettings ? cachedSettings.hardwareAcceleration !== false : null
  const [hwAccel, setHwAccel] = useState(seedHwAccel)
  // The value that's actually applied to the running process, so we can tell
  // the user a relaunch is pending when their toggle no longer matches it.
  const [appliedHwAccel, setAppliedHwAccel] = useState(seedHwAccel)
  const [preventSleep, setPreventSleep] = useState(
    cachedSettings ? cachedSettings.preventSleep === true : null
  )
  const [diagnosticsAvailable, setDiagnosticsAvailable] = useState(false)
  const [exportStatus, setExportStatus] = useState('idle')
  const [exportError, setExportError] = useState('')

  useEffect(() => {
    let cancelled = false
    window.electron?.ipcRenderer
      ?.invoke('get-app-settings')
      .then((settings) => {
        cachedSettings = settings || {}
        if (cancelled) return
        const enabled = settings?.hardwareAcceleration !== false
        setHwAccel(enabled)
        setAppliedHwAccel(enabled)
        setPreventSleep(settings?.preventSleep === true)
      })
      .catch((error) => {
        console.error('[AdvancedSettings] Failed to load app settings:', error)
        if (cancelled) return
        setHwAccel(true)
        setAppliedHwAccel(true)
        setPreventSleep(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    window.api?.diagnostics
      ?.isAvailable()
      .then((available) => {
        if (!cancelled) setDiagnosticsAvailable(available === true)
      })
      .catch((error) => {
        console.error('[AdvancedSettings] Failed to check diagnostic log availability:', error)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const togglePreventSleep = (enabled) => {
    setPreventSleep(enabled)
    if (cachedSettings) cachedSettings.preventSleep = enabled
    window.electron?.ipcRenderer?.send('set-idle-inhibitor', enabled)
  }

  const toggleHwAccel = (enabled) => {
    setHwAccel(enabled)
    if (cachedSettings) cachedSettings.hardwareAcceleration = enabled
    window.electron?.ipcRenderer?.send('set-app-settings', { hardwareAcceleration: enabled })
    // The set of available encoders is about to change, so a previously-learned
    // "AV1 is software → prefer H.264" verdict is stale — re-probe AV1 next share.
    resetScreenCodecPreference()
    // The camera's VP9/H.264 verdict is independent, but the same encoder
    // landscape change invalidates it too.
    resetCameraCodecPreference()
  }

  const relaunch = () => window.electron?.ipcRenderer?.send('relaunch-app')

  const exportLogs = async () => {
    setExportStatus('exporting')
    setExportError('')
    try {
      const result = await window.api.diagnostics.exportLogs()
      if (result?.ok) {
        setExportStatus('saved')
      } else if (result?.canceled) {
        setExportStatus('idle')
      } else {
        setExportStatus('error')
        setExportError(result?.error || 'The diagnostic log could not be exported.')
      }
    } catch (error) {
      console.error('[AdvancedSettings] Diagnostic log export failed:', error)
      setExportStatus('error')
      setExportError(error?.message || 'The diagnostic log could not be exported.')
    }
  }

  const needsRestart = hwAccel != null && appliedHwAccel != null && hwAccel !== appliedHwAccel

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>Advanced</h2>
          <p>Hardware acceleration, power behavior, and diagnostic tools.</p>
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

        {supportsIdleInhibitor && (
          <div className="settings-section settings-toggle-row">
            <div className="settings-toggle-copy">
              <label htmlFor="prevent-sleep-toggle">Keep System Awake</label>
              <p className="settings-section-desc">
                Stop your computer from going to sleep while Pylon is running, so long calls and
                screen shares aren&apos;t cut off by the idle timer. Your display can still turn off
                on its own schedule. Applies immediately.
              </p>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                id="prevent-sleep-toggle"
                checked={preventSleep ?? false}
                disabled={preventSleep == null}
                onChange={(e) => togglePreventSleep(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        )}

        {diagnosticsAvailable && (
          <div className="settings-section settings-toggle-row">
            <div className="settings-toggle-copy">
              <label>Diagnostic Logs</label>
              <p className="settings-section-desc">
                Export recent production warnings, errors, and crash details for troubleshooting.
                Routine health and media-stat messages are not included.
              </p>
              <p
                className={`settings-diagnostic-export-status ${
                  exportStatus === 'error' ? 'error' : 'success'
                }`}
                role="status"
                aria-live="polite"
              >
                {exportStatus === 'saved' && 'Diagnostic logs exported.'}
                {exportStatus === 'error' && exportError}
              </p>
            </div>
            <button
              type="button"
              className="settings-restart-btn"
              onClick={exportLogs}
              disabled={exportStatus === 'exporting'}
            >
              {exportStatus === 'saved' ? (
                <IconCircleCheck size={16} stroke={2} />
              ) : (
                <IconDownload size={16} stroke={2} />
              )}
              {exportStatus === 'exporting' ? 'Exporting…' : 'Export Logs'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default AdvancedSettings
