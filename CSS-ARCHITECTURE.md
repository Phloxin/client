# CSS Architecture Guide

## Overview

This project uses a comprehensive CSS theming system with CSS custom properties (variables) to support multiple color themes while maintaining a clean, organized file structure.

## File Structure

```
src/renderer/src/
├── assets/
│   ├── base.css           # Reset, typography, base imports
│   ├── globals.css        # Global component styles (buttons, forms, etc.)
│   ├── themes.css         # Theme variable definitions
│   └── main.css           # Main entry point (imports all assets)
├── App.css                # App component-specific styles
├── pages/
│   ├── Admin.css          # Admin page-specific styles
│   ├── Main.css           # Main page layout styles
│   └── Settings.css       # Settings page-specific styles
└── components/
    ├── Channel.jsx        # Component files (styles inline or co-located)
    └── ...
```

## Theme System

### Available Themes

1. **catppuccin-frappe** (Default) - Warm, cozy dark theme
2. **catppuccin-mocha** - Darker variant
3. **nord** - Arctic, north-bluish color palette
4. **dracula** - Vibrant, high contrast dark theme

### CSS Variables Structure

All themes define the following variable categories:

#### Colors
- `--color-background` - Primary background
- `--color-background-soft` - Secondary background
- `--color-background-mute` - Tertiary background
- `--color-surface` - Surface/elevated elements
- `--color-text` - Primary text
- `--color-text-secondary` - Secondary text
- `--color-text-tertiary` - Tertiary text
- `--color-text-muted` - Muted text
- `--color-primary` - Primary accent color
- `--color-primary-hover` - Primary accent hover state
- `--color-success` - Success state color
- `--color-success-hover` - Success hover state
- `--color-danger` - Danger/error color
- `--color-warning` - Warning color
- `--color-border` - Primary border color
- `--color-border-light` - Light border color

#### Typography
- `--font-family-primary` - Main font family
- `--font-size-xs` through `--font-size-xl` - Font size scale
- `--font-weight-regular` through `--font-weight-bold` - Font weights

#### Spacing
- `--spacing-xs` through `--spacing-xl` - Consistent spacing scale

#### Radii
- `--border-radius-sm` - Small border radius
- `--border-radius-md` - Medium border radius

## How to Switch Themes

### Using the Hook (React Components)

```javascript
import { useTheme } from '../hooks/useTheme';

function MyComponent() {
  const { theme, availableThemes, setCurrentTheme } = useTheme();

  return (
    <div>
      <p>Current theme: {theme}</p>
      <select onChange={(e) => setCurrentTheme(e.target.value)}>
        {availableThemes.map(t => (
          <option key={t.id} value={t.id}>{t.name}</option>
        ))}
      </select>
    </div>
  );
}
```

### Using the Utility Functions (Vanilla JS)

```javascript
import { setTheme, getTheme, initializeTheme } from '../lib/themeUtils';

// Initialize on app start
initializeTheme();

// Switch theme
setTheme('nord');

// Get current theme
const currentTheme = getTheme();
```

### Listening for Theme Changes

```javascript
window.addEventListener('theme-changed', (e) => {
  console.log('Theme changed to:', e.detail.theme);
});
```

## CSS Organization Principles

### Global Styles (`globals.css`)

Use for styles that apply across multiple components:
- Button styles (`.btn`, `.btn-primary`, `.admin-btn`, `.join-btn`)
- Form elements (inputs, selects)
- Common layouts (`.video-grid`)
- Scrollbar styling

### Page-Specific Styles (`pages/*.css`)

Use for page layouts and page-level components:
- Layout structures (`.layout`, `.sidebar`, `.chat-area`)
- Page-specific positioning
- Page-specific sections

### Component Styles

Keep with component files when styles are tightly coupled:
- Small, focused component styles
- Component-specific animations
- Override global styles when necessary

## Adding New Colors

1. Add the variable to all theme definitions in `themes.css`:
   ```css
   --color-new-color: #value;
   ```

2. Add to each theme block:
   ```css
   [data-theme="catppuccin-frappe"] {
     --color-new-color: #frappe-value;
   }
   ```

## Adding New Themes

1. Add a new theme block to `themes.css`:
   ```css
   [data-theme="my-theme"] {
     /* Define all variables */
   }
   ```

2. Register in `themeUtils.js`:
   ```javascript
   export const AVAILABLE_THEMES = [
     // ... existing themes
     {
       id: 'my-theme',
       name: 'My Theme',
       description: 'Description'
     }
   ];
   ```

## Best Practices

1. **Always use variables** - Never hardcode colors in component CSS
2. **Consistent spacing** - Use the spacing scale variables (`--spacing-*`)
3. **Font sizing** - Use the font size scale (`--font-size-*`)
4. **Responsive design** - Keep in mind when using fixed sizes
5. **Component isolation** - Keep component styles separate from global styles
6. **Transitions** - Use `transition: ... 0.15s` for smooth theme switching

## Migration Notes

- Old hardcoded colors have been replaced with CSS variables
- Duplicate button styles have been consolidated to `globals.css`
- Typography is now consistent across all pages
- All colors now support theme switching
