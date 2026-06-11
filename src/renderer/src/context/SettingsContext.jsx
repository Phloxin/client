import { createContext, useContext, useState, useEffect } from 'react'

const SettingsContext = createContext(null)

// Audio encoding constants — not exposed in settings UI
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNEL_COUNT = 1
const AUDIO_BITRATE = 128000

const DEFAULT_SETTINGS = {
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: false,
  sampleRate: AUDIO_SAMPLE_RATE,
  channelCount: AUDIO_CHANNEL_COUNT,
  bitrate: AUDIO_BITRATE,
  deviceId: 'default',
  useVolumeGate: false,
  volumeGateThreshold: 30,
}

export function SettingsProvider({ children }) {
  const [micSettings, setMicSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('micSettings')
      return saved ? JSON.parse(saved) : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })

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