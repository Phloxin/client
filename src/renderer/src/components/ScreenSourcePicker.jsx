import { useState, useEffect, useMemo, useRef } from 'react'
import { motion } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop } from '../lib/motionPresets'
import SegmentedTabs from './SegmentedTabs'
import './ScreenSourcePicker.css'
import {
  IconDeviceDesktop,
  IconAppWindow,
  IconLoader2,
  IconCamera,
  IconScreenShare
} from '@tabler/icons-react'
import { getScreenAudioCapabilities, listScreenAudioApps } from '../lib/screenAudio'

const RESOLUTIONS = [
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '1440p', width: 2560, height: 1440 }
  // 4K omitted from the picker — restore when the encoder/bitrate ladder is
  // tuned for it.
  // { label: '4K',    width: 3840, height: 2160 },
]

// Linux needs an explicit audio-source choice. X11 can use the selected window
// title to suggest a matching PipeWire playback app, but Wayland's portal does
// not expose the selected window's owning PID, so the audio app is selected
// independently. Other platforms keep the simpler On/Off control.
function audioOptionsFor(tab, caps) {
  const off = { value: 'none', label: 'Off' }
  if (!caps) return [off]
  if (caps.backend === 'none') {
    // Electron's display-media `loopback` source is currently Windows-only.
    // Offering it on Linux/macOS produced a video-only stream while the picker
    // misleadingly said audio was enabled.
    return caps.platform === 'win32' ? [{ value: 'system-legacy', label: 'On' }, off] : [off]
  }

  if (caps.platform === 'linux') {
    const app = { value: 'app', label: 'Selected app(s) only' }
    const system = caps.excludeSelf
      ? { value: 'system-exclude-self', label: 'Entire system (except Pylon)' }
      : caps.system
        ? { value: 'system', label: 'Entire system' }
        : null

    const nativeOptions = [system, caps.perApp ? app : null].filter(Boolean)

    // A window share defaults to per-app audio. Screen shares (and Wayland,
    // where the portal has not picked a source yet) default to system audio.
    return tab === 'windows' && caps.perApp
      ? [app, ...(system ? [system] : []), off]
      : [...nativeOptions, off]
  }

  const onValue =
    tab === 'windows' && caps.perApp
      ? 'app'
      : caps.excludeSelf
        ? 'system-exclude-self'
        : caps.system
          ? 'system'
          : 'system-legacy'
  return [{ value: onValue, label: 'On' }, off]
}

// Preselect audio apps whose name plausibly matches the shared window's title.
function matchAppsToWindow(apps, windowName) {
  if (!windowName) return []
  const title = windowName.toLowerCase()
  return apps
    .filter((app) => {
      const name = app.name?.toLowerCase()
      if (!name) return false
      return title.includes(name) || name.includes(title)
    })
    .map((app) => app.id)
}

// Last-used quality/audio choices, remembered across sessions so a user with a
// consistent setup doesn't re-pick them every share. Audio is stored as On/Off
// only — the concrete capture mode is re-derived from caps each time.
const PREFS_KEY = 'streamPrefs'
function loadPrefs() {
  try {
    return { ...JSON.parse(localStorage.getItem(PREFS_KEY)) }
  } catch {
    return {}
  }
}

