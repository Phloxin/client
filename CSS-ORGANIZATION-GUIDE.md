# CSS Organization Visual Guide

## File Hierarchy & What Goes Where (JUST AN EXAMPLE, CAN BE OUTDATED)

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
│   │   └─ Truly Global Styles
│   │      • Base form elements (select, input)
│   │      • Scrollbar styling
│   │      • Utility classes with no clear owner
│   │      ⚠️  Button styles live in their page/component CSS, not here
│   │
│   ├── 📄 base.css
│   │   └─ Base Styles & Imports
│   │      • CSS reset (*, box-sizing, margins)
│   │      • Typography base
│   │      • HTML/body defaults
│   │
│   ├── 📋 main.css
│   │   └─ Main Entry Point
│   │      • Imports base.css
│   │      • Imports globals.css
│   │      • Root container setup
│   │      ⚠️  Imported once in main.jsx — do not re-import elsewhere
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
│          • IPC broadcast to all Electron windows
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
│   │
│   ├── 🎨 ThemeSwitcher.jsx + ThemeSwitcher.css
│   │   └─ Theme Selector Component
│   │      • UI for theme selection
│   │      • Shows all 4 themes
│   │      • .theme-switcher, .theme-options, .theme-option
│   │
│   ├── 🔐 LoginScreen.jsx + LoginScreen.css
│   │   └─ Login Form Component
│   │      • .login-screen, .login-box, .login-title
│   │      • .admin-section (login form fields)
│   │      • Self-contained — imports only its own CSS
│   │
│   ├── 📹 VideoGrid.jsx + VideoGrid.css
│   │   └─ Video Stream Grid
│   │      • .video-grid, .video-tile
│   │
│   └── 🎙️  VoiceChannel.jsx + VoiceChannel.css
│       └─ Voice Channel Row
│          • .join-btn, .leave-btn, .share-btn
│
├── 📦 pages/ ───────────────────────────────────────────────────────
│   │
│   ├── 📄 Main.jsx + Main.css
│   │   └─ Main Page Layout
│   │      • .layout, .sidebar, .chat-area
│   │      • .settings-btn, .view-toggle-btn
│   │      • .chat-log, .log-entry, .btn-wrap
│   │      • .loading
│   │      ✨ All colors use CSS variables
│   │
│   ├── 📄 Admin.jsx + Admin.css
│   │   └─ Admin Page
│   │      • .admin-layout, .admin-header, .admin-body
│   │      • .admin-section, .admin-status, .admin-btn
│   │      ✨ All colors use CSS variables
│   │
│   └── 📄 Settings.jsx + Settings.css
│       └─ Settings Page
│          • .settings-layout, .settings-header, .settings-body
│          • .settings-section, .settings-status
│          ✨ All colors use CSS variables
│
├── 🎨 App.css
│   └─ App Component Styles
│      • Body base styles
│      • App-level overrides
│      ✨ All colors use CSS variables
│
└── 📄 main.jsx
    └─ App Entry Point
       ✨ Calls initializeTheme() and listenForThemeUpdates()
```

## CSS Cascade & Specificity

```
main.jsx
  ↓ (initializes theme, listens for IPC theme updates)
  ↓
main.css ──────────┐
  ├─ imports ─────→ base.css ─────────┐
  │                                   └─ imports ─→ themes.css ← 🎨 THEME VARS
  └─ imports ─────→ globals.css
                      (uses variables)

Each page imports only its own CSS:
  App.jsx      ──→ App.css
  Main.jsx     ──→ Main.css
  Admin.jsx    ──→ Admin.css
  Settings.jsx ──→ Settings.css   (not Admin.css)

Each component imports only its own CSS:
  LoginScreen.jsx  ──→ LoginScreen.css   (not Admin.css)
  ThemeSwitcher.jsx ─→ ThemeSwitcher.css
  VideoGrid.jsx    ──→ VideoGrid.css
  VoiceChannel.jsx ──→ VoiceChannel.css
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
localStorage saves preference
          ↓
