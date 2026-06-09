import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HashRouter } from 'react-router-dom'
import { AuthProvider } from './context/AuthContext'
import { SettingsProvider } from './context/SettingsContext'
import './assets/main.css'
import { initializeTheme, listenForThemeUpdates } from './lib/themeUtils'
import App from './App'

// Initialize theme on app start and listen for shared theme updates
initializeTheme()
listenForThemeUpdates()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <HashRouter>
      <AuthProvider>
        <SettingsProvider>
          <App />
        </SettingsProvider>
      </AuthProvider>
    </HashRouter>
  </StrictMode>
)