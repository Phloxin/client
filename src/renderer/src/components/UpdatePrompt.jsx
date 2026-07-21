import { useState, useEffect, useRef } from 'react'
import { IconDownload, IconCircleCheck, IconAlertTriangle } from '@tabler/icons-react'
import './UpdatePrompt.css'

// Silent-on-launch update prompt. On mount it asks main to run a launch check
// (gated on the checkUpdatesOnLaunch setting); nothing shows unless an update is
// actually available. From there it reuses the same updater:event stream as the
// General settings tab to download and install.
function UpdatePrompt() {
  // 'hidden' | 'prompt' | 'downloading' | 'downloaded' | 'error'
  const [stage, setStage] = useState('hidden')
  const [version, setVersion] = useState('')
  const [percent, setPercent] = useState(0)
  const [error, setError] = useState('')
  const [dontAsk, setDontAsk] = useState(false)
  // Only show download/error state after the user opts into the update, so a
  // background launch-check error never pops a dialog on its own.
  const engaged = useRef(false)

  useEffect(() => {
    window.electron?.ipcRenderer
      ?.invoke('get-app-settings')
      .then((settings) => {
        if (settings?.checkUpdatesOnLaunch !== false) {
          window.electron?.ipcRenderer?.invoke('updater:check-on-launch')
        }
      })
      .catch(() => {})

    const off = window.electron?.ipcRenderer?.on('updater:event', (_e, msg) => {
      switch (msg.type) {
        case 'available':
          // Only launch checks pop this dialog; manual checks stay in Settings.
          if (msg.launch) {
            setVersion(msg.version)
            setStage('prompt')
          }
          break
        case 'progress':
          setStage('downloading')
          setPercent(msg.percent || 0)
          break
        case 'downloaded':
          setStage('downloaded')
          break
        case 'error':
          // Only surface errors once the user opted into this update flow.
          if (engaged.current) {
            setError(msg.message || 'Update failed.')
            setStage('error')
          }
          break
      }
    })
    return off
  }, [])

  const startUpdate = () => {
    engaged.current = true
    setStage('downloading')
    window.electron?.ipcRenderer?.invoke('updater:download')
  }

  const install = () => window.electron?.ipcRenderer?.send('updater:install')

  const dismiss = () => {
    if (dontAsk) {
      window.electron?.ipcRenderer?.send('set-app-settings', { checkUpdatesOnLaunch: false })
    }
    setStage('hidden')
  }

  if (stage === 'hidden') return null

  return (
    <div className="update-prompt-overlay">
      <div className="update-prompt">
        {stage === 'prompt' && (
          <>
            <h3>Update available</h3>
            <p>Version {version} is available. Would you like to update?</p>
            <label className="update-prompt-dontask">
              <input
                type="checkbox"
                checked={dontAsk}
                onChange={(e) => setDontAsk(e.target.checked)}
              />
              Don&apos;t show me again
            </label>
            <div className="update-prompt-actions">
              <button type="button" className="picker-btn secondary" onClick={dismiss}>
                Not now
              </button>
              <button type="button" className="picker-btn primary" onClick={startUpdate}>
                <IconDownload size={16} stroke={2} />
                Update
              </button>
            </div>
          </>
        )}

        {stage === 'downloading' && (
          <>
            <h3>Downloading update…</h3>
            <div className="update-prompt-progress">
              <div
                className="update-prompt-progress-bar"
                style={{ width: `${Math.round(percent)}%` }}
              />
            </div>
            <p>{Math.round(percent)}%</p>
          </>
        )}

        {stage === 'downloaded' && (
          <>
            <h3>Update ready</h3>
            <p>Version {version} has downloaded. Restart to install it now.</p>
            <div className="update-prompt-actions">
              <button
                type="button"
                className="picker-btn secondary"
                onClick={() => setStage('hidden')}
              >
                Later
              </button>
              <button type="button" className="picker-btn primary" onClick={install}>
                <IconCircleCheck size={16} stroke={2} />
                Restart &amp; Install
              </button>
            </div>
          </>
        )}

        {stage === 'error' && (
          <>
            <h3 className="update-prompt-error-title">
              <IconAlertTriangle size={18} stroke={2} />
              Update failed
            </h3>
            <p>{error}</p>
            <div className="update-prompt-actions">
              <button
                type="button"
                className="picker-btn secondary"
                onClick={() => setStage('hidden')}
              >
                Close
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default UpdatePrompt
