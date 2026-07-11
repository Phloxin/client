/**
 * Theme Switcher Utility
 *
 * Provides functions to switch between available themes.
 * Theme choice persists to localStorage and is broadcast to all Electron
 * windows over IPC; each window applies it via the data-theme attribute,
 * which selects a CSS custom-property block in styles/themes.css.
 */

const THEME_KEY = 'app-theme'
const DEFAULT_THEME = 'studio'

// `swatch` mirrors the theme's [chrome, canvas, accent] colors for the picker
// preview tiles — keep in sync with styles/themes.css.
export const AVAILABLE_THEMES = [
  {
    id: 'studio',
    name: 'Studio',
    description: 'Ink-blue console with an amber signal',
    swatch: ['#0f1317', '#171d23', '#f0a63c']
  },
  {
    id: 'daylight',
    name: 'Daylight',
    description: 'Cool paper light with deep amber',
    swatch: ['#e7eaee', '#fbfcfd', '#b26e0e']
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'OLED black with electric violet',
    swatch: ['#060609', '#0e0f16', '#a78bfa']
  },
  {
    id: 'aurora',
    name: 'Aurora',
    description: 'Arctic slate with glacial teal',
    swatch: ['#20252e', '#2a303c', '#7dd3e0']
  },
  {
    id: 'mocha',
    name: 'Mocha',
    description: 'Warm cozy dark with soft mauve',
    swatch: ['#16161f', '#1e1e2e', '#cba6f7']
  },
  {
    id: 'terra',
    name: 'Terra',
    description: 'Earthy analog warmth with burnt orange',
    swatch: ['#1c1916', '#262220', '#e8833a']
  },
  {
    id: 'frappe',
    name: 'Frappé',
    description: 'Catppuccin Frappé — muted dusk with mauve',
    swatch: ['#292c3c', '#303446', '#ca9ee6']
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'Classic Dracula dark with vivid purple',
    swatch: ['#21222c', '#282a36', '#bd93f9']
  },
  {
    id: 'rose-pine',
    name: 'Rosé Pine',
    description: 'Soho vibes — muted rose and iris',
    swatch: ['#191724', '#1f1d2e', '#c4a7e7']
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Retro warm dark with golden yellow',
    swatch: ['#201b1a', '#2b2423', '#fabd2f']
  }
]

// Saved ids from the pre-redesign catalog map to their nearest new theme so an
// existing preference never dangles on an unknown id.
const LEGACY_THEME_MAP = {
  'classic-dark': 'studio',
  'classic-light': 'daylight',
  'catppuccin-frappe': 'frappe',
  'catppuccin-mocha': 'mocha',
  nord: 'aurora',
  'tokyo-night': 'midnight',
  'one-dark-pro': 'studio'
}

function resolveThemeId(themeId) {
  if (AVAILABLE_THEMES.some((t) => t.id === themeId)) return themeId
  return LEGACY_THEME_MAP[themeId] || null
}

/**
 * Apply a theme to the document without persisting or broadcasting.
 * @param {string} themeId
 */
function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId)
  document.body.setAttribute('data-theme', themeId)

  window.dispatchEvent(new CustomEvent('theme-changed', { detail: { theme: themeId } }))
}

/**
 * Broadcast theme change to all Electron windows via IPC.
 * @param {string} themeId
 */
function notifyThemeChange(themeId) {
  try {
    if (window?.electron?.ipcRenderer?.send) {
      window.electron.ipcRenderer.send('theme-changed-ipc', themeId)
    }
  } catch (e) {
    console.warn('Could not broadcast theme change via IPC', e)
  }
}

/**
 * Set the current theme, persist to localStorage, and broadcast via IPC.
 * @param {string} themeId - The ID of the theme to set
 * @returns {boolean} - True if theme was set successfully
 */
export function setTheme(themeId) {
  const resolved = resolveThemeId(themeId)
  if (!resolved) {
    console.warn(`Theme '${themeId}' not found. Using default theme.`)
    return false
  }

  applyTheme(resolved)

  try {
    localStorage.setItem(THEME_KEY, resolved)
  } catch (e) {
    console.warn('Could not save theme preference to localStorage', e)
  }

  notifyThemeChange(resolved)

  return true
}

/**
 * Get the current theme ID from the document attribute.
 * @returns {string}
 */
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME
}

/**
 * Initialize theme from localStorage on app start.
 * Falls back to the default theme if nothing (or an unknown id) is saved;
 * legacy ids are migrated to their nearest new theme.
 */
export function initializeTheme() {
  let theme = DEFAULT_THEME

  try {
    const saved = resolveThemeId(localStorage.getItem(THEME_KEY))
    if (saved) theme = saved
  } catch (e) {
    console.warn('Could not read theme from localStorage', e)
  }

  applyTheme(theme)
}

/**
 * Listen for theme changes broadcast from other Electron windows via IPC.
 */
export function listenForThemeUpdates() {
  try {
    if (window?.electron?.ipcRenderer?.on) {
      window.electron.ipcRenderer.on('theme-changed-ipc', (_, themeId) => {
        if (themeId && themeId !== getTheme()) {
          applyTheme(themeId)
        }
      })
    }
  } catch (e) {
    console.warn('Could not listen for theme updates via IPC', e)
  }
}

/**
 * Get all available themes.
 * @returns {Array}
 */
export function getAvailableThemes() {
  return AVAILABLE_THEMES
}

/**
 * Get a theme object by ID.
 * @param {string} themeId
 * @returns {Object|null}
 */
export function getThemeById(themeId) {
  return AVAILABLE_THEMES.find((t) => t.id === themeId) || null
}
