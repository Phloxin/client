// The whiteboard's small interface parts, with nothing of the board in them: element builders,
// tooltips that name a control's shortcut, the one popover open at a time (a sheet from the
// bottom in a narrow pane), toasts, and the colour picker, which is built from plain elements
// because a native colour input cannot open from a sandboxed frame.
/* global wbIcons */
;(() => {
  const { icon } = wbIcons
  const $ = (id) => document.getElementById(id)
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
  const SHEET_UNDER = 440
  const TIP_DELAY_MS = 450
  const TOAST_MS = 3600
  const MAX_TOASTS = 3
  const EDGE = 8

  function el(tag, className, ...children) {
    const e = document.createElement(tag)
    if (className) e.className = className
    for (const c of children) if (c != null) e.append(c)
    return e
  }

  function button(className, content, onClick, label, keys) {
    const b = el('button', className)
    b.type = 'button'
    if (content != null) b.append(content)
    if (label) tip(b, label, keys)
    if (onClick) b.addEventListener('click', onClick)
    return b
  }

  const iconButton = (name, label, onClick, keys) =>
    button('icon-btn', icon(name), onClick, label, keys)

  // A switch: a button that says whether it is on.
  function toggle(label, onChange) {
    const b = button('switch', el('span', 'switch-knob'), () =>
      onChange(b.getAttribute('aria-checked') !== 'true')
    )
    b.setAttribute('role', 'switch')
    b.setAttribute('aria-label', label)
    b.setAttribute('aria-checked', 'false')
    return b
  }
  const setToggle = (b, on) => b.setAttribute('aria-checked', on ? 'true' : 'false')

  const tips = new WeakMap()
  let tipTimer = null
  let tipFor = null

  // Names a control: its accessible name, and the tooltip with its shortcut keys.
  function tip(target, label, keys) {
    tips.set(target, { label, keys: keys ? [].concat(keys) : [] })
    target.dataset.tip = ''
    target.setAttribute('aria-label', label)
  }

  function hideTip() {
    clearTimeout(tipTimer)
    tipFor = null
    $('tip').hidden = true
  }

  function showTip(target) {
    const data = tips.get(target)
    if (!data || !target.isConnected) return
    const box = $('tip')
    box.replaceChildren(el('span', null, data.label), ...data.keys.map((k) => el('kbd', null, k)))
    box.hidden = false
    const r = target.getBoundingClientRect()
    const w = box.offsetWidth
    const h = box.offsetHeight
    const above = r.top - h - 6 >= EDGE
    box.style.left = `${clamp(r.left + r.width / 2 - w / 2, EDGE, innerWidth - w - EDGE)}px`
    box.style.top = `${above ? r.top - h - 6 : r.bottom + 6}px`
  }

  document.addEventListener('pointerover', (event) => {
    if (event.pointerType === 'touch') return
    const target = event.target.closest?.('[data-tip]')
    if (target === tipFor) return
    hideTip()
    if (!target) return
    tipFor = target
    tipTimer = setTimeout(() => showTip(target), TIP_DELAY_MS)
  })
  document.addEventListener('pointerdown', hideTip, true)
  document.addEventListener('pointerleave', hideTip)
  addEventListener('blur', hideTip)

  let open = null

  function place(pop) {
    const { card, anchor } = pop
    const sheet = innerWidth < SHEET_UNDER
    card.classList.toggle('sheet', sheet)
    card.style.left = card.style.top = card.style.maxHeight = ''
    if (sheet || !anchor?.isConnected) return
    const r = anchor.getBoundingClientRect()
    const below = r.top + r.height / 2 < innerHeight / 2
    const room = below ? innerHeight - r.bottom - EDGE * 2 : r.top - EDGE * 2
    card.style.maxHeight = `${Math.max(120, room)}px`
    const w = card.offsetWidth
    const h = card.offsetHeight
    const left = clamp(r.left + r.width / 2 - w / 2, EDGE, Math.max(EDGE, innerWidth - w - EDGE))
    card.style.left = `${left}px`
    card.style.top = `${below ? r.bottom + EDGE : r.top - EDGE - h}px`
    card.style.setProperty('--wb-origin-x', `${r.left + r.width / 2 - left}px`)
    card.style.setProperty('--wb-origin-y', below ? '0px' : '100%')
  }

  function closePop() {
    if (!open) return
    const { card, anchor, onClose } = open
    open = null
    anchor?.classList.remove('pop-open')
    card.classList.remove('in')
    // The leave transition, or at once when motion is reduced and no transition runs.
    setTimeout(() => card.remove(), 170)
    onClose?.()
  }

  // Opens popover `id` by `anchor`, built by build(card). Opening the one that is open closes
  // it. Returns the card, or null when this call closed it.
  function openPop(id, anchor, build, { className = '', onClose } = {}) {
    if (open?.id === id) {
      closePop()
      return null
    }
    closePop()
    const card = el('div', `pop ${className}`)
    card.setAttribute('role', 'dialog')
    build(card)
    $('pops').append(card)
    open = { id, card, anchor, onClose }
    anchor?.classList.add('pop-open')
    place(open)
    // Two frames, so the entering state is painted before the transition starts.
    requestAnimationFrame(() => requestAnimationFrame(() => card.classList.add('in')))
    return card
  }

  document.addEventListener(
    'pointerdown',
    (event) => {
      if (!open) return
      if (open.card.contains(event.target) || open.anchor?.contains(event.target)) return
      closePop()
    },
    true
  )
  addEventListener('resize', () => open && place(open))

  const toasts = []

  function dismiss(t) {
    const at = toasts.indexOf(t)
    if (at < 0) return
    toasts.splice(at, 1)
    clearTimeout(t.timer)
    t.node.classList.remove('in')
    setTimeout(() => t.node.remove(), 200)
  }

  // A passing notice. The same text again restarts the one already showing.
  function toast(text, kind = 'info', iconName = null) {
    const again = toasts.find((t) => t.text === text)
    if (again) {
      clearTimeout(again.timer)
      again.timer = setTimeout(() => dismiss(again), TOAST_MS)
      again.node.classList.remove('again')
      void again.node.offsetWidth
      again.node.classList.add('again')
      return
    }
    const name = iconName ?? (kind === 'error' ? 'alert' : kind === 'ok' ? 'check' : null)
    const node = el('div', `toast ${kind}`, name ? icon(name) : null, el('span', null, text))
    $('toasts').append(node)
    const t = { text, node, timer: null }
    toasts.push(t)
    if (toasts.length > MAX_TOASTS) dismiss(toasts[0])
    requestAnimationFrame(() => requestAnimationFrame(() => node.classList.add('in')))
    t.timer = setTimeout(() => dismiss(t), TOAST_MS)
  }

  function hsvToRgb(h, s, v) {
    const f = (n) => {
      const k = (n + h / 60) % 6
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))))
    }
    return (f(5) << 16) | (f(3) << 8) | f(1)
  }

  function rgbToHsv(color) {
    const r = ((color >> 16) & 255) / 255
    const g = ((color >> 8) & 255) / 255
    const b = (color & 255) / 255
    const max = Math.max(r, g, b)
    const span = max - Math.min(r, g, b)
    let h = 0
    if (span) {
      if (max === r) h = ((g - b) / span) % 6
      else if (max === g) h = (b - r) / span + 2
      else h = (r - g) / span + 4
      h = (h * 60 + 360) % 360
    }
    return { h, s: max ? span / max : 0, v: max }
  }

  const hex = (color) => `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
  function parseHex(text) {
    const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text.trim())
    if (!m) return null
    const digits = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1]
    return parseInt(digits, 16)
  }

  // Drags along `area`, calling move(x, y) with the pointer's place in it, each 0 to 1.
  function drag(area, move) {
    const at = (event) => {
      const r = area.getBoundingClientRect()
      move(
        clamp((event.clientX - r.left) / r.width, 0, 1),
        clamp((event.clientY - r.top) / r.height, 0, 1)
      )
    }
    area.addEventListener('pointerdown', (event) => {
      area.setPointerCapture(event.pointerId)
      at(event)
    })
    area.addEventListener('pointermove', (event) => {
      if (area.hasPointerCapture(event.pointerId)) at(event)
    })
  }

  // A saturation and brightness square, a hue strip and a hex field. pick(color) on every
  // change; `set` shows a colour chosen elsewhere.
  function colorPicker(pick) {
    let hsv = { h: 0, s: 0, v: 0 }
    const svKnob = el('span', 'picker-knob')
    const sv = el('div', 'picker-sv', svKnob)
    const hueKnob = el('span', 'picker-knob')
    const hue = el('div', 'picker-hue', hueKnob)
    const chip = el('span', 'picker-chip')
    const field = el('input', 'picker-hex')
    field.type = 'text'
    field.maxLength = 7
    field.spellcheck = false
    field.autocomplete = 'off'
    field.setAttribute('aria-label', 'Hex colour')
    const root = el('div', 'picker', sv, hue, el('div', 'picker-row', chip, field))

    function show(typing) {
      const color = hsvToRgb(hsv.h, hsv.s, hsv.v)
      sv.style.setProperty('--wb-hue', `hsl(${hsv.h} 100% 50%)`)
      svKnob.style.left = `${hsv.s * 100}%`
      svKnob.style.top = `${(1 - hsv.v) * 100}%`
      svKnob.style.background = hex(color)
      hueKnob.style.left = `${(hsv.h / 360) * 100}%`
      hueKnob.style.background = `hsl(${hsv.h} 100% 50%)`
      chip.style.background = hex(color)
      if (!typing) field.value = hex(color)
      return color
    }

    drag(sv, (x, y) => {
      hsv = { h: hsv.h, s: x, v: 1 - y }
      pick(show(false))
    })
    drag(hue, (x) => {
      hsv = { ...hsv, h: Math.min(359.9, x * 360) }
      pick(show(false))
    })
    field.addEventListener('input', () => {
      const color = parseHex(field.value)
      if (color == null) return
      const next = rgbToHsv(color)
      // A grey has no hue of its own; the strip stays where it was.
      hsv = next.s ? next : { ...next, h: hsv.h }
      show(true)
      pick(color)
    })
    field.addEventListener('blur', () => show(false))

    return {
      el: root,
      set(color) {
        if (hsvToRgb(hsv.h, hsv.s, hsv.v) === color) return
        const next = rgbToHsv(color)
        hsv = next.s ? next : { ...next, h: hsv.h }
        show(document.activeElement === field)
      }
    }
  }

  window.wbWidgets = {
    el,
    button,
    iconButton,
    toggle,
    setToggle,
    tip,
    hideTip,
    openPop,
    closePop,
    placePop: () => open && place(open),
    get popId() {
      return open?.id ?? null
    },
    get popCard() {
      return open?.card ?? null
    },
    toast,
    colorPicker,
    hex
  }
})()
