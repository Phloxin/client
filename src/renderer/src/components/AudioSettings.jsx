import { useState, useEffect } from 'react'
import VolumeGateMeter from './VolumeGateMeter'

function AudioSettings({ micSettings, updateMicSettings }) {
  const [audioDevices, setAudioDevices] = useState([])

  // Enumerate audio input devices on mount
  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const audioInputs = devices.filter((device) => device.kind === 'audioinput')
        setAudioDevices(audioInputs)
      } catch (err) {
        console.error('[AudioSettings] Failed to enumerate devices:', err)
      }
    }

    getDevices()
  }, [])

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>Audio</h2>
          <p>Adjust microphone capture quality and audio processing.</p>
        </div>
      </div>

      <div className="settings-panel-group">
        <div className="settings-section">
          <label>Microphone Device</label>
          <select
            value={micSettings.deviceId || 'default'}
            onChange={(e) => updateMicSettings({ deviceId: e.target.value })}
          >
            <option value="default">Default Device</option>
            {audioDevices.map((device) => (
              <option key={device.deviceId} value={device.deviceId}>
                {device.label || `Audio Input ${device.deviceId.slice(0, 8)}`}
              </option>
            ))}
          </select>
        </div>

        <div className="settings-section">
          <label>Sample Rate</label>
          <select
            value={micSettings.sampleRate}
            onChange={(e) => updateMicSettings({ sampleRate: parseInt(e.target.value) })}
          >
            <option value={44100}>44100 Hz</option>
            <option value={48000}>48000 Hz</option>
          </select>
        </div>

        <div className="settings-section">
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

        <div className="settings-section">
          <label>Channel Count</label>
          <select
            value={micSettings.channelCount}
            onChange={(e) => updateMicSettings({ channelCount: parseInt(e.target.value) })}
          >
            <option value={1}>Mono</option>
            <option value={2}>Stereo</option>
          </select>
        </div>

        <div className="settings-section settings-toggle-row">
          <label htmlFor="echoCancellation">Echo Cancellation</label>
          <input
            type="checkbox"
            id="echoCancellation"
            checked={micSettings.echoCancellation}
            onChange={(e) => updateMicSettings({ echoCancellation: e.target.checked })}
          />
        </div>

        <div className="settings-section settings-toggle-row">
          <label htmlFor="noiseSuppression">Noise Suppression</label>
          <input
            type="checkbox"
            id="noiseSuppression"
            checked={micSettings.noiseSuppression}
            onChange={(e) => updateMicSettings({ noiseSuppression: e.target.checked })}
          />
        </div>

        <div className="settings-section settings-toggle-row">
          <label htmlFor="autoGainControl">Auto Gain Control</label>
          <input
            type="checkbox"
            id="autoGainControl"
            checked={micSettings.autoGainControl}
            onChange={(e) => updateMicSettings({ autoGainControl: e.target.checked })}
          />
        </div>

        <div className="settings-section settings-toggle-row">
          <label htmlFor="useVolumeGate">Use Volume Gate</label>
          <input
            type="checkbox"
            id="useVolumeGate"
            checked={micSettings.useVolumeGate}
            onChange={(e) => updateMicSettings({ useVolumeGate: e.target.checked })}
          />
        </div>

        {micSettings.useVolumeGate && (
          <div className="settings-section">
            <label>Volume Gate Threshold</label>
            <p className="settings-section-desc">
              Drag the threshold marker to set microphone sensitivity. Audio below the threshold is filtered out.
            </p>
            <VolumeGateMeter
              threshold={micSettings.volumeGateThreshold}
              onThresholdChange={(value) => updateMicSettings({ volumeGateThreshold: value })}
              micSettings={micSettings}
            />
          </div>
        )}
      </div>

      <div className="settings-status">Settings saved automatically</div>
    </div>
  )
}

export default AudioSettings
