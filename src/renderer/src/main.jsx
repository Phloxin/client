import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import ErrorBoundary from './components/ErrorBoundary'
import './styles/main.css'
import './styles/animations.css'
import '@tabler/icons-webfont/dist/tabler-icons.min.css'
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

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ErrorBoundary>
      <HashRouter>
        <AuthProvider>
          <SettingsProvider>
            <App />
          </SettingsProvider>
        </AuthProvider>
      </HashRouter>
    </ErrorBoundary>
  </StrictMode>
)
