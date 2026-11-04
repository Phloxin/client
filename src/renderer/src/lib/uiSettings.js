// Apply appearance/animation preferences to the document. Shared by the
// SettingsContext effects and the pre-paint init in main.jsx so the two can't drift.

// Selectable interface fonts. Each `stack` ends in the system sans so it still
// renders if the bundled woff2 (imported in main.jsx) somehow fails to load.
// `id` is what's persisted; the Settings dropdown is built from this list. Kept
// deliberately short — each entry is a distinct voice rather than another
// neutral grotesque, so the list is worth scrolling. An id that's no longer here
// falls back to UI_FONTS[0] below.
export const UI_FONTS = [
  // Neutral UI grotesque — the default.
  { id: 'inter', label: 'Inter', stack: "'Inter Variable', Inter, system-ui, sans-serif" },
  // Neo-grotesque, the Android/Google look.
  { id: 'roboto', label: 'Roboto', stack: "'Roboto Variable', Roboto, system-ui, sans-serif" },
  // Technical humanist, more character than the two above.
  {
    id: 'ibm-plex-sans',
    label: 'IBM Plex Sans',
    stack: "'IBM Plex Sans Variable', 'IBM Plex Sans', system-ui, sans-serif"
  },
  // Widest glyph coverage — the safe pick for non-Latin names.
  {
    id: 'noto-sans',
    label: 'Noto Sans',
    stack: "'Noto Sans Variable', 'Noto Sans', system-ui, sans-serif"
  },
  // Geometric and tight.
  { id: 'manrope', label: 'Manrope', stack: "'Manrope Variable', Manrope, system-ui, sans-serif" },
  // Rounded terminals — the soft one.
  { id: 'nunito', label: 'Nunito', stack: "'Nunito Variable', Nunito, system-ui, sans-serif" },
  // Monospace throughout, for the terminal look.
  {
    id: 'jetbrains-mono',
    label: 'JetBrains Mono',
    stack: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace"
  },
  // No webfont — whatever the OS uses for its own UI (Segoe UI, SF, Cantarell).
  { id: 'system', label: 'System Default', stack: 'system-ui, sans-serif' }
]

const UI_FONTS_BY_ID = new Map(UI_FONTS.map((font) => [font.id, font]))

export function applyAppearanceSettings({
  transparencyEnabled,
  transparencyBlur = 20,
  transparencyOpacity = 85,
  gradientsEnabled = true,
  shadowsEnabled = true,
  fontFamily = 'inter',
  clientPanelPosition = 'left'
}) {
  const html = document.documentElement
  html.setAttribute(
    'data-client-panel-position',
    clientPanelPosition === 'right' ? 'right' : 'left'
  )

  // Drive the global --font-family-primary token off the saved choice; every
  // surface already consumes that token, so the whole UI switches at once.
  const font = UI_FONTS_BY_ID.get(fontFamily) ?? UI_FONTS[0]
  html.style.setProperty('--font-family-primary', font.stack)
  if (transparencyEnabled) {
    html.setAttribute('data-transparency', 'true')
    html.style.setProperty('--transparency-blur', `${transparencyBlur}px`)
    html.style.setProperty('--transparency-opacity', `${transparencyOpacity}%`)
  } else {
    html.removeAttribute('data-transparency')
  }

  // Gradients are on by default; flag the document only when they're disabled so
  // gradients.css can flatten the gradient tokens back to solid colors.
  if (gradientsEnabled) {
    html.removeAttribute('data-gradients')
  } else {
    html.setAttribute('data-gradients', 'off')
  }

  // Same shape as gradients: flag the document only when shadows are off so
  // base.css can flatten the elevation tokens.
  if (shadowsEnabled) {
    html.removeAttribute('data-shadows')
  } else {
    html.setAttribute('data-shadows', 'off')
  }
}

export function applyAnimationSettings({
  enabled = true,
  channelSwitch = 'fade',
  userJoin = 'pop',
  channelList = 'pop',
  overlays = 'on',
  messages = 'slide'
}) {
  const html = document.documentElement
  // An attribute is present only when animations are on and the category isn't
  // 'off', so the stylesheet can key purely off its value. (Motion-driven
  // categories read the same settings through useAnimationCategory instead.)
  const apply = (attr, value) =>
    enabled && value && value !== 'off'
      ? html.setAttribute(attr, value)
      : html.removeAttribute(attr)
  apply('data-anim-channel-switch', channelSwitch)
  apply('data-anim-user-join', userJoin)
  apply('data-anim-channel-list', channelList)
  apply('data-anim-overlays', overlays)
  apply('data-anim-messages', messages)
}
