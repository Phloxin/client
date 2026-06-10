import { useTheme } from '../hooks/useTheme';
import './ThemeSwitcher.css';

/**
 * ThemeSwitcher Component
 * 
 * Demonstrates how to use the theme system in a React component.
 * Can be integrated into settings or admin pages.
 */
export function ThemeSwitcher() {
  const { theme, availableThemes, setCurrentTheme, currentThemeInfo } = useTheme();

  return (
    <div className="theme-switcher">
      <div className="theme-switcher-header">
        <h3>Theme</h3>
        <p className="theme-switcher-description">
          Choose your preferred color theme
        </p>
      </div>

      <div className="theme-options">
        {availableThemes.map((t) => (
          <button
            key={t.id}
            className={`theme-option ${theme === t.id ? 'active' : ''}`}
            onClick={() => setCurrentTheme(t.id)}
            title={t.description}
          >
            <span className="theme-option-info">
              <span className="theme-option-name">{t.name}</span>
              <span className="theme-option-desc">{t.description}</span>
            </span>
            {theme === t.id && <span className="theme-option-check">✓</span>}
          </button>
        ))}
      </div>

      <div className="theme-switcher-info">
        <p>
          Current theme: <strong>{currentThemeInfo?.name}</strong>
        </p>
        <p className="text-muted">
          Your preference will be saved automatically.
        </p>
      </div>
    </div>
  );
}

export default ThemeSwitcher;
