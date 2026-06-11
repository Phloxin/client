import { useState } from 'react'
import { IconPalette, IconMicrophone, IconAdjustments } from '@tabler/icons-react'
import { useSettings } from '../context/SettingsContext'
import { ThemeSwitcher } from '../components/ThemeSwitcher'
import AudioSettings from '../components/AudioSettings'
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