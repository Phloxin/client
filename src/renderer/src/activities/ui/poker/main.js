// No-limit Texas hold'em for 2 to 9 seats. Draws each snapshot on the casino helpers (cards.js):
// the board, the pot and nine pods around the oval with their plates, hole cards and street bets
// kept by key, and the moves the change from the snapshot before calls for. The dock holds the
// raise panel and the turn's buttons, and sends sit, stand, start, fold, check, call, raise,
// reveal and rebuy.
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
    no_free_seat: 'Every seat is taken'
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
    el.appendChild(sit)
    $('pods').appendChild(el)
    const q = (s) => el.querySelector(s)
    return {
      el,
      sit,
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
    text.append(name, span('plate-stack'))
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
  const local = { raiseTo: null, decision: '', presets: {}, reveal: null }
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
    }
    local.raiseTo = clamp(local.raiseTo ?? minTo)

    $('call').textContent =
      toCall === 0
        ? 'Check'
        : toCall === me.stack
          ? `All in ${casino.money(toCall)}`
          : `Call ${casino.money(toCall)}`
    $('raise').hidden = $('raise-btn').hidden = !canRaise
    const range = $('raise-range')
    range.min = String(minTo)
    range.max = String(maxTo)
    range.value = String(local.raiseTo)
    range.disabled = !live() || minTo === maxTo
    $('raise-less').disabled = range.disabled || local.raiseTo <= minTo
    $('raise-more').disabled = range.disabled || local.raiseTo >= maxTo
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
    for (const pod of pods) {
      pod.sit.hidden = pod.client != null || isSeated
      pod.sit.disabled = !act
    }
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

  function moves(a, b, m, kind) {
    const ha = a.hand
    const hb = b.hand
    if (kind === 'deal') {
      dealHand(b, m)
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

    // Stacks count to their new value: down at once, up when the chips land.
    for (const pod of pods) {
      if (!pod.plate) continue
      const was = chipsOf(a, pod.client)
      const now = chipsOf(b, pod.client)
      if (was === now) continue
      const delay = now > was ? (awards.get(String(pod.client)) ?? 0) : 0
      fx.count(stackOf(pod), was, now, { delay, duration: kind === 'idle' ? 400 : 300 })
    }
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

    if (kind) moves(a, view, m, kind)
    else for (const pod of pods) clearSay(pod)
    prev = view
  }

  // ── Input ─────────────────────────────────────────────────────────────────

  $('raise-range').addEventListener('input', () => {
    if (!myTurn(room.view)) return
    local.raiseTo = Number($('raise-range').value)
    drawTurn(room.view)
  })
  $('presets').addEventListener('click', (event) => {
    const preset = event.target.closest('[data-preset]')?.dataset.preset
    if (!preset || !myTurn(room.view)) return
    local.raiseTo = local.presets[preset]
    drawTurn(room.view)
  })
  // A big blind a press, clamped to the slider's range by drawTurn.
  const step = (sign) => {
    if (!myTurn(room.view) || local.raiseTo == null) return
    local.raiseTo += sign * room.view.blinds[1]
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
  })
  const sends = { leave: 'stand', start: 'start', rebuy: 'rebuy', fold: 'fold' }
  for (const [id, type] of Object.entries(sends)) {
    $(id).addEventListener('click', () => room.send({ type }))
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