IPC broadcasts to all Electron windows
          ↓
✨ Smooth theme transition across all windows
```

## Variable Resolution Example

### When theme = "catppuccin-frappe"
```css
[data-theme="catppuccin-frappe"] {
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
  --color-text: #eceff4;
  --color-primary: #88c0d0;
}
```

### Variable resolution updates automatically
```css
.my-button {
  color: var(--color-text);           /* Now #eceff4 */
  background: var(--color-primary);   /* Now #88c0d0 */
}
/* ✨ CSS updates without touching the rule */
```

## Component Styling Guidelines

### 🟢 Truly Global (globals.css)
No clear owner, used everywhere
```css
select {
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
}
```

### 🟡 Page-Scoped (pages/*.css)
Owned by a specific page, not shared
```css
/* Admin.css */
.admin-btn {
  background: var(--color-primary);
  color: var(--color-background);
}

/* Main.css */
.settings-btn {
  background: var(--color-primary);
  color: var(--color-background);
}
```

### 🔵 Component-Scoped (components/*.css)
Tightly coupled to one component
```css
/* VoiceChannel.css */
.join-btn {
  background: var(--color-success);
}
```

## Style Ownership Map

| Class | File | Notes |
|-------|------|-------|
| `.layout`, `.sidebar` | `Main.css` | Main page layout |
| `.settings-btn` | `Main.css` | Sidebar nav buttons |
| `.view-toggle-btn` | `Main.css` | Chat/video toggle |
| `.admin-layout`, `.admin-btn` | `Admin.css` | Admin page only |
| `.admin-section`, `.admin-status` | `Admin.css` | Admin page only |
| `.settings-layout` | `Settings.css` | Settings page only |
| `.login-screen`, `.login-box` | `LoginScreen.css` | Login component |
| `.join-btn`, `.leave-btn`, `.share-btn` | `VoiceChannel.css` | Channel buttons |
| `.theme-switcher`, `.theme-option` | `ThemeSwitcher.css` | Theme picker |
| `.video-grid`, `.video-tile` | `VideoGrid.css` | Video layout |

## Adding New Styles: Decision Tree

```
Is this style used in more than one unrelated page or component?
  ├─ YES → Is it a base HTML element (input, select, scrollbar)?
  │          ├─ YES → globals.css
  │          └─ NO  → Reconsider. Can you rename the class to be
  │                   page-specific and duplicate it? Explicit > implicit.
  └─ NO  → Is it inside a component (VoiceChannel, VideoGrid, etc.)?
             ├─ YES → components/<ComponentName>.css
             └─ NO  → pages/<PageName>.css
```

## Quick Reference

| Type | Location | Example class |
|------|----------|---------------|
| Base HTML elements | `globals.css` | `select`, `input` |
| Page layout | `pages/*.css` | `.sidebar`, `.admin-layout` |
| Page buttons | `pages/*.css` | `.admin-btn`, `.settings-btn` |
| Component styles | `components/*.css` | `.join-btn`, `.login-box` |
| Theme variables | `themes.css` | `--color-primary` |
| App-level overrides | `App.css` | `body`, `.app` |

## What Not To Do

```css
/* ❌ Never import another page's CSS */
/* In LoginScreen.jsx: */
import '../pages/Admin.css'   /* Wrong — creates hidden dependency */

/* ✅ Each file imports only its own CSS */
import './LoginScreen.css'    /* Correct */
```

```css
/* ❌ Never hardcode colors */
.btn { background: #8caaee; }

/* ✅ Always use variables */
.btn { background: var(--color-primary); }
```

```css
/* ❌ Don't put page-specific buttons in globals */
/* globals.css */
.admin-btn { ... }   /* Wrong — only Admin.jsx uses this */

/* ✅ Put them in the page that owns them */
/* Admin.css */
.admin-btn { ... }   /* Correct */
```