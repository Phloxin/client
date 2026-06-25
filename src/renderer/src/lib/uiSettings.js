// Apply appearance/animation preferences to the document. Shared by the
// SettingsContext effects and the pre-paint init in main.jsx so the two can't drift.

// Selectable interface fonts. Each `stack` ends in the system sans so it still
// renders if the bundled woff2 (imported in main.jsx) somehow fails to load.
// `id` is what's persisted; the Settings dropdown is built from this list.
export const UI_FONTS = [
  { id: 'inter', label: 'Inter', stack: "'Inter Variable', Inter, system-ui, sans-serif" },
  { id: 'open-sans', label: 'Open Sans', stack: "'Open Sans Variable', 'Open Sans', system-ui, sans-serif" },
  { id: 'dm-sans', label: 'DM Sans', stack: "'DM Sans Variable', 'DM Sans', system-ui, sans-serif" },
  { id: 'roboto', label: 'Roboto', stack: "'Roboto Variable', Roboto, system-ui, sans-serif" },
  { id: 'nunito', label: 'Nunito', stack: "'Nunito Variable', Nunito, system-ui, sans-serif" }
]

export function applyAppearanceSettings({
  transparencyEnabled,
  transparencyBlur = 20,
  transparencyOpacity = 85,
  gradientsEnabled = true,
  fontFamily = 'inter'
}) {
  const html = document.documentElement

  // Drive the global --font-family-primary token off the saved choice; every
  // surface already consumes that token, so the whole UI switches at once.
  const font = UI_FONTS.find((f) => f.id === fontFamily) || UI_FONTS[0]
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
}

export function applyAnimationSettings({
  enabled = true,
  channelSwitch = 'fade',
  userJoin = 'pop',
  channelList = 'pop'
}) {
  const html = document.documentElement
  // An attribute is present only when animations are on and the category isn't
  // 'off', so the stylesheet can key purely off its value.
  const apply = (attr, value) =>
    enabled && value && value !== 'off'
      ? html.setAttribute(attr, value)
      : html.removeAttribute(attr)
  apply('data-anim-channel-switch', channelSwitch)
  apply('data-anim-user-join', userJoin)
  apply('data-anim-channel-list', channelList)
}
