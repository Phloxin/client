import { createContext, useContext, useState, useEffect } from 'react'

const SettingsContext = createContext(null)

const DEFAULT_SETTINGS = {
  echoCancellation: false,
  noiseSuppression: true,
  autoGainControl: false,
  sampleRate: 48000,
  channelCount: 2,
  bitrate: 128000,
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
    const merged = { ...micSettings, ...newSettings }
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