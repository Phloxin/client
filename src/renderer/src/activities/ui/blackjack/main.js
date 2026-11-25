// Blackjack against the house for 1 to 7 seats. Draws each snapshot on the casino helpers
// (cards.js): the dealer and the shoe, seven spots with their plates, bets and hands kept by key,
// and the moves the change from the snapshot before calls for. The dock holds the chip rack and
// the play buttons, and sends sit, stand, bet, deal, hit, stay, double, split and rebuy.
/* global bridge, room, casino */
;(() => {
  const $ = (id) => document.getElementById(id)
  const TURN_MS = 30000
  const AWAY_TURN_MS = 3000
  const MIN_BET = 10
  const MAX_BET = 500
  const MAX_HANDS = 4
  const DECK = 312
  const RACK = [10, 25, 50, 100, 500]
  const VACATE_AFTER_MS = 1500
  const VACATE_MS = 400
  const OUTCOME = { blackjack: 'Blackjack', win: 'Win', push: 'Push', lose: 'Lose', bust: 'Bust' }

  room.rejections({
    round_in_progress: 'Wait for the round to end',
    not_playing: 'No round is being played',
    not_your_turn: 'Not your turn',
    not_leader: 'Only the leader can deal',
    no_bets: 'Nobody has bet yet',
    bad_bet: 'Bets are 10 to 500',
    not_enough_chips: 'Not enough chips',
    cannot_double: "You can't double this hand",
    cannot_split: "You can't split this hand",
    not_broke: 'You still have chips',
    not_seated: 'Take a seat first',
    already_seated: 'You already have a seat',
    no_free_seat: 'Every seat is taken'
  })

  const table = $('table')
  const fx = casino.stage($('fx'))
  const same = (a, b) => a != null && b != null && String(a) === String(b)
  const span = (className, text) => {
    const el = document.createElement('span')
    el.className = className
    if (text != null) el.textContent = text
    return el
  }

  // ── The table's fixed parts ───────────────────────────────────────────────

  const spots = Array.from({ length: 7 }, (_, seat) => {
    const el = document.createElement('div')
    el.className = 'spot'
    el.dataset.seat = String(seat)
    el.innerHTML =
      '<div class="spot-top"><div class="bet-circle"><div class="next-bet" hidden>' +
      '<span class="chips"></span><span class="amount"></span></div></div>' +
      '<div class="hands"></div></div>'
    const sit = document.createElement('button')
    sit.type = 'button'
    sit.className = 'btn sit'
    sit.textContent = 'Sit'
    sit.hidden = true
    el.appendChild(sit)
    $('spots').appendChild(el)
    return {
      el,
      sit,
      hands: el.querySelector('.hands'),
      next: el.querySelector('.next-bet'),
      client: null,
      leaving: false,
      plate: null,
      handIds: [],
      nextId: 0
    }
  })
  for (const d of RACK) $('rack').appendChild(casino.rackChip(d))

  function plate(id) {
    const el = document.createElement('div')
    el.className = 'plate'
    const wrap = span('avatar-wrap')
    wrap.append(room.avatarEl(id), casino.ring())
    const text = span('plate-text')
    const name = span('plate-name')
    name.append(span('', room.nameOf(id)))
    text.append(name, span('plate-stack'))
    const tag = span('tag')
    tag.hidden = true
    el.append(wrap, text, tag)
    el.dataset.avatar = room.avatarOf(id) ?? ''
    return el
  }

  // The name and avatar follow the client list, which may arrive after the seat.
  function refreshPlate(spot) {
    const id = spot.client
    if (!spot.plate || id == null) return
    const name = spot.plate.querySelector('.plate-name > span')
    if (name.textContent !== room.nameOf(id)) name.textContent = room.nameOf(id)
    const avatar = room.avatarOf(id) ?? ''
    if (spot.plate.dataset.avatar !== avatar) {
      spot.plate.dataset.avatar = avatar
      spot.plate.querySelector('.avatar').replaceWith(room.avatarEl(id))
    }
  }

  function handEl() {
    const el = document.createElement('div')
    el.className = 'hand'
    el.innerHTML =
      '<div class="cards"></div><span class="pill total"></span>' +
      '<span class="pill outcome" hidden><b></b><i></i></span>' +
      '<div class="hand-bet"><span class="chips"></span><span class="amount"></span></div>'
    return el
  }

  // ── Reading a snapshot ────────────────────────────────────────────────────

  // The viewer's own betting: the amount built in the rack, the one sent and not yet seen in
  // `bets`, and the last bet known, for Same bet.
  const local = { amount: 0, placing: null, last: null }
  // The snapshot drawn last.
  let prev = null
  // The next snapshot is drawn without moves: the first one, and the first after a reconnect.
  let fresh = true
  // While the end of a round plays.
  let dealerTurn = false

  const seated = (view, id) => view.seats.some((s) => same(s, id))
  const playing = (view) => view.status?.kind === 'playing'
  const playerOf = (view, id) => view.round?.players.find((p) => same(p.client, id)) ?? null
  const chipsOf = (view, id) => view.chips[String(id)] ?? 0
  const betOf = (view, id) => view.bets[String(id)] ?? null
  const busted = (hand) => hand.total > 21
  const live = () => room.connected && !room.closed
  const slotOf = (view, seat) => {
    const mine = view.seats.findIndex((s) => same(s, room.you))
    return mine < 0 ? seat : (seat - mine + 3 + 7) % 7
  }
  const key = (card) => (card ? `${card.rank}${card.suit}` : '')
  // Two views of one round: the same players, and the first cards unchanged.
  const sameRound = (a, b) =>
    !!a &&
    !!b &&
    a.players.length === b.players.length &&
    key(a.dealer.cards[0]) === key(b.dealer.cards[0]) &&
    a.players.every(
      (p, i) =>
        same(p.client, b.players[i].client) &&
        key(p.hands[0]?.cards[0]) === key(b.players[i].hands[0]?.cards[0])
    )
  // Between rounds the round on the table changes only when the next one is dealt.
  const dealtSince = (a, b) =>
    !!b.round && !playing(a) && JSON.stringify(a.round) !== JSON.stringify(b.round)

  // What the change from `a` to `b` plays: a deal, the end of a round, a move in a round, a change
  // between rounds, or nothing when the two cannot be told apart move by move.
  function change(a, b) {
    if (dealtSince(a, b)) return 'deal'
    if (!playing(a)) return playing(b) ? null : 'between'
    if (!sameRound(a.round, b.round)) return null
    return playing(b) ? 'play' : 'finish'
  }

  function cardValue(rank) {
    return rank === 14 ? 1 : rank > 10 ? 10 : rank
  }
  function totalOf(cards) {
    let sum = 0
    let ace = false
    for (const c of cards) {
      sum += cardValue(c.rank)
      ace ||= c.rank === 14
    }
    return ace && sum + 10 <= 21 ? { total: sum + 10, soft: true } : { total: sum, soft: false }
  }

  function followLocal(view) {
    const me = room.you
    const player = playerOf(view, me)
    const mine = betOf(view, me)
    if (mine != null) local.last = mine
    else if (local.last == null && player) {
      const first = player.hands[0]
      local.last = first.doubled ? first.bet / 2 : first.bet
    }
    if (mine != null && mine === local.placing) {
      local.amount = 0
      local.placing = null
    }
    if (playing(view) || !seated(view, me) || local.amount > Math.min(MAX_BET, chipsOf(view, me))) {
      local.amount = 0
      local.placing = null
    }
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  function drawTotal(el, t, show) {
    el.hidden = !show
    el.replaceChildren()
    if (!show) return
    if (t.soft && t.total < 21) el.append(span('soft', 'soft '))
    el.append(String(t.total))
    el.classList.toggle('bust', t.total > 21)
  }

  function drawHand(el, hand, active, inPlay) {
    el.style.setProperty('--n', String(hand.cards.length))
    const cardsEl = el.querySelector('.cards')
    casino.sync(
      cardsEl,
      hand.cards.map((_, i) => i),
      () => casino.card(null)
    )
    hand.cards.forEach((c, i) => casino.setCard(cardsEl.children[i], c))
    const bust = busted(hand)
    el.classList.toggle('active', active)
    el.classList.toggle('doubled', hand.doubled)
    el.classList.toggle('lost', bust || hand.outcome === 'lose')
    const total = el.querySelector('.total')
    drawTotal(total, hand, hand.cards.length > 0)
    total.classList.toggle('gold', hand.outcome === 'blackjack')

    const outcome = el.querySelector('.outcome')
    const kind = hand.outcome ?? (bust ? 'bust' : null)
    outcome.hidden = !kind
    if (kind) {
      outcome.className = `pill outcome ${kind === 'blackjack' ? 'gold' : kind}`
      const word = outcome.querySelector('b')
      const net = hand.paid - hand.bet
      word.textContent = OUTCOME[kind]
      if (kind === 'blackjack') word.dataset.short = 'BJ'
      else delete word.dataset.short
      outcome.querySelector('i').textContent =
        !hand.outcome || net === 0
          ? ''
          : net > 0
            ? `+${casino.money(net)}`
            : `−${casino.money(-net)}`
    }

    const bet = el.querySelector('.hand-bet')
    const staked = inPlay && !hand.outcome && !bust
    bet.classList.toggle('off', !staked)
    if (staked) {
      casino.setChips(bet.querySelector('.chips'), hand.bet)
      bet.querySelector('.amount').textContent = casino.money(hand.bet)
    }
  }

  // The circle holds the bet for the next round: the placed one, or the viewer's own while it is
  // being built.
  function drawNextBet(spot, view) {
    const id = spot.client
    const building = id != null && same(id, room.you) && local.amount > 0
    const amount = id == null || playing(view) ? null : building ? local.amount : betOf(view, id)
    spot.next.hidden = amount == null
    spot.next.classList.toggle('pending', building)
    if (amount != null) {
      casino.setChips(spot.next.querySelector('.chips'), amount)
      spot.next.querySelector('.amount').textContent = casino.money(amount)
    }
  }

  function drawSpot(spot, seat, view, old, kind) {
    const was = old?.seats[seat] ?? null
    // A player who left mid-round keeps the spot while the end of the round plays.
    spot.leaving =
      kind === 'finish' &&
      view.seats[seat] == null &&
      was != null &&
      !seated(view, was) &&
      !!playerOf(view, was)
    const id = spot.leaving ? was : (view.seats[seat] ?? null)
    const { el } = spot
    el.dataset.slot = String(slotOf(view, seat))
    el.classList.toggle('empty', id == null)
    el.classList.toggle('me', same(id, room.you))

    if (String(spot.client) !== String(id)) {
      spot.plate?.remove()
      spot.plate = id == null ? null : plate(id)
      if (spot.plate) el.appendChild(spot.plate)
      spot.client = id
      spot.handIds = []
    }

    const player = id == null ? null : playerOf(view, id)
    const hands = player?.hands ?? []
    const turn = view.round?.turn
    const acting = playing(view) && !!turn && same(turn.client, id)

    // A hand keeps its element through a split: the new hand gets a new key, put in after the
    // hand that was split.
    if (spot.handIds.length !== hands.length || kind === 'deal') {
      const was = old?.round?.turn
      if (
        kind === 'play' &&
        spot.handIds.length === hands.length - 1 &&
        was &&
        same(was.client, id)
      ) {
        spot.handIds.splice(was.hand + 1, 0, spot.nextId++)
      } else {
        spot.handIds = hands.map(() => spot.nextId++)
      }
    }
    casino.sync(spot.hands, spot.handIds, handEl)
    hands.forEach((hand, i) =>
      drawHand(spot.hands.children[i], hand, acting && turn.hand === i, playing(view))
    )
    el.dataset.hands = String(Math.max(1, hands.length))
    el.classList.toggle('acting', acting)

    if (spot.plate) {
      refreshPlate(spot)
      spot.plate.querySelector('.plate-stack').textContent = casino.money(chipsOf(view, id))
      const name = spot.plate.querySelector('.plate-name')
      const crown = name.querySelector('.crown')
      if (same(view.leader, id) && !crown) name.appendChild(casino.crown())
      if (!same(view.leader, id)) crown?.remove()
      const tag = spot.plate.querySelector('.tag')
      tag.hidden = !player?.away
      tag.textContent = 'Away'
      casino.timer(
        spot.plate.querySelector('.ring'),
        acting ? (view.round.until_ms ?? null) : null,
        room.clockOffsetMs,
        player?.away ? AWAY_TURN_MS : TURN_MS
      )
    }
    drawNextBet(spot, view)
  }

  function drawDealer(view) {
    const dealer = view.round?.dealer
    const cards = dealer?.cards ?? []
    const hand = $('dealer-hand')
    hand.style.setProperty('--n', String(cards.length))
    casino.sync(
      $('dealer-cards'),
      cards.map((_, i) => i),
      () => casino.card(null)
    )
    cards.forEach((c, i) => casino.setCard($('dealer-cards').children[i], c))
    drawTotal($('dealer-total'), dealer ?? { total: 0 }, cards.length > 0)

    // The server fills the shoe at the first deal; until then it reads 0 and no count is shown.
    const shoe = view.shoe || (view.round ? 0 : DECK)
    const out =
      cards.length +
      (view.round?.players ?? []).reduce(
        (n, p) => n + p.hands.reduce((m, h) => m + h.cards.length, 0),
        0
      )
    const unfilled = !view.shoe && !view.round
    $('shoe-count').hidden = unfilled
    $('shoe-count').textContent = unfilled ? '' : String(shoe)
    $('discard').classList.toggle('has', shoe + out < DECK)
  }

  function drawStale(view) {
    table.classList.toggle(
      'stale',
      !playing(view) && !!view.round && (local.amount > 0 || betOf(view, room.you) != null)
    )
  }

  function statusText(view) {
    const me = room.you
    if (dealerTurn) return "Dealer's turn"
    if (playing(view)) {
      const turn = view.round?.turn
      if (!turn) return ''
      return same(turn.client, me) ? 'Your turn' : `${room.nameOf(turn.client)}'s turn`
    }
    if (!seated(view, me)) return 'Watching'
    return betOf(view, me) == null && chipsOf(view, me) >= MIN_BET
      ? 'Place your bet'
      : 'Waiting for bets'
  }

  // The dock and every control: always from the newest snapshot, never held back by a move.
  function drawControls() {
    const view = room.view
    if (!view) return
    const me = room.you
    const isSeated = seated(view, me)
    const inRound = playing(view) && !!playerOf(view, me)
    const chips = chipsOf(view, me)
    const turn = view.round?.turn
    const myTurn = inRound && !!turn && same(turn.client, me)
    const broke = isSeated && !inRound && chips < MIN_BET
    const act = room.canAct()
    bridge.setBusy(inRound)

    $('status').textContent = statusText(view)
    $('watching').hidden = isSeated || !playing(view)
    $('leave').hidden = !isSeated || inRound
    $('leave').disabled = !act
    $('deal').hidden = !(
      same(view.leader, me) &&
      !playing(view) &&
      Object.keys(view.bets).length > 0
    )
    $('deal').disabled = !act
    for (const spot of spots) {
      spot.sit.hidden = spot.client != null || isSeated
      spot.sit.disabled = !act
    }
    $('actions').hidden = !isSeated
    $('broke').hidden = !broke
    $('rebuy').disabled = !act
    $('betting').hidden = !isSeated || playing(view) || broke
    $('playing').hidden = !myTurn

    const cap = Math.min(MAX_BET, chips)
    for (const chip of $('rack').children) {
      chip.disabled = !live() || local.amount + Number(chip.dataset.d) > cap
    }
    $('bet-amount').textContent = local.amount ? casino.money(local.amount) : ''
    $('bet-place').disabled = !act || local.amount < MIN_BET
    $('bet-clear').disabled = local.amount === 0
    $('bet-same').hidden = !(
      local.last != null &&
      local.last >= MIN_BET &&
      local.last <= cap &&
      local.amount === 0 &&
      betOf(view, me) !== local.last
    )
    $('bet-same').disabled = !act

    for (const id of ['hit', 'stay', 'double', 'split']) $(id).disabled = !act
    if (myTurn) {
      const player = playerOf(view, me)
      const hand = player.hands[turn.hand]
      const two = hand?.cards.length === 2
      $('double').hidden = !(two && chips >= hand.bet)
      $('split').hidden = !(
        two &&
        hand.cards[0].rank === hand.cards[1].rank &&
        player.hands.length < MAX_HANDS &&
        chips >= hand.bet
      )
    }
  }

  // ── Moves ─────────────────────────────────────────────────────────────────

  const handBox = (spot, i) => spot.hands.children[i]
  const cardsIn = (handElement) => [...handElement.querySelector('.cards').children]
  const betChips = (handElement) => handElement.querySelector('.hand-bet .chips')

  // What may leave the table in this draw, with where it is now.
  function measure(newRound) {
    const m = { bets: new Map(), split: new Map(), totals: new Map(), lost: new Set(), sweep: [] }
    for (const spot of spots) {
      ;[...spot.hands.children].forEach((handElement) => {
        const at = `${spot.el.dataset.seat}/${handElement.dataset.key}`
        if (handElement.classList.contains('lost')) m.lost.add(handElement)
        const chips = betChips(handElement)
        if (!handElement.querySelector('.hand-bet').classList.contains('off')) {
          m.bets.set(at, { el: chips.cloneNode(true), rect: chips.getBoundingClientRect() })
        }
        m.totals.set(at, keep(handElement.querySelector('.total')))
        const second = cardsIn(handElement)[1]
        if (second) m.split.set(at, second.getBoundingClientRect())
      })
    }
    if (newRound) {
      for (const card of table.querySelectorAll('.spots .card, .dealer .card')) {
        m.sweep.push({ el: card.cloneNode(true), rect: card.getBoundingClientRect() })
      }
    }
    return m
  }

  // A label keeps what it showed until `ms`, then shows what it has now.
  const keep = (el) => ({ html: el.innerHTML, className: el.className })
  function late(el, was, ms) {
    if (!was) return
    const now = keep(el)
    Object.assign(el, { innerHTML: was.html, className: was.className })
    fx.at(ms, () => Object.assign(el, { innerHTML: now.html, className: now.className }))
  }

  function deal(view, m) {
    const shoe = $('shoe-top')
    let t = 0
    if (m.sweep.length) {
      for (const { el, rect } of m.sweep) {
        fx.fly(el, { from: rect, to: $('discard'), duration: 320, fade: 'out', tilt: -7 })
      }
      t = 260
    }
    const order = []
    for (let r = 0; r < 2; r++) {
      for (const p of view.round.players) {
        const spot = spots.find((s) => same(s.client, p.client))
        const card = spot?.hands.children[0] && cardsIn(handBox(spot, 0))[r]
        if (card) order.push({ card, total: r === 1 && handBox(spot, 0) })
      }
      const card = $('dealer-cards').children[r]
      if (card) order.push({ card, total: r === 1 && $('dealer-hand') })
    }
    const gap = Math.min(150, 1900 / Math.max(1, order.length))
    order.forEach(({ card, total }, i) => {
      const hole = card.classList.contains('down')
      const over = !hole && card.parentElement.id === 'dealer-cards' && i === order.length - 1
      fx.fly(card, {
        from: shoe,
        match: true,
        spin: 7,
        delay: t + i * gap,
        duration: 380,
        turn: over ? 'later' : hole ? null : 'onway'
      })
      if (total) fx.show(total.querySelector('.total'), { delay: t + i * gap + 380 })
    })
    for (const spot of spots) {
      if (spot.hands.children.length) fx.pulse(betChips(handBox(spot, 0)), 'bump', { delay: t })
    }
    return t + order.length * gap + 380
  }

  function finish(a, view, m, t0, holeWasDown, dealt) {
    const shoe = $('shoe-top')
    const dealer = view.round.dealer
    const cards = [...$('dealer-cards').children]
    const had = dealt ? 2 : a.round.dealer.cards.length
    dealerTurn = true
    $('status').textContent = statusText(view)
    let t = t0

    const totalEl = $('dealer-total')
    const totals = []
    if (holeWasDown && cards[1]) {
      fx.flip(cards[1], { delay: t })
      t += 380
      totals.push([t - 120, totalOf(dealer.cards.slice(0, 2))])
    }
    const drawn = cards.slice(had)
    const gap = Math.min(350, 1300 / Math.max(1, drawn.length))
    drawn.forEach((card, i) => {
      fx.fly(card, {
        from: shoe,
        match: true,
        spin: 7,
        turn: 'onway',
        delay: t + i * gap,
        duration: Math.min(360, gap)
      })
      totals.push([t + i * gap + Math.min(360, gap), totalOf(dealer.cards.slice(0, had + i + 1))])
    })
    t += drawn.length * gap + 200
    if (totals.length) {
      const end = keep(totalEl)
      drawTotal(totalEl, totalOf([dealer.cards[0]]), true)
      totals.forEach(([ms, value], i) =>
        fx.at(ms, () => {
          if (i === totals.length - 1)
            Object.assign(totalEl, { innerHTML: end.html, className: end.className })
          else drawTotal(totalEl, value, true)
          fx.pulse(totalEl, 'bump')
        })
      )
    }
    fx.at(t, () => {
      dealerTurn = false
      $('status').textContent = statusText(room.view)
    })

    const dealerRect = $('dealer-cards').getBoundingClientRect()
    let n = 0
    for (const spot of spots) {
      if (spot.client == null) continue
      const player = playerOf(view, spot.client)
      if (!player) continue
      const stack = spot.plate.querySelector('.plate-stack')
      const avatar = spot.plate.querySelector('.avatar')
      let won = false
      let last = t
      player.hands.forEach((hand, i) => {
        const box = handBox(spot, i)
        if (!box) return
        const pop = t + n++ * 50
        last = pop
        fx.show(box.querySelector('.outcome'), { kind: 'pop', delay: pop })
        // A hand lost here dims as its label pops; one lost before stays as it was.
        if (box.classList.contains('lost') && !m.lost.has(box)) {
          box.classList.remove('lost')
          fx.at(pop, () => box.classList.add('lost'))
        }
        const bet = m.bets.get(`${spot.el.dataset.seat}/${box.dataset.key}`)
        if (!bet) return
        if (hand.paid === 0) {
          fx.fly(bet.el, {
            from: bet.rect,
            to: dealerRect,
            delay: t + 150,
            duration: 360,
            fade: 'out'
          })
          return
        }
        won = true
        fx.fly(bet.el, { from: bet.rect, to: avatar, delay: t + 560, duration: 360, fade: 'out' })
        if (hand.paid > hand.bet) {
          const beside = new DOMRect(
            bet.rect.left + bet.rect.width * 1.1,
            bet.rect.top,
            bet.rect.width,
            bet.rect.height
          )
          const winnings = casino.chips(hand.paid - hand.bet)
          const chip = bet.rect.width
          fx.fly(winnings, {
            from: dealerRect,
            to: beside,
            delay: t + 150,
            duration: 410,
            wait: 'hidden',
            chip
          })
          fx.fly(winnings, {
            from: beside,
            to: avatar,
            delay: t + 560,
            duration: 360,
            wait: 'hidden',
            fade: 'out',
            chip
          })
        }
      })
      if (won) {
        fx.count(stack, chipsOf(a, spot.client), chipsOf(view, spot.client), {
          delay: t + 860,
          duration: 300
        })
      }
      if (spot.leaving) vacate(spot, view, last + VACATE_AFTER_MS)
    }
  }

  // The plate and hands of a player who left fade out, then the spot is the open seat `view` has.
  function vacate(spot, view, ms) {
    let fades = []
    fx.at(ms, () => {
      fades = [spot.plate, spot.hands].map((el) =>
        el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: VACATE_MS, fill: 'forwards' })
      )
    })
    fx.at(ms + VACATE_MS, () => {
      for (const fade of fades) fade.cancel()
      drawSpot(spot, spots.indexOf(spot), view, null, null)
      drawControls()
    })
  }

  function moves(a, view, m, kind) {
    const shoe = $('shoe-top')
    if (kind === 'deal') {
      const t = deal(view, m)
      if (!playing(view)) finish(a, view, m, t + 150, true, true)
      return
    }
    if (kind === 'finish') {
      finish(a, view, m, 0, a.round.dealer.cards[1] == null, false)
      return
    }

    for (const spot of spots) {
      const id = spot.client
      if (id == null) continue
      const stack = spot.plate.querySelector('.plate-stack')
      const avatar = spot.plate.querySelector('.avatar')

      if (kind === 'between') {
        const bet = betOf(view, id)
        if (bet != null && bet !== betOf(a, id) && !spot.next.classList.contains('pending')) {
          fx.fly(spot.next.querySelector('.chips'), { from: avatar, duration: 320 })
          fx.show(spot.next.querySelector('.amount'), { delay: 300 })
        }
        if (chipsOf(a, id) !== chipsOf(view, id)) {
          fx.count(stack, chipsOf(a, id), chipsOf(view, id), { duration: 400 })
        }
        continue
      }
      const was = playerOf(a, id)
      const now = playerOf(view, id)
      if (!was || !now) continue

      const split = now.hands.length === was.hands.length + 1
      const at = a.round.turn?.hand ?? 0
      now.hands.forEach((hand, i) => {
        const box = handBox(spot, i)
        if (!box) return
        const cards = cardsIn(box)
        const total = box.querySelector('.total')
        if (split && i === at) {
          fx.fly(cards[1], { from: shoe, match: true, spin: 7, turn: 'onway', delay: 280 })
          fx.show(total, { delay: 660 })
        } else if (split && i === at + 1) {
          const from = m.split.get(`${spot.el.dataset.seat}/${handBox(spot, at).dataset.key}`)
          if (from) fx.fly(cards[0], { from, duration: 300 })
          fx.fly(cards[1], { from: shoe, match: true, spin: 7, turn: 'onway', delay: 460 })
          fx.fly(betChips(box), { from: avatar, delay: 100, duration: 320 })
          fx.show(box.querySelector('.hand-bet .amount'), { delay: 420 })
          fx.show(total, { delay: 840 })
        } else {
          const before = was.hands[split && i > at ? i - 1 : i]
          if (!before || hand.cards.length <= before.cards.length) return
          const card = cards[cards.length - 1]
          fx.fly(card, {
            from: shoe,
            match: true,
            spin: 7,
            tilt: hand.doubled ? 12 : 0,
            turn: 'onway'
          })
          late(total, m.totals.get(`${spot.el.dataset.seat}/${box.dataset.key}`), 380)
          fx.pulse(total, 'bump', { delay: 380 })
          if (hand.doubled && !before.doubled) {
            fx.fly(casino.chips(before.bet), { from: avatar, to: betChips(box), duration: 320 })
          }
          if (busted(hand)) {
            fx.show(box.querySelector('.outcome'), { kind: 'pop', delay: 380 })
            fx.from(box.querySelector('.cards'), { opacity: 1 }, { delay: 380 })
            fx.pulse(box.querySelector('.cards'), 'shake', { delay: 380 })
            const bet = m.bets.get(`${spot.el.dataset.seat}/${box.dataset.key}`)
            if (bet) {
              fx.fly(bet.el, {
                from: bet.rect,
                to: $('dealer-cards'),
                delay: 620,
                duration: 380,
                fade: 'out'
              })
            }
          }
        }
      })
      if (chipsOf(a, id) !== chipsOf(view, id)) {
        fx.count(stack, chipsOf(a, id), chipsOf(view, id), { duration: 300 })
      }
    }
  }

  function drawSnapshot(view) {
    fx.snap()
    dealerTurn = false
    const a = fresh ? null : prev
    fresh = false
    const kind = a ? change(a, view) : null
    const old = kind ? a : null
    followLocal(view)
    const m = old ? measure(kind === 'deal') : null
    const slide = old
      ? fx.mark(table.querySelectorAll('.spot .card, .spot .total, .hand-bet'))
      : null

    spots.forEach((spot, seat) => drawSpot(spot, seat, view, old, kind))
    drawDealer(view)
    drawStale(view)
    drawControls()
    $('game').hidden = false

    if (old) {
      slide()
      moves(old, view, m, kind)
    }
    prev = view
  }

  // The rack, Clear and a click on a chip change only the viewer's own circle and the dock.
  function drawLocal() {
    const view = room.view
    if (!view) return
    for (const spot of spots) drawNextBet(spot, view)
    drawStale(view)
    drawControls()
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  $('rack').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip')
    if (!chip || chip.disabled || !room.view) return
    local.amount += Number(chip.dataset.d)
    drawLocal()
    const mine = spots.find((s) => same(s.client, room.you))
    const target = mine?.next.querySelector('.chip:last-child')
    if (target) {
      fx.fly(casino.chips(Number(chip.dataset.d)), {
        from: chip.getBoundingClientRect(),
        to: target,
        match: true,
        chip: chip.offsetWidth,
        duration: 300
      })
    }
  })
  $('bet-clear').addEventListener('click', () => {
    local.amount = 0
    drawLocal()
  })
  const placeBet = (amount) => {
    if (amount == null || amount < MIN_BET) return
    local.placing = amount
    room.send({ type: 'bet', amount })
  }
  $('bet-place').addEventListener('click', () => placeBet(local.amount))
  $('bet-same').addEventListener('click', () => placeBet(local.last))
  $('spots').addEventListener('click', (event) => {
    if (event.target.closest('.btn.sit')) room.send({ type: 'sit' })
  })
  const sends = {
    leave: 'stand',
    deal: 'deal',
    hit: 'hit',
    stay: 'stay',
    double: 'double',
    split: 'split',
    rebuy: 'rebuy'
  }
  for (const [id, type] of Object.entries(sends)) {
    $(id).addEventListener('click', () => room.send({ type }))
  }

  room.onRender(() => {
    if (!room.connected) fresh = true
    const view = room.view
    if (!view) return
    if (view !== prev) drawSnapshot(view)
    else {
      for (const spot of spots) refreshPlate(spot)
      drawControls()
    }
  })
})()
