import { useState } from 'react'
import {
  IconPalette,
  IconMicrophone,
  IconBellRinging,
  IconKeyboard,
  IconCheck,
  IconX,
  IconPin,
  IconPlayerPlayFilled,
  IconAdjustments,
  IconSettings
} from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import AudioSettings from '../components/AudioSettings'
import KeybindsSettings from '../components/KeybindsSettings'
import AdvancedSettings from '../components/AdvancedSettings'
import GeneralSettings from '../components/GeneralSettings'
import {
  SOUND_SECTIONS,
  SOUND_DEFAULTS,
  SOUNDPACK_OPTIONS,
  getSoundFilename,
  playUiSound,
  UNWIRED_SOUNDS
} from '../lib/sounds'
import { UI_FONTS } from '../lib/uiSettings'
import './Settings.css'

const sections = [
  {
    id: 'general',
    title: 'General',
    description: 'App version and updates.',
    icon: IconSettings
  },
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Pick the app theme and visual style.',
    icon: IconPalette
  },
  {
    id: 'audio',
    title: 'Audio',
    description: 'Microphone quality, levels, and processing.',
    icon: IconMicrophone
  },
  {
    id: 'keybinds',
    title: 'Keybinds',
    description: 'Keyboard shortcuts for muting and deafening.',
    icon: IconKeyboard
  },
  {
    id: 'notifications',
    title: 'Notifications',
    description: 'Adjust volume and toggle notification sounds.',
    icon: IconBellRinging
  },
  {
    id: 'advanced',
    title: 'Advanced',
    description: 'Hardware acceleration and diagnostic overlays.',
    icon: IconAdjustments
  }
]

