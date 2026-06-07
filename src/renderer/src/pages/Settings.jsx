import { useSettings } from '../context/SettingsContext'
import '../App.css'

function Settings() {
  const { micSettings, updateMicSettings } = useSettings()

  return (
    <div className="admin-layout">
      <div className="admin-header">Settings</div>
      <div className="admin-body">
        <div className="channel-section-label">Microphone</div>

        <div className="admin-section">
          <label>Sample Rate</label>
          <select
            value={micSettings.sampleRate}
            onChange={(e) => updateMicSettings({ sampleRate: parseInt(e.target.value) })}
          >
            <option value={44100}>44100 Hz</option>
            <option value={48000}>48000 Hz</option>
          </select>
        </div>

        <div className="admin-section">
          <label>Audio Bitrate</label>
          <select
            value={micSettings.bitrate}
            onChange={(e) => updateMicSettings({ bitrate: parseInt(e.target.value) })}
          >
            <option value={128000}>128 kbps (High)</option>
            <option value={256000}>256 kbps (Very High)</option>
            <option value={510000}>510 kbps (Maximum)</option>
          </select>
        </div>

        <div className="admin-section">
          <label>Channel Count</label>
          <select
            value={micSettings.channelCount}
            onChange={(e) => updateMicSettings({ channelCount: parseInt(e.target.value) })}
          >
            <option value={1}>Mono</option>
            <option value={2}>Stereo</option>
          </select>
        </div>

        <div className="admin-section" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <input
            type="checkbox"
            id="echoCancellation"
            checked={micSettings.echoCancellation}
            onChange={(e) => updateMicSettings({ echoCancellation: e.target.checked })}
          />
          <label htmlFor="echoCancellation">Echo Cancellation</label>
        </div>

        <div className="admin-section" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <input
            type="checkbox"
            id="noiseSuppression"
            checked={micSettings.noiseSuppression}
            onChange={(e) => updateMicSettings({ noiseSuppression: e.target.checked })}
          />
          <label htmlFor="noiseSuppression">Noise Suppression</label>
        </div>

        <div className="admin-section" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <input
            type="checkbox"
            id="autoGainControl"
            checked={micSettings.autoGainControl}
            onChange={(e) => updateMicSettings({ autoGainControl: e.target.checked })}
          />
          <label htmlFor="autoGainControl">Auto Gain Control</label>
        </div>

        <div className="admin-status" style={{ color: '#57f287' }}>Settings saved automatically</div>
      </div>
    </div>
  )
}

export default Settings