import { useState } from 'react'
import { IconPalette, IconMicrophone, IconBellRinging, IconKeyboard } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import AudioSettings from '../components/AudioSettings'
import KeybindsSettings from '../components/KeybindsSettings'
import { SOUND_CATEGORIES } from '../lib/sounds'
import { UI_FONTS } from '../lib/uiSettings'
import './Settings.css'

const sections = [
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
  }
]

function Settings() {
  const {
    micSettings,
    updateMicSettings,
    soundSettings,
    updateSoundSettings,
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

                {animationSettings.enabled && (
                  <>
                    <div className="settings-section">
                      <label htmlFor="anim-channel-switch">Switch Views</label>
                      <select
                        id="anim-channel-switch"
                        value={animationSettings.channelSwitch}
                        onChange={(e) => updateAnimationSettings({ channelSwitch: e.target.value })}
                      >
                        <option value="fade">Fade</option>
                        <option value="slide">Slide</option>
                        <option value="off">Off</option>
                      </select>
                    </div>

                    <div className="settings-section">
                      <label htmlFor="anim-user-join">User Join</label>
                      <select
                        id="anim-user-join"
                        value={animationSettings.userJoin}
                        onChange={(e) => updateAnimationSettings({ userJoin: e.target.value })}
                      >
                        <option value="pop">Pop</option>
                        <option value="off">Off</option>
                      </select>
                    </div>

                    <div className="settings-section">
                      <label htmlFor="anim-channel-list">Channel List</label>
                      <select
                        id="anim-channel-list"
                        value={animationSettings.channelList}
                        onChange={(e) => updateAnimationSettings({ channelList: e.target.value })}
                      >
                        <option value="pop">Pop</option>
                        <option value="off">Off</option>
                      </select>
                    </div>

                    <div className="settings-section">
                      <label htmlFor="anim-messages">New Messages</label>
                      <select
                        id="anim-messages"
                        value={animationSettings.messages}
                        onChange={(e) => updateAnimationSettings({ messages: e.target.value })}
                      >
                        <option value="slide">Slide</option>
                        <option value="off">Off</option>
                      </select>
                    </div>

                    <div className="settings-section">
                      <label htmlFor="anim-overlays">Menus &amp; Dialogs</label>
                      <select
                        id="anim-overlays"
                        value={animationSettings.overlays}
                        onChange={(e) => updateAnimationSettings({ overlays: e.target.value })}
                      >
                        <option value="on">On</option>
                        <option value="off">Off</option>
                      </select>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}

          {activeSection === 'audio' && (
            <AudioSettings micSettings={micSettings} updateMicSettings={updateMicSettings} />
          )}

          {activeSection === 'keybinds' && <KeybindsSettings />}

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
                  <label>Sound Toggles</label>
                  <p className="settings-section-desc">
                    Choose which sound effects play. These are local cues only you hear.
                  </p>
                </div>

                {SOUND_CATEGORIES.map((category) => (
                  <div key={category.id} className="settings-section settings-toggle-row">
                    <div className="settings-toggle-copy">
                      <label htmlFor={`sound-${category.id}`}>{category.label}</label>
                    </div>
                    <label className="toggle-switch">
                      <input
                        type="checkbox"
                        id={`sound-${category.id}`}
                        checked={soundSettings[category.id] !== false}
                        onChange={(e) => updateSoundSettings({ [category.id]: e.target.checked })}
                      />
                      <span className="toggle-slider" />
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Settings
