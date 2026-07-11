import { useState, useEffect } from 'react'
import { IconMicrophone, IconHeadphones } from '@tabler/icons-react'
import VolumeGateMeter from './VolumeGateMeter'

function AudioSettings({ micSettings, updateMicSettings }) {
  const [audioDevices, setAudioDevices] = useState([])
  const [outputDevices, setOutputDevices] = useState([])
  const [draftSettings, setDraftSettings] = useState(micSettings)

  useEffect(() => {
    const getDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        setAudioDevices(devices.filter((device) => device.kind === 'audioinput'))
        setOutputDevices(devices.filter((device) => device.kind === 'audiooutput'))
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
          <p>Adjust microphone capture, playback output, and audio processing.</p>
        </div>
      </div>

      <div className="settings-panel-group">
        {/* 1. Microphone Device */}
        <div className="settings-section">
          <label>Input Device</label>
          <div className="settings-select-row">
            <IconMicrophone size={18} stroke={2} />
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
        </div>

        {/* 2. Output Device */}
        <div className="settings-section">
          <label>Output Device</label>
          <p className="settings-section-desc">
            Choose which speakers or headphones other people&apos;s audio plays through.
          </p>
          <div className="settings-select-row">
            <IconHeadphones size={18} stroke={2} />
            <select
              value={draftSettings.outputDeviceId || 'default'}
              onChange={(e) => updateDraft({ outputDeviceId: e.target.value })}
            >
              <option value="default">Default Device</option>
              {outputDevices.map((device) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Audio Output ${device.deviceId.slice(0, 8)}`}
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* 3. Output Volume */}
        <div className="settings-section">
          <label>Output Volume</label>
          <p className="settings-section-desc">
            Master playback level applied to everyone you hear.
          </p>
          <div className="settings-volume-row">
            <input
              type="range"
              min="0"
              max="100"
              step="1"
              value={draftSettings.outputVolume ?? 100}
              onChange={(e) => updateDraft({ outputVolume: Number(e.target.value) })}
              className="settings-volume-slider"
            />
            <span className="settings-volume-value">{draftSettings.outputVolume ?? 100}%</span>
          </div>
        </div>

        {/* 4. Volume Gate toggle + meter */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="useVolumeGate">Use Voice Gate</label>
            <p className="settings-section-desc">
              Silences your mic when ambient noise falls below a set level, cutting background sound
              between words.
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
          <label>Voice Gate Threshold</label>
          <p className="settings-section-desc">
            Click the bar to set the cut-off level. Audio below the marker is filtered out.
            {!draftSettings.useVolumeGate &&
              ' Enable the volume gate above to apply this during calls.'}
          </p>
          <VolumeGateMeter
            gateEnabled={draftSettings.useVolumeGate}
            threshold={draftSettings.volumeGateThreshold}
            onThresholdChange={(value) => updateDraft({ volumeGateThreshold: value })}
            micSettings={draftSettings}
          />
        </div>

        {/* 5. AI Noise Suppression (RNNoise) - mutually exclusive with browser Noise Suppression */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="useRnnoise">AI Noise Suppression (Recommended)</label>
            <p className="settings-section-desc">
              Uses a voice-trained model to strip keyboard/typing sounds and steady background noise
              while letting your voice through. More effective than basic noise suppression for
              typing. Enabling this turns off basic Noise Suppression. Pair with a low Voice Gate
              for the best experience.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="useRnnoise"
              checked={draftSettings.useRnnoise}
              onChange={(e) =>
                updateDraft(
                  e.target.checked
                    ? { useRnnoise: true, noiseSuppression: false }
                    : { useRnnoise: false }
                )
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* 6. Noise Suppression (browser) - mutually exclusive with AI Noise Suppression */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="noiseSuppression">Standard Noise Suppression</label>
            <p className="settings-section-desc">
              Basic filtering of steady background noise such as fans, air conditioning, and
              keyboard clicks. Enabling this turns off AI Noise Suppression.
            </p>
          </div>
          <label className="toggle-switch">
            <input
              type="checkbox"
              id="noiseSuppression"
              checked={draftSettings.noiseSuppression}
              onChange={(e) =>
                updateDraft(
                  e.target.checked
                    ? { noiseSuppression: true, useRnnoise: false }
                    : { noiseSuppression: false }
                )
              }
            />
            <span className="toggle-slider" />
          </label>
        </div>

        {/* 7. Echo Cancellation */}
        <div className="settings-section settings-toggle-row">
          <div className="settings-toggle-copy">
            <label htmlFor="echoCancellation">Echo Cancellation</label>
            <p className="settings-section-desc">
              Removes echoes caused by your speakers being picked up by your microphone.
            </p>
            <p className="settings-section-desc">
              PLEASE NOTE: This feature can interfere with the microphone test above.
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

        {/* 8. Auto Gain Control */}
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

      {isDirty && (
        <div className="settings-status">
          <span>You have unsaved changes</span>
          <button className="settings-apply-btn" onClick={handleApply}>
            Apply
          </button>
        </div>
      )}
    </div>
  )
}

export default AudioSettings
