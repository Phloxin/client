import { createContext, useContext, useState, useEffect } from 'react'
import { setOutputDevice, setMasterVolume } from '../lib/soup'

const SettingsContext = createContext(null)

// Audio encoding constants — not exposed in settings UI
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNEL_COUNT = 1
const AUDIO_BITRATE = 128000

const DEFAULT_SETTINGS = {
  echoCancellation: false,
  // Mutually exclusive with useRnnoise - AI suppression is the default, so the
  // basic browser suppressor starts off (see AudioSettings for the toggle logic).
  noiseSuppression: false,
  autoGainControl: false,
  sampleRate: AUDIO_SAMPLE_RATE,
  channelCount: AUDIO_CHANNEL_COUNT,
  bitrate: AUDIO_BITRATE,
  deviceId: 'default',
  useVolumeGate: false,
  volumeGateThreshold: 30,
  useRnnoise: true,
  outputDeviceId: 'default',
  outputVolume: 100,
}

export function SettingsProvider({ children }) {
  const [micSettings, setMicSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('micSettings')
      // Merge over defaults so settings stored before a new key was added still
      // pick up a sensible value for it.
      return saved ? { ...DEFAULT_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  // Push playback (output) settings into the media layer so they apply to any
  // audio already playing as well as future streams — on load and on change.
  useEffect(() => {
    setOutputDevice(micSettings.outputDeviceId || 'default')
  }, [micSettings.outputDeviceId])

  useEffect(() => {
    setMasterVolume((micSettings.outputVolume ?? 100) / 100)
  }, [micSettings.outputVolume])

  const updateMicSettings = (newSettings) => {
    const merged = {
      ...micSettings,
      ...newSettings,
      // Always enforce hardcoded encoding constants
      sampleRate: AUDIO_SAMPLE_RATE,
      channelCount: AUDIO_CHANNEL_COUNT,
      bitrate: AUDIO_BITRATE,
    }
    setMicSettings(merged)
    localStorage.setItem('micSettings', JSON.stringify(merged))
  }

  return (
    <SettingsContext.Provider value={{ micSettings, updateMicSettings }}>
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  return useContext(SettingsContext)
}