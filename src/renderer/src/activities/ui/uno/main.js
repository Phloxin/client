// Uno for 2 to 10 seats, started by the room's leader. room and seats draw the plates and the
// notice line; this draws the table (top card, the colour in play, the deck), the viewer's hand,
// the revealed hands a spectator sees, the status line and Start, and sends `play`, `draw`,
// `start` and `reveal`.
/* global bridge, room, seats */
;(() => {
  const COLORS = ['red', 'yellow', 'green', 'blue']
  const COLOR_NAMES = { red: 'Red', yellow: 'Yellow', green: 'Green', blue: 'Blue' }
  const FACE_ORDER = { number: 0, skip: 1, reverse: 2, draw_two: 3, wild: 4, wild_draw_four: 5 }
  const SVG = {
    skip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><circle cx="12" cy="12" r="8"/><path d="M6.6 17.4 17.4 6.6"/></svg>',
    reverse:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h14M14 5l4 4-4 4M20 15H6M10 11l-4 4 4 4"/></svg>',
    wild: '<svg viewBox="0 0 24 32"><g transform="rotate(20 12 16)"><path class="q-red" d="M12 16V3a8 13 0 0 1 8 13z"/><path class="q-blue" d="M12 16h8a8 13 0 0 1-8 13z"/><path class="q-green" d="M12 16v13a8 13 0 0 1-8-13z"/><path class="q-yellow" d="M12 16H4a8 13 0 0 1 8-13z"/></g></svg>',
    crown:
      '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 6l4 6 5-4-2 10H5L3 8l5 4z"/></svg>',
    arrow:
      '<svg viewBox="0 0 64 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h58M54 1.5 60 6l-6 4.5"/></svg>'
  }

  const $ = (id) => document.getElementById(id)
  const game = $('game')
  const pile = $('pile')
  const deck = $('deck')
  const deckCount = $('deck-count')
  const hand = $('hand')
  const revealed = $('revealed')
  const statusEl = $('status')
  const watching = $('watching')
  const action = $('action')
  const revealRow = $('reveal-row')
  const revealBox = $('reveal')
  const colors = $('colors')

  // The wild card waiting on the colour picker.
  let choosing = null

  room.rejections({
    not_leader: 'Only the leader can start',
    does_not_match: "That card doesn't match",
    not_in_hand: "You don't have that card",
    bad_color: 'Pick a colour',
    round_in_progress: 'Wait for the round to end',
    need_two_players: 'Two players are needed',
    not_playing: 'No round is being played'
  })

  const view = () => room.view
  const playing = () => view().status?.kind === 'playing'
  const round = () => view().round ?? null
  const playerOf = (clientId) => round()?.players?.find((p) => p.client === clientId) ?? null
  const me = () => playerOf(room.you)
  const isLeader = () => view().leader != null && view().leader === room.you
  const myTurn = () => playing() && round()?.turn === room.you
  // Whether input can reach the room at all; a pending action does not count, so the hand does
  // not flicker while one is in flight.
  const live = () => room.connected && !room.closed
  const takenSeats = () => view().seats.filter((id) => id != null).length

  const playable = (card) => {
    const r = round()
    if (!r) return false
    if (card.color == null || card.color === r.color) return true
    if (card.face !== r.top?.face) return false
    return card.face !== 'number' || card.number === r.top.number
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  const span = (className, content) => {
    const el = document.createElement('span')
    el.className = className
    if (content != null) el.innerHTML = content
    return el
  }

  // What a face shows, as markup: the number, a sign, or the four colours.
  function faceMarkup(card) {
    switch (card.face) {
      case 'number':
        return String(card.number ?? '')
      case 'skip':
        return SVG.skip
      case 'reverse':
        return SVG.reverse
      case 'draw_two':
        return '+2'
      case 'wild_draw_four':
        return '+4'
      case 'wild':
        return SVG.wild
      default:
        return ''
    }
  }

  function cardEl(card, tag = 'div') {
    const el = document.createElement(tag)
    if (tag === 'button') el.type = 'button'
    el.className = `card ${card.color ?? 'wild'}`
    el.dataset.face = card.face
    el.dataset.card = String(card.id)
    if (card.face === 'number') el.dataset.number = String(card.number)
    const markup = faceMarkup(card)
    el.append(span('corner top', markup), span('face', markup), span('corner bottom', markup))
    return el
  }

  const backEl = (className = '') =>
    span(`back ${className}`.trim(), '<span class="back-mark"></span>')

  const sortKey = (card) => [
    card.color == null ? COLORS.length : COLORS.indexOf(card.color),
    FACE_ORDER[card.face] ?? 9,
    card.number ?? 0,
    card.id
  ]
  function sorted(cards) {
    return [...cards].sort((a, b) => {
      const ka = sortKey(a)
      const kb = sortKey(b)
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
      return 0
    })
  }

  // ── Seat plates ───────────────────────────────────────────────────────────

  function extra(seat) {
    const id = view().seats[seat]
    if (id == null) return null
    const box = span('seat-extra')
    const marks = span('seat-marks')
    const player = playerOf(id)
    if (player) {
      const count = span('seat-cards')
      count.append(backEl('mini'), String(player.cards))
      box.appendChild(count)
      if (player.away) marks.appendChild(span('away', 'Away'))
    }
    if (view().leader === id) marks.appendChild(span('crown', SVG.crown))
    if (marks.firstChild) box.appendChild(marks)
    return box.firstChild ? box : null
  }

  seats.setup({
    label: () => 'Open seat',
    active: (seat) => playing() && view().seats[seat] === round()?.turn,
    extra,
    canSit: () => !playing(),
    canStand: () => !playing(),
    emptySeats: 'one',
    emptyLabel: true
  })

  // ── Drawing ───────────────────────────────────────────────────────────────

  function statusText() {
    const v = view()
    const s = v.status ?? {}
    if (s.kind === 'waiting') {
      return isLeader()
        ? 'Start when everyone is seated'
        : `Waiting for ${room.nameOf(v.leader)} to start`
    }
    if (s.kind === 'playing') {
      const turn = round()?.turn
      return turn === room.you ? 'Your turn' : `${room.nameOf(turn)}'s turn`
    }
    if (s.kind === 'over') {
      if (s.winner == null) return 'Round over'
      return s.winner === room.you ? 'You won' : `${room.nameOf(s.winner)} won`
    }
    return ''
  }

  function drawTable() {
    const r = round()
    $('table').hidden = !r
    const direction = $('direction')
    direction.hidden = !(r && playing())
    if (!r) return
    if (!direction.firstChild) direction.innerHTML = SVG.arrow
    direction.classList.toggle('backward', r.direction === 'backward')

    pile.className = `pile ${COLORS.includes(r.color) ? r.color : ''}`.trim()
    const topId = r.top ? String(r.top.id) : ''
    if (pile.dataset.card !== topId || pile.dataset.color !== r.color) {
      pile.dataset.card = topId
      pile.dataset.color = r.color
      pile.replaceChildren(...(r.top ? [cardEl(r.top)] : []))
    }

    const turn = myTurn() && live()
    deck.disabled = !(turn && room.canAct())
    deck.classList.toggle('open', turn)
    if (!deck.firstChild) deck.appendChild(backEl())
    const label = deck.querySelector('.back-mark')
    label.textContent = turn ? 'Draw' : ''
    deckCount.textContent = String(r.deck ?? 0)
  }

  function drawHand() {
    const mine = me()
    const cards = mine?.hand
    hand.hidden = !cards
    if (!cards) {
      hand.replaceChildren()
      return
    }
    const turn = myTurn() && live()
    const act = room.canAct()
    hand.replaceChildren(
      ...sorted(cards).map((card) => {
        const el = cardEl(card, 'button')
        const ok = turn && playable(card)
        el.classList.toggle('playable', ok)
        el.classList.toggle('dim', turn && !ok)
        el.classList.toggle('choosing', choosing === card.id)
        // Not `disabled`: a disabled button swallows the click that closes the colour picker.
        el.setAttribute('aria-disabled', String(!(ok && act)))
        el.tabIndex = ok && act ? 0 : -1
        return el
      })
    )
  }

  function drawRevealed() {
    const r = round()
    const rows =
      seats.isSeated() || !r
        ? []
        : r.players.filter((p) => p.hand && view().revealing?.includes(p.client))
    revealed.hidden = rows.length === 0
    revealed.replaceChildren(
      ...rows.map((p) => {
        const row = document.createElement('div')
        row.className = 'revealed-row'
        const name = span('revealed-name')
        name.textContent = room.nameOf(p.client)
        const cards = span('revealed-cards')
        cards.append(...sorted(p.hand).map((card) => cardEl(card)))
        row.append(name, cards)
        return row
      })
    )
  }

  function drawColors() {
    colors.hidden = choosing == null
    if (choosing == null) return
    if (!colors.firstChild) {
      colors.append(
        ...COLORS.map((color) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = `swatch ${color}`
          b.dataset.color = color
          b.setAttribute('aria-label', COLOR_NAMES[color])
          return b
        })
      )
    }
    // Over the card being played, kept inside the frame.
    const card = hand.querySelector(`[data-card="${choosing}"]`)
    if (!card) return
    const box = card.getBoundingClientRect()
    const area = game.getBoundingClientRect()
    const width = colors.offsetWidth
    const height = colors.offsetHeight
    const left = Math.min(Math.max(box.left + box.width / 2 - width / 2, 8), innerWidth - width - 8)
    const top = Math.max(box.top - height - 8, 8)
    colors.style.left = `${left - area.left + game.scrollLeft}px`
    colors.style.top = `${top - area.top + game.scrollTop}px`
  }

  function draw() {
    const v = view()
    if (!v) return
    game.hidden = false
    bridge.setBusy(!!me() && playing())

    // The picker lasts only while that card can still be played.
    if (choosing != null) {
      const card = me()?.hand?.find((c) => c.id === choosing)
      if (!card || !myTurn() || !room.canAct() || !playable(card)) choosing = null
    }

    statusEl.textContent = statusText()
    watching.hidden = seats.isSeated()
    const s = v.status?.kind
    action.hidden = !(isLeader() && (s === 'waiting' || s === 'over'))
    action.textContent = s === 'over' ? 'Start next round' : 'Start'
    action.disabled = !room.canAct() || takenSeats() < 2

    revealRow.hidden = !seats.isSeated()
    revealBox.checked = !!v.revealing?.includes(room.you)
    revealBox.disabled = !room.canAct()

    drawTable()
    drawRevealed()
    drawHand()
    drawColors()
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  action.addEventListener('click', () => room.send({ type: 'start' }))
  deck.addEventListener('click', () => {
    if (myTurn()) room.send({ type: 'draw' })
  })
  revealBox.addEventListener('change', () => {
    const on = revealBox.checked
    // The box shows the server's state; the click only asks for the change.
    revealBox.checked = !on
    room.send({ type: 'reveal', on })
  })

  // One handler for the hand, the colour picker and a click anywhere else.
  document.addEventListener('click', (event) => {
    if (!room.view) return
    const swatch = event.target.closest('.swatch')
    if (swatch && choosing != null) {
      const card = choosing
      choosing = null
      room.send({ type: 'play', card, color: swatch.dataset.color })
      draw()
      return
    }
    if (choosing != null) {
      choosing = null
      draw()
      return
    }
    const el = event.target.closest('.hand .card')
    if (!el || !myTurn() || !room.canAct()) return
    const id = Number(el.dataset.card)
    const card = me()?.hand?.find((c) => c.id === id)
    if (!card || !playable(card)) return
    if (card.color == null) {
      choosing = id
      draw()
      colors.querySelector('.swatch')?.focus()
      return
    }
    room.send({ type: 'play', card: id })
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && choosing != null && room.view) {
      choosing = null
      draw()
    }
  })

  room.onRender(draw)
})()
