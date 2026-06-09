# CSS Organization Visual Guide

## File Hierarchy & What Goes Where

```
src/renderer/src/
│
├── 📦 assets/ ─────────────────────────────────────────────────────
│   │
│   ├── 🎨 themes.css
│   │   └─ Theme Definitions
│   │      • 4 complete color themes
│   │      • CSS custom properties (variables)
│   │      • catppuccin-frappe, mocha, nord, dracula
│   │      • Colors, typography, spacing variables
│   │
│   ├── 🌐 globals.css  
│   │   └─ Global Component Styles
│   │      • Button styles (.btn, .admin-btn, .join-btn)
│   │      • Form elements (select, input)
│   │      • Common layouts (.video-grid, .video-tile)
│   │      • Scrollbar styling
│   │      • Shared utility classes
│   │
│   ├── 📄 base.css
│   │   └─ Base Styles & Imports
│   │      • Imports themes.css
│   │      • CSS reset (*, box-sizing, margins)
│   │      • Typography base
│   │      • HTML/body defaults
│   │
│   ├── 📋 main.css
│   │   └─ Main Entry Point
│   │      • Imports base.css
│   │      • Imports globals.css
│   │      • Root container setup
│   │      ⚠️  Include this in your app!
│   │
│   └── 📖 CSS-ARCHITECTURE.md
│       └─ Detailed Documentation
│
├── 📦 lib/ ────────────────────────────────────────────────────────
│   └── 🎛️  themeUtils.js
│       └─ Theme Utilities
│          • setTheme(themeId)
│          • getTheme()
│          • initializeTheme()
│          • nextTheme()
│          • getAvailableThemes()
│          • localStorage integration
│
├── 📦 hooks/ ───────────────────────────────────────────────────────
│   └── 🪝 useTheme.js
│       └─ React Hook
│          • useTheme() hook
│          • theme state management
│          • setCurrentTheme() function
│          • availableThemes access
│          • theme change events
│
├── 📦 components/ ──────────────────────────────────────────────────
│   └── 🎨 ThemeSwitcher/
│       ├── ThemeSwitcher.jsx
│       │   └─ Theme Selector Component
│       │      • UI for theme selection
│       │      • Shows all 4 themes
│       │      • Visual previews
│       │      • Easy integration
│       │
│       └── ThemeSwitcher.css
│           └─ Component Styles
│              • .theme-switcher
│              • .theme-options
│              • .theme-preview
│
├── 📦 pages/ ───────────────────────────────────────────────────────
│   ├── 📄 Main.css
│   │   └─ Main Page Layout
│   │      • .layout, .sidebar, .chat-area
│   │      • Page-specific positioning
│   │      • Uses CSS variables
│   │      ✨ All colors now themed
│   │
│   ├── 📄 Admin.css
│   │   └─ Admin Page Styles
│   │      • .admin-layout, .admin-header
│   │      • .admin-section, .login-screen
│   │      • Uses CSS variables
│   │      ✨ All colors now themed
│   │
│   └── (Settings.jsx) 
│       └─ Uses Admin.css layout
│
├── 🎨 App.css
│   └─ App Component Styles
│      • Body base styles
│      • App-level overrides
│      • Uses CSS variables
│      ✨ All colors now themed
│
└── 📄 main.jsx
    └─ App Entry Point
       ✨ UPDATED: Added initializeTheme()
```

## CSS Cascade & Specificity

```
main.jsx
  ↓ (initializes theme)
  ↓
main.css ──────────┐
  ├─ imports ─────→ base.css ─────────┐
  │                                   ├─ imports ─→ themes.css ← 🎨 THEME VARS
  └─ imports ─────→ globals.css ──────┘
                      (uses variables)

Each page/component imports its CSS:
  App.jsx ────→ App.css (uses variables)
  Main.jsx ───→ Main.css (uses variables)
  Admin.jsx ──→ Admin.css (uses variables)
  Settings.jsx → Admin.css (uses variables)
```

## Data Flow: Theme Switching

```
User Action (Theme Button)
          ↓
    useTheme() hook
          ↓
  setTheme(themeId)
          ↓
    document.setAttribute('data-theme', themeId)
          ↓
CSS matches new [data-theme] selector
          ↓
Variables update instantly
          ↓
All components using var(--color-*) update
          ↓
Custom event: 'theme-changed'
          ↓
Component state updates (if listening)
          ↓
✨ Smooth theme transition
```

## Variable Resolution Example

### When theme = "catppuccin-frappe"
```css
:root, [data-theme="catppuccin-frappe"] {
  --color-text: #c6d0f5;
  --color-primary: #8caaee;
}
```

### Any CSS using variables
```css
.my-button {
  color: var(--color-text);           /* Resolves to #c6d0f5 */
  background: var(--color-primary);   /* Resolves to #8caaee */
}
```

### When theme switches to "nord"
```css
[data-theme="nord"] {
  --color-text: #eceff4;              /* New value */
  --color-primary: #88c0d0;           /* New value */
}
```

### Variable resolution updates
```css
.my-button {
  color: var(--color-text);           /* Now #eceff4 */
  background: var(--color-primary);   /* Now #88c0d0 */
}
/* ✨ CSS automatically updates without changing the rule! */
```

## Component Styling Guidelines

### 🟢 Global Components (globals.css)
Used across multiple pages/components
```css
.admin-btn {
  background: var(--color-primary);
  color: var(--color-background);
  /* Shared button style */
}
```

### 🟡 Page-Specific Styles (pages/*.css)
Unique to a particular page
```css
.sidebar {
  width: 240px;
  background: var(--color-background-soft);
  /* Main page only */
}
```

### 🔵 Component-Specific Styles (components/*.css)
Tightly coupled to component
```css
.theme-switcher {
  display: flex;
  gap: var(--spacing-lg);
  /* ThemeSwitcher component only */
}
```

## Migration Summary

### Before ❌
```css
.button {
  background: #8caaee;     /* Hardcoded */
  color: #303446;          /* Hardcoded */
  padding: 8px;            /* Magic number */
}
```

### After ✅
```css
.button {
  background: var(--color-primary);      /* Variable */
  color: var(--color-background);        /* Variable */
  padding: var(--spacing-sm);            /* Variable */
}
```

## Quick Reference: Where to Add New Styles

| Type | Location | Example |
|------|----------|---------|
| Global button | `globals.css` | `.btn-special` |
| Page layout | `pages/*.css` | `.page-header` |
| Component | `components/*.css` | `.my-component` |
| Override | `App.css` | App-level tweaks |

## Imports Order (Important!)

1. **themes.css** - Defines all variables
2. **base.css** - Uses variables from themes
3. **globals.css** - Uses variables from base
4. **main.css** - Imports all above
5. **Page CSS** - Imports main.css implicitly through main.jsx
6. **Component CSS** - Uses variables from globals

## Testing Theme Changes

### Manual Test
1. Open DevTools
2. Run: `setTheme('nord')` (need to import)
3. Verify all colors update
4. Check localStorage has theme saved
5. Refresh page - theme persists ✅

### Component Test
```javascript
import { useTheme } from '../hooks/useTheme';

function Test() {
  const { theme, setCurrentTheme } = useTheme();
  
  return (
    <>
      <p>Current: {theme}</p>
      <button onClick={() => setCurrentTheme('dracula')}>
        Switch to Dracula
      </button>
    </>
  );
}
```

---

**Everything is connected and ready to use!** 🎉
