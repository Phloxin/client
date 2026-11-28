// Lucky Seven's cards as elements: the thirteen numbers, the plus and double cards and the three
// action cards, drawn as inline SVG on the casino card (cards.js), so the stage can fly and turn
// them. One global, `l7faces`.
;(() => {
  const NUMBER_INK = [
    '#6b7280',
    '#8b5e3c',
    '#a88f12',
    '#e0562f',
    '#1a9c94',
    '#2f9e4f',
    '#8456d1',
    '#d6336c',
    '#5c8f14',
    '#d47a08',
    '#c9303a',
    '#2f6fdb',
    '#3f4aa8'
  ]
  const KINDS = {
    freeze: {
      name: 'Freeze',
      label: 'FREEZE',
      verb: 'Freeze',
      ask: 'Choose who to freeze',
      asking: 'is choosing who to freeze',
      about: 'Freeze: that player banks their points and is out of the round'
    },
    flip_three: {
      name: 'Flip 3',
      label: 'FLIP 3',
      verb: 'Flip 3',
      ask: 'Choose who flips three cards',
      asking: 'is choosing who flips three',
      about: 'Flip 3: that player must take the next three cards'
    },
    second_chance: {
      name: 'Second Chance',
      label: '2ND CHANCE',
      verb: 'Give',
      ask: 'Give your spare Second Chance away',
      asking: 'is giving away a Second Chance',
      about: 'Second Chance: saves its holder from one repeated number'
    }
  }

  const HEART = 'M50 91C22 68 6 50 6 32a22 22 0 0 1 44-6 22 22 0 0 1 44 6c0 18-16 36-44 59z'

  function snowflake(cx, cy, r, w) {
    let out = `<g fill="none" stroke="#fff" stroke-width="${w}" stroke-linecap="round">`
    for (let i = 0; i < 3; i++) {
      const b = r * 0.3
      const tips = [-1, 1]
        .map(
          (s) =>
            `M${cx - b} ${cy + s * (r - b * 0.2)}L${cx} ${cy + s * (r - b * 1.1)}L${cx + b} ${cy + s * (r - b * 0.2)}`
        )
        .join('')
      out += `<path transform="rotate(${i * 60} ${cx} ${cy})" d="M${cx} ${cy - r}V${cy + r}${tips}"/>`
    }
    return out + '</g>'
  }

  function fan(cx, cy, s) {
    const one = (turn, opacity) =>
      `<rect transform="rotate(${turn} ${cx} ${cy + 30 * s})" x="${cx - 13 * s}" y="${cy - 19 * s}" ` +
      `width="${26 * s}" height="${38 * s}" rx="${4 * s}" fill="#fff" fill-opacity="${opacity}" ` +
      'stroke="rgb(0 0 0 / 30%)" stroke-width="1.5"/>'
    return one(-26, 0.75) + one(26, 0.75) + one(0, 1)
  }

  const heart = (cx, cy, s) =>
    `<path transform="translate(${cx - 50 * s} ${cy - 50 * s}) scale(${s})" d="${HEART}" fill="#fff"/>`

  const frame = '<rect class="l7-frame" x="5.5" y="5.5" width="89" height="129" rx="7"/>'
  const corners = (text, cls = '') =>
    `<text class="l7-idx ${cls}" x="18" y="27">${text}</text>` +
    `<g transform="rotate(180 50 70)"><text class="l7-idx ${cls}" x="18" y="27">${text}</text></g>`

  function faceSvg(card) {
    let full
    let mini
    if (card.face === 'number') {
      // A 6 and a 9 are underlined in the corners, where one is seen upside down.
      const wide = card.value > 9 ? ' wide' : card.value === 6 || card.value === 9 ? ' mark' : ''
      full =
        frame +
        '<circle class="l7-disc" cx="50" cy="70" r="34"/>' +
        `<text class="l7-num${wide}" x="50" y="91">${card.value}</text>` +
        corners(card.value, wide)
      mini = `<text class="l7-big${wide}" x="50" y="99">${card.value}</text>`
    } else if (card.face === 'plus' || card.face === 'double') {
      const text = card.face === 'plus' ? `+${card.value}` : '×2'
      const wide = text.length > 2 ? ' wide' : ''
      full =
        frame +
        '<circle class="l7-coin" cx="50" cy="70" r="33"/>' +
        `<text class="l7-num mod${wide}" x="50" y="88">${text}</text>` +
        `<text class="l7-label" x="50" y="126">${card.face === 'plus' ? 'BONUS' : 'DOUBLE'}</text>`
      mini = `<text class="l7-big mod${wide}" x="50" y="96">${text}</text>`
    } else {
      const art = {
        freeze: [snowflake(50, 62, 30, 6), snowflake(50, 70, 36, 9)],
        flip_three: [
          fan(50, 56, 1.15) + '<text class="l7-three" x="50" y="66">3</text>',
          fan(50, 62, 1.5) + '<text class="l7-three big" x="50" y="76">3</text>'
        ],
        second_chance: [heart(50, 62, 0.56), heart(50, 72, 0.74)]
      }[card.face]
      full =
        frame + art[0] + `<text class="l7-label" x="50" y="124">${KINDS[card.face].label}</text>`
      mini = art[1]
    }
    return (
      '<svg viewBox="0 0 100 140" aria-hidden="true">' +
      `<g class="f-full">${full}</g><g class="f-mini">${mini}</g></svg>`
    )
  }

  const isAction = (card) => Object.hasOwn(KINDS, card.face)

  function name(card) {
    if (card.face === 'number') return String(card.value)
    if (card.face === 'plus') return `+${card.value}`
    if (card.face === 'double') return '×2'
    return KINDS[card.face].name
  }

  function about(card) {
    if (card.face === 'number') return `${card.value}: worth ${card.value} points`
    if (card.face === 'plus') return `+${card.value}: adds ${card.value} points`
    if (card.face === 'double') return '×2: doubles your number cards'
    return KINDS[card.face].about
  }

  // Shows `card` on the element, or turns it face down for null.
  function setCard(el, card) {
    const code = card ? `${card.face}/${card.value ?? ''}` : ''
    if (el.dataset.card === code) return
    el.dataset.card = code
    el.classList.toggle('down', !card)
    const face = el.querySelector('.card-face')
    if (!card) {
      face.replaceChildren()
      delete el.dataset.face
      delete el.dataset.value
      el.removeAttribute('title')
      el.setAttribute('aria-label', 'Face-down card')
      return
    }
    el.dataset.face = card.face
    if (card.face === 'number') {
      el.dataset.value = String(card.value)
      el.style.setProperty('--l7-ink', NUMBER_INK[card.value])
    } else {
      delete el.dataset.value
      el.style.removeProperty('--l7-ink')
    }
    face.innerHTML = faceSvg(card)
    el.title = about(card)
    el.setAttribute('aria-label', name(card))
  }

  // A card element, face down when `card` is null. Its width is the CSS variable --card-w.
  function card(card, key) {
    const el = document.createElement('div')
    el.className = 'card l7'
    el.setAttribute('role', 'img')
    if (key != null) el.dataset.key = String(key)
    el.innerHTML =
      '<div class="card-in"><div class="card-face"></div><div class="card-back"></div></div>'
    setCard(el, card)
    return el
  }

  window.l7faces = { card, setCard, name, about, isAction, kinds: KINDS }
})()
