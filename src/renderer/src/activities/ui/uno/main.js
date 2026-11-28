// Uno for 2 to 10 seats, started by the room's leader. Draws each snapshot on the casino helpers
// (cards.js): the other players around the table as fans of card backs, the deck and the pile in
// the middle, the viewer's hand along the bottom (or, for a watcher, a hand a player shows), and
// the moves the change from the snapshot before calls for, as steps.js works them out. Sends sit,
// stand, start, play, draw and reveal.
/* global bridge, room, casino, unofaces, unosteps */
;(() => {
  const $ = (id) => document.getElementById(id)
  const { same, kindOf, playable, sorted } = unosteps
  const AWAY_TURN_MS = 3000
  const FLY_MS = 400
  const DRAW_GAP_MS = 170
  // The most card backs a fan shows; the number beside it is the count.
  const FAN_MAX = 8
  const PILE_MAX = 5
  // A pod at scale 1, as `.pod` in style.css has it.
  const POD_W = 112
  const POD_H = 76
  const POD_GAP = 6
  const DECK = 108
  const BITS = ['#f3c552', '#dc3b35', '#2f9f57', '#2b72e0', '#f2bb22', '#ffffff']
  const TROPHY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2h3v3a4 4 0 0 1-3.4 3.95A5 5 0 0 1 13 14.9V18h3v3H8v-3h3v-3.1a5 5 0 0 1-3.6-2.95A4 4 0 0 1 4 8V5h3zm0 4H6v1a2 2 0 0 0 1 1.73zm10 0v2.73A2 2 0 0 0 18 8V7z"/></svg>'
  const LEGEND = [
    [
      [
        { color: 'red', face: 'number', number: 5 },
        { color: 'blue', face: 'number', number: 5 }
      ],
      'Numbers 0 to 9',
      'Play one on its colour, or on the same number in another colour.'
    ],
    [[{ color: 'yellow', face: 'skip' }], 'Skip', 'The next player misses a turn.'],
    [
      [{ color: 'green', face: 'reverse' }],
      'Reverse',
      'The order of play turns round. Between two players it works as a skip.'
    ],
    [
      [{ color: 'blue', face: 'draw_two' }],
      'Draw Two',
      'The next player draws two cards and misses a turn.'
    ],
    [[{ color: null, face: 'wild' }], 'Wild', 'Goes on any card. You pick the colour to play on.'],
    [
      [{ color: null, face: 'wild_draw_four' }],
      'Wild Draw Four',
      'You pick the colour. The next player draws four cards and misses a turn.'
    ]
  ]

  room.rejections({
    not_leader: 'Only the leader can start',
    does_not_match: "That card doesn't match",
    not_in_hand: "You don't have that card",
    bad_color: 'Pick a colour',
    round_in_progress: 'Wait for the round to end',
    need_two_players: 'Two players are needed',
    not_playing: 'No round is being played',
    not_your_turn: 'Not your turn',
    not_seated: 'Take a seat first',
    already_seated: 'You already have a seat',
    no_free_seat: 'Every seat is taken',
    bad_action: 'The room did not understand that'
  })

  const table = $('table')
  const layer = $('fx')
  const fx = casino.stage(layer)
  const around = $('around')
  const podsEl = $('pods')
  const centre = $('centre')
  const deck = $('deck')
  const mat = $('mat')
  const pileEl = $('pile')
  const mineEl = $('mine')
  const handEl = $('hand')
  const colors = $('colors')
  const span = (className, text) => {
    const el = document.createElement('span')
    el.className = className
    if (text != null) el.textContent = text
    return el
  }

  // ── Reading a snapshot ────────────────────────────────────────────────────

  const playing = (view) => kindOf(view) === 'playing'
  const playerOf = (view, id) => view.round?.players.find((p) => same(p.client, id)) ?? null
  const seatedIn = (view, id) => view.seats.some((s) => same(s, id))
  const seatCount = (view) => view.seats.filter((s) => s != null).length
  const who = (id) => (same(id, room.you) ? 'You' : room.nameOf(id))
  const myTurn = (view) => playing(view) && same(view.round.turn, room.you)
  // Whether input can reach the room at all; a pending action does not count, so the hand does
  // not flicker while one is in flight.
  const live = () => room.connected && !room.closed
  const plural = (n) => `${n} card${n === 1 ? '' : 's'}`

  // The snapshot drawn last.
  let prev = null
  // The next snapshot is drawn without moves: the first one, and the first after a reconnect.
  let fresh = true
  // The result sheet the viewer closed, so it stays closed until another round ends.
  let dismissed = null
  // The wild card waiting on the colour picker.
  let choosing = null
  // The player whose shown hand a watcher has along the bottom.
  let watched = null
  // The hand along the bottom: { id, own, cards, shown } or null. `shown` lists who shows a hand.
  let bottom = null
  let handById = new Map()
  // The cards seen going onto the pile, the top one last: { card, tilt, dx, dy }.
  let pile = []
  // When the server plays for the player to move, who has left: server time, from when their turn
  // was first seen here.
  let awayUntil = null

  // ── Seats: a pod for each other player, and the viewer's own ──────────────

  const podOf = new WeakMap()
  // Client id -> the pod on the table now.
  let pods = new Map()
  // The seat along the bottom answers to the names a pod has; `id` is whose hand lies there.
  const mine = {
    id: null,
    el: mineEl,
    plate: $('my-plate'),
    name: $('my-name'),
    wins: $('my-wins'),
    n: $('my-count'),
    cards: handEl,
    avatar: null
  }
  mine.wins.innerHTML = `${TROPHY}<span></span>`

  function makePod(id) {
    const el = document.createElement('div')
    el.className = 'pod'
    el.innerHTML =
      '<div class="fan"><div class="fan-cards"></div><span class="pill fan-n"></span></div>' +
      '<div class="plate"><span class="avatar-wrap">' +
      `<span class="wins" title="Rounds won" hidden>${TROPHY}<span></span></span></span>` +
      '<span class="plate-name"><span></span></span>' +
      '<span class="tag" hidden>Away</span></div>'
    const q = (selector) => el.querySelector(selector)
    q('.avatar-wrap').prepend(room.avatarEl(id), casino.ring())
    podOf.set(el, {
      id: String(id),
      el,
      fan: q('.fan'),
      cards: q('.fan-cards'),
      n: q('.fan-n'),
      plate: q('.plate'),
      name: q('.plate-name'),
      wins: q('.wins'),
      ring: q('.ring'),
      tag: q('.tag'),
      avatar: `${id}/${room.avatarOf(id) ?? ''}`
    })
    return el
  }

  function openSeat() {
    const el = document.createElement('div')
    el.className = 'pod open'
    el.innerHTML =
      '<div class="seat"><span>Open seat</span>' +
      '<button class="btn primary sit" type="button">Sit</button></div>'
    return el
  }

  // The seat of a client at the table, or null: the viewer's own along the bottom, a pod for
  // anyone else. A hand a watcher follows is no seat; its player has a pod.
  const seatOf = (id) =>
    bottom?.own && same(bottom.id, id) ? mine : (pods.get(String(id)) ?? null)

  // The hand that lies along the bottom: the viewer's own when seated, else a hand a player
  // shows, the one the watcher picked or the first.
  function bottomOf(view) {
    const me = room.you
    if (seatedIn(view, me) || (playing(view) && playerOf(view, me))) {
      return { id: String(me), own: true, cards: playerOf(view, me)?.hand ?? null, shown: [] }
    }
    const shown = (view.round?.players ?? []).filter(
      (p) => p.hand && view.revealing?.some((c) => same(c, p.client))
    )
    if (!shown.length) return null
    const p = shown.find((x) => same(x.client, watched)) ?? shown[0]
    return {
      id: String(p.client),
      own: false,
      cards: p.hand,
      shown: shown.map((x) => String(x.client))
    }
  }

  // Puts a pod on the table for every other player, in the order of play after the viewer, and
  // an open seat when the viewer may take one. Returns the pods that are new.
  function place(view) {
    const ids = (
      playing(view) ? view.round.players.map((p) => p.client) : view.seats.filter((s) => s != null)
    ).map(String)
    const me = ids.findIndex((id) => same(id, room.you))
    const others = me < 0 ? ids : [...ids.slice(me + 1), ...ids.slice(0, me)]
    const open = !playing(view) && !seatedIn(view, room.you) && view.seats.some((s) => s == null)
    const keys = open ? [...others, 'open'] : others
    const { added } = casino.sync(podsEl, keys, (key) =>
      key === 'open' ? openSeat() : makePod(key)
    )
    pods = new Map()
    for (const el of podsEl.children) {
      const pod = podOf.get(el)
      if (pod) pods.set(pod.id, pod)
    }
    return added
  }

  // The name, the avatar and the marks beside them follow the client list and the newest snapshot.
  function identify(seat, view) {
    const id = seat.id
    const name = seat.name.firstElementChild
    const text = seat === mine && !bottom.own ? `${room.nameOf(id)}'s hand` : room.nameOf(id)
    if (name.textContent !== text) name.textContent = text
    const avatar = room.avatarOf(id) ?? ''
    const wrap = seat.plate.querySelector('.avatar-wrap')
    if (seat.avatar !== `${id}/${avatar}`) {
      seat.avatar = `${id}/${avatar}`
      wrap.querySelector('.avatar')?.remove()
      wrap.prepend(room.avatarEl(id))
    }
    // The crown sits on the avatar and the wins hang from it, so the name keeps the plate.
    const crown = wrap.querySelector('.crown')
    if (same(view.leader, id) && !crown) wrap.appendChild(casino.crown())
    if (!same(view.leader, id)) crown?.remove()
    const wins = view.wins?.[String(id)] ?? 0
    seat.wins.hidden = wins === 0
    seat.wins.lastElementChild.textContent = String(wins)
  }

  // The number beside a hand; nothing for no cards.
  function setCount(seat, n) {
    if (!seat) return
    seat.n.textContent = n ? (seat === mine ? plural(n) : String(n)) : ''
    if (seat === mine) seat.n.hidden = !n
  }

  function drawPod(pod, view) {
    const p = playerOf(view, pod.id)
    const count = p?.cards ?? 0
    // A hand is only sent for a player who shows it to watchers.
    const faces = p?.hand ? sorted(p.hand) : null
    const keys = faces
      ? faces.map((c) => `c${c.id}`)
      : Array.from({ length: Math.min(count, FAN_MAX) }, (_, i) => `b${i}`)
    const byKey = new Map((faces ?? []).map((c) => [`c${c.id}`, c]))
    casino.sync(pod.cards, keys, (key) => unofaces.card(byKey.get(key) ?? null))
    pod.fan.classList.toggle('open', !!faces)
    pod.fan.style.setProperty('--uno-n', String(keys.length))
    ;[...pod.cards.children].forEach((el, i) =>
      el.style.setProperty('--uno-i', String(i - (keys.length - 1) / 2))
    )
    identify(pod, view)
    setCount(pod, count)
    pod.tag.hidden = !p?.away
    pod.el.classList.toggle('away', !!p?.away)
    pod.el.classList.toggle('last', playing(view) && count === 1)
    pod.el.classList.toggle('won', kindOf(view) === 'over' && same(view.status.winner, pod.id))
    pod.el.classList.toggle('shown', !!faces)
    pod.el.classList.toggle('watched', !!faces && !!bottom && same(bottom.id, pod.id))
  }

  // Who the table shows as the one to move, with the clock of a player who has left (`clock`
  // false for a turn shown only until its move has played).
  function setTurn(view, id, clock = true) {
    for (const pod of pods.values()) {
      const acting = same(pod.id, id)
      pod.el.classList.toggle('acting', acting)
      const away = clock && acting && !!playerOf(view, pod.id)?.away
      casino.timer(pod.ring, away ? awayUntil : null, room.clockOffsetMs, AWAY_TURN_MS)
    }
    mineEl.classList.toggle('acting', !!bottom && same(bottom.id, id))
  }

  // ── Laying the table out ──────────────────────────────────────────────────

  // Places the pods around the top and the sides and gives the middle what is left: `a` pods
  // down each side and `b` across the top. Each split is scored on how large it leaves the pods
  // and the cards in the middle; among near equals the one closest to an even spread around the
  // edge wins.
  function fit() {
    const full = around.clientWidth
    const H = around.clientHeight
    if (!full || !H) return
    // A very wide table keeps its players within reach of the middle.
    const W = Math.min(full, Math.max(520, H * 2.4))
    // The table's unit, as style.css has it: a large table gets larger pods and cards.
    const u = Math.min(table.clientWidth, table.clientHeight * 1.7) / 100
    const largest = Math.max(1.3, Math.min(1.7, u * 0.12))
    const widest = Math.max(84, Math.min(112, u * 7.6))
    const left = (full - W) / 2
    const els = [...podsEl.children]
    const n = els.length
    const note = $('lobby').hidden ? 0 : $('lobby').offsetHeight + 8
    const options = []
    for (let a = 0; 2 * a <= n; a++) {
      const b = n - 2 * a
      const top = b > 0 ? 1 : 0
      let fits = largest
      if (b > 0) fits = Math.min(fits, (W - (b - 1) * POD_GAP) / (b * POD_W), (H * 0.4) / POD_H)
      if (a > 0) {
        const down = (H - (a - 1 + top) * POD_GAP) / ((a + top) * POD_H)
        fits = Math.min(fits, down, (W * 0.25) / POD_W)
      }
      const s = Math.max(0.5, fits)
      const x0 = a > 0 ? POD_W * s + POD_GAP : 0
      const y0 = b > 0 ? POD_H * s + POD_GAP : 0
      const cw = Math.max(22, Math.min(widest, (W - 2 * x0) / 4, (H - y0 - note) / 2.7))
      // Pods too small to read cost more than anything they leave room for.
      const score = Math.min(fits, 1) / 2 + Math.min(cw, 70) / 140 - Math.max(0, 0.55 - fits) * 3
      options.push({ a, b, s, x0, y0, cw, score })
    }
    const best = Math.max(...options.map((o) => o.score))
    const even = (n * H * 0.7) / (2 * H * 0.7 + W)
    const { a, b, s, x0, y0, cw } = options
      .filter((o) => o.score >= best - 0.04)
      .reduce((x, y) => (Math.abs(y.a - even) < Math.abs(x.a - even) ? y : x))
    const pw = POD_W * s
    els.forEach((el, i) => {
      let x
      let y
      if (i < a) {
        x = pw / 2
        y = y0 + ((H - y0) * (a - i - 0.5)) / a
      } else if (i < a + b) {
        x = (W * (i - a + 0.5)) / b
        y = (POD_H * s) / 2
      } else {
        x = W - pw / 2
        y = y0 + ((H - y0) * (i - a - b + 0.5)) / a
      }
      el.style.left = `${left + x}px`
      el.style.top = `${y}px`
    })

    centre.style.left = `${left + x0}px`
    centre.style.top = `${y0}px`
    centre.style.width = `${W - 2 * x0}px`
    centre.style.height = `${H - y0}px`
    table.style.setProperty('--uno-s', s.toFixed(3))
    table.style.setProperty('--uno-cw', `${cw.toFixed(1)}px`)
    around.classList.toggle('tight', s < 0.8)
  }

  // Lays the hand out in as few rows as keep every card's index in view; a row closes up to the
  // width there is, and each row lies over the lower half of the one above.
  function layHand() {
    const cards = [...handEl.children]
    const n = cards.length
    if (!n) {
      handEl.style.height = ''
      return
    }
    const W = handEl.clientWidth
    const cw = cards[0].offsetWidth
    const ch = cw * 1.4
    const need = cw * (cw >= 56 ? 0.36 : 0.5)
    const fits = Math.max(1, Math.floor((W - cw) / need) + 1)
    const rows = Math.min(3, Math.ceil(n / fits))
    const per = Math.ceil(n / rows)
    const lift = ch * 0.2
    cards.forEach((el, i) => {
      const row = Math.floor(i / per)
      const inRow = Math.min(per, n - row * per)
      const step = inRow > 1 ? Math.min(cw * 1.08, (W - cw) / (inRow - 1)) : 0
      const x0 = (W - (cw + (inRow - 1) * step)) / 2
      el.style.left = `${x0 + (i - row * per) * step}px`
      el.style.top = `${lift + row * ch * 0.5}px`
    })
    handEl.style.height = `${lift + ch + (rows - 1) * ch * 0.5}px`
  }

  // ── The middle ────────────────────────────────────────────────────────────

  // How a card lies on the pile, the same every time it is drawn.
  const lie = (card) => ({
    card,
    tilt: ((card.id * 47) % 25) - 12,
    dx: ((card.id * 31) % 9) - 4,
    dy: ((card.id * 17) % 7) - 3
  })

  // What lies on the mat before the first round: a card of each colour, fanned out. Their ids
  // are below any real card's.
  const SAMPLES = [
    { color: 'red', face: 'number', number: 7 },
    { color: 'yellow', face: 'skip' },
    { color: 'green', face: 'reverse' },
    { color: 'blue', face: 'draw_two' }
  ].map((card, i) => ({ card: { id: -1 - i, ...card }, tilt: i * 16 - 24, dx: i * 22 - 33, dy: 0 }))

  // Keeps the pile's memory in step with the snapshot: `d` is the change that led to it.
  function remember(view, d) {
    const top = view.round?.top
    if (!top) {
      pile = SAMPLES
      return
    }
    if (pile[pile.length - 1]?.card.id === top.id) {
      if (d?.reshuffled) pile = pile.slice(-1)
      return
    }
    const played = !!d && !d.fresh && d.steps.some((s) => s.kind === 'play')
    pile = played ? [...pile, lie(top)].slice(-PILE_MAX) : [lie(top)]
  }

  function setLive(color) {
    mat.dataset.color = color ?? ''
    const chip = $('live')
    chip.hidden = !color
    if (color && chip.dataset.color !== color) {
      chip.innerHTML = unofaces.mark(color)
      chip.append(unofaces.COLOR_NAMES[color])
    }
    chip.dataset.color = color ?? ''
  }

  function setDirection(direction) {
    if (direction) mat.dataset.dir = direction
    else delete mat.dataset.dir
  }

  function drawCentre(view) {
    const round = view.round
    const kind = kindOf(view)
    $('lobby').hidden = kind !== 'waiting'
    $('lobby-seats').textContent = `${seatCount(view)} of ${view.seats.length} seated`
    const left = round ? round.deck : DECK
    deck.classList.toggle('empty', left === 0)
    deck.classList.toggle('thin', left > 0 && left < 10)
    $('deck-n').textContent = round ? String(left) : ''

    const byId = new Map(pile.map((x) => [String(x.card.id), x]))
    casino.sync(
      pileEl,
      pile.map((x) => x.card.id),
      (key) => unofaces.card(byId.get(key).card)
    )
    // The snapshot has the top card only; the count says whether more lie under what is shown.
    pileEl.classList.toggle('deep', !!round && unosteps.discards(round) > pile.length)
    for (const el of pileEl.children) {
      const x = byId.get(el.dataset.key)
      el.style.setProperty('--uno-tilt', `${x.tilt}deg`)
      el.style.setProperty('--uno-dx', `${x.dx}%`)
      el.style.setProperty('--uno-dy', `${x.dy}%`)
    }
    setLive(round?.color ?? null)
    setDirection(kind === 'playing' ? round.direction : null)
  }

  // ── The hand along the bottom ─────────────────────────────────────────────

  function drawHand(view) {
    bottom = bottomOf(view)
    mineEl.hidden = !bottom
    if (!bottom) {
      handEl.replaceChildren()
      handById = new Map()
      return
    }
    // A hand of buttons for the viewer's own, of pictures for a hand a watcher is shown.
    const tag = bottom.own ? 'button' : 'div'
    if (handEl.dataset.tag !== tag) handEl.replaceChildren()
    handEl.dataset.tag = tag
    const cards = sorted(bottom.cards ?? [])
    handById = new Map(cards.map((c) => [String(c.id), c]))
    casino.sync(
      handEl,
      cards.map((c) => c.id),
      (key) => unofaces.card(handById.get(key), key, tag)
    )
    const p = playerOf(view, bottom.id)
    mine.id = bottom.id
    identify(mine, view)
    setCount(mine, p?.cards ?? 0)
    mineEl.classList.toggle('last', playing(view) && p?.cards === 1)
    mineEl.classList.toggle('won', kindOf(view) === 'over' && same(view.status.winner, bottom.id))
    $('hand-note').hidden = cards.length > 0
    $('hand-note').textContent = !bottom.own
      ? 'No cards left'
      : kindOf(view) === 'over' && p
        ? 'You are out of cards'
        : 'Your cards are dealt here'

    const watch = $('watch')
    watch.hidden = bottom.own || bottom.shown.length < 2
    if (!watch.hidden && watch.dataset.ids !== bottom.shown.join()) {
      watch.dataset.ids = bottom.shown.join()
      watch.replaceChildren(
        ...bottom.shown.map((id) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.dataset.watch = id
          b.title = `${room.nameOf(id)}'s hand`
          b.appendChild(room.avatarEl(id))
          return b
        })
      )
    }
    for (const b of watch.children) {
      b.setAttribute('aria-pressed', String(same(b.dataset.watch, bottom.id)))
    }
  }

  // ── The colour picker ─────────────────────────────────────────────────────

  function drawColors() {
    const card = choosing == null ? null : handEl.querySelector(`[data-key="${choosing}"]`)
    const was = colors.hidden
    colors.hidden = !card
    if (!card) return
    if (!colors.firstChild) {
      colors.append(
        ...unofaces.COLORS.map((color) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'swatch'
          b.dataset.color = color
          b.title = unofaces.COLOR_NAMES[color]
          b.setAttribute('aria-label', unofaces.COLOR_NAMES[color])
          b.innerHTML = `${unofaces.mark(color)}<b></b>`
          return b
        })
      )
    }
    for (const b of colors.children) {
      const held = [...handById.values()].filter((c) => c.color === b.dataset.color).length
      b.lastElementChild.textContent = held ? String(held) : ''
    }
    // Over the card being played, kept inside the table.
    const box = card.getBoundingClientRect()
    const area = table.getBoundingClientRect()
    const width = colors.offsetWidth
    const x = box.left + box.width / 2 - width / 2 - area.left
    const y = box.top - colors.offsetHeight - 10 - area.top
    colors.style.left = `${Math.min(Math.max(x, 6), area.width - width - 6)}px`
    colors.style.top = `${Math.max(y, 6)}px`
    if (was) fx.show(colors, { kind: 'pop', duration: 160 })
  }

  // ── The result ────────────────────────────────────────────────────────────

  function drawResults(view) {
    const over = kindOf(view) === 'over'
    const round = view.round
    const winner = over ? (view.status.winner ?? null) : null
    const key = over ? JSON.stringify([winner, round?.top.id, round?.players.length]) : null
    if (!over) dismissed = null
    const sheet = $('results')
    sheet.hidden = !over || dismissed === key
    sheet.dataset.key = key ?? ''
    if (sheet.hidden) return

    $('results-title').textContent =
      winner == null
        ? 'Round over'
        : same(winner, room.you)
          ? 'You win!'
          : `${room.nameOf(winner)} wins!`
    sheet.querySelector('.trophy').hidden = winner == null
    const rows = [...(round?.players ?? [])].sort(
      (x, y) => same(y.client, winner) - same(x.client, winner) || x.cards - y.cards
    )
    $('standings').replaceChildren(
      ...rows.map((p) => {
        const li = document.createElement('li')
        li.classList.toggle('first', same(p.client, winner))
        const won = span('won')
        won.innerHTML = TROPHY
        won.title = 'Rounds won'
        won.append(String(view.wins?.[String(p.client)] ?? 0))
        li.append(
          room.avatarEl(p.client),
          span('who', who(p.client)),
          span('left', p.cards === 0 ? 'Out' : `${plural(p.cards)} left`),
          won
        )
        return li
      })
    )
    const leader = view.leader
    const leads = same(leader, room.you)
    $('results-note').textContent = leads
      ? seatCount(view) < 2
        ? 'Two seated players are needed for another round'
        : ''
      : leader != null
        ? `${room.nameOf(leader)} can start the next round`
        : ''
    $('again').hidden = !leads
  }

  // ── The dock and every control ────────────────────────────────────────────

  function statusText(view) {
    const kind = kindOf(view)
    if (kind === 'waiting') {
      if (same(view.leader, room.you)) return 'Start when everyone is seated'
      return view.leader == null
        ? 'Waiting for players'
        : `Waiting for ${room.nameOf(view.leader)} to start`
    }
    if (kind === 'playing') {
      const turn = view.round.turn
      return same(turn, room.you) ? 'Your turn' : `${room.nameOf(turn)}'s turn`
    }
    const winner = view.status.winner
    if (winner == null) return 'Round over'
    return same(winner, room.you) ? 'You won' : `${room.nameOf(winner)} won`
  }

  // The line beside the viewer's plate.
  function hintText(view) {
    if (!bottom) return ''
    if (!bottom.own) return 'Shown to watchers'
    const kind = kindOf(view)
    const me = playerOf(view, room.you)
    if (kind === 'waiting') return seatCount(view) < 2 ? 'Waiting for another player' : ''
    if (kind === 'over') {
      if (!me) return 'You are in for the next round'
      return same(view.status.winner, room.you) ? 'You won the round' : ''
    }
    if (!me) return ''
    if (!myTurn(view)) return `Waiting for ${room.nameOf(view.round.turn)}`
    return me.hand?.some((c) => playable(c, view.round))
      ? 'Play a card, or draw one'
      : 'Nothing matches: draw a card'
  }

  // Always from the newest snapshot, never held back by a move.
  function drawControls() {
    const view = room.view
    if (!view) return
    const me = room.you
    const seated = seatedIn(view, me)
    const inRound = playing(view) && !!playerOf(view, me)
    const act = room.canAct()
    const turn = myTurn(view) && live()
    bridge.setBusy(inRound)

    $('status').textContent = statusText(view)
    $('watching').hidden = seated
    $('leave').hidden = !seated || playing(view)
    $('leave').disabled = !act
    const free = !seated && !playing(view) && view.seats.some((s) => s == null)
    $('sit').hidden = !free
    $('sit').disabled = !act
    for (const b of podsEl.querySelectorAll('.sit')) b.disabled = !act

    const leads = same(view.leader, me) && !playing(view)
    $('start').hidden = !leads
    $('start').textContent = kindOf(view) === 'over' ? 'Next round' : 'Start'
    $('start').disabled = $('again').disabled = !act || seatCount(view) < 2

    $('draw').hidden = !myTurn(view)
    $('draw').disabled = deck.disabled = !(turn && act)
    deck.classList.toggle('open', turn)
    deck.setAttribute('aria-label', turn ? 'Draw a card' : 'Deck')
    const stuck = turn && !playerOf(view, me)?.hand?.some((c) => playable(c, view.round))
    $('draw').classList.toggle('primary', !!stuck)

    $('reveal-row').hidden = !seated
    $('reveal').checked = !!view.revealing?.some((c) => same(c, me))
    $('reveal').disabled = !act

    // The picker lasts only while that card can still be played.
    if (choosing != null) {
      const card = bottom?.own ? handById.get(String(choosing)) : null
      if (!card || !turn || !act || !playable(card, view.round)) choosing = null
    }
    if (bottom?.own) {
      for (const el of handEl.children) {
        const card = handById.get(el.dataset.key)
        const ok = turn && playable(card, view.round)
        el.classList.toggle('playable', ok)
        el.classList.toggle('off', turn && !ok)
        el.classList.toggle('choosing', choosing === card.id)
        // Not `disabled`: a disabled button swallows the click that closes the colour picker.
        el.setAttribute('aria-disabled', String(!(ok && act)))
        el.tabIndex = ok && act ? 0 : -1
      }
    }
    $('hint').textContent = hintText(view)
    drawColors()
  }

  // ── Moves ─────────────────────────────────────────────────────────────────

  // Ends every move, the ones a move's end started included.
  function settle() {
    for (const id of cues) clearTimeout(id)
    cues.clear()
    for (let i = 0; i < 8 && fx.busy; i++) fx.snap()
  }

  // Sounds go by the clock alone, so moves that are cut short play none of what was left.
  const cues = new Set()
  function cue(name, delay = 0) {
    const id = setTimeout(() => {
      cues.delete(id)
      bridge.sound(name)
    }, delay)
    cues.add(id)
  }

  const POP = [
    { opacity: 0, transform: 'translate(-50%, -50%) scale(0.5)' },
    { opacity: 1, transform: 'translate(-50%, -50%) scale(1.12)', offset: 0.16 },
    { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.26 },
    { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.8 },
    { opacity: 0, transform: 'translate(-50%, -75%) scale(1)' }
  ]
  const BLINK = [
    { opacity: 0 },
    { opacity: 1, offset: 0.15 },
    { opacity: 1, offset: 0.8 },
    { opacity: 0 }
  ]

  // Shows `el` in `parent` for `ms` from `delay`, then takes it out.
  function pop(parent, el, delay, ms) {
    fx.at(delay, () => {
      parent.appendChild(el)
      el.animate(casino.motion.reduced ? BLINK : POP, { duration: ms, fill: 'both' })
      fx.at(ms, () => el.remove())
    })
  }

  // A word over a seat.
  function flash(seat, text, kind, delay = 0) {
    if (!seat) return
    fx.at(delay, () => seat.el.querySelector(':scope > .flash')?.remove())
    pop(seat.el, span(`flash ${kind}`, text), delay, 1200)
  }

  // A word over the middle of the table, or with `above` a smaller one on the mat's upper edge.
  function banner(text, kind, delay, ms, above = false) {
    const el = span(`banner ${kind}${above ? ' note' : ''}`, text)
    const base = layer.getBoundingClientRect()
    const mid = mat.getBoundingClientRect()
    el.style.left = `${mid.left + mid.width / 2 - base.left}px`
    el.style.top = `${mid.top + (above ? 0 : mid.height / 2) - base.top}px`
    pop(layer, el, delay, ms)
  }

  // Small pieces thrown over the table; make(i, base) gives each its start and its frames.
  function bits(n, make) {
    if (casino.motion.reduced) return
    const base = layer.getBoundingClientRect()
    const els = []
    let longest = 0
    for (let i = 0; i < n; i++) {
      const { x, y, frames, duration, delay = 0 } = make(i, base)
      const el = document.createElement('i')
      el.className = i % 3 === 0 ? 'bit round' : 'bit'
      el.style.left = `${x - base.left}px`
      el.style.top = `${y - base.top}px`
      el.style.background = BITS[i % BITS.length]
      layer.appendChild(el)
      el.animate(frames, {
        duration,
        delay,
        fill: 'both',
        easing: 'cubic-bezier(0.15, 0.7, 0.3, 1)'
      })
      els.push(el)
      longest = Math.max(longest, duration + delay)
    }
    fx.at(longest, () => els.forEach((el) => el.remove()))
  }

  function sparkle(target) {
    const r = target.getBoundingClientRect()
    const n = 26
    bits(n, (i) => {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5
      const reach = Math.max(r.width, 90) * (0.5 + Math.random() * 0.5)
      const dx = Math.cos(angle) * reach
      const dy = Math.sin(angle) * reach * 0.7
      const spin = Math.round((Math.random() - 0.5) * 540)
      return {
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        duration: 800 + Math.random() * 400,
        frames: [
          { transform: 'translate(-50%, -50%) scale(0.4)', opacity: 1 },
          {
            transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${spin}deg)`,
            opacity: 1,
            offset: 0.7
          },
          {
            transform: `translate(calc(-50% + ${dx * 1.08}px), calc(-50% + ${dy * 1.08 + 16}px)) rotate(${spin}deg)`,
            opacity: 0
          }
        ]
      }
    })
  }

  function confetti() {
    bits(80, (_i, base) => {
      const fall = base.height * (0.65 + Math.random() * 0.4)
      const drift = Math.round((Math.random() - 0.5) * 140)
      const spin = Math.round((Math.random() - 0.5) * 1080)
      return {
        x: base.left + Math.random() * base.width,
        y: base.top - 12,
        delay: Math.random() * 600,
        duration: 1700 + Math.random() * 1300,
        frames: [
          { transform: 'translate(0, 0) rotate(0deg)', opacity: 1 },
          { opacity: 1, offset: 0.8 },
          { transform: `translate(${drift}px, ${fall}px) rotate(${spin}deg)`, opacity: 0 }
        ]
      }
    })
  }

  // The colour in play goes out from the mat as a ring.
  function burst(color) {
    fx.pulse($('live'), 'bump')
    if (casino.motion.reduced || !color) return
    const base = layer.getBoundingClientRect()
    const r = mat.getBoundingClientRect()
    const el = document.createElement('i')
    el.className = 'burst'
    el.dataset.color = color
    el.style.left = `${r.left - base.left}px`
    el.style.top = `${r.top - base.top}px`
    el.style.width = `${r.width}px`
    el.style.height = `${r.height}px`
    layer.appendChild(el)
    el.animate(
      [
        { transform: 'scale(0.9)', opacity: 0.95 },
        { transform: 'scale(1.75)', opacity: 0 }
      ],
      { duration: 640, easing: 'ease-out', fill: 'both' }
    )
    fx.at(640, () => el.remove())
  }

  // The turn goes from one seat's plate to the next.
  function spark(from, to, delay) {
    if (!from || !to || from === to || casino.motion.reduced) return
    const dot = (seat) => {
      const r = seat.plate.getBoundingClientRect()
      const d = Math.max(14, r.height * 0.7)
      return new DOMRect(r.left + r.width / 2 - d / 2, r.top + r.height / 2 - d / 2, d, d)
    }
    const el = document.createElement('i')
    el.className = 'spark'
    fx.fly(el, { from: dot(from), to: dot(to), delay, duration: 380, wait: 'hidden', fade: 'out' })
  }

  // The degrees a card in a fan is turned by, for a copy that leaves it or lands on it.
  const turnOf = (el) =>
    el.closest('.fan:not(.open)') ? Number(el.style.getPropertyValue('--uno-i') || 0) * 5 : 0

  // Where an element lies, as the box it has before any turn.
  function flat(el) {
    const r = el.getBoundingClientRect()
    const w = el.offsetWidth
    const h = el.offsetHeight
    return new DOMRect(r.left + r.width / 2 - w / 2, r.top + r.height / 2 - h / 2, w, h)
  }

  // Marks a card the viewer has just drawn, once it has landed, for a moment.
  function markNew(id, delay) {
    setTimeout(() => {
      const el = handEl.querySelector(`[data-key="${id}"]`)
      if (!el) return
      el.classList.add('new')
      setTimeout(() => el.classList.remove('new'), 2400)
    }, delay)
  }

  // Before the table is redrawn: what leaves it in this change, with where it lies now.
  function measure(d) {
    const m = { sweep: [], from: null, spin: 0, faceUp: false }
    if (d.fresh) {
      const old = table.querySelectorAll('.fan .card, .hand .card, .pile .card')
      for (const el of [...old].slice(0, 60)) {
        m.sweep.push({ el: el.cloneNode(true), rect: flat(el) })
      }
    }
    const play = d.steps.find((s) => s.kind === 'play')
    if (play) {
      const seat = seatOf(play.client)
      const el =
        seat === mine
          ? handEl.querySelector(`[data-key="${play.card.id}"]`)
          : (seat?.cards.querySelector(`[data-key="c${play.card.id}"]`) ??
            seat?.cards.lastElementChild)
      m.from = el ? flat(el) : (seat?.plate.getBoundingClientRect() ?? null)
      m.spin = el ? turnOf(el) : 0
      m.faceUp = !!el && !el.classList.contains('down')
    }
    return m
  }

  // Where a card dealt or drawn lands: the card's own element when the viewer is shown it, else
  // the back at `index` in the fan.
  function landing(seat, card, index) {
    if (seat === mine) return card ? handEl.querySelector(`[data-key="${card.id}"]`) : null
    if (card) return seat.cards.querySelector(`[data-key="c${card.id}"]`)
    return seat.cards.querySelector(`[data-key="b${index}"]`)
  }

  // A card comes from the deck to `client`: onto its place in that seat, or out of sight into the
  // seat when the fan shows no more backs. A hand a watcher follows shows the card as it lands at
  // the player's pod.
  function arrive(client, card, index, at, duration) {
    const from = $('deck-top')
    const seat = seatOf(client)
    const el = seat ? landing(seat, card, index) : null
    if (el) {
      fx.fly(el, {
        from,
        match: true,
        spin: 10,
        tilt: turnOf(el),
        turn: el.classList.contains('down') ? null : 'onway',
        delay: at,
        duration
      })
    } else if (seat) {
      const to = seat.cards.lastElementChild ?? seat.plate
      fx.fly(unofaces.card(null), {
        from,
        to,
        match: to !== seat.plate,
        delay: at,
        duration,
        wait: 'hidden',
        fade: 'out'
      })
    }
    if (card && bottom && !bottom.own && same(bottom.id, client)) {
      const shown = handEl.querySelector(`[data-key="${card.id}"]`)
      if (shown) fx.from(shown, { opacity: 0 }, { delay: at + duration - 60, duration: 160 })
    }
  }

  function reshuffle(t) {
    const from = pileEl.getBoundingClientRect()
    for (let i = 0; i < 5; i++) {
      fx.fly(unofaces.card(null), {
        from,
        to: $('deck-top'),
        match: true,
        delay: t + i * 70,
        duration: 340,
        wait: 'hidden'
      })
    }
    cue('shuffle', t)
    banner('Reshuffle', '', t, 900, true)
  }

  // A new round: the old cards go back to the deck, it is shuffled, every hand is dealt a card at
  // a time, and the first card is turned onto the pile.
  function deal(view, d, m) {
    const round = view.round
    let t = 0
    if (m.sweep.length) {
      m.sweep.forEach(({ el, rect }, i) =>
        fx.fly(el, {
          from: rect,
          to: $('deck-top'),
          match: true,
          delay: Math.min(i * 8, 160),
          duration: 340,
          fade: 'out'
        })
      )
      cue('slide', 40)
      t = 460
    }
    cue('shuffle', t)
    fx.pulse(deck, 'shake', { delay: t, duration: 420 })
    t += 560

    const total = d.deal.length
    const gap = Math.max(26, Math.min(95, 2000 / Math.max(1, total)))
    const every = Math.max(1, Math.ceil(120 / gap))
    d.deal.forEach(({ client, card, index }, k) => {
      arrive(client, card, index, t + k * gap, 340)
      if (k % every === 0) cue('deal', t + k * gap)
    })
    const dealt = total * gap
    for (const p of round.players) {
      const seat = seatOf(p.client)
      if (!seat) continue
      fx.count(seat.n, 0, p.cards, {
        delay: t,
        duration: dealt,
        format: seat === mine ? plural : String
      })
    }
    fx.count($('deck-n'), DECK, round.deck, { delay: t, duration: dealt, format: String })

    const top = pileEl.lastElementChild
    const land = t + dealt + 140 + FLY_MS
    if (top) {
      fx.fly(top, {
        from: $('deck-top'),
        match: true,
        spin: 10,
        tilt: pile[pile.length - 1].tilt,
        turn: 'onway',
        delay: land - FLY_MS,
        duration: FLY_MS
      })
    }
    cue('place', land - 70)
    setLive(null)
    setDirection(null)
    setTurn(view, null)
    table.classList.add('dealing')
    fx.at(land, () => {
      table.classList.remove('dealing')
      setLive(round.color)
      setDirection(round.direction)
      burst(round.color)
    })
    fx.at(land + 260, () => {
      setTurn(view, round.turn)
      const seat = seatOf(round.turn)
      flash(seat, seat === mine ? 'You start' : 'Starts', 'gold')
    })
  }

  function moves(view, d, m) {
    if (d.fresh) return deal(view, d, m)
    if (!d.steps.length) return
    const before = prev.round
    const round = view.round
    const had = (id) => before.players.find((p) => same(p.client, id))?.cards ?? 0
    let t = 0

    for (const step of d.steps) {
      const seat = step.client != null ? seatOf(step.client) : null
      if (step.kind === 'play') {
        const top = pileEl.lastElementChild
        const land = t + FLY_MS
        if (top && m.from) {
          fx.fly(top, {
            from: m.from,
            match: true,
            spin: m.spin,
            tilt: pile[pile.length - 1].tilt,
            turn: m.faceUp ? null : 'onway',
            delay: t,
            duration: FLY_MS
          })
        }
        cue('place', land - 70)
        setLive(step.was)
        fx.at(land, () => {
          setLive(step.color)
          if (step.color !== step.was) burst(step.color)
          if (top) fx.pulse(top, 'bump', { duration: 220 })
        })
        t = land
      } else if (step.kind === 'last') {
        seat?.el.classList.remove('last')
        fx.at(t, () => {
          seat?.el.classList.add('last')
          flash(seat, 'Last card!', 'gold')
        })
      } else if (step.kind === 'reverse') {
        setDirection(before.direction)
        fx.at(t, () => {
          setDirection(step.direction)
          // The arrows turn over to go the other way.
          fx.from(
            $('orbit'),
            { transform: `scaleX(${step.direction === 'backward' ? 1 : -1})` },
            { duration: 460, easing: 'ease-in-out' }
          )
        })
        banner('Reverse', '', t, 850, true)
        t += 260
      } else if (step.kind === 'skip') {
        fx.at(t, () => {
          flash(seat, 'Skipped', 'bad')
          if (seat) fx.pulse(seat.plate, 'shake')
        })
        t += 220
      } else if (step.kind === 'draw') {
        const n = step.cards.length
        const start = had(step.client)
        if (!n) {
          fx.at(t, () => flash(seat, 'No cards left', ''))
          continue
        }
        if (d.reshuffled) {
          reshuffle(t)
          t += 520
        }
        const forced = step.why !== 'turn'
        if (forced) {
          fx.at(t, () => {
            flash(seat, `+${n}`, 'bad')
            if (seat) fx.pulse(seat.plate, 'shake')
          })
        }
        setCount(seat, start)
        fx.count($('deck-n'), d.reshuffled ? round.deck + n : before.deck, round.deck, {
          delay: t,
          duration: n * DRAW_GAP_MS,
          format: String
        })
        step.cards.forEach((card, i) => {
          const at = t + i * DRAW_GAP_MS
          arrive(step.client, card, start + i, at, FLY_MS)
          cue('deal', at)
          fx.at(at + FLY_MS, () => {
            setCount(seat, start + i + 1)
            if (seat) fx.pulse(seat.n, 'bump', { duration: 200 })
          })
          if (seat === mine && card) markNew(card.id, at + FLY_MS)
        })
        t += (n - 1) * DRAW_GAP_MS + FLY_MS
      } else if (step.kind === 'win') {
        fx.at(t, () => {
          if (step.client == null) return banner('Round over', '', 0, 1300)
          banner(seat === mine ? 'You win!' : `${room.nameOf(step.client)} wins!`, 'gold', 0, 1700)
          if (seat) {
            sparkle(seat.plate)
            fx.pulse(seat.plate, 'bump')
          }
          confetti()
        })
        const sheet = $('results')
        if (!sheet.hidden) {
          fx.from(sheet, { opacity: 0 }, { delay: t + 1500, duration: 260 })
          fx.from(
            sheet.firstElementChild,
            { opacity: 0, transform: 'scale(0.8)' },
            { delay: t + 1500, duration: 320 }
          )
        }
      }
    }

    // The turn stays where it was until everything has played, then goes on.
    setTurn(view, d.was, false)
    fx.at(t, () => setTurn(view, d.turn))
    if (d.turn != null) spark(seatOf(d.was), seatOf(d.turn), Math.max(0, t - 160))
  }

  function drawSnapshot(view) {
    settle()
    const a = fresh ? null : prev
    fresh = false
    const d = a ? unosteps.diff(a, view) : null
    const m = d ? measure(d) : null
    const slide = a ? fx.mark(table.querySelectorAll('.hand .card, .pod')) : null

    // The clock of a player who has left runs from when their turn is first seen.
    const turn = playing(view) ? view.round.turn : null
    const gone = turn != null && !!playerOf(view, turn)?.away
    const held = a && playing(a) && same(a.round.turn, turn) && !!playerOf(a, turn)?.away
    if (!gone) awayUntil = null
    else if (!held || awayUntil == null) {
      awayUntil = Date.now() + room.clockOffsetMs + AWAY_TURN_MS
    }

    remember(view, d)
    drawHand(view)
    const added = place(view)
    for (const pod of pods.values()) drawPod(pod, view)
    drawCentre(view)
    setTurn(view, turn)
    drawResults(view)
    drawControls()
    $('game').hidden = false
    layHand()
    fit()
    drawColors()

    if (a) for (const el of added) fx.show(el, { kind: 'pop', duration: 240 })
    if (d) {
      // The moves first: they measure where things lie, which a slide in progress would shift.
      moves(view, d, m)
    }
    slide?.()
    prev = view
  }

  // Draws the snapshot again as it is, with no moves: the watcher picked another hand.
  function redraw() {
    fresh = true
    if (room.view) drawSnapshot(room.view)
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  const sends = { leave: 'stand', sit: 'sit', start: 'start', again: 'start' }
  for (const [id, type] of Object.entries(sends)) {
    $(id).addEventListener('click', () => room.send({ type }))
  }
  const draw = () => {
    if (room.view && myTurn(room.view)) room.send({ type: 'draw' })
  }
  $('draw').addEventListener('click', draw)
  deck.addEventListener('click', draw)
  $('reveal').addEventListener('change', () => {
    const on = $('reveal').checked
    // The box shows the server's state; the click only asks for the change.
    $('reveal').checked = !on
    room.send({ type: 'reveal', on })
  })

  // One handler for the hand, the colour picker, the seats and a click anywhere else.
  document.addEventListener('click', (event) => {
    const view = room.view
    if (!view) return
    const swatch = event.target.closest('.swatch')
    if (swatch && choosing != null) {
      const card = choosing
      choosing = null
      room.send({ type: 'play', card, color: swatch.dataset.color })
      drawControls()
      return
    }
    if (choosing != null) {
      choosing = null
      drawControls()
      return
    }
    if (event.target.closest('.pod .sit')) return room.send({ type: 'sit' })
    const pick = event.target.closest('[data-watch]') ?? event.target.closest('.pod.shown')
    if (pick) {
      watched = pick.dataset.watch ?? pick.dataset.key
      return redraw()
    }
    const el = event.target.closest('.hand button.card')
    if (!el || !myTurn(view) || !room.canAct()) return
    const card = handById.get(el.dataset.key)
    if (!card || !playable(card, view.round)) return
    if (card.color == null) {
      choosing = card.id
      drawControls()
      colors.querySelector('.swatch')?.focus()
      return
    }
    room.send({ type: 'play', card: card.id })
  })

  $('help').addEventListener('click', () => ($('rules').hidden = !$('rules').hidden))
  $('rules-close').addEventListener('click', () => ($('rules').hidden = true))
  $('results-close').addEventListener('click', () => {
    dismissed = $('results').dataset.key
    $('results').hidden = true
  })
  for (const sheet of [$('rules'), $('results')]) {
    sheet.addEventListener('click', (event) => {
      if (event.target !== sheet) return
      if (sheet.id === 'results') dismissed = sheet.dataset.key
      sheet.hidden = true
    })
  }
  addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      $('rules').hidden = true
      if (choosing != null && room.view) {
        choosing = null
        drawControls()
      }
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return
    if (!$('rules').hidden || $('draw').hidden) return
    if (event.key.toLowerCase() === 'd') $('draw').click()
  })

  for (const [cards, name, text] of LEGEND) {
    const dt = document.createElement('dt')
    dt.append(...cards.map((c) => unofaces.card(c)))
    const dd = document.createElement('dd')
    const b = document.createElement('b')
    b.textContent = name
    dd.append(b, text)
    $('legend').append(dt, dd)
  }
  for (const color of unofaces.COLORS) {
    const chip = span(`shape ${color}`)
    chip.innerHTML = unofaces.mark(color)
    chip.append(unofaces.COLOR_NAMES[color])
    $('shapes').appendChild(chip)
  }

  new ResizeObserver(() =>
    requestAnimationFrame(() => {
      layHand()
      fit()
      drawColors()
    })
  ).observe(table)

  room.onRender(() => {
    if (!room.connected) fresh = true
    const view = room.view
    if (!view) return
    if (view !== prev) drawSnapshot(view)
    else {
      for (const pod of pods.values()) identify(pod, view)
      if (bottom) identify(mine, view)
      drawControls()
    }
  })
})()
