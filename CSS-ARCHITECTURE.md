# CSS Architecture Guide

## Overview

This project uses a comprehensive CSS theming system with CSS custom properties (variables) to support multiple color themes while maintaining a clean, organized file structure.

## File Structure

```
src/renderer/src/
├── assets/
│   ├── base.css           # Reset, typography, base imports
│   ├── globals.css        # Truly global styles (form elements, scrollbars)
│   ├── themes.css         # Theme variable definitions
│   └── main.css           # Main entry point (imports all assets)
├── App.css                # App component-specific styles
├── pages/
│   ├── Main.css           # Main page layout and sidebar styles
│   └── Settings.css       # Settings page-specific styles
└── components/
    ├── ThemeSwitcher.css  # Theme switcher component styles
    ├── VideoGrid.css      # Video grid component styles
    └── VoiceChannel.css   # Voice channel component styles
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

### In React Components

Read with `getTheme()`, switch with `setTheme(id)`, and subscribe to the
`theme-changed` window event to follow changes made elsewhere — see
`components/ThemeSwitcher.jsx` for the full pattern.

### Using the Utility Functions (Vanilla JS)

```javascript
import { setTheme, getTheme, initializeTheme } from '../lib/themeUtils'

// Initialize on app start
initializeTheme()

// Switch theme
setTheme('nord')

// Get current theme
const currentTheme = getTheme()
```

### Listening for Theme Changes

```javascript
window.addEventListener('theme-changed', (e) => {
  console.log('Theme changed to:', e.detail.theme)
})
```

## CSS Organization Principles

### Global Styles (`globals.css`)

Reserved for styles that are genuinely shared across the entire app with no clear owner:

- Base form elements (select, input)
- Scrollbar styling
- Utility classes used everywhere

Button styles are **not** in globals — each button class is owned by the page or component that uses it to avoid implicit cross-page dependencies.

### Page-Specific Styles (`pages/*.css`)

Each page owns its own layout, sections, buttons, and status elements:

| File           | Owns                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `Main.css`     | `.layout`, `.sidebar`, `.chat-area`, `.settings-btn`, `.view-toggle-btn` |
| `Settings.css` | `.settings-layout`, `.settings-section`, `.settings-status`              |

### Component Styles (`components/*.css`)

Each component with non-trivial styling has a co-located CSS file:

| File                | Owns                                                                            |
| ------------------- | ------------------------------------------------------------------------------- |
| `ThemeSwitcher.css` | `.theme-switcher`, `.theme-options`, `.theme-option`                            |
| `VideoGrid.css`     | `.video-grid`, `.video-tile`                                                    |
| `VoiceChannel.css`  | `.join-btn`, `.leave-btn`, `.share-btn`                                         |

## Adding New Colors

1. Add the variable to all theme definitions in `themes.css`:

   ```css
   --color-new-color: #value;
   ```

2. Add to each theme block:
   ```css
   [data-theme='catppuccin-frappe'] {
     --color-new-color: #frappe-value;
   }
   ```

## Adding New Themes

1. Add a new theme block to `themes.css`:

   ```css
   [data-theme='my-theme'] {
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
   ]
   ```

## Best Practices

1. **Always use variables** - Never hardcode colors in component CSS
2. **Own your styles** - Each page and component imports only its own CSS file; never import another page's stylesheet
3. **Consistent spacing** - Use the spacing scale variables (`--spacing-*`)
4. **Font sizing** - Use the font size scale (`--font-size-*`)
5. **Component isolation** - A component should never depend on styles leaking in from a sibling page or component
6. **Transitions** - Use `transition: ... 0.15s` for smooth theme switching
