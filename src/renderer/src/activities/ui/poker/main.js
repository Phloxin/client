// No-limit Texas hold'em for 2 to 9 seats. Draws each snapshot on the casino helpers (cards.js):
// the board, the pot and nine pods around the oval with their plates, hole cards and street bets
// kept by key, and the moves the change from the snapshot before calls for. The dock holds the
// raise panel and the turn's buttons, and sends sit, stand, start, fold, check, call, raise,
// reveal and rebuy. Each plate shows the player's net from the server's ledger, a broke player's
// plate offers the viewer a loan (lend), and the Ledger tile lists what everyone bought, holds,
// lent and borrowed.
/* global bridge, room, casino */
;(() => {
  const $ = (id) => document.getElementById(id)
  const TURN_MS = 30000
  const AWAY_TURN_MS = 3000
  const SAY_MS = 1800
  const CATEGORY = {
    high_card: ['High card', 'High'],
    pair: ['Pair'],
    two_pair: ['Two pair'],
    three_of_a_kind: ['Three of a kind', 'Trips'],
    straight: ['Straight'],
    flush: ['Flush'],
    full_house: ['Full house'],
    four_of_a_kind: ['Four of a kind', 'Quads'],
    straight_flush: ['Straight flush', 'Str. flush']
  }

  room.rejections({
    in_hand: 'Fold before you leave',
    hand_in_progress: 'A hand is being played',
    not_playing: 'No hand is being played',
    not_your_turn: 'Not your turn',
    not_leader: 'Only the leader can start',
    need_two_players: 'Two players with chips are needed',
    cannot_check: "You can't check here",
    nothing_to_call: 'Nothing to call',
    cannot_raise: "You can't raise here",
    raise_too_small: 'That raise is too small',
    not_enough_chips: 'Not enough chips',
    not_broke: 'You still have chips',
    not_seated: 'Take a seat first',
    already_seated: 'You already have a seat',
    no_free_seat: 'Every seat is taken',
    lend_self: "You can't lend to yourself",
    target_not_seated: "They aren't seated",
    target_not_broke: 'They still have chips',
    target_in_hand: "They're in this hand",
    lend_too_small: 'Lend at least the big blind',
    lender_in_hand: 'Wait for this hand to end'
  })

  const fx = casino.stage($('fx'))
  const deck = $('deck').firstElementChild
  const slots = [...$('board').children]
  const same = (a, b) => a != null && b != null && String(a) === String(b)
  const span = (className, text) => {
    const el = document.createElement('span')
    el.className = className
    if (text != null) el.textContent = text
    return el
  }
  // A net as the plate and the ledger print it: +340, −2,000 (a real minus sign), 0.
  const signed = (n) =>
    n > 0 ? `+${casino.money(n)}` : n < 0 ? `−${casino.money(-n)}` : casino.money(0)

  // ── The table's fixed parts ───────────────────────────────────────────────

  const pods = Array.from({ length: 9 }, (_, seat) => {
    const el = document.createElement('div')
    el.className = 'pod'
    el.dataset.seat = String(seat)
    el.innerHTML =
      '<div class="hole"></div>' +
      '<div class="pod-front"><span class="marker dealer" hidden>D</span>' +
      '<span class="marker blind" hidden></span>' +
      '<span class="pod-bet" hidden><span class="chips"></span><span class="amount"></span></span></div>'
    const sit = document.createElement('button')
    sit.type = 'button'
    sit.className = 'btn sit'
    sit.textContent = 'Sit'
    sit.hidden = true
    // On a broke player's plate, for a viewer who can lend to them.
    const lend = document.createElement('button')
    lend.type = 'button'
    lend.className = 'btn lend'
    lend.textContent = 'Lend'
    lend.hidden = true
    el.append(sit, lend)
    $('pods').appendChild(el)
    const q = (s) => el.querySelector(s)
    return {
      el,
      sit,
      lend,
      hole: q('.hole'),
      dealer: q('.marker.dealer'),
      blind: q('.marker.blind'),
      bet: q('.pod-bet'),
      best: null,
      won: null,
      client: null,
      plate: null,
      say: null,
      sayTimer: 0
    }
  })

  function plate(id) {
    const el = document.createElement('div')
    el.className = 'plate'
    const wrap = span('avatar-wrap')
    wrap.append(room.avatarEl(id), casino.ring())
    const text = span('plate-text')
    const name = span('plate-name')
    name.append(span('', room.nameOf(id)))
    const net = span('plate-net')
    net.hidden = true
    text.append(name, span('plate-stack'), net)
    const tag = span('tag')
    tag.hidden = true
    el.append(wrap, text, tag, span('pill best'), span('pill gold won'))
    el.dataset.avatar = room.avatarOf(id) ?? ''
    return el
  }

  // The name and avatar follow the client list, which may arrive after the seat.
  function refreshPlate(pod) {
    const id = pod.client
    if (!pod.plate || id == null) return
    const name = pod.plate.querySelector('.plate-name > span')
    if (name.textContent !== room.nameOf(id)) name.textContent = room.nameOf(id)
    const avatar = room.avatarOf(id) ?? ''
    if (pod.plate.dataset.avatar !== avatar) {
      pod.plate.dataset.avatar = avatar
      pod.plate.querySelector('.avatar').replaceWith(room.avatarEl(id))
    }
  }

  // ── Reading a snapshot ────────────────────────────────────────────────────

  // The viewer's own input: the raise amount on the slider, for the decision it was set on, and
  // the reveal asked for and not yet applied or refused.
  // `typed` is the amount box's text while the viewer is typing in it, else null.
  const local = { raiseTo: null, typed: null, decision: '', presets: {}, reveal: null }
  // The lend popover: the broke player it lends to (null while closed), the amount it would send
  // and, like the raise box, the box's text while the viewer is typing in it.
  const loan = { to: null, amount: 0, typed: null }
  // The whole chips in a typed amount ("1,500" is 1500), or null when there are none.
  const amountOf = (text) => {
    const digits = String(text).replace(/[^\d]/g, '')
    return digits ? Number(digits) : null
  }
  // The snapshot drawn last.
  let prev = null
  // The next snapshot is drawn without moves: the first one, and the first after a reconnect.
  let fresh = true
  // While the end of a showdown plays.
  let showdown = false
  let ticking = 0

  const seated = (view, id) => view.seats.some((s) => same(s, id))
  const playing = (view) => view.status?.kind === 'playing'
  const playerOf = (hand, id) => hand?.players.find((p) => same(p.client, id)) ?? null
  const chipsOf = (view, id) => view.chips[String(id)] ?? 0
  // The server works the net out; it only moves when a hand ends. On the plate a net that went up
  // waits for that player's winnings to land (countStacks), like the stack.
  const netOf = (view, id) => Number(view.net[String(id)] ?? 0)
  // Seated, out of chips and not in the hand being played: they may rebuy or borrow.
  const broke = (view, id) =>
    id != null &&
    seated(view, id) &&
    chipsOf(view, id) === 0 &&
    !(playing(view) && playerOf(view.hand, id))
  // The most the viewer may lend now: seated, out of the hand being played (folded or not, the
  // stack lives in the hand until it ends) and holding at least the big blind. 0 when they can't.
  const lendable = (view) => {
    if (!seated(view, room.you) || (playing(view) && playerOf(view.hand, room.you))) return 0
    const chips = chipsOf(view, room.you)
    return chips >= view.blinds[1] ? chips : 0
  }
  const live = () => room.connected && !room.closed
  const slotOf = (view, seat) => {
    const mine = view.seats.findIndex((s) => same(s, room.you))
    return mine < 0 ? seat : (seat - mine + 9) % 9
  }
  const podOf = (id) => pods.find((pod) => same(pod.client, id))
  const cardIs = (a, b) => !!a && !!b && a.rank === b.rank && a.suit === b.suit
  const dealtIn = (hand) => hand.players.map((p) => String(p.client)).join()

  // What the change from `a` to `b` plays: a new deal, a move in the hand (its end included), a
  // change while the same finished hand stays on the table, or nothing.
  function change(a, b) {
    const ha = a.hand
    const hb = b.hand
    if (!hb) return null
    if (
      !ha ||
      (ha.pots && !hb.pots) ||
      !same(ha.button, hb.button) ||
      dealtIn(ha) !== dealtIn(hb)
    ) {
      return 'deal'
    }
    if (ha.pots && hb.pots) {
      return JSON.stringify([ha.pots, ha.board]) === JSON.stringify([hb.pots, hb.board])
        ? 'idle'
        : null
    }
    return 'play'
  }

  // What each winner of a pot gets, the odd chips to the first ones.
  function shares(pot) {
    const n = pot.winners.length
    return pot.winners.map((id, k) => [
      id,
      Math.floor(pot.amount / n) + (k < pot.amount % n ? 1 : 0)
    ])
  }
  function wonBy(hand, id) {
    let sum = 0
    for (const pot of hand.pots ?? []) {
      for (const [winner, share] of shares(pot)) if (same(winner, id)) sum += share
    }
    return sum
  }
  function blindOf(hand, id) {
    if (hand.street !== 'preflop' || hand.pots) return null
    const n = hand.players.length
    const button = hand.players.findIndex((p) => same(p.client, hand.button))
    const small = n === 2 ? button : (button + 1) % n
    const at = hand.players.findIndex((p) => same(p.client, id))
    return at === small ? 'SB' : at === (small + 1) % n ? 'BB' : null
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  // The net line under the stack: green above 0, red below, hidden at 0.
  function setNet(pod, net) {
    const el = pod.plate?.querySelector('.plate-net')
    if (!el) return
    el.hidden = !net
    el.textContent = net ? signed(net) : ''
    el.classList.toggle('up', net > 0)
    el.classList.toggle('down', net < 0)
  }

  function drawPod(pod, seat, view) {
    const id = view.seats[seat] ?? null
    const hand = view.hand
    const p = id == null ? null : playerOf(hand, id)
    const over = !!hand?.pots
    const { el } = pod
    const mine = same(id, room.you)
    const acting = playing(view) && same(hand?.turn, id)
    const out = id != null && !p && view.status.kind !== 'waiting'

    el.dataset.slot = String(slotOf(view, seat))
    el.classList.toggle('empty', id == null)
    el.classList.toggle('me', mine)
    el.classList.toggle('acting', acting)
    el.classList.toggle('folded', !!p?.folded)
    el.classList.toggle('out', out)

    if (String(pod.client) !== String(id)) {
      pod.plate?.remove()
      pod.plate = id == null ? null : plate(id)
      if (pod.plate) pod.hole.after(pod.plate)
      pod.best = pod.plate?.querySelector('.best') ?? null
      pod.won = pod.plate?.querySelector('.won') ?? null
      pod.client = id
      clearSay(pod)
    }

    // Folded cards are gone from the table; the viewer still sees their own.
    const dealt = !!p && (!p.folded || (mine && !!p.cards))
    casino.sync(pod.hole, dealt ? [0, 1] : [], () => casino.card(null))
    if (dealt) [...pod.hole.children].forEach((c, i) => casino.setCard(c, p.cards?.[i] ?? null))
    el.classList.toggle('shown', dealt && !mine && !!p.cards)

    pod.dealer.hidden = !(p && same(hand.button, id))
    const blind = p ? blindOf(hand, id) : null
    pod.blind.hidden = !blind
    pod.blind.textContent = blind ?? ''
    const bet = p && !over ? p.street_bet : 0
    pod.bet.hidden = !bet
    if (bet) {
      casino.setChips(pod.bet.querySelector('.chips'), bet)
      pod.bet.querySelector('.amount').textContent = casino.money(bet)
    }

    const won = over && id != null ? wonBy(hand, id) : 0
    el.classList.toggle('winner', won > 0)

    if (!pod.plate) return
    refreshPlate(pod)
    const best = dealt && !p.folded && p.best ? CATEGORY[p.best.category] : null
    pod.best.hidden = !best
    if (best) {
      pod.best.textContent = best[0]
      if (best[1]) pod.best.dataset.short = best[1]
      else delete pod.best.dataset.short
    }
    pod.best.classList.toggle('gold', won > 0)
    pod.won.hidden = !won
    pod.won.textContent = `+${casino.money(won)}`
    // `chips` holds the live stack of a dealt player, and a rebuy made after the hand ended.
    pod.plate.querySelector('.plate-stack').textContent = casino.money(
      view.chips[String(id)] ?? p?.stack ?? 0
    )
    setNet(pod, netOf(view, id))
    const name = pod.plate.querySelector('.plate-name')
    const crown = name.querySelector('.crown')
    if (same(view.leader, id) && !crown) name.appendChild(casino.crown())
    if (!same(view.leader, id)) crown?.remove()
    const tag = pod.plate.querySelector('.tag')
    const allIn = !!p && !p.folded && p.stack === 0 && !over
    const text = allIn
      ? 'All in'
      : p?.away
        ? 'Away'
        : p?.folded
          ? 'Folded'
          : out
            ? 'Sitting out'
            : null
    tag.hidden = !text
    tag.textContent = text ?? ''
    tag.classList.toggle('allin', allIn)
    casino.timer(
      pod.plate.querySelector('.ring'),
      acting ? (hand.until_ms ?? null) : null,
      room.clockOffsetMs,
      p?.away ? AWAY_TURN_MS : TURN_MS
    )
  }

  // Lifts the best five of pot `i`'s winners and dims the other cards shown; null clears it.
  function highlight(view, i) {
    const hand = view.hand
    const pot = i == null ? null : hand?.pots?.[i]
    const five = []
    if (pot && hand.street === 'showdown') {
      for (const id of pot.winners) five.push(...(playerOf(hand, id)?.best?.cards ?? []))
    }
    const mark = (el, card) => {
      const part = five.some((c) => cardIs(c, card))
      el.classList.toggle('lift', part)
      el.classList.toggle('dim', five.length > 0 && !part && !el.classList.contains('down'))
    }
    slots.forEach(
      (slot, k) => slot.firstElementChild && mark(slot.firstElementChild, hand?.board[k])
    )
    for (const pod of pods) {
      const p = pod.client == null ? null : playerOf(hand, pod.client)
      ;[...pod.hole.children].forEach((el, k) => mark(el, p?.cards?.[k] ?? null))
    }
  }

  function drawCentre(view) {
    const hand = view.hand
    slots.forEach((slot, i) => {
      const card = hand?.board[i]
      if (!card) return slot.replaceChildren()
      if (!slot.firstElementChild) slot.appendChild(casino.card(card))
      casino.setCard(slot.firstElementChild, card)
    })
    const open = !!hand && !hand.pots
    const inPot = open ? hand.pot - hand.players.reduce((n, p) => n + p.street_bet, 0) : 0
    casino.setChips($('pot-chips'), inPot, 3)
    $('pot-total').hidden = !(open && hand.pot > 0)
    $('pot-total').textContent = `Pot ${casino.money(hand?.pot)}`
    $('table-info').textContent = `Blinds ${view.blinds[0]} / ${view.blinds[1]}`
  }

  function statusText(view) {
    if (showdown) return 'Showdown'
    const s = view.status
    if (s.kind === 'waiting') {
      return same(view.leader, room.you)
        ? 'Start when ready'
        : `Waiting for ${room.nameOf(view.leader)} to start`
    }
    if (s.kind === 'between') {
      const left = Math.max(0, Math.ceil((s.until_ms - (Date.now() + room.clockOffsetMs)) / 1000))
      return `Next hand in ${left}`
    }
    const turn = view.hand?.turn
    if (turn == null) return ''
    return same(turn, room.you) ? 'Your turn' : `${room.nameOf(turn)}'s turn`
  }

  function drawStatus() {
    const view = room.view
    if (!view) return
    const text = statusText(view)
    if ($('status').textContent !== text) $('status').textContent = text
  }

  // The viewer's turn: what calling costs and the raise range, from the newest snapshot.
  function turnOf(view) {
    const hand = view.hand
    const me = playerOf(hand, room.you)
    const toCall = Math.min(hand.bet - me.street_bet, me.stack)
    const maxTo = me.street_bet + me.stack
    const minTo = Math.min(hand.min_raise_to, maxTo)
    const others = hand.players.some((p) => !same(p.client, room.you) && !p.folded && p.stack > 0)
    return { hand, me, toCall, maxTo, minTo, canRaise: me.stack > toCall && others }
  }

  function myTurn(view) {
    if (!view || !playing(view)) return false
    const me = playerOf(view.hand, room.you)
    return !!me && !me.folded && same(view.hand.turn, room.you)
  }

  function drawTurn(view) {
    const { hand, me, toCall, maxTo, minTo, canRaise } = turnOf(view)
    const clamp = (v) => Math.max(minTo, Math.min(maxTo, Math.round(v)))
    const decision = [hand.button, hand.street, hand.bet, hand.min_raise_to, me.street_bet].join()
    if (decision !== local.decision) {
      local.decision = decision
      local.raiseTo = null
      local.typed = null
    }
    local.raiseTo = clamp(local.raiseTo ?? minTo)
    const typed = local.typed == null ? null : amountOf(local.typed)

    $('call').textContent =
      toCall === 0
        ? 'Check'
        : toCall === me.stack
          ? `All in ${casino.money(toCall)}`
          : `Call ${casino.money(toCall)}`
    $('raise').hidden = $('raise-btn').hidden = !canRaise
    // While the viewer types, the box keeps their text; the raise button shows what would be sent.
    const box = $('raise-amount')
    if (local.typed == null) box.value = casino.money(local.raiseTo)
    box.title = `${casino.money(minTo)} to ${casino.money(maxTo)}`
    box.disabled = !live() || minTo === maxTo
    box.classList.toggle('out', typed != null && (typed < minTo || typed > maxTo))
    if (local.typed != null && typed == null) $('raise-btn').disabled = true
    $('raise-less').disabled = box.disabled || local.raiseTo <= minTo
    $('raise-more').disabled = box.disabled || local.raiseTo >= maxTo
    $('raise-btn').textContent =
      local.raiseTo === maxTo
        ? `All in ${casino.money(maxTo)}`
        : `${hand.bet === 0 ? 'Bet' : 'Raise to'} ${casino.money(local.raiseTo)}`
    local.presets = {
      min: minTo,
      half: clamp(hand.bet + (hand.pot + toCall) / 2),
      pot: clamp(hand.bet + hand.pot + toCall),
      max: maxTo
    }
  }

  // The dock and every control: always from the newest snapshot, never held back by a move.
  function drawControls() {
    const view = room.view
    if (!view) return
    const me = room.you
    const isSeated = seated(view, me)
    const mine = playing(view) ? playerOf(view.hand, me) : null
    const inHand = !!mine && !mine.folded
    const turn = myTurn(view)
    const act = room.canAct()
    bridge.setBusy(inHand)

    drawStatus()
    if (view.status.kind === 'between' && !ticking) ticking = setInterval(drawStatus, 250)
    if (view.status.kind !== 'between' && ticking) {
      clearInterval(ticking)
      ticking = 0
    }

    const withChips = view.seats.filter((id) => id != null && chipsOf(view, id) > 0)
    $('watching').hidden = isSeated
    $('leave').hidden = !isSeated || inHand
    $('leave').disabled = !act
    $('start').hidden = !(same(view.leader, me) && view.status.kind === 'waiting')
    $('start').disabled = !act || withChips.length < 2
    $('rebuy').hidden = !(isSeated && chipsOf(view, me) === 0 && !mine)
    $('rebuy').disabled = !act
    const canLend = lendable(view) > 0
    for (const pod of pods) {
      pod.sit.hidden = pod.client != null || isSeated
      pod.sit.disabled = !act
      pod.lend.hidden = !(canLend && !same(pod.client, me) && broke(view, pod.client))
      pod.lend.disabled = !act
      pod.lend.classList.toggle('open', same(loan.to, pod.client))
    }
    drawLend(view)
    drawLedger(view)
    $('actions').hidden = !isSeated
    $('turn').hidden = !turn
    $('reveal-row').hidden = !isSeated
    if (local.reveal != null && act) local.reveal = null
    $('reveal').checked = local.reveal ?? view.revealing.some((id) => same(id, me))
    $('reveal').disabled = !act
    for (const id of ['fold', 'call', 'raise-btn']) $(id).disabled = !act
    for (const btn of $('presets').children) btn.disabled = !live()
    if (turn) drawTurn(view)
  }

  // ── Moves ─────────────────────────────────────────────────────────────────

  function clearSay(pod) {
    clearTimeout(pod.sayTimer)
    pod.say?.remove()
    pod.say = null
  }
  function say(pod, text, kind = '') {
    clearSay(pod)
    pod.say = span(`say ${kind}`.trim(), text)
    pod.el.appendChild(pod.say)
    pod.sayTimer = setTimeout(() => clearSay(pod), SAY_MS)
  }

  // A label's text and attributes, to put back for a while.
  const keep = (el) => ({
    text: el.textContent,
    attrs: [...el.attributes].map((a) => [a.name, a.value])
  })
  function restore(el, k) {
    for (const name of el.getAttributeNames()) el.removeAttribute(name)
    for (const [name, value] of k.attrs) el.setAttribute(name, value)
    el.textContent = k.text
  }

  // What may leave the table in this draw, with where it is now.
  function measure() {
    const copy = (el) => ({ el: el.cloneNode(true), rect: el.getBoundingClientRect() })
    const m = {
      bets: new Map(),
      hole: new Map(),
      best: new Map(),
      board: [],
      pot: copy($('pot-chips'))
    }
    for (const pod of pods) {
      if (pod.client == null) continue
      if (pod.best) m.best.set(String(pod.client), keep(pod.best))
      if (!pod.bet.hidden) m.bets.set(String(pod.client), copy(pod.bet.querySelector('.chips')))
      m.hole.set(String(pod.client), [...pod.hole.children].map(copy))
    }
    for (const slot of slots) if (slot.firstElementChild) m.board.push(copy(slot.firstElementChild))
    return m
  }

  const avatarOf = (pod) => pod.plate.querySelector('.avatar')
  const stackOf = (pod) => pod.plate.querySelector('.plate-stack')
  const toDeck = (list, delay = 0) => {
    for (const { el, rect } of list) {
      fx.fly(el, { from: rect, to: deck, delay, duration: 300, fade: 'out', match: true })
    }
  }

  function dealHand(view, m) {
    const hand = view.hand
    let t = 0
    const old = [...m.board, ...[...m.hole.values()].flat()]
    if (old.length) {
      toDeck(old)
      t = 240
    }
    const n = hand.players.length
    const button = hand.players.findIndex((p) => same(p.client, hand.button))
    const order = []
    for (let r = 0; r < 2; r++) {
      for (let k = 1; k <= n; k++) {
        const pod = podOf(hand.players[(button + k) % n].client)
        if (pod?.hole.children[r]) order.push(pod.hole.children[r])
      }
    }
    const gap = Math.min(90, 1500 / Math.max(1, order.length))
    order.forEach((card, i) =>
      fx.fly(card, {
        from: deck,
        match: true,
        spin: -18,
        delay: t + i * gap,
        duration: 340,
        turn: card.classList.contains('down') ? null : 'onway'
      })
    )
    for (const p of hand.players) {
      const pod = podOf(p.client)
      if (!pod?.plate || pod.bet.hidden) continue
      fx.fly(pod.bet.querySelector('.chips'), { from: avatarOf(pod), delay: t, duration: 300 })
      fx.show(pod.bet.querySelector('.amount'), { delay: t + 280 })
    }
  }

  // The board cards from index `from` on, a street at a time. Returns when the last has landed.
  function dealBoard(from, t, quick) {
    const fresh = slots.map((slot) => slot.firstElementChild).filter((card, i) => card && i >= from)
    let at = t
    fresh.forEach((card, k) => {
      const i = from + k
      if (i >= 3 && k > 0) at += quick ? 260 : 420
      else if (k > 0) at += quick ? 80 : 110
      fx.fly(card, {
        from: deck,
        match: true,
        delay: at,
        duration: quick ? 280 : 340,
        turn: 'onway'
      })
    })
    return fresh.length ? at + (quick ? 280 : 340) : t
  }

  // The move each player made since `ha`, worked out from what they put in and whether they
  // folded. A timeout looks the same as a move chosen.
  function moveLabels(ha, hb, m, potRect, streetOver) {
    const turnMoved = !same(ha.turn, hb.turn) || streetOver
    let put = false
    for (const pb of hb.players) {
      const pa = playerOf(ha, pb.client)
      const pod = podOf(pb.client)
      if (!pa || !pod?.plate) continue
      const added = pb.committed - pa.committed
      if (pb.folded && !pa.folded) {
        say(pod, 'Fold', 'fold')
        if (!same(pb.client, room.you)) toDeck(m.hole.get(String(pb.client)) ?? [])
      } else if (added > 0) {
        const to = pa.street_bet + added
        if (added >= pa.stack) say(pod, 'All in', 'allin')
        else if (to > ha.bet) {
          say(pod, `${ha.bet === 0 ? 'Bet' : 'Raise to'} ${casino.money(to)}`, 'raise')
        } else say(pod, `Call ${casino.money(added)}`)
        put = true
        if (streetOver) {
          fx.fly(casino.chips(added), {
            from: avatarOf(pod),
            to: potRect,
            duration: 320,
            fade: 'out',
            auto: true
          })
        } else {
          fx.fly(pod.bet.querySelector('.chips'), { from: avatarOf(pod), duration: 300 })
          fx.show(pod.bet.querySelector('.amount'), { delay: 280 })
        }
      } else if (same(pb.client, ha.turn) && !pb.folded && turnMoved) {
        say(pod, 'Check')
      }
    }
    return put
  }

  // The end of a hand: the cards turned up at a showdown, then each pot to its winners, side
  // pots first. Returns when each seat's winnings land.
  function finish(hb, ha, t, potRect) {
    const lit = hb.street === 'showdown'
    const awards = new Map()
    if (lit) {
      showdown = true
      drawStatus()
      let turned = 0
      for (const p of hb.players) {
        const pod = podOf(p.client)
        const before = playerOf(ha, p.client)
        if (!pod?.plate || !p.cards || before?.cards) continue
        ;[...pod.hole.children].forEach((card, k) =>
          fx.flip(card, { delay: t + turned * 60 + k * 40 })
        )
        fx.show(pod.best, { kind: 'pop', delay: t + turned * 60 + 330 })
        turned++
      }
      if (turned) t += 420 + turned * 60
      highlight({ hand: hb }, null)
    }
    for (const pod of pods) pod.el.classList.remove('winner')
    const n = hb.pots.length
    const step = Math.min(1100, Math.max(380, (3700 - t) / n))
    for (let k = 0; k < n; k++) {
      const i = n - 1 - k
      const start = t + k * step
      const go = start + (lit ? step * 0.45 : 80)
      const land = go + Math.min(450, step * 0.42)
      if (lit) fx.at(start, () => highlight({ hand: hb }, i))
      const pot = hb.pots[i]
      shares(pot).forEach(([id, share], w) => {
        const pod = podOf(id)
        if (!pod?.plate) return
        const from = new DOMRect(
          potRect.left + (w - (pot.winners.length - 1) / 2) * potRect.height,
          potRect.top,
          potRect.width,
          potRect.height
        )
        fx.fly(casino.chips(share, 2), {
          from,
          to: avatarOf(pod),
          delay: go,
          duration: land - go,
          fade: 'out',
          auto: true
        })
        fx.at(land, () => pod.el.classList.add('winner'))
        awards.set(String(id), land)
      })
    }
    for (const [id, land] of awards) fx.show(podOf(id).won, { kind: 'pop', delay: land - 60 })
    fx.at(t + n * step, () => {
      showdown = false
      drawStatus()
    })
    return awards
  }

  const LOAN_MS = 700

  // Each loan whose total went up since `a`: its chips (drawn larger than a payout's, style.css
  // .chips.loan) fly from the lender's avatar to the borrower's, one loan after another 150 ms
  // apart, each pod saying what it lent or borrowed, and the borrower's avatar bumps as they land.
  // A pod with no plate gets no flight, only the new numbers. Returns when each borrower's chips
  // land and every pod a loan moved chips at.
  function flyLoans(a, b) {
    const lands = new Map()
    const ids = new Set()
    const key = (l) => `${l.from}>${l.to}`
    const before = new Map(a.loans.map((l) => [key(l), l.amount]))
    let t = 0
    for (const l of b.loans) {
      const delta = l.amount - (before.get(key(l)) ?? 0)
      if (delta <= 0) continue
      ids.add(String(l.from)).add(String(l.to))
      const lender = podOf(l.from)
      const borrower = podOf(l.to)
      if (!lender?.plate || !borrower?.plate) continue
      say(lender, `Lent ${casino.money(delta)}`)
      say(borrower, `Borrowed ${casino.money(delta)}`)
      const stack = casino.chips(delta, 2)
      stack.classList.add('loan')
      fx.fly(stack, {
        from: avatarOf(lender),
        to: avatarOf(borrower),
        delay: t,
        duration: LOAN_MS,
        fade: 'out',
        auto: true
      })
      const land = t + LOAN_MS
      fx.pulse(avatarOf(borrower), 'bump', { delay: land })
      lands.set(String(l.to), Math.max(land, lands.get(String(l.to)) ?? 0))
      t += 150
    }
    return { lands, ids }
  }

  // Stacks count to their new value and net lines change to theirs by the same rule: down at once,
  // up after `delays` (when that player's chips land). `only` limits it to those clients.
  function countStacks(a, b, delays, duration, only = null) {
    for (const pod of pods) {
      if (!pod.plate || (only && !only.has(String(pod.client)))) continue
      const land = delays.get(String(pod.client)) ?? 0
      const was = chipsOf(a, pod.client)
      const now = chipsOf(b, pod.client)
      if (was !== now) {
        fx.count(stackOf(pod), was, now, { delay: now > was ? land : 0, duration })
      }
      const netWas = netOf(a, pod.client)
      const netNow = netOf(b, pod.client)
      if (netNow > netWas && land > 0) {
        setNet(pod, netWas)
        fx.at(land, () => setNet(pod, netNow))
      }
    }
  }

  function moves(a, b, m, kind, loans) {
    const ha = a.hand
    const hb = b.hand
    if (kind === 'deal') {
      dealHand(b, m)
      if (loans.ids.size) countStacks(a, b, loans.lands, 300, loans.ids)
      return
    }
    let awards = new Map()
    if (kind === 'play') {
      const potRect = $('pot').getBoundingClientRect()
      const ending = !!hb.pots && !ha.pots
      const streetOver = hb.street !== ha.street || ending
      const put = moveLabels(ha, hb, m, potRect, streetOver)

      let t = 0
      if (streetOver) {
        for (const [, bet] of m.bets) {
          fx.fly(bet.el, { from: bet.rect, to: potRect, duration: 320, fade: 'out' })
        }
        if (m.bets.size || put) {
          t = 300
          if (!hb.pots) {
            fx.fly(m.pot.el, {
              from: m.pot.rect,
              to: m.pot.rect,
              duration: t,
              cover: $('pot-chips')
            })
            fx.count($('pot-total'), ha.pot, hb.pot, {
              delay: t - 100,
              duration: 250,
              format: (n) => `Pot ${casino.money(n)}`
            })
            fx.pulse($('pot-chips'), 'bump', { delay: t })
          }
        }
      }
      const landed = dealBoard(ha.board.length, t, ending)
      // Hand names wait for the board they are made with.
      if (landed > t) {
        for (const pod of pods) {
          const best = pod.best
          const was = best && m.best.get(String(pod.client))
          if (!was) continue
          const now = keep(best)
          restore(best, was)
          fx.at(landed, () => restore(best, now))
        }
      }
      t = landed
      if (ending) awards = finish(hb, ha, t, potRect)
    }

    // Stacks and net lines: down at once, up when the pot's or a loan's chips land.
    const delays = new Map(loans.lands)
    for (const [id, land] of awards) delays.set(id, Math.max(land, delays.get(id) ?? 0))
    countStacks(a, b, delays, kind === 'idle' ? 400 : 300)
  }

  function drawSnapshot(view) {
    fx.snap()
    showdown = false
    const a = fresh ? null : prev
    fresh = false
    const kind = a ? change(a, view) : null
    const m = kind ? measure() : null

    pods.forEach((pod, seat) => drawPod(pod, seat, view))
    drawCentre(view)
    highlight(view, view.hand?.pots ? 0 : null)
    drawControls()
    $('game').hidden = false

    if (!kind) for (const pod of pods) clearSay(pod)
    // A loan plays on any change, between hands included.
    const loans = a ? flyLoans(a, view) : { lands: new Map(), ids: new Set() }
    if (kind) moves(a, view, m, kind, loans)
    else if (loans.ids.size) countStacks(a, view, loans.lands, 300, loans.ids)
    prev = view
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  // The amount box. Its text stays as typed until it is left, Enter is pressed or another control
  // sets the amount; drawControls (and drawTurn in it) clamps what would be sent meanwhile.
  const box = $('raise-amount')
  const settle = () => {
    local.typed = null
    if (myTurn(room.view)) drawControls()
  }
  box.addEventListener('input', () => {
    if (!myTurn(room.view)) return
    local.typed = box.value
    const n = amountOf(box.value)
    if (n != null) local.raiseTo = n
    drawControls()
  })
  box.addEventListener('change', settle)
  box.addEventListener('blur', settle)
  // After the click that focused it, which would otherwise drop the selection.
  box.addEventListener('focus', () => setTimeout(() => box.select()))
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault()
      if (local.typed != null && amountOf(local.typed) == null) return
      settle()
      $('raise-btn').click()
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      event.preventDefault()
      step(event.key === 'ArrowUp' ? 1 : -1)
      box.select()
    }
  })
  $('presets').addEventListener('click', (event) => {
    const preset = event.target.closest('[data-preset]')?.dataset.preset
    if (!preset || !myTurn(room.view)) return
    local.raiseTo = local.presets[preset]
    local.typed = null
    drawTurn(room.view)
  })
  // A big blind a press, clamped to the allowed range by drawTurn.
  function step(sign) {
    if (!myTurn(room.view) || local.raiseTo == null) return
    local.raiseTo += sign * room.view.blinds[1]
    local.typed = null
    drawTurn(room.view)
  }
  $('raise-less').addEventListener('click', () => step(-1))
  $('raise-more').addEventListener('click', () => step(1))
  $('call').addEventListener('click', () => {
    if (!myTurn(room.view)) return
    room.send({ type: turnOf(room.view).toCall === 0 ? 'check' : 'call' })
  })
  $('raise-btn').addEventListener('click', () => {
    if (!myTurn(room.view) || local.raiseTo == null) return
    room.send({ type: 'raise', to: local.raiseTo })
  })
  $('reveal').addEventListener('change', () => {
    if (!room.canAct()) return drawControls()
    local.reveal = $('reveal').checked
    room.send({ type: 'reveal', on: local.reveal })
  })
  $('pods').addEventListener('click', (event) => {
    if (event.target.closest('.btn.sit')) room.send({ type: 'sit' })
    const lend = event.target.closest('.btn.lend')
    const pod = lend && pods.find((p) => p.lend === lend)
    if (pod) {
      if (same(loan.to, pod.client)) closeLend()
      else openLend(pod.client)
    }
  })
  const sends = { leave: 'stand', start: 'start', rebuy: 'rebuy', fold: 'fold' }
  for (const [id, type] of Object.entries(sends)) {
    $(id).addEventListener('click', () => room.send({ type }))
  }

  // ── The lend popover ──────────────────────────────────────────────────────

  // By the broke player's plate: an amount box that behaves like the raise box (its text stays as
  // typed until it is left, Enter is pressed or a preset sets the amount; what would be sent is
  // held between the big blind and the viewer's chips meanwhile), presets and the Lend button.
  // It closes once the borrower has chips again (a lend that went through does that), when the
  // viewer can no longer lend, on Escape and on a click outside it.
  const pop = $('lend')
  const lendBox = $('lend-amount')

  function openLend(id) {
    const view = room.view
    if (!view || !lendable(view)) return
    loan.to = id
    loan.amount = Math.min(500, lendable(view))
    loan.typed = null
    drawControls()
    lendBox.focus()
  }
  function closeLend() {
    if (loan.to == null) return
    loan.to = null
    loan.typed = null
    pop.hidden = true
    if (room.view) drawControls()
  }

  // Below the plate, or above it when there is no room below, kept inside the frame.
  function placeLend(plateEl) {
    const rect = plateEl.getBoundingClientRect()
    const w = pop.offsetWidth
    const h = pop.offsetHeight
    let y = rect.bottom + 8
    if (y + h > innerHeight - 8) y = rect.top - h - 8
    const x = rect.left + rect.width / 2 - w / 2
    pop.style.left = `${Math.min(Math.max(8, x), Math.max(8, innerWidth - w - 8))}px`
    pop.style.top = `${Math.min(Math.max(8, y), Math.max(8, innerHeight - h - 8))}px`
  }

  function drawLend(view) {
    if (loan.to == null) {
      pop.hidden = true
      return
    }
    const most = lendable(view)
    const pod = podOf(loan.to)
    if (!most || !broke(view, loan.to) || !pod?.plate) {
      loan.to = null
      loan.typed = null
      pop.hidden = true
      for (const p of pods) p.lend.classList.remove('open')
      return
    }
    const least = view.blinds[1]
    loan.amount = Math.max(least, Math.min(most, Math.round(loan.amount)))
    const typed = loan.typed == null ? null : amountOf(loan.typed)
    $('lend-title').textContent = `Lend to ${room.nameOf(loan.to)}`
    if (loan.typed == null) lendBox.value = casino.money(loan.amount)
    lendBox.title = `${casino.money(least)} to ${casino.money(most)}`
    lendBox.disabled = !live()
    // Out of range (the red outline) the button reads just "Lend" and can't be pressed; the raise
    // box instead sends the clamped amount.
    const out = typed != null && (typed < least || typed > most)
    lendBox.classList.toggle('out', out)
    const send = $('lend-send')
    send.disabled = !room.canAct() || out || (loan.typed != null && typed == null)
    send.textContent = out ? 'Lend' : `Lend ${casino.money(loan.amount)}`
    for (const btn of $('lend-presets').children) btn.disabled = !live()
    pop.hidden = false
    placeLend(pod.plate)
  }

  const sendLend = () => {
    const view = room.view
    if (loan.to == null || !view || !lendable(view)) return
    room.send({ type: 'lend', to: String(loan.to), amount: loan.amount })
  }
  const settleLend = () => {
    loan.typed = null
    if (loan.to != null && room.view) drawLend(room.view)
  }
  lendBox.addEventListener('input', () => {
    if (loan.to == null || !room.view) return
    loan.typed = lendBox.value
    const n = amountOf(lendBox.value)
    if (n != null) loan.amount = n
    drawLend(room.view)
  })
  lendBox.addEventListener('change', settleLend)
  lendBox.addEventListener('blur', settleLend)
  lendBox.addEventListener('focus', () => setTimeout(() => lendBox.select()))
  lendBox.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Enter does what the button would: nothing while it is disabled (empty or out of range).
    if (loan.typed != null && $('lend-send').disabled) return
    settleLend()
    sendLend()
  })
  $('lend-presets').addEventListener('click', (event) => {
    const preset = event.target.closest('[data-lend]')?.dataset.lend
    if (!preset || loan.to == null || !room.view) return
    loan.amount = preset === 'all' ? lendable(room.view) : Number(preset)
    loan.typed = null
    drawLend(room.view)
  })
  $('lend-send').addEventListener('click', sendLend)
  // A press outside closes it; the Lend buttons on the plates open and close it themselves.
  addEventListener(
    'pointerdown',
    (event) => {
      if (loan.to == null || pop.contains(event.target)) return
      if (event.target.closest?.('.btn.lend')) return
      closeLend()
    },
    true
  )
  addEventListener('resize', () => loan.to != null && room.view && drawLend(room.view))

  // ── Floating tiles: the hands guide and the ledger ────────────────────────

  // Both float over the game on casino.tile (cards.js): dragged by the head, resized from the
  // corner, kept inside the frame, the one touched last on top.
  const handsTile = casino.tile($('hands'), $('hands-head'), 'right')
  const ledgerTile = casino.tile($('ledger'), $('ledger-head'), 'left')
  $('help').addEventListener('click', handsTile.toggle)
  $('hands-close').addEventListener('click', handsTile.close)
  $('ledger-btn').addEventListener('click', () => {
    ledgerTile.toggle()
    if (room.view) drawLedger(room.view)
  })
  $('ledger-close').addEventListener('click', ledgerTile.close)
  // Escape closes the lend popover first, then the tiles.
  addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    if (loan.to != null) return closeLend()
    handsTile.close()
    ledgerTile.close()
  })

  // ── The ledger ────────────────────────────────────────────────────────────

  // Everyone who sat down, highest net first: what they bought from the bank, the chips they hold,
  // what they lent (+) and borrowed (−), and the net the server worked out. Then each loan.
  function drawLedger(view) {
    if ($('ledger').hidden) return
    const net = view.net ?? {}
    const loans = view.loans
    const lent = new Map()
    const borrowed = new Map()
    for (const l of loans) {
      lent.set(String(l.from), (lent.get(String(l.from)) ?? 0) + l.amount)
      borrowed.set(String(l.to), (borrowed.get(String(l.to)) ?? 0) + l.amount)
    }
    const ids = Object.keys(net).sort((a, b) => netOf(view, b) - netOf(view, a))
    const cell = (text, className = '') => {
      const td = document.createElement('td')
      if (className) td.className = className
      if (text != null) td.textContent = text
      return td
    }
    const rows = ids.map((id) => {
      const tr = document.createElement('tr')
      tr.classList.toggle('me', same(id, room.you))
      const who = cell(null, 'who')
      const inner = span('who-inner')
      inner.append(room.avatarEl(id), span('who-name', room.nameOf(id)))
      who.append(inner)
      const loansCell = cell(null, 'loans')
      if (lent.has(id)) loansCell.append(span('lent', `+${casino.money(lent.get(id))}`))
      if (borrowed.has(id)) {
        loansCell.append(span('borrowed', `−${casino.money(borrowed.get(id))}`))
      }
      if (!loansCell.childElementCount) loansCell.append(span('none', '–'))
      const n = netOf(view, id)
      tr.append(
        who,
        cell(casino.money(view.bought[id] ?? 0)),
        cell(casino.money(chipsOf(view, id))),
        loansCell,
        cell(signed(n), `net${n > 0 ? ' up' : n < 0 ? ' down' : ''}`)
      )
      return tr
    })
    $('ledger-rows').replaceChildren(...rows)
    $('ledger-empty').hidden = ids.length > 0
    $('ledger-loans').replaceChildren(
      ...loans.map((l) => {
        const li = document.createElement('li')
        li.textContent = `${room.nameOf(l.from)} lent ${room.nameOf(l.to)} ${casino.money(l.amount)}`
        return li
      })
    )
  }

  // ── The hands guide ───────────────────────────────────────────────────────

  // Best first: an example of each category, its cards as rank and suit letter, with the kickers
  // (cards that only break ties) after a '|'.
  const GUIDE = [
    ['straight_flush', 'As Ks Qs Js Ts', 'Five in a row, all one suit. Ace high is a royal flush.'],
    ['four_of_a_kind', '9s 9h 9d 9c | Kh', 'Four cards of one rank.'],
    ['full_house', 'Qs Qh Qd 7c 7s', 'Three of one rank and a pair of another.'],
    ['flush', 'Kh Th 7h 4h 2h', 'Five of one suit, in any order.'],
    ['straight', '9c 8d 7s 6h 5c', 'Five in a row. The ace plays high or low: A 2 3 4 5.'],
    ['three_of_a_kind', '8s 8h 8d | Kc 3s', 'Three cards of one rank.'],
    ['two_pair', 'Js Jd 4c 4h | As', 'Two different pairs.'],
    ['pair', 'Th Tc | Ad 7s 3h', 'Two cards of one rank.'],
    ['high_card', 'Ad | Jc 8h 5s 2d', 'Nothing else: the highest card plays.']
  ]
  const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10 }
  const SUIT = { s: 'spades', h: 'hearts', d: 'diamonds', c: 'clubs' }
  for (const [category, hand, text] of GUIDE) {
    const dt = document.createElement('dt')
    let kicker = false
    for (const code of hand.split(' ')) {
      if (code === '|') {
        kicker = true
        continue
      }
      const el = casino.card({ rank: RANK[code[0]] ?? Number(code[0]), suit: SUIT[code[1]] })
      el.classList.toggle('kicker', kicker)
      dt.append(el)
    }
    const dd = document.createElement('dd')
    const b = document.createElement('b')
    b.textContent = CATEGORY[category][0]
    dd.append(b, text)
    $('legend').append(dt, dd)
  }

  room.onRender(() => {
    if (!room.connected) fresh = true
    const view = room.view
    if (!view) return
    if (view !== prev) drawSnapshot(view)
    else {
      for (const pod of pods) refreshPlate(pod)
      drawControls()
    }
  })
})()
