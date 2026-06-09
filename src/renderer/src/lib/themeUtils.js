/**
 * Theme Switcher Utility
 * 
 * Provides functions to switch between available themes.
 * Available themes: 'catppuccin-frappe', 'catppuccin-mocha', 'nord', 'dracula'
 * 
 * Usage:
 *   import { setTheme, getTheme, getAvailableThemes } from './themeUtils';
 *   
 *   setTheme('nord');
 *   const current = getTheme();
 *   const all = getAvailableThemes();
 */

const THEME_KEY = 'app-theme';
const DEFAULT_THEME = 'catppuccin-frappe';

export const AVAILABLE_THEMES = [
  {
    id: 'catppuccin-frappe',
    name: 'Catppuccin Frappe',
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
  }
];

/**
 * Set the current theme
 * @param {string} themeId - The ID of the theme to set
 * @returns {boolean} - True if theme was set successfully
 */
function applyTheme(themeId) {
  document.documentElement.setAttribute('data-theme', themeId);
  document.body.setAttribute('data-theme', themeId);

  window.dispatchEvent(
    new CustomEvent('theme-changed', { detail: { theme: themeId } })
  );
}

function notifyThemeChange(themeId) {
  try {
    if (window?.electron?.ipcRenderer?.send) {
      window.electron.ipcRenderer.send('theme-changed-ipc', themeId)
    }
  } catch (e) {
    console.warn('Could not broadcast theme change via IPC', e)
  }
}

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
 * Get the current theme ID
 * @returns {string} - The ID of the currently active theme
 */
export function getTheme() {
  return document.documentElement.getAttribute('data-theme') || DEFAULT_THEME;
}

/**
 * Initialize theme from localStorage or system preference
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
 * Get all available themes
 * @returns {Array} - Array of theme objects
 */
export function getAvailableThemes() {
  return [...AVAILABLE_THEMES];
}

/**
 * Get theme by ID
 * @param {string} themeId - The ID of the theme
 * @returns {Object|null} - The theme object or null if not found
 */
export function getThemeById(themeId) {
  return AVAILABLE_THEMES.find(t => t.id === themeId) || null;
}

/**
 * Cycle to the next theme
 * @returns {string} - The ID of the new theme
 */
export function nextTheme() {
  const current = getTheme();
  const currentIndex = AVAILABLE_THEMES.findIndex(t => t.id === current);
  const nextIndex = (currentIndex + 1) % AVAILABLE_THEMES.length;
  const nextThemeId = AVAILABLE_THEMES[nextIndex].id;
  setTheme(nextThemeId);
  return nextThemeId;
}
