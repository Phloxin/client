import { createContext, useContext, useState, useEffect } from 'react'
import { setOutputDevice, setMasterVolume } from '../lib/soup'
import { SOUND_CATEGORIES, setSoundCategoriesEnabled } from '../lib/sounds'
import { applyAppearanceSettings, applyAnimationSettings } from '../lib/uiSettings'
import { prefersReducedMotion } from '../lib/animation'

const SettingsContext = createContext(null)

// Sound-effect categories all start enabled. Derived from the soundpack registry
// so a newly-added category is on by default without touching this file.
const DEFAULT_SOUND_SETTINGS = Object.fromEntries(SOUND_CATEGORIES.map((c) => [c.id, true]))

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
  outputVolume: 100
}

const DEFAULT_APPEARANCE = {
  transparencyEnabled: false,
  transparencyBlur: 20,
  transparencyOpacity: 85
}

const DEFAULT_ANIMATIONS = {
  // enabled is the master switch; the rest are 'off' or a per-category style.
  enabled: true,
  channelSwitch: 'fade', // 'fade' | 'slide' | 'off'
  userJoin: 'slide', // 'slide' | 'pop' | 'off'
  channelList: 'slide' // 'slide' | 'pop' | 'off'
}

export function SettingsProvider({ children }) {
  const [appearanceSettings, setAppearanceSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('appearanceSettings')
      return saved ? { ...DEFAULT_APPEARANCE, ...JSON.parse(saved) } : DEFAULT_APPEARANCE
    } catch {
      return DEFAULT_APPEARANCE
    }
  })

  useEffect(() => {
    applyAppearanceSettings(appearanceSettings)
    try {
      window.electron?.ipcRenderer?.send(
        'set-window-vibrancy',
        appearanceSettings.transparencyEnabled
      )
    } catch {}
  }, [appearanceSettings])

  const updateAppearanceSettings = (changes) => {
    setAppearanceSettings((prev) => {
      const merged = { ...prev, ...changes }
      localStorage.setItem('appearanceSettings', JSON.stringify(merged))
      return merged
    })
  }

  const [animationSettings, setAnimationSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('animationSettings')
      return saved ? { ...DEFAULT_ANIMATIONS, ...JSON.parse(saved) } : DEFAULT_ANIMATIONS
    } catch {
      return DEFAULT_ANIMATIONS
    }
  })

  useEffect(() => {
    applyAnimationSettings(animationSettings)
  }, [animationSettings])

  const updateAnimationSettings = (changes) => {
    setAnimationSettings((prev) => {
      const merged = { ...prev, ...changes }
      localStorage.setItem('animationSettings', JSON.stringify(merged))
      return merged
    })
  }

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

  const [soundSettings, setSoundSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('soundSettings')
      // Merge over defaults so a category added after the prefs were saved still
      // gets a sensible (enabled) value.
      return saved ? { ...DEFAULT_SOUND_SETTINGS, ...JSON.parse(saved) } : DEFAULT_SOUND_SETTINGS
    } catch {
      return DEFAULT_SOUND_SETTINGS
    }
  })

  // Mirror sound-category prefs into the (non-React) sounds module so playUiSound
  // can honour them — on load and on every change.
  useEffect(() => {
    setSoundCategoriesEnabled(soundSettings)
  }, [soundSettings])

  const updateSoundSettings = (changes) => {
    setSoundSettings((prev) => {
      const merged = { ...prev, ...changes }
      localStorage.setItem('soundSettings', JSON.stringify(merged))
      return merged
    })
  }

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
      bitrate: AUDIO_BITRATE
    }
    setMicSettings(merged)
    localStorage.setItem('micSettings', JSON.stringify(merged))
  }

  return (
    <SettingsContext.Provider
      value={{
        micSettings,
        updateMicSettings,
        soundSettings,
        updateSoundSettings,
        appearanceSettings,
        updateAppearanceSettings,
        animationSettings,
        updateAnimationSettings
      }}
    >
      {children}
    </SettingsContext.Provider>
  )
}

export function useSettings() {
  return useContext(SettingsContext)
}

// Whether a given animation category should actually run: master switch on, the
// category not 'off', and the OS isn't asking us to reduce motion.
export function useAnimationCategory(category) {
  const { animationSettings } = useSettings()
  return (
    animationSettings.enabled && animationSettings[category] !== 'off' && !prefersReducedMotion()
  )
}
