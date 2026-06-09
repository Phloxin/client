import { useState, useEffect } from 'react';
import {
  setTheme,
  getTheme,
  getAvailableThemes,
  getThemeById,
  nextTheme,
  initializeTheme
} from '../lib/themeUtils';

/**
 * useTheme Hook
 * 
 * Provides theme state and switching functionality to React components
 * 
 * Usage:
 *   const { theme, availableThemes, setCurrentTheme, nextTheme } = useTheme();
 */
export function useTheme() {
  const [theme, setThemeState] = useState(() => {
    initializeTheme();
    return getTheme();
  });

  useEffect(() => {
    // Listen for theme changes from other parts of the app
    const handleThemeChange = (e) => {
      setThemeState(e.detail.theme);
    };

    window.addEventListener('theme-changed', handleThemeChange);
    return () => {
      window.removeEventListener('theme-changed', handleThemeChange);
    };
  }, []);

  const setCurrentTheme = (themeId) => {
    if (setTheme(themeId)) {
      setThemeState(themeId);
    }
  };

  const handleNextTheme = () => {
    const newTheme = nextTheme();
    setThemeState(newTheme);
  };

  return {
    theme,
    availableThemes: getAvailableThemes(),
    currentThemeInfo: getThemeById(theme),
    setCurrentTheme,
    nextTheme: handleNextTheme,
    getThemeById
  };
}
