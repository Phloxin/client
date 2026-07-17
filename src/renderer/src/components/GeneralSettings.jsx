import { useState, useEffect } from 'react'
import { IconRefresh, IconDownload, IconCircleCheck, IconAlertTriangle } from '@tabler/icons-react'

// Update flow backed by electron-updater in main. The main process broadcasts
// 'updater:event' messages; this component just reflects the latest one and
// exposes the three actions (check / download / install).
function GeneralSettings() {
  const [version, setVersion] = useState('')
  // 'idle' | 'checking' | 'available' | 'not-available' | 'downloading'
  //   | 'downloaded' | 'error' | 'disabled'
  const [status, setStatus] = useState('idle')
  const [newVersion, setNewVersion] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')

  useEffect(() => {
    window.electron?.ipcRenderer?.invoke('get-app-version').then(setVersion).catch(() => {})

    const off = window.electron?.ipcRenderer?.on('updater:event', (_e, msg) => {
      switch (msg.type) {
        case 'checking':
          setStatus('checking')
          setError('')
          break
        case 'available':
          setStatus('available')
          setNewVersion(msg.version)
          break
        case 'not-available':
          setStatus('not-available')
          break
        case 'progress':
          setStatus('downloading')
          setPercent(msg.percent || 0)
          break
        case 'downloaded':
          setStatus('downloaded')
          setNewVersion(msg.version)
          break
        case 'disabled':
          setStatus('disabled')
          break
        case 'error':
          setStatus('error')
          setError(msg.message || 'Update failed.')
          break
      }
    })
    return off
  }, [])

  const check = () => window.electron?.ipcRenderer?.invoke('updater:check')
  const download = () => window.electron?.ipcRenderer?.invoke('updater:download')
  const install = () => window.electron?.ipcRenderer?.send('updater:install')

  const checking = status === 'checking'

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>General</h2>
          <p>Application version and updates.</p>
        </div>
      </div>

      <div className="settings-panel-group">
        <div className="settings-section">
          <label>Version</label>
          <p className="settings-section-desc">
            You&apos;re running Pylon {version && `v${version}`}. New releases install without
            reinstalling the app.
          </p>
        </div>

        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label>Updates</label>
            <p className="settings-section-desc">
              {status === 'checking' && 'Checking for updates…'}
              {status === 'idle' && 'Check whether a newer version is available.'}
              {status === 'not-available' && "You're on the latest version."}
              {status === 'available' && `Version ${newVersion} is available.`}
              {status === 'downloading' && `Downloading update… ${Math.round(percent)}%`}
              {status === 'downloaded' &&
                `Version ${newVersion} is ready. Restart to install, or keep working — it installs automatically when you close the app.`}
              {status === 'disabled' && 'Updates are only available in the installed app.'}
              {status === 'error' && (error || 'Something went wrong checking for updates.')}
            </p>
          </div>

          {(status === 'idle' ||
            status === 'not-available' ||
            status === 'checking' ||
            status === 'error') && (
            <button
              type="button"
              className="settings-restart-btn"
              onClick={check}
              disabled={checking}
            >
              <IconRefresh size={16} stroke={2} />
              {checking ? 'Checking…' : 'Check for Updates'}
            </button>
          )}

          {status === 'available' && (
            <button type="button" className="settings-restart-btn" onClick={download}>
              <IconDownload size={16} stroke={2} />
              Update
            </button>
          )}

          {status === 'downloaded' && (
            <button type="button" className="settings-restart-btn" onClick={install}>
              <IconCircleCheck size={16} stroke={2} />
              Restart &amp; Install
            </button>
          )}
        </div>

        {status === 'downloading' && (
          <div className="settings-section">
            <div className="settings-update-progress">
              <div
                className="settings-update-progress-bar"
                style={{ width: `${Math.round(percent)}%` }}
              />
            </div>
          </div>
        )}

        {status === 'error' && (
          <div className="settings-section settings-restart-notice">
            <IconAlertTriangle size={18} stroke={2} />
            <span>{error}</span>
          </div>
        )}
      </div>
    </div>
  )
}

export default GeneralSettings
