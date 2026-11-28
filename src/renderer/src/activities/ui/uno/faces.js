// Uno's cards as elements, drawn as inline SVG on the casino card (cards.js) so the stage can fly
// and turn them. Every colour has a shape of its own (diamond, circle, triangle, square), behind
// the number and under each corner index, so a card can be told without its colour. A face has
// two drawings: casino.css shows `f-mini` on a card under 56 px wide and `f-full` on the rest.
// One global, `unofaces`.
;(() => {
  const COLORS = ['red', 'yellow', 'green', 'blue']
  const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' }
  // On a 100 box around (50, 50). The triangle is set high so its weight sits on the centre.
  const SHAPES = {
    red: '<path d="M50 4 96 50 50 96 4 50z"/>',
    yellow: '<circle cx="50" cy="50" r="45"/>',
    green: '<path d="M50 -6 100 78H0z"/>',
    blue: '<rect x="8" y="8" width="84" height="84" rx="14"/>'
  }
  const KINDS = {
    skip: { name: 'Skip', about: 'the next player misses a turn' },
    reverse: { name: 'Reverse', about: 'the order of play turns round' },
    draw_two: { name: 'Draw Two', about: 'the next player draws two cards and misses a turn' },
    wild: { name: 'Wild', about: 'goes on any card, and you pick the colour' },
    wild_draw_four: {
      name: 'Wild Draw Four',
      about: 'you pick the colour, the next player draws four cards and misses a turn'
    }
  }

  const at = (cx, cy, size) =>
    `transform="translate(${cx - size / 2} ${cy - size / 2}) scale(${size / 100})"`
  const shape = (color, cx, cy, size, cls) =>
    `<g class="${cls}" ${at(cx, cy, size)}>${SHAPES[color]}</g>`

  // An arc with an arrowhead, clockwise from `from` to `to` degrees on a circle of radius `r`.
  function arc(r, from, to, head) {
    const rad = (deg) => (deg * Math.PI) / 180
    const pt = (deg, d = r) =>
      `${(50 + d * Math.cos(rad(deg))).toFixed(1)} ${(50 + d * Math.sin(rad(deg))).toFixed(1)}`
    const tipX = 50 + r * Math.cos(rad(to)) - Math.sin(rad(to)) * head
    const tipY = 50 + r * Math.sin(rad(to)) + Math.cos(rad(to)) * head
    return (
      `<path d="M${pt(from)}A${r} ${r} 0 0 1 ${pt(to)}"/>` +
      `<path class="head" d="M${tipX.toFixed(1)} ${tipY.toFixed(1)}L${pt(to, r + head * 0.8)}L${pt(to, r - head * 0.8)}z"/>`
    )
  }
  const HALF = arc(31, 200, 318, 19)
  const SYMBOLS = {
    skip: '<circle cx="50" cy="50" r="34"/><path d="M26 74 74 26"/>',
    reverse: `${HALF}<g transform="rotate(180 50 50)">${HALF}</g>`
  }
  const symbol = (face, cx, cy, size) =>
    `<g class="uno-sym" ${at(cx, cy, size)}>${SYMBOLS[face]}</g>`

  // The four colours' shapes, two by two, around (cx, cy).
  function four(cx, cy, size, gap) {
    const d = (size + gap) / 2
    return COLORS.map((color, i) =>
      shape(color, cx + (i % 2 ? d : -d), cy + (i < 2 ? -d : d), size, `uno-m ${color}`)
    ).join('')
  }

  // The four in a row, centred on (cx, cy).
  const row = (cx, cy, size, gap) =>
    COLORS.map((color, i) =>
      shape(color, cx + (i - 1.5) * (size + gap), cy, size, `uno-m ${color}`)
    ).join('')

  const FRAME = '<rect class="uno-frame" x="5" y="5" width="90" height="135" rx="7"/>'
  const corners = (index) => `${index}<g transform="rotate(180 50 72.5)">${index}</g>`
  const number = (text, cls = '') =>
    `<text class="uno-num shade${cls}" x="52" y="96.5">${text}</text>` +
    `<text class="uno-num${cls}" x="50" y="94.5">${text}</text>`

  function faceSvg(card) {
    const color = card.color
    let full
    let mini
    if (card.face === 'number') {
      // A 6 and a 9 are underlined in the corners, where one is seen upside down.
      const mark = card.number === 6 || card.number === 9 ? ' mark' : ''
      full =
        shape(color, 50, 72.5, 64, 'uno-medal') +
        number(card.number) +
        corners(
          `<text class="uno-idx${mark}" x="17" y="29">${card.number}</text>` +
            shape(color, 17, 41, 9, 'uno-pip')
        )
      mini =
        shape(color, 69, 108, 42, 'uno-wash') +
        `<text class="uno-big" x="33" y="64">${card.number}</text>`
    } else if (card.face === 'skip' || card.face === 'reverse') {
      full =
        shape(color, 50, 72.5, 64, 'uno-medal') +
        symbol(card.face, 50, 72.5, 50) +
        corners(symbol(card.face, 17, 21, 18) + shape(color, 17, 41, 9, 'uno-pip'))
      mini = shape(color, 69, 108, 42, 'uno-wash') + symbol(card.face, 36, 44, 50)
    } else if (card.face === 'draw_two') {
      full =
        shape(color, 50, 72.5, 64, 'uno-medal') +
        number('+2', ' mod') +
        corners(
          '<text class="uno-idx mod" x="18" y="28">+2</text>' + shape(color, 17, 41, 9, 'uno-pip')
        )
      mini =
        shape(color, 69, 108, 42, 'uno-wash') + '<text class="uno-big mod" x="38" y="60">+2</text>'
    } else if (card.face === 'wild') {
      full = four(50, 72.5, 25, 9) + corners(four(17, 22, 8, 3))
      mini = four(50, 72.5, 34, 12)
    } else {
      full =
        row(50, 49, 14, 5) +
        '<text class="uno-num shade mod" x="52" y="104">+4</text>' +
        '<text class="uno-num mod" x="50" y="102">+4</text>' +
        corners('<text class="uno-idx mod" x="18" y="28">+4</text>')
      mini = '<text class="uno-big mod" x="38" y="60">+4</text>' + four(64, 108, 21, 7)
    }
    return (
      '<svg viewBox="0 0 100 145" aria-hidden="true">' +
      `<g class="f-full">${FRAME}${full}</g><g class="f-mini">${mini}</g></svg>`
    )
  }

  function name(card) {
    if (card.color == null) return KINDS[card.face].name
    const what = card.face === 'number' ? String(card.number) : KINDS[card.face].name
    return `${COLOR_NAMES[card.color]} ${what}`
  }

  function about(card) {
    return card.face === 'number' ? name(card) : `${name(card)}: ${KINDS[card.face].about}`
  }

  // Shows `card` on the element, or turns it face down for null.
  function setCard(el, card) {
    const code = card ? `${card.color ?? 'wild'}/${card.face}/${card.number ?? ''}` : ''
    if (el.dataset.card === code) return
    el.dataset.card = code
    el.classList.toggle('down', !card)
    const face = el.querySelector('.card-face')
    if (!card) {
      face.replaceChildren()
      delete el.dataset.color
      delete el.dataset.face
      el.removeAttribute('title')
      el.setAttribute('aria-label', 'Face-down card')
      return
    }
    el.dataset.color = card.color ?? 'wild'
    el.dataset.face = card.face
    face.innerHTML = faceSvg(card)
    el.title = about(card)
    el.setAttribute('aria-label', name(card))
  }

  // A card element, face down when `card` is null: a button for a card in the viewer's hand. Its
  // width is the CSS variable --card-w.
  function card(card, key, tag = 'div') {
    const el = document.createElement(tag)
    if (tag === 'button') el.type = 'button'
    else el.setAttribute('role', 'img')
    el.className = 'card uno'
    if (key != null) el.dataset.key = String(key)
    el.innerHTML =
      '<span class="card-in"><span class="card-face"></span><span class="card-back"></span></span>'
    setCard(el, card)
    return el
  }

  // A colour's shape on its own, for the colour in play and the colour picker.
  const mark = (color) =>
    `<svg class="uno-mark" viewBox="-10 -16 120 120" aria-hidden="true">${SHAPES[color]}</svg>`

  window.unofaces = { COLORS, COLOR_NAMES, card, setCard, name, about, mark, kinds: KINDS }
})()