// Modal that lists capturable screens/windows (fetched from the main process)
// and lets the user pick which one to share. On Wayland the OS portal picks
// the video source instead, so only audio/quality options are shown there.
function ScreenSourcePicker({ onSelect, onCancel }) {
  const [sources, setSources] = useState(null)
  const [cameras, setCameras] = useState(null)
  const [error, setError] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [activeTab, setActiveTab] = useState('screens')
  const prefs = useMemo(loadPrefs, [])
  const [fps, setFps] = useState(prefs.fps ?? 30)
  const [resolution, setResolution] = useState(prefs.resolution ?? '1080p')
  // Bias the encoder toward sharp frames ('detail', for text/UI) or smooth
  // motion ('motion', for video-heavy shares). Threaded to soup as optimizeFor.
  const [optimizeFor, setOptimizeFor] = useState(prefs.optimizeFor ?? 'motion')
  const [caps, setCaps] = useState(null)
  // Remembered as On/Off; 'off' -> silent, 'on' lets the effective mode below
  // derive the best capture mode from caps. null falls through to the tab default.
  const [audioMode, setAudioMode] = useState(prefs.audioOff ? 'none' : null)
  const [apps, setApps] = useState(null)
  const [selectedApps, setSelectedApps] = useState(() => new Set())
  const audioSelectionTouched = useRef(false)
  const overlayAnim = useAnimationCategory('overlays')

  const isWayland = caps?.wayland === true
  // null caps = still loading; treat as non-Wayland until known.
  const capsLoaded = caps !== null

  useEffect(() => {
    let cancelled = false
    getScreenAudioCapabilities()
      .then((result) => {
        if (!cancelled) setCaps(result)
      })
      .catch(() => {
        if (!cancelled)
          setCaps({
            backend: 'none',
            perApp: false,
            excludeSelf: false,
            system: false,
            platform: window.api.platform
          })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Enumerate screens/windows for the source grid. Skipped on Wayland, where
  // enumeration itself would pop the OS portal dialog - the portal picks the
  // source when the share actually starts.
  useEffect(() => {
    if (!capsLoaded || isWayland) return
    let cancelled = false
    window.electron.ipcRenderer
      .invoke('get-screen-sources')
      .then((result) => {
        if (cancelled) return
        setSources(result)
        // Pre-select the first screen for a sensible default
        const firstScreen = result.find((s) => s.isScreen) || result[0]
        if (firstScreen) {
          setSelectedId(firstScreen.id)
          setActiveTab(firstScreen.isScreen ? 'screens' : 'windows')
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Failed to load screen sources')
      })
    return () => {
      cancelled = true
    }
  }, [capsLoaded, isWayland])

  // Enumerate connected webcams for the Devices tab. Labels are only populated
  // once camera permission has been granted; fall back to a generic name.
  useEffect(() => {
    let cancelled = false
    navigator.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (cancelled) return
        setCameras(devices.filter((d) => d.kind === 'videoinput'))
      })
      .catch(() => {
        if (!cancelled) setCameras([])
      })
    return () => {
      cancelled = true
    }
  }, [])

  const screens = sources?.filter((s) => s.isScreen) ?? []
  const windows = sources?.filter((s) => !s.isScreen) ?? []

  const audioOptions = useMemo(
    () => audioOptionsFor(activeTab === 'windows' ? 'windows' : 'screens', caps),
    [activeTab, caps]
  )
  // Default mode follows the tab until the user explicitly picks one that the
  // current tab also offers.
  const effectiveAudioMode = audioOptions.some((o) => o.value === audioMode)
    ? audioMode
    : audioOptions[0].value

  const needsAppList = effectiveAudioMode === 'app' && caps?.platform !== 'win32'

  // Keep the Linux playback-app list live while per-app mode is selected.
  // Requests are scheduled sequentially because the main-process bridge has a
  // single in-flight list-apps reply slot.
  useEffect(() => {
    if (!needsAppList) return
    let cancelled = false
    let refreshTimer = null

    const refreshApps = () => {
      listScreenAudioApps()
        .then((result) => {
          if (cancelled) return
          setApps(result)
          const availableIds = new Set(result.map((app) => app.id))
          setSelectedApps((previous) => {
            const retained = new Set([...previous].filter((id) => availableIds.has(id)))
            if (retained.size > 0 || isWayland || audioSelectionTouched.current) {
              return retained
            }
            const windowName = sources?.find((source) => source.id === selectedId)?.name
            return new Set(matchAppsToWindow(result, windowName))
          })
        })
        .catch(() => {
          if (!cancelled) setApps((current) => current ?? [])
        })
        .finally(() => {
          if (!cancelled) refreshTimer = setTimeout(refreshApps, 1500)
        })
    }

    refreshApps()
    return () => {
      cancelled = true
      if (refreshTimer !== null) clearTimeout(refreshTimer)
    }
    // Window changes are handled by selectSource without restarting polling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needsAppList])

  const toggleApp = (id) => {
    audioSelectionTouched.current = true
    setSelectedApps((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const selectSource = (source) => {
    setSelectedId(source.id)
    if (needsAppList && !isWayland && !source.isScreen && apps !== null) {
      audioSelectionTouched.current = false
      setSelectedApps(new Set(matchAppsToWindow(apps, source.name)))
    }
  }

  const selectAudioMode = (mode) => {
    setAudioMode(mode)
    if (mode === 'app' && caps?.platform === 'linux') {
      audioSelectionTouched.current = false
      setApps(null)
      setSelectedApps(new Set())
    }
  }

  // Switch tabs and move the selection to that tab's first item, so the
  // selected source always matches what's visible.
  const switchTab = (tab) => {
    setActiveTab(tab)
    if (tab === 'screens') setSelectedId(screens[0]?.id ?? null)
    else if (tab === 'windows' && windows[0]) selectSource(windows[0])
    else if (tab === 'windows') setSelectedId(null)
    else setSelectedId(cameras?.[0]?.deviceId ?? null)
  }

  const shareDisabled =
    activeTab === 'devices'
      ? !selectedId
      : (!isWayland && !selectedId) || (needsAppList && (apps === null || selectedApps.size === 0))

  const confirmWith = (id) => {
    if (activeTab === 'devices') {
      if (id) onSelect(id, { isCamera: true })
      return
    }
    const res = RESOLUTIONS.find((r) => r.label === resolution)
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({ fps, resolution, optimizeFor, audioOff: effectiveAudioMode === 'none' })
    )
    let audioTargets = null
    if (effectiveAudioMode === 'app') {
      audioTargets = caps?.platform === 'win32' ? [id] : [...selectedApps]
    }
    onSelect(id, {
      fps,
      width: res.width,
      height: res.height,
      audioMode: effectiveAudioMode,
      audioTargets,
      optimizeFor
    })
  }

  const confirm = () => {
    if (shareDisabled) return
    confirmWith(isWayland && activeTab !== 'devices' ? null : selectedId)
  }

  const renderSource = (source) => (
    <button
      key={source.id}
      type="button"
      className={`source-card${selectedId === source.id ? ' selected' : ''}`}
      onClick={() => selectSource(source)}
      onDoubleClick={() => confirmWith(source.id)}
    >
      <div className="source-thumb">
        <img src={source.thumbnail} alt={source.name} />
      </div>
      <div className="source-name">
        {source.appIcon && <img className="source-icon" src={source.appIcon} alt="" />}
        <span>{source.name}</span>
      </div>
    </button>
  )

  const renderCamera = (device, index) => (
    <button
      key={device.deviceId}
      type="button"
      className={`source-card${selectedId === device.deviceId ? ' selected' : ''}`}
      onClick={() => setSelectedId(device.deviceId)}
      onDoubleClick={() => onSelect(device.deviceId, { isCamera: true })}
    >
      <div className="source-thumb source-thumb-device">
        <IconCamera size={40} />
      </div>
      <div className="source-name">
        <span>{device.label || `Camera ${index + 1}`}</span>
      </div>
    </button>
  )

  const sourceTabs = isWayland
    ? [{ id: 'screens', label: 'Screen / Window', icon: <IconDeviceDesktop size={15} /> }]
    : [
        { id: 'screens', label: 'Screens', icon: <IconDeviceDesktop size={15} /> },
        { id: 'windows', label: 'Apps', icon: <IconAppWindow size={15} /> }
      ]

  return (
    <div className="source-picker-overlay" onClick={onCancel}>
      <motion.div
        className="source-picker-modal"
        onClick={(e) => e.stopPropagation()}
        {...overlayPop(overlayAnim)}
      >
        <div className="source-picker-tabs">
          <SegmentedTabs
            ariaLabel="Capture source type"
            active={activeTab === 'windows' && isWayland ? 'screens' : activeTab}
            onChange={switchTab}
            tabs={[
              ...sourceTabs,
              { id: 'devices', label: 'Devices', icon: <IconCamera size={15} /> }
            ]}
          />
        </div>

        <div className="source-picker-body">
          {error && <div className="source-picker-error">{error}</div>}

          {activeTab === 'devices' ? (
            cameras === null ? (
              <div className="source-picker-loading">
                <IconLoader2 size={32} className="spin" />
                Loading cameras…
              </div>
            ) : cameras.length > 0 ? (
              <div className="source-grid">{cameras.map(renderCamera)}</div>
            ) : (
              <div className="source-picker-loading">No cameras found</div>
            )
          ) : isWayland ? (
            <div className="picker-portal-note">
              <IconScreenShare size={40} />
              <p>Your desktop will ask which screen or window to share when the stream starts.</p>
            </div>
          ) : !sources && !error ? (
            <div className="source-picker-loading">
              <IconLoader2 size={32} className="spin" />
              Loading sources…
            </div>
          ) : (activeTab === 'screens' ? screens : windows).length > 0 ? (
            <div className="source-grid">
              {(activeTab === 'screens' ? screens : windows).map(renderSource)}
            </div>
          ) : (
            <div className="source-picker-loading">No {activeTab} found</div>
          )}

          {activeTab !== 'devices' && capsLoaded && caps.backend === 'none' && (
            <div className="picker-audio-warning" title={caps.reason || undefined}>
              {caps.platform === 'win32'
                ? 'Per-app audio filtering is unavailable; system audio uses Windows loopback.'
                : 'Screen audio capture is unavailable; this share will be video-only.'}
              {caps.reason ? ` (${caps.reason})` : ''}
            </div>
          )}

          {activeTab !== 'devices' && needsAppList && (
            <div className="picker-app-list">
              <div className="picker-app-list-title">Share audio from:</div>
              {apps === null ? (
                <div className="source-picker-loading">
                  <IconLoader2 size={20} className="spin" />
                  Finding apps playing audio…
                </div>
              ) : apps.length === 0 ? (
                <div className="picker-app-list-empty">
                  No apps are playing audio right now. Start playback and reopen this picker, or
                  choose a different audio source.
                </div>
              ) : (
                apps.map((app) => (
                  <label key={app.id} className="picker-app-item">
                    <input
                      type="checkbox"
                      checked={selectedApps.has(app.id)}
                      onChange={() => toggleApp(app.id)}
                    />
                    <span className="picker-app-name">{app.name}</span>
                    {app.binary && <span className="picker-app-binary">{app.binary}</span>}
                  </label>
                ))
              )}
            </div>
          )}
        </div>

        <div className="source-picker-footer">
          {activeTab === 'devices' ? (
            <p className="picker-device-note">
              Webcams stream without audio at the device&apos;s native quality.
            </p>
          ) : (
            <div className="picker-quality">
              <div className="picker-quality-group">
                <span className="picker-quality-label">Audio</span>
                {caps?.platform === 'linux' ? (
                  <select
                    className="picker-audio-select"
                    aria-label="Screen-share audio source"
                    value={effectiveAudioMode}
                    onChange={(e) => selectAudioMode(e.target.value)}
                  >
                    {audioOptions.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                ) : (
                  <div className="picker-segment">
                    {audioOptions.map((opt) => (
                      <button
                        key={opt.value}
                        type="button"
                        className={`picker-segment-btn${effectiveAudioMode === opt.value ? ' active' : ''}`}
                        onClick={() => selectAudioMode(opt.value)}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="picker-quality-group">
                <span className="picker-quality-label">FPS</span>
                <div className="picker-segment">
                  {[30, 60].map((val) => (
                    <button
                      key={val}
                      type="button"
                      className={`picker-segment-btn${fps === val ? ' active' : ''}`}
                      onClick={() => setFps(val)}
                    >
                      {val}
                    </button>
                  ))}
                </div>
              </div>

              <div className="picker-quality-group">
                <span className="picker-quality-label">Resolution</span>
                <div className="picker-segment">
                  {RESOLUTIONS.map(({ label }) => (
                    <button
                      key={label}
                      type="button"
                      className={`picker-segment-btn${resolution === label ? ' active' : ''}`}
                      onClick={() => setResolution(label)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="picker-quality-group">
                <span className="picker-quality-label">Optimize</span>
                <div className="picker-segment">
                  {[
                    { value: 'detail', label: 'Detail' },
                    { value: 'motion', label: 'Motion' }
                  ].map(({ value, label }) => (
                    <button
                      key={value}
                      type="button"
                      className={`picker-segment-btn${optimizeFor === value ? ' active' : ''}`}
                      onClick={() => setOptimizeFor(value)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="picker-footer-actions">
            <button type="button" className="picker-btn secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="picker-btn primary"
              onClick={confirm}
              disabled={shareDisabled}
            >
              Share
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  )
}

export default ScreenSourcePicker