function Settings() {
  const {
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
    updateAnimationSettings
  } = useSettings()
  const [activeSection, setActiveSection] = useState('appearance')

  return (
    <div className="settings-layout">
      <div className="settings-header">Settings</div>
      <div className="settings-body">
        <aside className="settings-menu">
          {sections.map((section) => {
            const SectionIcon = section.icon
            const isActive = activeSection === section.id

            return (
              <button
                key={section.id}
                type="button"
                className={`settings-menu-item ${isActive ? 'active' : ''}`}
                onClick={() => setActiveSection(section.id)}
              >
                <span className="settings-menu-icon">
                  <SectionIcon size={20} stroke={2} />
                </span>
                <span className="settings-menu-title">{section.title}</span>
              </button>
            )
          })}
        </aside>

        <section className="settings-panel">
          {activeSection === 'general' && <GeneralSettings />}

          {activeSection === 'appearance' && (
            <div className="settings-panel-card">
              <div className="settings-panel-header">
                <div>
                  <h2>Appearance</h2>
                  <p>Choose a theme for the app and customize visual settings.</p>
                </div>
              </div>

              <ThemeSwitcher />

              <div className="theme-switcher-header">
                <h3>Interface</h3>
                <p className="theme-switcher-description">
                  Adjust surface gradients, background transparency, interface font, and animations.
                </p>
              </div>

              <div className="settings-panel-group">
                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="transparency-toggle">Background Transparency</label>
                    <p className="settings-section-desc">
                      Show a blurred, semi-transparent window background. Requires compositor blur
                      support on Linux (KDE, GNOME with blur plugin). Uses Acrylic on Windows 11.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      id="transparency-toggle"
                      checked={appearanceSettings.transparencyEnabled}
                      onChange={(e) =>
                        updateAppearanceSettings({ transparencyEnabled: e.target.checked })
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {appearanceSettings.transparencyEnabled && (
                  <>
                    <div className="settings-section">
                      <label>Blur Amount</label>
                      <div className="settings-volume-row">
                        <input
                          type="range"
                          className="settings-volume-slider"
                          min={0}
                          max={40}
                          value={appearanceSettings.transparencyBlur}
                          onChange={(e) =>
                            updateAppearanceSettings({ transparencyBlur: Number(e.target.value) })
                          }
                        />
                        <span className="settings-volume-value">
                          {appearanceSettings.transparencyBlur}px
                        </span>
                      </div>
                    </div>

                    <div className="settings-section">
                      <label>Background Opacity</label>
                      <div className="settings-volume-row">
                        <input
                          type="range"
                          className="settings-volume-slider"
                          min={10}
                          max={100}
                          value={appearanceSettings.transparencyOpacity}
                          onChange={(e) =>
                            updateAppearanceSettings({
                              transparencyOpacity: Number(e.target.value)
                            })
                          }
                        />
                        <span className="settings-volume-value">
                          {appearanceSettings.transparencyOpacity}%
                        </span>
                      </div>
                    </div>
                  </>
                )}

                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="gradients-toggle">Surface Gradients</label>
                    <p className="settings-section-desc">
                      Add soft gradient shading to backgrounds, panels, and buttons for extra depth.
                      Turn off for flat, solid surfaces.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      id="gradients-toggle"
                      checked={appearanceSettings.gradientsEnabled}
                      onChange={(e) =>
                        updateAppearanceSettings({ gradientsEnabled: e.target.checked })
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="shadows-toggle">Shadows</label>
                    <p className="settings-section-desc">
                      Add soft drop shadows to raised surfaces like panels, popovers, and dialogs
                      for a sense of depth. Turn off for a flatter look.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      id="shadows-toggle"
                      checked={appearanceSettings.shadowsEnabled}
                      onChange={(e) =>
                        updateAppearanceSettings({ shadowsEnabled: e.target.checked })
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="group-tags-toggle">Server Group Tags</label>
                    <p className="settings-section-desc">
                      Show each user&apos;s server group names as small pills next to their name in
                      channel and user lists.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      id="group-tags-toggle"
                      checked={appearanceSettings.showGroupTags}
                      onChange={(e) =>
                        updateAppearanceSettings({ showGroupTags: e.target.checked })
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="group-icons-toggle">Server Group Icons</label>
                    <p className="settings-section-desc">
                      Show server group icon badges on the right side of client rows.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      id="group-icons-toggle"
                      checked={appearanceSettings.showGroupIcons}
                      onChange={(e) =>
                        updateAppearanceSettings({ showGroupIcons: e.target.checked })
                      }
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                <div className="settings-section">
                  <label htmlFor="interface-font">Interface Font</label>
                  <p className="settings-section-desc">The typeface used across the app.</p>
                  <select
                    id="interface-font"
                    value={appearanceSettings.fontFamily}
                    onChange={(e) => updateAppearanceSettings({ fontFamily: e.target.value })}
                    style={{
                      fontFamily: UI_FONTS.find((f) => f.id === appearanceSettings.fontFamily)
                        ?.stack
                    }}
                  >
                    {UI_FONTS.map((f) => (
                      <option key={f.id} value={f.id} style={{ fontFamily: f.stack }}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-section">
                  <label>Message Display</label>
                  <p className="settings-section-desc">
                    Cozy shows an avatar beside each message. Compact drops the avatar for a tighter
                    list of name, time, and message.
                  </p>
                  <div
                    className="message-display-grid"
                    role="radiogroup"
                    aria-label="Message display"
                  >
                    {[
                      { id: 'cozy', label: 'Cozy' },
                      { id: 'compact', label: 'Compact' }
                    ].map((mode) => {
                      const active = appearanceSettings.messageDisplay === mode.id
                      return (
                        <button
                          key={mode.id}
                          type="button"
                          role="radio"
                          aria-checked={active}
                          className={`theme-card${active ? ' active' : ''}`}
                          onClick={() => updateAppearanceSettings({ messageDisplay: mode.id })}
                        >
                          <span
                            className={`message-display-preview ${mode.id}`}
                            aria-hidden="true"
                          >
                            {[0, 1].map((row) => (
                              <span key={row} className="message-display-row">
                                <span className="message-display-avatar" />
                                <span className="message-display-name" />
                                <span className="message-display-time" />
                                <span className="message-display-text" />
                              </span>
                            ))}
                          </span>
                          <span className="theme-card-meta">
                            <span className="theme-card-name">{mode.label}</span>
                            {active && (
                              <span className="theme-card-check" aria-hidden="true">
                                <IconCheck size={13} stroke={3} />
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>
              </div>

              <div className="settings-panel-group">
                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="animations-toggle">Animations</label>
                    <p className="settings-section-desc">
                      Subtle motion for loading/joining channels and switching between channel
                      views.
                    </p>
                  </div>
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      id="animations-toggle"
                      checked={animationSettings.enabled}
                      onChange={(e) => updateAnimationSettings({ enabled: e.target.checked })}
                    />
                    <span className="toggle-slider" />
                  </label>
                </div>

                {animationSettings.enabled &&
                  [
                    { key: 'channelSwitch', label: 'Switch Views', on: 'fade' },
                    { key: 'userJoin', label: 'User Join', on: 'pop' },
                    { key: 'channelList', label: 'Channel List', on: 'pop' },
                    { key: 'messages', label: 'New Messages', on: 'slide' },
                    { key: 'overlays', label: 'Menus & Dialogs', on: 'on' }
                  ].map(({ key, label, on }) => (
                    <div key={key} className="settings-section settings-toggle-row">
                      <div className="settings-toggle-copy">
                        <label htmlFor={`anim-${key}`}>{label}</label>
                      </div>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          id={`anim-${key}`}
                          checked={animationSettings[key] !== 'off'}
                          onChange={(e) =>
                            updateAnimationSettings({ [key]: e.target.checked ? on : 'off' })
                          }
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {activeSection === 'audio' && (
            <AudioSettings micSettings={micSettings} updateMicSettings={updateMicSettings} />
          )}

          {activeSection === 'keybinds' && <KeybindsSettings />}

          {activeSection === 'advanced' && <AdvancedSettings />}

          {activeSection === 'notifications' && (
            <div className="settings-panel-card">
              <div className="settings-panel-header">
                <div>
                  <h2>Notifications</h2>
                  <p>Manage primary application preferences and accessibility options.</p>
                </div>
              </div>

              <div className="settings-panel-group">
                <div className="settings-section">
                  <label htmlFor="soundpack">Soundpack</label>
                  <p className="settings-section-desc">
                    Which set of sounds to play. The list below follows the selected pack.
                  </p>
                  <select
                    id="soundpack"
                    value={soundpack}
                    onChange={(e) => setSoundpack(e.target.value)}
                  >
                    {SOUNDPACK_OPTIONS.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="settings-section">
                  <label htmlFor="sound-volume">Notification Volume</label>
                  <p className="settings-section-desc">
                    Volume for soundpack sounds, separate from the voice output volume.
                  </p>
                  <div className="settings-volume-row">
                    <input
                      id="sound-volume"
                      type="range"
                      className="settings-volume-slider"
                      min={0}
                      max={100}
                      value={soundVolume}
                      onChange={(e) => updateSoundVolume(Number(e.target.value))}
                    />
                    <span className="settings-volume-value">{soundVolume}%</span>
                  </div>
                </div>
              </div>

              {SOUND_SECTIONS.map((section) => {
                // Only show the sounds the active pack actually contains.
                const sounds = section.sounds
                  .map((s) => ({ ...s, filename: getSoundFilename(soundpack, s.id) }))
                  .filter((s) => s.filename)
                if (sounds.length === 0) return null

                // Master switch enables/disables the whole section; it reads as on
                // while any sound is enabled, and re-enabling keeps pins pinned.
                const resolve = (id) => soundState[id] || SOUND_DEFAULTS[id] || 'on'
                const anyOn = sounds.some((s) => resolve(s.id) !== 'off')
                const toggleSection = (on) =>
                  setSoundState(
                    Object.fromEntries(
                      sounds.map((s) => [s.id, on ? (resolve(s.id) === 'pin' ? 'pin' : 'on') : 'off'])
                    )
                  )

                return (
                  <div key={section.id} className="settings-panel-group sound-section">
                    <div className="settings-section settings-toggle-row sound-section-head">
                      <label htmlFor={`section-${section.id}`}>{section.label}</label>
                      <label className="toggle-switch">
                        <input
                          type="checkbox"
                          id={`section-${section.id}`}
                          checked={anyOn}
                          onChange={(e) => toggleSection(e.target.checked)}
                        />
                        <span className="toggle-slider" />
                      </label>
                    </div>

                    {sounds.map(({ id, label, filename }) => {
                      const state = resolve(id)
                      return (
                        <div key={id} className="settings-section settings-toggle-row">
                          <div className="settings-toggle-copy">
                            <label title={filename}>
                              {label}
                              {UNWIRED_SOUNDS.has(id) && (
                                <span className="sound-unwired" title="No trigger wired yet">
                                  not wired
                                </span>
                              )}
                            </label>
                          </div>
                          <div className="sound-preview-group">
                            <button
                              type="button"
                              className="sound-preview-btn"
                              title={`Play ${filename}`}
                              aria-label={`Play ${filename}`}
                              onClick={() => playUiSound(id, undefined, true)}
                            >
                              <IconPlayerPlayFilled size={14} />
                            </button>
                          </div>
                          <div className="sound-state" role="group" aria-label={filename}>
                            {[
                              ['off', IconX, 'Off'],
                              ['on', IconCheck, 'Enabled'],
                              ['pin', IconPin, 'Enabled — always heard, even when sound is muted']
                            ].map(([val, Icon, title]) => (
                              <button
                                key={val}
                                type="button"
                                title={title}
                                aria-pressed={state === val}
                                className={`sound-state-seg ${val}${state === val ? ' active' : ''}`}
                                onClick={() => setSoundState({ [id]: val })}
                              >
                                <Icon size={15} />
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Settings
