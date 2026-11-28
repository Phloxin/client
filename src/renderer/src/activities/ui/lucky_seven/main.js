// Lucky Seven, a push-your-luck card game for 2 to 10 seats. Draws each snapshot on the casino
// helpers (cards.js): a board per player with its cards kept by key, the piles, the action card
// waiting for a target, and the moves the change from the snapshot before calls for, in the order
// steps.js works out. The dock sends sit, stand, start, hit, stay and choose.
/* global bridge, room, casino, l7faces, l7steps */
;(() => {
  const $ = (id) => document.getElementById(id)
  const { same, kindOf, inGame, tally, arrange, repeats, GOAL, SEVEN } = l7steps
  const TURN_MS = 30000
  const AWAY_TURN_MS = 3000
  const NEXT_ROUND_MS = 5000
  const FLY_MS = 400
  // How long a card that is on its way out is shown before it goes.
  const LEAVE_MS = 520
  const BITS = ['#f3c552', '#86d4ff', '#ff7fa8', '#46d483', '#ff8a4a', '#ffffff']
  const TROPHY =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10v2h3v3a4 4 0 0 1-3.4 3.95A5 5 0 0 1 13 14.9V18h3v3H8v-3h3v-3.1a5 5 0 0 1-3.6-2.95A4 4 0 0 1 4 8V5h3zm0 4H6v1a2 2 0 0 0 1 1.73zm10 0v2.73A2 2 0 0 0 18 8V7z"/></svg>'
  const POINTS = { active: '', stayed: 'banked', frozen: 'iced', busted: 'bust', seven: 'gold' }
  const LEGEND = [
    [
      [
        { face: 'number', value: 3 },
        { face: 'number', value: 7 },
        { face: 'number', value: 12 }
      ],
      'Numbers 0 to 12',
      'Worth their value. There are twelve 12s, eleven 11s and so on down to one 1 and one 0.'
    ],
    [
      [
        { face: 'plus', value: 4 },
        { face: 'double', value: null }
      ],
      'Bonus cards',
      '+2 to +10 add to your round. ×2 doubles your numbers first.'
    ],
    [
      [{ face: 'freeze' }],
      'Freeze',
      'Whoever flips it picks a player still in the round, themselves included. That player banks their points and is out.'
    ],
    [
      [{ face: 'flip_three' }],
      'Flip 3',
      'Whoever flips it picks a player who must take the next three cards.'
    ],
    [
      [{ face: 'second_chance' }],
      'Second Chance',
      'Cancels one repeated number, then it is gone. You hold one at most; a second goes to another player.'
    ]
  ]

  room.rejections({
    game_in_progress: 'Wait for the game to end',
    not_playing: 'No round is being played',
    not_your_turn: 'Not your turn',
    not_your_choice: 'That card is not yours to play',
    bad_target: "You can't pick that player",
    not_leader: 'Only the leader can start',
    need_two_players: 'Two players are needed',
    not_seated: 'Take a seat first',
    already_seated: 'You already have a seat',
    no_free_seat: 'Every seat is taken',
    bad_action: 'The room did not understand that'
  })

  const table = $('table')
  const layer = $('fx')
  const fx = casino.stage(layer)
  const grid = $('others-grid')
  const mineEl = $('mine')
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
  const totalOf = (view, id) => view.totals?.[String(id)] ?? null
  const isAway = (view, id) => !!view.away?.some((c) => same(c, id))
  const choiceOf = (view) => (playing(view) ? (view.round.choice ?? null) : null)
  const waitingOn = (view) => (playing(view) ? (view.round.choice?.by ?? view.round.turn) : null)
  const who = (id) => (same(id, room.you) ? 'You' : room.nameOf(id))

  // The snapshot drawn last.
  let prev = null
  // The next snapshot is drawn without moves: the first one, and the first after a reconnect.
  let fresh = true
  // The result sheet the viewer closed, so it stays closed until another game ends.
  let dismissed = null
  let choosingKey = ''

  // ── Boards ────────────────────────────────────────────────────────────────

  const boardOf = new WeakMap()
  // Client id -> the board on the table now.
  let boards = new Map()

  function makeBoard(id) {
    const el = document.createElement('div')
    el.className = 'board'
    el.innerHTML =
      '<div class="board-in"><div class="board-head"><span class="avatar-wrap"></span>' +
      '<span class="board-name"><span></span>' +
      '<span class="dealer-chip" title="Dealer" hidden>D</span>' +
      `<span class="board-wins" title="Games won" hidden>${TROPHY}<span></span></span></span>` +
      '<span class="board-total" hidden><b></b><i>/200</i></span></div>' +
      '<div class="meter"><i class="meter-next"></i><i class="meter-fill"></i></div>' +
      '<div class="board-cards"><div class="numbers"><div class="slots"></div>' +
      '<div class="nums"></div></div><div class="board-foot"><div class="extras"></div>' +
      '<span class="sum"></span><span class="pill points" hidden></span></div>' +
      '</div><span class="frost"></span>' +
      '<span class="tag" hidden>Away</span>' +
      '<button class="pick" type="button" hidden><span></span></button></div>'
    const q = (selector) => el.querySelector(selector)
    for (let i = 0; i < SEVEN; i++) q('.slots').appendChild(span('slot'))
    q('.avatar-wrap').append(room.avatarEl(id), casino.ring())
    boardOf.set(el, {
      id: String(id),
      el,
      panel: q('.board-in'),
      name: q('.board-name'),
      dealer: q('.dealer-chip'),
      wins: q('.board-wins'),
      total: q('.board-total'),
      totalN: q('.board-total b'),
      fill: q('.meter-fill'),
      next: q('.meter-next'),
      nums: q('.nums'),
      extras: q('.extras'),
      sum: q('.sum'),
      points: q('.points'),
      ring: q('.ring'),
      tag: q('.tag'),
      pick: q('.pick'),
      avatar: room.avatarOf(id) ?? ''
    })
    return el
  }

  function openSeat() {
    const el = document.createElement('div')
    el.className = 'board open'
    el.innerHTML =
      '<div class="board-in"><span>Open seat</span>' +
      '<button class="btn primary sit" type="button">Sit</button></div>'
    return el
  }

  // Picks the columns and rows for the other boards that leave their cards largest: a board's
  // card is as wide as a seventh of its cell allows and as tall as its row allows (the numbers
  // here follow `.board-in` in style.css).
  function fit() {
    const n = Number(grid.dataset.n) || 0
    const box = $('others')
    const gap = parseFloat(getComputedStyle(grid).columnGap) || 8
    const width = (cols) => (Math.min(460, (box.offsetWidth + gap) / cols - gap) - 14) / 7.5
    let best = { cols: 1, rows: Math.max(1, n), cw: 0 }
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols)
      const cw = Math.min(58, width(cols), ((box.offsetHeight + gap) / rows - gap - 68) / 2.56)
      if (cw > best.cw + 0.5) best = { cols, rows, cw }
    }
    // Too many to fit: as many columns as keep a card readable, and the grid scrolls.
    if (best.cw < 15) {
      let cols = 1
      while (cols < n && width(cols + 1) >= 15) cols++
      best = { cols, rows: Math.ceil(n / cols) }
    }
    grid.style.setProperty('--l7-cols', String(best.cols))
    grid.style.setProperty('--l7-rows', String(best.rows))
  }

  // Puts a board on the table for every player: the viewer's own along the bottom, the others in
  // the order of play after it. Returns the boards that are new.
  function place(view) {
    const ids = (
      inGame(view) ? view.round.players.map((p) => p.client) : view.seats.filter((s) => s != null)
    ).map(String)
    const me = ids.findIndex((id) => same(id, room.you))
    const others = me < 0 ? ids : [...ids.slice(me + 1), ...ids.slice(0, me)]
    const open = !inGame(view) && view.seats.some((s) => s == null)
    const keys = open ? [...others, 'open'] : others
    const a = casino.sync(grid, keys, (key) => (key === 'open' ? openSeat() : makeBoard(key)))
    const b = casino.sync(mineEl, me < 0 ? [] : [ids[me]], makeBoard)
    grid.dataset.n = String(keys.length)
    table.classList.toggle('seated', me >= 0)
    table.classList.toggle('crowded', me >= 0 && keys.length > 4)
    fit()
    boards = new Map()
    for (const el of [...grid.children, ...mineEl.children]) {
      const board = boardOf.get(el)
      if (board) boards.set(board.id, board)
    }
    return [...a.added, ...b.added]
  }

  // The name, the avatar and the marks beside them follow the client list and the newest snapshot.
  function identify(b, view) {
    const name = b.name.firstElementChild
    if (name.textContent !== room.nameOf(b.id)) name.textContent = room.nameOf(b.id)
    const avatar = room.avatarOf(b.id) ?? ''
    if (b.avatar !== avatar) {
      b.avatar = avatar
      b.el.querySelector('.avatar').replaceWith(room.avatarEl(b.id))
    }
    const crown = b.name.querySelector('.crown')
    if (same(view.leader, b.id) && !crown) b.name.insertBefore(casino.crown(), b.dealer)
    if (!same(view.leader, b.id)) crown?.remove()
    b.dealer.hidden = !(inGame(view) && same(view.round.dealer, b.id))
    b.tag.hidden = !isAway(view, b.id)
    const wins = view.wins?.[b.id] ?? 0
    b.wins.hidden = wins === 0
    b.wins.lastElementChild.textContent = String(wins)
  }

  const scale = (n) => `scaleX(${Math.max(0, Math.min(1, n / GOAL))})`

  function pointsText(state, score) {
    if (state === 'stayed') return `Stayed ${score}`
    if (state === 'frozen') return `Frozen ${score}`
    if (state === 'seven') return `Lucky 7 · ${score}`
    if (state === 'busted') return 'Bust'
    return String(score)
  }

  // The sum behind the points, for the viewer's own board.
  function sumText(t, state, score) {
    if (state === 'busted') return ''
    const parts = [String(t.sum)]
    for (let i = 0; i < t.doubles; i++) parts.push('×2')
    if (t.plus) parts.push(`+${t.plus}`)
    if (t.bonus) parts.push(`+${t.bonus}`)
    const count = `${t.unique} of ${SEVEN}`
    return parts.length > 1 ? `${count} · ${parts.join(' ')} = ${score}` : count
  }

  // Writes a hand on a board's labels: `hand` is { cards, state, score } or null for a seat with
  // no hand, `base` the total the meter stands on (null for none), `pending` whether the hand's
  // points are still to be added to it. The cards themselves are placed by drawBoard.
  function paint(b, hand, base, pending) {
    const state = hand?.state ?? 'active'
    const t = tally(hand?.cards ?? [], state)
    const score = hand?.score ?? t.total
    b.el.dataset.state = state
    const twice = state === 'busted' ? repeats(hand.cards) : null
    for (const el of b.nums.children) {
      el.classList.toggle('dup', !!twice?.has(Number(el.dataset.value)))
    }
    b.points.hidden = !hand
    b.points.className = `pill points ${POINTS[state]}`
    b.points.textContent = pointsText(state, score)
    b.sum.textContent = hand ? sumText(t, state, score) : ''
    b.total.hidden = base == null
    b.totalN.textContent = String(base ?? 0)
    b.fill.style.transform = scale(base ?? 0)
    b.next.style.transform = scale((base ?? 0) + (pending ? score : 0))
  }

  function drawBoard(b, view) {
    const p = playerOf(view, b.id)
    const cards = p?.cards ?? []
    const byId = new Map(cards.map((c) => [String(c.id), c]))
    const { numbers, extras } = arrange(cards)
    const make = (key) => l7faces.card(byId.get(key))
    casino.sync(
      b.nums,
      numbers.map((c) => c.id),
      make
    )
    casino.sync(
      b.extras,
      extras.map((c) => c.id),
      make
    )
    b.extras.style.setProperty('--n', String(extras.length))
    identify(b, view)
    paint(b, p, totalOf(view, b.id), playing(view))
    const acting = same(waitingOn(view), b.id)
    b.el.classList.toggle('acting', acting)
    casino.timer(
      b.ring,
      acting ? (view.round.until_ms ?? null) : null,
      room.clockOffsetMs,
      isAway(view, b.id) ? AWAY_TURN_MS : TURN_MS
    )
  }

  // ── The middle ────────────────────────────────────────────────────────────

  const bars = new WeakMap()

  // Runs a bar down to `untilMs` (server time) as a share of `totalMs`; null stops it.
  function runBar(el, untilMs, totalMs) {
    bars.get(el)?.cancel()
    bars.delete(el)
    if (untilMs == null) return
    const left = Math.max(0, untilMs - (Date.now() + room.clockOffsetMs))
    const total = Math.max(totalMs, left, 1)
    const anim = el.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], {
      duration: total,
      fill: 'both',
      easing: casino.motion.reduced ? `steps(${Math.max(1, Math.round(total / 1000))})` : 'linear'
    })
    anim.currentTime = total - left
    bars.set(el, anim)
  }

  function drawMiddle(view) {
    const kind = kindOf(view)
    const round = view.round
    const choice = choiceOf(view)
    $('lobby').hidden = kind !== 'waiting'
    $('round').hidden = kind === 'waiting' || kind === 'scoring' || !!choice
    $('round-n').textContent = kind === 'over' ? 'Game over' : `Round ${round?.number ?? 1}`
    $('next').hidden = kind !== 'scoring'
    $('next-text').textContent = `Round ${round?.number ?? 1} over`
    runBar($('next-fill'), kind === 'scoring' ? (round.until_ms ?? null) : null, NEXT_ROUND_MS)

    $('play').hidden = !choice
    casino.sync($('play-slot'), choice ? [choice.card.id] : [], () => l7faces.card(choice.card))
    table.dataset.pick = choice ? choice.card.face : ''
    if (choice) {
      const kinds = l7faces.kinds[choice.card.face]
      $('play-text').textContent = same(choice.by, room.you)
        ? kinds.ask
        : `${room.nameOf(choice.by)} ${kinds.asking}`
    }

    $('deck').classList.toggle('has', view.deck > 0 || kind === 'waiting')
    $('deck-n').textContent = round ? String(view.deck) : ''
    $('discard').classList.toggle('has', view.discard > 0)
    $('discard-n').textContent = view.discard > 0 ? String(view.discard) : ''
  }

  // ── The result ────────────────────────────────────────────────────────────

  function drawResults(view) {
    const over = kindOf(view) === 'over'
    const key = over ? JSON.stringify([view.status.winner, view.totals]) : null
    if (!over) dismissed = null
    const sheet = $('results')
    sheet.hidden = !over || dismissed === key
    sheet.dataset.key = key ?? ''
    if (sheet.hidden) return

    const winner = view.status.winner ?? null
    $('results-title').textContent =
      winner == null
        ? 'Game over'
        : same(winner, room.you)
          ? 'You win!'
          : `${room.nameOf(winner)} wins!`
    sheet.querySelector('.trophy').hidden = winner == null
    const rows = Object.entries(view.totals ?? {}).sort(
      ([a, x], [b, y]) => same(b, winner) - same(a, winner) || y - x
    )
    $('standings').replaceChildren(
      ...rows.map(([id, total], i) => {
        const li = document.createElement('li')
        li.classList.toggle('first', same(id, winner))
        li.append(
          span('rank', String(i + 1)),
          room.avatarEl(id),
          span('who', who(id)),
          span('score', String(total))
        )
        return li
      })
    )
    const leader = view.leader
    const mine = same(leader, room.you)
    $('results-note').textContent = mine
      ? seatCount(view) < 2
        ? 'Two seated players are needed for another game'
        : ''
      : leader != null
        ? `${room.nameOf(leader)} can start another game`
        : ''
    $('again').hidden = !mine
  }

  // ── The dock and every control ────────────────────────────────────────────

  function statusText(view) {
    const kind = kindOf(view)
    if (kind === 'waiting') {
      if (seatCount(view) < 2) return 'Waiting for players'
      return same(view.leader, room.you)
        ? 'Ready when you are'
        : `Waiting for ${room.nameOf(view.leader)} to start`
    }
    if (kind === 'scoring') return `Round ${view.round.number} over`
    if (kind === 'over') {
      const winner = view.status.winner
      if (winner == null) return 'Game over'
      return same(winner, room.you) ? 'You win!' : `${room.nameOf(winner)} wins!`
    }
    const choice = view.round.choice
    if (choice) {
      const kinds = l7faces.kinds[choice.card.face]
      return same(choice.by, room.you) ? kinds.ask : `${room.nameOf(choice.by)} ${kinds.asking}`
    }
    const turn = view.round.turn
    if (turn == null) return ''
    return same(turn, room.you) ? 'Your turn' : `${room.nameOf(turn)}'s turn`
  }

  // The line in place of the buttons while the viewer has nothing to press.
  function idleText(view, mine) {
    const kind = kindOf(view)
    if (kind === 'waiting' || kind === 'over') {
      if (seatCount(view) < 2) return 'Waiting for another player to sit'
      return same(view.leader, room.you)
        ? 'Start the game when everyone is seated'
        : `${room.nameOf(view.leader)} starts the game`
    }
    if (!mine) return ''
    if (mine.state === 'busted') return 'You busted this round'
    if (mine.state === 'stayed') return `You stayed on ${mine.score}`
    if (mine.state === 'frozen') return `You were frozen on ${mine.score}`
    if (mine.state === 'seven') return `Lucky Seven! ${mine.score} points`
    if (kind === 'scoring') return `You scored ${mine.score} this round`
    const on = waitingOn(view)
    return on == null ? '' : `Waiting for ${room.nameOf(on)}`
  }

  function drawTargets(choice, act) {
    const key = choice ? `${choice.card.id}/${choice.targets.join()}/${act}` : ''
    if (key === choosingKey) return
    choosingKey = key
    const box = $('choosing')
    if (!choice) return box.replaceChildren()
    box.replaceChildren(
      ...choice.targets.map((id) => {
        const b = document.createElement('button')
        b.type = 'button'
        b.className = 'btn target'
        b.dataset.target = String(id)
        b.disabled = !act
        b.append(room.avatarEl(id), who(id))
        return b
      })
    )
  }

  // Always from the newest snapshot, never held back by a move.
  function drawControls() {
    const view = room.view
    if (!view) return
    const me = room.you
    const seated = seatedIn(view, me)
    const mine = inGame(view) ? playerOf(view, me) : null
    const act = room.canAct()
    const choice = choiceOf(view)
    const myChoice = !!choice && same(choice.by, me)
    const myTurn = playing(view) && !choice && same(view.round.turn, me)
    bridge.setBusy(!!mine)

    $('status').textContent = statusText(view)
    $('watching').hidden = seated || !!mine || !inGame(view)
    $('leave').hidden = !seated || inGame(view)
    $('leave').disabled = !act
    const leads = same(view.leader, me) && !inGame(view)
    $('start').hidden = !leads
    $('start').textContent = kindOf(view) === 'over' ? 'New game' : 'Start game'
    $('start').disabled = $('again').disabled = !act || seatCount(view) < 2

    $('actions').hidden = !seated && !mine
    $('playing').hidden = !myTurn
    $('choosing').hidden = !myChoice
    $('idle').hidden = myTurn || myChoice
    $('idle').textContent = idleText(view, mine)
    $('hit').disabled = $('stay').disabled = !act
    $('stay-text').textContent = mine?.score ? `Stay on ${mine.score}` : 'Stay'
    drawTargets(myChoice ? choice : null, act)

    const clock = myTurn || myChoice ? (view.round.until_ms ?? null) : null
    if ($('clock').dataset.until !== String(clock)) {
      $('clock').dataset.until = String(clock)
      $('clock').hidden = clock == null
      runBar($('clock-fill'), clock, TURN_MS)
    }

    table.classList.toggle('picking', myChoice)
    for (const b of boards.values()) {
      const can = myChoice && choice.targets.some((id) => same(id, b.id))
      b.el.classList.toggle('can-pick', can)
      b.pick.hidden = !can
      b.pick.disabled = !act
      if (can) {
        const verb = l7faces.kinds[choice.card.face].verb
        b.pick.firstElementChild.textContent = same(b.id, me) ? `${verb} myself` : verb
        b.pick.setAttribute('aria-label', `${verb}: ${who(b.id)}`)
      }
    }
    const sit = grid.querySelector('.sit')
    if (sit) {
      sit.hidden = seated
      sit.disabled = !act
    }
  }

  // ── Moves ─────────────────────────────────────────────────────────────────

  const cardEl = (id) => table.querySelector(`.board .card[data-key="${id}"]`)

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

  // What leaves the table in this draw, with where it is now.
  function measure(d) {
    const m = { sweep: [], play: null, spent: new Map() }
    if (d.fresh) {
      for (const card of table.querySelectorAll('.board .card, .play-slot .card')) {
        m.sweep.push({ el: card.cloneNode(true), rect: card.getBoundingClientRect() })
      }
    }
    m.play = $('play-slot').firstElementChild?.getBoundingClientRect() ?? null
    for (const step of d.steps) {
      const el = step.kind === 'save' ? cardEl(step.card.id) : null
      if (el) m.spent.set(step.card.id, el.getBoundingClientRect())
    }
    return m
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

  // A word over a board.
  function flash(b, text, kind, delay = 0) {
    fx.at(delay, () => b.panel.querySelector('.flash')?.remove())
    pop(b.panel, span(`flash ${kind}`, text), delay, 1200)
  }

  // A word over the middle of the table.
  function banner(text, kind, delay, ms) {
    const el = span(`banner ${kind}`, text)
    const base = layer.getBoundingClientRect()
    const mid = table.querySelector('.middle').getBoundingClientRect()
    el.style.top = `${mid.top + mid.height / 2 - base.top}px`
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
    const n = 28
    bits(n, (i) => {
      const angle = (i / n) * Math.PI * 2 + Math.random() * 0.5
      const reach = Math.max(r.width, r.height) * (0.45 + Math.random() * 0.4)
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

  function reshuffle(t, announce) {
    const from = $('discard').getBoundingClientRect()
    for (let i = 0; i < 5; i++) {
      fx.fly(l7faces.card(null), {
        from,
        to: $('deck-top'),
        match: true,
        delay: t + i * 70,
        duration: 340,
        wait: 'hidden'
      })
    }
    cue('shuffle', t)
    if (announce) banner('Reshuffle', '', t, 900)
  }

  // A Second Chance spent: the repeat comes from the deck onto the number it repeats, then it
  // and the Second Chance (from `rect`, where it lay) go to the discard pile.
  function save(b, step, rect, at) {
    const discard = $('discard')
    cue('deal', at)
    cue('slide', at + FLY_MS + LEAVE_MS)
    const twin =
      step.repeat &&
      [...b.nums.children].find((el) => Number(el.dataset.value) === step.repeat.value)
    // Beside the number it repeats, so both can be read.
    const on = twin?.getBoundingClientRect()
    const spot = on
      ? new DOMRect(on.x + on.width * 0.38, on.y + on.height * 0.16, on.width, on.height)
      : rect
    if (spot) {
      fx.fly(l7faces.card(step.repeat), {
        from: $('deck-top'),
        to: spot,
        match: true,
        spin: 8,
        turn: step.repeat ? 'onway' : null,
        delay: at,
        duration: FLY_MS,
        wait: 'hidden'
      })
      fx.at(at + FLY_MS, () => {
        if (twin) fx.pulse(twin, 'shake')
        fx.fly(l7faces.card(step.repeat), {
          from: spot,
          to: discard,
          match: true,
          delay: LEAVE_MS,
          duration: 360,
          fade: 'out',
          tilt: -5
        })
      })
    }
    if (rect) {
      fx.fly(l7faces.card(step.card), {
        from: rect,
        to: discard,
        match: true,
        delay: at + FLY_MS + LEAVE_MS,
        duration: 360,
        fade: 'out',
        tilt: 5
      })
    }
  }

  // An action card nobody could be given: it shows over the board it was flipped for, from the
  // deck or from where it waited for a target (`from`), then goes to the discard pile.
  function drop(b, card, from, at) {
    cue(from ? 'slide' : 'deal', at)
    cue('slide', at + FLY_MS + LEAVE_MS)
    const over = b.nums.getBoundingClientRect()
    const w = (from ?? $('deck-top').getBoundingClientRect()).width
    const spot = new DOMRect(
      over.left + over.width / 2 - w / 2,
      over.top + over.height / 2 - w * 0.7,
      w,
      w * 1.4
    )
    fx.fly(
      l7faces.card(card),
      from
        ? { from, to: spot, delay: at, duration: FLY_MS }
        : {
            from: $('deck-top'),
            to: spot,
            match: true,
            spin: 8,
            turn: 'onway',
            delay: at,
            duration: FLY_MS,
            wait: 'hidden'
          }
    )
    flash(b, 'Discarded', '', at + FLY_MS)
    fx.at(at + FLY_MS, () =>
      fx.fly(l7faces.card(card), {
        from: spot,
        to: $('discard'),
        match: true,
        delay: LEAVE_MS,
        duration: 360,
        fade: 'out',
        tilt: -5
      })
    )
  }

  // What a card that has just landed sets off; `now` is the hand when it was the last to land.
  function landed(b, frame, now, old) {
    if (frame.saved) flash(b, 'Second Chance!', 'rose')
    else if (frame.card?.face === 'flip_three') flash(b, 'Flip 3!', 'hot')
    else if (frame.card?.face === 'second_chance') flash(b, 'Second Chance', 'rose')
    if (!now || now.state === old.state) {
      fx.pulse(b.points, 'bump')
      return
    }
    if (now.state === 'busted') {
      fx.pulse(b.nums, 'shake')
      fx.show(b.points, { kind: 'pop' })
      flash(b, 'Bust!', 'bad')
    } else if (now.state === 'frozen') {
      flash(b, 'Frozen', 'ice')
    } else if (now.state === 'stayed') {
      flash(b, 'Stayed', 'good')
    } else if (now.state === 'seven') {
      banner('Lucky Seven!', 'gold', 100, 1500)
      sparkle(b.panel)
      fx.pulse(b.panel, 'bump')
    }
  }

  // The round's points go to the totals, one board after another, and a game that is over then
  // shows its result.
  function tallyUp(view, d, t0) {
    let i = 0
    let last = t0
    for (const [id, gain] of d.gains) {
      const b = boards.get(id)
      if (!b) continue
      const total = totalOf(view, id) ?? 0
      last = t0 + i++ * 110
      fx.at(last, () => {
        if (gain > 0) {
          fx.fly(b.points.cloneNode(true), {
            from: b.points.getBoundingClientRect(),
            to: b.totalN,
            duration: 420,
            fade: 'out'
          })
        }
        fx.at(gain > 0 ? 380 : 0, () => {
          paint(b, playerOf(view, id), total, false)
          if (gain > 0) {
            fx.count(b.totalN, total - gain, total, { duration: 500 })
            fx.pulse(b.total, 'bump')
          }
        })
      })
    }
    const sheet = $('results')
    if (kindOf(view) !== 'over' || sheet.hidden) return
    fx.from(sheet, { opacity: 0 }, { delay: last + 1300, duration: 260 })
    fx.from(
      sheet.firstElementChild,
      { opacity: 0, transform: 'scale(0.8)' },
      { delay: last + 1300, duration: 320 }
    )
    if (view.status.winner != null) fx.at(last + 1350, confetti)
  }

  function moves(view, d, m) {
    const deck = $('deck-top')
    let t = 0
    if (m.sweep.length) {
      m.sweep.forEach(({ el, rect }, i) =>
        fx.fly(el, {
          from: rect,
          to: $('discard'),
          match: true,
          delay: Math.min(i * 10, 150),
          duration: 340,
          fade: 'out',
          tilt: -5
        })
      )
      cue('slide', 40)
      t = 430
    }
    if (d.reshuffled) {
      reshuffle(t, !d.fresh)
      t += 560
    }
    if (d.fresh) {
      banner(`Round ${view.round.number}`, '', t, 800)
      t += 250
    }

    // Each board shows the hand it had, then the hand as each of its cards lands.
    const gap = d.fresh ? Math.max(110, Math.min(190, 1900 / Math.max(1, d.steps.length))) : 480
    const hands = new Map([...d.before].map(([id, old]) => [id, [...old.cards]]))
    const lines = new Map()
    let at = t
    let end = t
    for (const step of d.steps) {
      const id = String(step.client)
      if (!boards.has(id)) continue
      if (!lines.has(id)) lines.set(id, [])
      if (step.kind === 'save') {
        hands.set(
          id,
          hands.get(id).filter((c) => c.id !== step.card.id)
        )
        save(boards.get(id), step, m.spent.get(step.card.id), at)
        lines.get(id).push({ at: at + FLY_MS, cards: [...hands.get(id)], saved: true })
        end = at + FLY_MS + LEAVE_MS + 360
        at += 1100
        continue
      }
      if (step.kind === 'drop') {
        drop(boards.get(id), step.card, step.from === 'play' ? m.play : null, at)
        end = at + FLY_MS + LEAVE_MS + 360
        at += 1100
        continue
      }
      const el = cardEl(step.card.id)
      const given = step.from === 'play' && m.play
      cue(given ? 'slide' : 'deal', at)
      if (el) {
        fx.fly(
          el,
          given
            ? { from: m.play, match: true, delay: at, duration: FLY_MS }
            : { from: deck, match: true, spin: 8, turn: 'onway', delay: at, duration: FLY_MS }
        )
      }
      hands.get(id).push(step.card)
      lines.get(id).push({ at: at + FLY_MS, cards: [...hands.get(id)], card: step.card })
      end = at + FLY_MS
      at += given ? gap + 250 : gap
    }

    for (const [id, old] of d.before) {
      const b = boards.get(id)
      const frames = lines.get(id)?.length ? lines.get(id) : null
      if (!b || (!frames && !d.ended)) continue
      const now = playerOf(view, id)
      const total = totalOf(view, id) ?? 0
      const base = d.ended ? total - (d.gains.get(id) ?? 0) : total
      paint(b, frames ? old : now, base, true)
      frames?.forEach((frame, i) => {
        const last = i === frames.length - 1
        fx.at(frame.at, () => {
          paint(b, last ? now : { cards: frame.cards, state: 'active' }, base, true)
          landed(b, frame, last ? now : null, old)
        })
      })
    }

    for (const id of d.stays) {
      const b = boards.get(String(id))
      if (!b) continue
      flash(b, 'Stayed', 'good', t)
      fx.show(b.points, { kind: 'pop', delay: t })
    }

    if (d.pick) {
      const el = $('play-slot').firstElementChild
      if (el) {
        fx.fly(el, { from: deck, match: true, spin: 8, turn: 'onway', delay: at, duration: FLY_MS })
      }
      cue('deal', at)
      fx.show($('play-slot'), { delay: at + FLY_MS - 60, duration: 140 })
      fx.show($('play-text'), { delay: at + FLY_MS - 60 })
      end = Math.max(end, at + FLY_MS)
    }

    if (d.ended) tallyUp(view, d, end + 600)
  }

  function drawSnapshot(view) {
    settle()
    const a = fresh ? null : prev
    fresh = false
    const d = a ? l7steps.diff(a, view) : null
    const m = d ? measure(d) : null
    const slide = d ? fx.mark(table.querySelectorAll('.board .card')) : null

    const added = place(view)
    for (const b of boards.values()) drawBoard(b, view)
    drawMiddle(view)
    drawResults(view)
    drawControls()
    $('game').hidden = false

    if (a) for (const el of added) fx.show(el, { kind: 'rise', duration: 260 })
    if (d) {
      // The moves first: they measure where things lie, which a slide in progress would shift.
      moves(view, d, m)
      slide()
    }
    prev = view
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  const sends = { leave: 'stand', start: 'start', again: 'start', hit: 'hit', stay: 'stay' }
  for (const [id, type] of Object.entries(sends)) {
    $(id).addEventListener('click', () => room.send({ type }))
  }
  const choose = (target) => room.send({ type: 'choose', target: String(target) })
  $('choosing').addEventListener('click', (event) => {
    const b = event.target.closest('.target')
    if (b && !b.disabled) choose(b.dataset.target)
  })
  table.addEventListener('click', (event) => {
    if (event.target.closest('.sit')) return room.send({ type: 'sit' })
    const pick = event.target.closest('.pick')
    if (pick && !pick.disabled) choose(pick.closest('.board').dataset.key)
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
    if (event.key === 'Escape') $('rules').hidden = true
    if (event.ctrlKey || event.metaKey || event.altKey || event.repeat) return
    if (!$('rules').hidden || $('playing').hidden || $('actions').hidden) return
    const key = event.key.toLowerCase()
    if (key === 'h') $('hit').click()
    if (key === 's') $('stay').click()
  })

  for (const [cards, name, text] of LEGEND) {
    const dt = document.createElement('dt')
    dt.append(...cards.map((c) => l7faces.card(c)))
    const dd = document.createElement('dd')
    const b = document.createElement('b')
    b.textContent = name
    dd.append(b, text)
    $('legend').append(dt, dd)
  }

  new ResizeObserver(() => requestAnimationFrame(fit)).observe($('others'))

  room.onRender(() => {
    if (!room.connected) fresh = true
    const view = room.view
    if (!view) return
    if (view !== prev) drawSnapshot(view)
    else {
      for (const b of boards.values()) identify(b, view)
      drawControls()
    }
  })
})()
