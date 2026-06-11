import { useState, useEffect } from 'react'
import VolumeGateMeter from './VolumeGateMeter'

function AudioSettings({ micSettings, updateMicSettings }) {
  const [audioDevices, setAudioDevices] = useState([])

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

        {/* 1. Microphone Device */}
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

        {/* 2. Volume Gate toggle + meter */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="useVolumeGate">Use Volume Gate</label>
            <p className="settings-section-desc">
              Silences your mic when ambient noise falls below a set level, cutting background sound between words.
            </p>
          </div>
          <input
            type="checkbox"
            id="useVolumeGate"
            checked={micSettings.useVolumeGate}
            onChange={(e) => updateMicSettings({ useVolumeGate: e.target.checked })}
          />
        </div>

        <div className="settings-section">
          <label>Volume Gate Threshold</label>
          <p className="settings-section-desc">
            Drag the marker to set the cut-off level. Audio below the marker is filtered out.
            {!micSettings.useVolumeGate && ' Enable the volume gate above to apply this during calls.'}
          </p>
          <VolumeGateMeter
            gateEnabled={micSettings.useVolumeGate}
            threshold={micSettings.volumeGateThreshold}
            onThresholdChange={(value) => updateMicSettings({ volumeGateThreshold: value })}
            micSettings={micSettings}
          />
        </div>

        {/* 3. Echo Cancellation */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="echoCancellation">Echo Cancellation</label>
            <p className="settings-section-desc">
              Removes echoes caused by your speakers being picked up by your microphone.
            </p>
            <p className="settings-section-desc">
              PLEASE NOTE: This feature interferes with the microphone test above, be sure to disable it.
            </p>
          </div>
          <input
            type="checkbox"
            id="echoCancellation"
            checked={micSettings.echoCancellation}
            onChange={(e) => updateMicSettings({ echoCancellation: e.target.checked })}
          />
        </div>

        {/* 4. Noise Suppression */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="noiseSuppression">Noise Suppression</label>
            <p className="settings-section-desc">
              Filters out steady background noise such as fans, air conditioning, and keyboard clicks.
            </p>
          </div>
          <input
            type="checkbox"
            id="noiseSuppression"
            checked={micSettings.noiseSuppression}
            onChange={(e) => updateMicSettings({ noiseSuppression: e.target.checked })}
          />
        </div>

        {/* 5. Auto Gain Control */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="autoGainControl">Auto Gain Control</label>
            <p className="settings-section-desc">
              Automatically adjusts microphone volume to maintain a consistent input level.
            </p>
          </div>
          <input
            type="checkbox"
            id="autoGainControl"
            checked={micSettings.autoGainControl}
            onChange={(e) => updateMicSettings({ autoGainControl: e.target.checked })}
          />
        </div>

      </div>

      <div className="settings-status">Settings saved automatically</div>
    </div>
  )
}

export default AudioSettings