import { useState, useEffect } from 'react'
import './ScreenSourcePicker.css'
import { IconDeviceDesktop, IconAppWindow, IconLoader2 } from '@tabler/icons-react'

const RESOLUTIONS = [
  { label: '720p',  width: 1280, height: 720  },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 },
  { label: '4K',    width: 3840, height: 2160 },
]

// Modal that lists capturable screens/windows (fetched from the main process)
// and lets the user pick which one to share.
function ScreenSourcePicker({ onSelect, onCancel }) {
  const [sources, setSources] = useState(null)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [activeTab, setActiveTab] = useState('screens')
  const [fps, setFps] = useState(30)
  const [resolution, setResolution] = useState('1080p')
  const [audio, setAudio] = useState(true)

  useEffect(() => {
    let cancelled = false
    window.electron.ipcRenderer
      .invoke('get-screen-sources')
      .then((result) => {
        if (cancelled) return
        setSources(result)
        // Pre-select the first screen for a sensible default
        const firstScreen = result.find((s) => s.isScreen) || result[0]
        if (firstScreen) {
          setSelectedId(firstScreen.id)
          setActiveTab(firstScreen.isScreen ? 'screens' : 'windows')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load screen sources')
      })
    return () => { cancelled = true }
  }, [])

  const screens = sources?.filter((s) => s.isScreen) ?? []
  const windows = sources?.filter((s) => !s.isScreen) ?? []
  const visibleSources = activeTab === 'screens' ? screens : windows

  const confirm = () => {
    if (!selectedId) return
    const res = RESOLUTIONS.find((r) => r.label === resolution)
    onSelect(selectedId, { fps, audio, width: res.width, height: res.height })
  }

  const renderSource = (source) => (
    <button
      key={source.id}
      type="button"
      className={`source-card${selectedId === source.id ? ' selected' : ''}`}
      onClick={() => setSelectedId(source.id)}
      onDoubleClick={() => onSelect(source.id)}
    >
      <div className="source-thumb">
        <img src={source.thumbnail} alt={source.name} />
      </div>
      <div className="source-name">
        {source.appIcon && <img className="source-icon" src={source.appIcon} alt="" />}
        <span>{source.name}</span>
      </div>
    </button>
  )

  return (
    <div className="source-picker-overlay" onClick={onCancel}>
      <div className="source-picker-modal" onClick={(e) => e.stopPropagation()}>
        {sources && (
          <div className="source-picker-tabs">
            <button
              type="button"
              className={`source-tab${activeTab === 'screens' ? ' active' : ''}`}
              onClick={() => setActiveTab('screens')}
            >
              <IconDeviceDesktop size={16} /> Screens
            </button>
            <button
              type="button"
              className={`source-tab${activeTab === 'windows' ? ' active' : ''}`}
              onClick={() => setActiveTab('windows')}
            >
              <IconAppWindow size={16} /> Windows
            </button>
          </div>
        )}

        <div className="source-picker-body">
          {error && <div className="source-picker-error">{error}</div>}

          {!sources && !error && (
            <div className="source-picker-loading">
              <IconLoader2 size={32} className="spin" />
              Loading sources…
            </div>
          )}

          {sources && (
            visibleSources.length > 0
              ? <div className="source-grid">{visibleSources.map(renderSource)}</div>
              : <div className="source-picker-loading">No {activeTab} found</div>
          )}
        </div>

        <div className="source-picker-footer">
          <div className="picker-quality">
            <div className="picker-quality-group">
              <span className="picker-quality-label">Audio</span>
              <div className="picker-segment">
                {[true, false].map((val) => (
                  <button
                    key={String(val)}
                    type="button"
                    className={`picker-segment-btn${audio === val ? ' active' : ''}`}
                    onClick={() => setAudio(val)}
                  >
                    {val ? 'On' : 'Off'}
                  </button>
                ))}
              </div>
            </div>

            <div className="picker-quality-group">
              <span className="picker-quality-label">FPS</span>
              <div className="picker-segment">
                {[30, 60].map((val) => (
                  <button
                    key={val}
                    type="button"
                    className={`picker-segment-btn${fps === val ? ' active' : ''}`}
                    onClick={() => setFps(val)}
                  >
                    {val}
                  </button>
                ))}
              </div>
            </div>

            <div className="picker-quality-group">
              <span className="picker-quality-label">Resolution</span>
              <div className="picker-segment">
                {RESOLUTIONS.map(({ label }) => (
                  <button
                    key={label}
                    type="button"
                    className={`picker-segment-btn${resolution === label ? ' active' : ''}`}
                    onClick={() => setResolution(label)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="picker-footer-actions">
            <button type="button" className="picker-btn secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="picker-btn primary"
              onClick={confirm}
              disabled={!selectedId}
            >
              Share
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default ScreenSourcePicker
