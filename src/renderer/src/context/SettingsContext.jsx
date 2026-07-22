import { createContext, useContext, useState, useEffect } from 'react'
import { setOutputDevice, setMasterVolume } from '../lib/soup'
import {
  setSoundStateMap,
  setSoundOutputDevice,
  setActiveSoundpack,
  setSoundVolume
} from '../lib/sounds'
import { applyAppearanceSettings, applyAnimationSettings } from '../lib/uiSettings'
import { prefersReducedMotion } from '../lib/animation'

const SettingsContext = createContext(null)

// Audio encoding constants — not exposed in settings UI
const AUDIO_SAMPLE_RATE = 48000
const AUDIO_CHANNEL_COUNT = 1
const AUDIO_BITRATE = 128000
const MIC_SETTINGS_VERSION = 3

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
  // On the shared speech-band RMS scale (see createSpeechLevelReader in soup.js).
  volumeGateThreshold: 15,
  useRnnoise: true,
  outputDeviceId: 'default',
  outputVolume: 100,
  // Bumped when a change makes an existing stored value mean something different;
  // read by migrateMicSettings to rewrite old saves.
  settingsVersion: MIC_SETTINGS_VERSION
}

const DEFAULT_APPEARANCE = {
  transparencyEnabled: false,
  transparencyBlur: 20,
  transparencyOpacity: 85,
  gradientsEnabled: true,
  shadowsEnabled: true,
  fontFamily: 'inter',
  // 'cozy' = avatar + name + time + message (default); 'compact' = name + time + message, no avatar.
  messageDisplay: 'cozy',
  // Server-group decorations on client rows (tag pills / icon badges).
  showGroupTags: true,
  showGroupIcons: true,
  // Show the codec / HW-SW badge on the focused stream (Advanced settings).
  showCodecBadge: true
}

// No shortcuts assigned by default; a value is a combo string like "Ctrl+Shift+M".
const DEFAULT_KEYBINDS = {
  toggleMicMute: null,
  toggleSoundMute: null
}

const DEFAULT_ANIMATIONS = {
  // enabled is the master switch; the rest are 'off' or a per-category style.
  enabled: true,
  channelSwitch: 'fade', // 'fade' | 'off'
  userJoin: 'pop', // 'pop' | 'off'
  channelList: 'pop', // 'pop' | 'off'
  overlays: 'on', // modals, menus, toasts — 'on' | 'off'
  messages: 'slide' // new chat messages — 'slide' | 'off'
}

// 'slide' was retired for user-join / channel-list (only 'pop' read well there)
// and later for channel-switch too (fade is the only non-off style now); fold any
// persisted 'slide' back to that category's remaining style so old saves don't
// dangle on a value the UI no longer offers.
function migrateAnimations(settings) {
  const next = { ...settings }
  if (next.userJoin === 'slide') next.userJoin = 'pop'
  if (next.channelList === 'slide') next.channelList = 'pop'
  if (next.channelSwitch === 'slide') next.channelSwitch = 'fade'
  return next
}

// Reset thresholds saved against an older meter scale. Version 2 introduced the
// shared speech-band RMS metric; version 3 gives speech more usable headroom by
// moving its dBFS range, so an old numeric threshold is no longer comparable.
function migrateMicSettings(saved) {
  const merged = { ...DEFAULT_SETTINGS, ...saved }
  if ((Number(saved.settingsVersion) || 0) < MIC_SETTINGS_VERSION) {
    merged.volumeGateThreshold = DEFAULT_SETTINGS.volumeGateThreshold
    merged.settingsVersion = DEFAULT_SETTINGS.settingsVersion
  }
  return merged
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
      return saved
        ? migrateAnimations({ ...DEFAULT_ANIMATIONS, ...JSON.parse(saved) })
        : DEFAULT_ANIMATIONS
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

  const [keybindSettings, setKeybindSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('keybindSettings')
      return saved ? { ...DEFAULT_KEYBINDS, ...JSON.parse(saved) } : DEFAULT_KEYBINDS
    } catch {
      return DEFAULT_KEYBINDS
    }
  })

  const updateKeybindSettings = (changes) => {
    setKeybindSettings((prev) => {
      const merged = { ...prev, ...changes }
      localStorage.setItem('keybindSettings', JSON.stringify(merged))
      return merged
    })
  }

  // Mirror the current binds into the main process, which owns the global
  // (OS-wide) keyboard hook — on load and on every change.
  useEffect(() => {
    window.electron?.ipcRenderer?.send('keybinds:set', keybindSettings)
  }, [keybindSettings])

  const [micSettings, setMicSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('micSettings')
      // Merge over defaults so settings stored before a new key was added still
      // pick up a sensible value for it, then run scale migrations.
      return saved ? migrateMicSettings(JSON.parse(saved)) : DEFAULT_SETTINGS
    } catch {
      return DEFAULT_SETTINGS
    }
  })

  // Per-sound state, keyed by sound id: 'off' | 'on' | 'pin'. Absent = 'on', so
  // only sounds the user has changed from the default are stored.
  const [soundState, setSoundStateObj] = useState(() => {
    try {
      const saved = localStorage.getItem('soundState')
      return saved ? JSON.parse(saved) : {}
    } catch {
      return {}
    }
  })

  // Mirror sound-state prefs into the (non-React) sounds module so playUiSound
  // can honour them — on load and on every change.
  useEffect(() => {
    setSoundStateMap(soundState)
  }, [soundState])

  const [soundpack, setSoundpackState] = useState(() => localStorage.getItem('soundpack') || 'default')

  // Mirror the chosen soundpack into the sounds module on load and on change.
  useEffect(() => {
    setActiveSoundpack(soundpack)
  }, [soundpack])

  const setSoundpack = (id) => {
    localStorage.setItem('soundpack', id)
    setSoundpackState(id)
  }

  // Notification-sound volume, 0..100 (separate from the voice master volume).
  const [soundVolume, setSoundVolumeState] = useState(() => {
    const raw = localStorage.getItem('soundVolume')
    const saved = Number(raw)
    // Absent → default 50; a saved 0 (muted) is honoured.
    return raw !== null && Number.isFinite(saved) ? Math.min(100, Math.max(0, saved)) : 50
  })

  // Mirror volume into the sounds module (as 0..1) on load and on change.
  useEffect(() => {
    setSoundVolume(soundVolume / 100)
  }, [soundVolume])

  const updateSoundVolume = (value) => {
    localStorage.setItem('soundVolume', String(value))
    setSoundVolumeState(value)
  }

  // `changes` is a map of soundId -> 'off'|'on'|'pin'; pass several to set a whole
  // section at once.
  const setSoundState = (changes) => {
    setSoundStateObj((prev) => {
      const merged = { ...prev, ...changes }
      localStorage.setItem('soundState', JSON.stringify(merged))
      return merged
    })
  }

  // Push playback (output) settings into the media layer so they apply to any
  // audio already playing as well as future streams — on load and on change.
  useEffect(() => {
    const device = micSettings.outputDeviceId || 'default'
    setOutputDevice(device)
    setSoundOutputDevice(device)
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
        soundState,
        setSoundState,
        soundpack,
        setSoundpack,
        soundVolume,
        updateSoundVolume,
        appearanceSettings,
        updateAppearanceSettings,
        animationSettings,
        updateAnimationSettings,
        keybindSettings,
        updateKeybindSettings
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
