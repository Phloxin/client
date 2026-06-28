/**
 * Theme Switcher Utility
 * 
 * Provides functions to switch between available themes.
 * 
 * Usage:
 *   import { setTheme, getTheme, getAvailableThemes } from './themeUtils';
 *   
 *   setTheme('nord');
 *   const current = getTheme();
 *   const all = getAvailableThemes();
 */

const THEME_KEY = 'app-theme';
const DEFAULT_THEME = 'classic-dark';

export const AVAILABLE_THEMES = [
  {
    id: 'classic-dark',
    name: 'Classic Dark',
    description: 'A clean, neutral dark theme'
  },
  {
    id: 'classic-light',
    name: 'Classic Light',
    description: 'A clean, neutral light theme'
  },
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappé',
    description: 'A warm, cozy dark theme'
  },
  {
    id: 'catppuccin-mocha',
    name: 'Catppuccin Mocha',
    description: 'A darker variant of Catppuccin'
  },
  {
    id: 'nord',
    name: 'Nord',
    description: 'An arctic, north-bluish color palette'
  },
  {
    id: 'dracula',
    name: 'Dracula',
    description: 'A vibrant, high contrast dark theme'
  },
  {
    id: 'tokyo-night',
    name: 'Tokyo Night',
    description: 'Deep navy blues inspired by Tokyo at night'
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    description: 'Retro groove color scheme with warm earthy tones'
  },
  {
    id: 'one-dark-pro',
    name: 'One Dark Pro',
    description: 'The classic Atom-inspired neutral dark theme'
  }
];

/**
 * Apply a theme to the document without persisting or broadcasting.
 * @param {string} themeId
 */
function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  document.body.setAttribute('data-theme', themeId);

  window.dispatchEvent(
    new CustomEvent('theme-changed', { detail: { theme: themeId } })
  );
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
  const validTheme = AVAILABLE_THEMES.find(t => t.id === themeId);
  if (!validTheme) {
    console.warn(`Theme '${themeId}' not found. Using default theme.`);
    return false;
  }

  applyTheme(themeId);

  try {
    localStorage.setItem(THEME_KEY, themeId);
  } catch (e) {
    console.warn('Could not save theme preference to localStorage', e);
  }

  notifyThemeChange(themeId);

  return true;
}

/**
 * Get the current theme ID from the document attribute.
 * @returns {string}
 */
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
}

/**
 * Initialize theme from localStorage on app start.
 * Falls back to the default theme if nothing is saved.
 */
export function initializeTheme() {
  let theme = DEFAULT_THEME;

  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && AVAILABLE_THEMES.find(t => t.id === saved)) {
      theme = saved;
    }
  } catch (e) {
    console.warn('Could not read theme from localStorage', e);
  }

  applyTheme(theme);
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
  return AVAILABLE_THEMES;
}

/**
 * Get a theme object by ID.
 * @param {string} themeId
 * @returns {Object|null}
 */
export function getThemeById(themeId) {
  return AVAILABLE_THEMES.find(t => t.id === themeId) || null;
}