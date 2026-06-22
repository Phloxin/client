// Apply appearance/animation preferences to the document. Shared by the
// SettingsContext effects and the pre-paint init in main.jsx so the two can't drift.

export function applyAppearanceSettings({
  transparencyEnabled,
  transparencyBlur = 20,
  transparencyOpacity = 85
}) {
  const html = document.documentElement
  if (transparencyEnabled) {
    html.setAttribute('data-transparency', 'true')
    html.style.setProperty('--transparency-blur', `${transparencyBlur}px`)
    html.style.setProperty('--transparency-opacity', `${transparencyOpacity}%`)
  } else {
    html.removeAttribute('data-transparency')
  }
}

export function applyAnimationSettings({
  enabled = true,
  channelSwitch = 'fade',
  userJoin = 'slide',
  channelList = 'slide'
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
