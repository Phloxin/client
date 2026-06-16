import { useState, useEffect } from 'react'
import VolumeGateMeter from './VolumeGateMeter'

function AudioSettings({ micSettings, updateMicSettings }) {
  const [audioDevices, setAudioDevices] = useState([])
  const [draftSettings, setDraftSettings] = useState(micSettings)

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

  const updateDraft = (changes) => {
    setDraftSettings((prev) => ({ ...prev, ...changes }))
  }

  const isDirty = JSON.stringify(draftSettings) !== JSON.stringify(micSettings)

  const handleApply = () => {
    updateMicSettings(draftSettings)
  }

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
            value={draftSettings.deviceId || 'default'}
            onChange={(e) => updateDraft({ deviceId: e.target.value })}
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
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="useVolumeGate"
              checked={draftSettings.useVolumeGate}
              onChange={(e) => updateDraft({ useVolumeGate: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        <div className="settings-section">
          <label>Volume Gate Threshold</label>
          <p className="settings-section-desc">
            Click the bar to set the cut-off level. Audio below the marker is filtered out.
            {!draftSettings.useVolumeGate && ' Enable the volume gate above to apply this during calls.'}
          </p>
          <VolumeGateMeter
            gateEnabled={draftSettings.useVolumeGate}
            threshold={draftSettings.volumeGateThreshold}
            onThresholdChange={(value) => updateDraft({ volumeGateThreshold: value })}
            micSettings={draftSettings}
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
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="echoCancellation"
              checked={draftSettings.echoCancellation}
              onChange={(e) => updateDraft({ echoCancellation: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* 4. Noise Suppression */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="noiseSuppression">Noise Suppression</label>
            <p className="settings-section-desc">
              Filters out steady background noise such as fans, air conditioning, and keyboard clicks.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="noiseSuppression"
              checked={draftSettings.noiseSuppression}
              onChange={(e) => updateDraft({ noiseSuppression: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* 5. Auto Gain Control */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="autoGainControl">Auto Gain Control</label>
            <p className="settings-section-desc">
              Automatically adjusts microphone volume to maintain a consistent input level.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="autoGainControl"
              checked={draftSettings.autoGainControl}
              onChange={(e) => updateDraft({ autoGainControl: e.target.checked })}
            />
            <span className="toggle-slider" />
          </label>
        </div>

      </div>

      <div className="settings-status">
        <span>{isDirty ? 'You have unsaved changes' : 'Settings saved'}</span>
        <button className="settings-apply-btn" onClick={handleApply} disabled={!isDirty}>
          Apply
        </button>
      </div>
    </div>
  )
}

export default AudioSettings