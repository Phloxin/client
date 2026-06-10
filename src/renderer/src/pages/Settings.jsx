import { useState } from 'react'
import { IconPalette, IconMicrophone, IconAdjustments } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import './Settings.css'

const sections = [
  {
    id: 'appearance',
    title: 'Appearance',
    description: 'Pick the app theme and visual style.',
    icon: IconPalette,
  },
  {
    id: 'audio',
    title: 'Audio',
    description: 'Microphone quality, levels, and processing.',
    icon: IconMicrophone,
  },
  {
    id: 'general',
    title: 'General',
    description: 'Core app preferences and behavior options.',
    icon: IconAdjustments,
  },
]

function Settings() {
  const { micSettings, updateMicSettings } = useSettings()
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
            </div>
          )}

          {activeSection === 'audio' && (
            <div className="settings-panel-card">
              <div className="settings-panel-header">
                <div>
                  <h2>Audio</h2>
                  <p>Adjust microphone capture quality and audio processing.</p>
                </div>
              </div>

              <div className="settings-panel-group">
                <div className="settings-section">
                  <label>Sample Rate</label>
                  <select
                    value={micSettings.sampleRate}
                    onChange={(e) => updateMicSettings({ sampleRate: parseInt(e.target.value) })}
                  >
                    <option value={44100}>44100 Hz</option>
                    <option value={48000}>48000 Hz</option>
                  </select>
                </div>

                <div className="settings-section">
                  <label>Audio Bitrate</label>
                  <select
                    value={micSettings.bitrate}
                    onChange={(e) => updateMicSettings({ bitrate: parseInt(e.target.value) })}
                  >
                    <option value={128000}>128 kbps (High)</option>
                    <option value={256000}>256 kbps (Very High)</option>
                    <option value={510000}>510 kbps (Maximum)</option>
                  </select>
                </div>

                <div className="settings-section">
                  <label>Channel Count</label>
                  <select
                    value={micSettings.channelCount}
                    onChange={(e) => updateMicSettings({ channelCount: parseInt(e.target.value) })}
                  >
                    <option value={1}>Mono</option>
                    <option value={2}>Stereo</option>
                  </select>
                </div>

                <div className="settings-section settings-toggle-row">
                  <label htmlFor="echoCancellation">Echo Cancellation</label>
                  <input
                    type="checkbox"
                    id="echoCancellation"
                    checked={micSettings.echoCancellation}
                    onChange={(e) => updateMicSettings({ echoCancellation: e.target.checked })}
                  />
                </div>

                <div className="settings-section settings-toggle-row">
                  <label htmlFor="noiseSuppression">Noise Suppression</label>
                  <input
                    type="checkbox"
                    id="noiseSuppression"
                    checked={micSettings.noiseSuppression}
                    onChange={(e) => updateMicSettings({ noiseSuppression: e.target.checked })}
                  />
                </div>

                <div className="settings-section settings-toggle-row">
                  <label htmlFor="autoGainControl">Auto Gain Control</label>
                  <input
                    type="checkbox"
                    id="autoGainControl"
                    checked={micSettings.autoGainControl}
                    onChange={(e) => updateMicSettings({ autoGainControl: e.target.checked })}
                  />
                </div>
              </div>

              <div className="settings-status">Settings saved automatically</div>
            </div>
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
                <div className="settings-card-note">
                  General settings will appear here once more options are added.
                </div>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

export default Settings