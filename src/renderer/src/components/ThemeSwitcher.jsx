import { useState, useEffect } from 'react'
import { IconCheck, IconChevronDown } from '@tabler/icons-react'
import { setTheme, getTheme, getAvailableThemes, getThemeById } from '../lib/themeUtils'
import './ThemeSwitcher.css'

// Theme picker: a grid of miniature window previews built from each theme's
// swatch colors ([chrome, canvas, accent]). Selection applies instantly,
// persists, and broadcasts to other windows (see lib/themeUtils). The grid
// collapses via a native <details> — the summary doubles as the section header.
export function ThemeSwitcher() {
  // Theme is already initialized at app boot (main.jsx) — just read it.
  const [theme, setThemeState] = useState(getTheme)

  // Follow theme changes made elsewhere (another window via IPC → themeUtils
  // re-dispatches a 'theme-changed' DOM event locally).
  useEffect(() => {
    const onChange = (e) => setThemeState(e.detail.theme)
    window.addEventListener('theme-changed', onChange)
    return () => window.removeEventListener('theme-changed', onChange)
  }, [])

  const setCurrentTheme = (themeId) => {
    if (setTheme(themeId)) setThemeState(themeId)
  }

  const availableThemes = getAvailableThemes()
  const currentThemeInfo = getThemeById(theme)

  return (
    <details className="theme-switcher">
      <summary className="theme-switcher-summary">
        <span className="theme-switcher-title">Theme</span>
        <span className="theme-switcher-current">{currentThemeInfo?.name}</span>
        <IconChevronDown size={16} className="theme-switcher-chevron" aria-hidden="true" />
      </summary>
      <div className="theme-grid" role="radiogroup" aria-label="App theme">
        {availableThemes.map((t) => {
          const [chrome, canvas, accent] = t.swatch
          const active = theme === t.id
          return (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={active}
              className={`theme-card${active ? ' active' : ''}`}
              onClick={() => setCurrentTheme(t.id)}
              title={t.description}
            >
              <span className="theme-card-preview" style={{ background: chrome }}>
                <span className="theme-card-canvas" style={{ background: canvas }}>
                  <span className="theme-card-accent" style={{ background: accent }} />
                  <span className="theme-card-line" style={{ background: accent, opacity: 0.35 }} />
                  <span
                    className="theme-card-line short"
                    style={{ background: accent, opacity: 0.2 }}
                  />
                </span>
              </span>
              <span className="theme-card-meta">
                <span className="theme-card-name">{t.name}</span>
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
    </details>
  )
}

export default ThemeSwitcher
