import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/main.css'
import './styles/animations.css'
// Bundled interface fonts (self-hosted woff2) selectable in Appearance settings.
import '@fontsource-variable/inter'
import '@fontsource-variable/open-sans'
import '@fontsource-variable/dm-sans'
import '@fontsource-variable/roboto'
import '@fontsource-variable/nunito'
import { initializeTheme, listenForThemeUpdates } from './lib/themeUtils'
import { applyAppearanceSettings, applyAnimationSettings } from './lib/uiSettings'
import App from './App'

// Initialize theme on app start and listen for shared theme updates
initializeTheme()
listenForThemeUpdates()

// Apply saved appearance/animation prefs before first paint to avoid a flash of
// the wrong (opaque / animated) state on load.
const applySaved = (key, apply) => {
  try {
    const saved = localStorage.getItem(key)
    if (saved) apply(JSON.parse(saved))
  } catch {}
}
applySaved('appearanceSettings', applyAppearanceSettings)
applySaved('animationSettings', applyAnimationSettings)

// Clicking a button focuses it without a focus ring, but Chromium flips into
// "keyboard modality" on the next keypress — so a button you clicked suddenly
// matches :focus-visible and sprouts a ring the moment you hit Escape to dismiss
// whatever it opened. Drop focus from a *mouse*-focused button on Escape. Tab
// focus is untouched (the flag is cleared by every keydown), and only buttons are
// blurred, so Escape keeps its meaning inside text fields.
let mouseFocused = false
document.addEventListener('mousedown', () => (mouseFocused = true), true)
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key === 'Escape' && mouseFocused) {
      const el = document.activeElement
      if (el?.matches('button, [role="button"]')) el.blur()
    }
    mouseFocused = false
  },
  true
)

// StrictMode intentionally left off: its dev-only double-render made dev diverge
// from production (it double-invokes renders/effects, which prod never does).
createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <HashRouter>
      <AuthProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </AuthProvider>
    </HashRouter>
  </ErrorBoundary>
)
