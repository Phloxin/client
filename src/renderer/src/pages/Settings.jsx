import { useState } from 'react'
import { IconPalette, IconMicrophone, IconAdjustments } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import AudioSettings from '../components/AudioSettings'
import { SOUND_CATEGORIES } from '../lib/sounds'
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
    id: 'general',
    title: 'General',
    description: 'Core app preferences and behavior options.',
    icon: IconAdjustments
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
                <span className="settings-menu-copy">
                  <span className="settings-menu-title">{section.title}</span>
                  <span className="settings-menu-desc">{section.description}</span>
                </span>
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
              </div>

              <div className="settings-panel-group">
                <div className="settings-section settings-toggle-row">
                  <div className="settings-toggle-copy">
                    <label htmlFor="animations-toggle">Animations</label>
                    <p className="settings-section-desc">
                      Subtle motion for switching channels, users joining or leaving a channel, and
                      channels being added, removed, or reordered.
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
                      <label htmlFor="anim-channel-switch">Channel / Tab Switch</label>
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
                      <label htmlFor="anim-user-join">User Join / Leave</label>
                      <select
                        id="anim-user-join"
                        value={animationSettings.userJoin}
                        onChange={(e) => updateAnimationSettings({ userJoin: e.target.value })}
                      >
                        <option value="slide">Slide</option>
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
                        <option value="slide">Slide</option>
                        <option value="pop">Pop</option>
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

          {activeSection === 'general' && (
            <div className="settings-panel-card">
              <div className="settings-panel-header">
                <div>
                  <h2>General</h2>
                  <p>Manage primary application preferences and accessibility options.</p>
                </div>
              </div>

              <div className="settings-panel-group">
                <div className="settings-section">
                  <label>Sounds</label>
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
