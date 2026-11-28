// Lucky Seven's rules as the bundle needs them, with no DOM: what a set of cards scores, how a
// hand is laid out, and what happened between two snapshots, as an ordered list the table can
// play. The server sends whole snapshots only, so the order is worked out here. One global,
// `l7steps`.
;(() => {
  const SEVEN = 7
  const SEVEN_BONUS = 15
  const GOAL = 200

  const same = (a, b) => a != null && b != null && String(a) === String(b)
  const kindOf = (view) => view?.status?.kind ?? 'waiting'
  const inGame = (view) => kindOf(view) === 'playing' || kindOf(view) === 'scoring'
  const isNumber = (card) => card.face === 'number'
  const isModifier = (card) => card.face === 'plus' || card.face === 'double'

  // The score of `cards` in `state`, as the server counts it, with its parts for the sum line.
  function tally(cards, state) {
    const values = cards.filter(isNumber).map((c) => c.value)
    const sum = values.reduce((a, b) => a + b, 0)
    const doubles = cards.filter((c) => c.face === 'double').length
    const plus = cards.filter((c) => c.face === 'plus').reduce((a, c) => a + c.value, 0)
    const bonus = state === 'seven' ? SEVEN_BONUS : 0
    const total = state === 'busted' ? 0 : sum * 2 ** doubles + plus + bonus
    return { values, sum, doubles, plus, bonus, total, unique: new Set(values).size }
  }

  // A hand in the order it is shown: numbers low to high, then the plus cards, the double, and
  // the action cards as they came.
  function arrange(cards) {
    const numbers = cards.filter(isNumber).sort((a, b) => a.value - b.value || a.id - b.id)
    const modifiers = cards
      .filter(isModifier)
      .sort((a, b) => (a.face === 'double') - (b.face === 'double') || a.value - b.value)
    const actions = cards.filter((c) => !isNumber(c) && !isModifier(c))
    return { numbers, extras: [...modifiers, ...actions] }
  }

  // The values a busted hand holds twice.
  function repeats(cards) {
    const seen = new Set()
    const twice = new Set()
    for (const c of cards.filter(isNumber)) (seen.has(c.value) ? twice : seen).add(c.value)
    return twice
  }

  const samePlayers = (ra, rb) =>
    ra.players.length === rb.players.length &&
    ra.players.every((p, i) => same(p.client, rb.players[i].client))

  // The players of `round`, starting left of the dealer: the order of the deal and of play.
  function dealOrder(round) {
    const at = round.players.findIndex((p) => same(p.client, round.dealer))
    const n = round.players.length
    return round.players.map((_, i) => round.players[(at + 1 + i) % n])
  }

  // What the change from snapshot `a` to `b` plays, or null when `b` is drawn as it is.
  //   fresh: `b` shows a round `a` did not; every card on the table before it is swept away.
  //   before: client -> the hand that player's moves start from.
  //   steps: in order. { kind: 'card', client, card, from: 'deck' | 'play' } for a card that came
  //     ('play' when it was the card waiting for a target). From the round's `spent` list,
  //     { kind: 'save', client, card, repeat } for a Second Chance (`card`) spent on a repeated
  //     number (`repeat`), and { kind: 'drop', client, card, from } for an action card discarded
  //     unplayed. Within a player's steps these follow the Flip Three that turned them up.
  //   stays: the clients who stayed without a card coming.
  //   pick: the action card now waiting for a target, when it was not waiting before.
  //   ended: the round ended in this change; gains: client -> the points it brought.
  //   reshuffled: the discard pile went back into the deck.
  function diff(a, b) {
    const rb = b?.round
    if (!a || !rb) return null
    const ra = a.round
    const fresh = !ra || ra.number !== rb.number || (!inGame(a) && inGame(b))
    if (!fresh && !samePlayers(ra, rb)) return null

    const before = new Map()
    const added = new Map()
    const stays = []
    for (const p of rb.players) {
      const was = fresh ? null : ra.players.find((q) => same(q.client, p.client))
      const old = was ?? { client: p.client, cards: [], state: 'active', score: 0 }
      before.set(String(p.client), old)
      const had = new Set(old.cards.map((c) => c.id))
      added.set(
        String(p.client),
        p.cards.filter((c) => !had.has(c.id))
      )
      if (old.state === 'active' && p.state === 'stayed' && !added.get(String(p.client)).length) {
        stays.push(p.client)
      }
    }

    const given = fresh ? null : (ra.choice?.card ?? null)
    const holder = given
      ? rb.players.find((p) => p.cards.some((c) => c.id === given.id))?.client
      : null
    // What left play since `a`, per client. The list only grows within a round.
    const gone = new Map()
    const repeats = new Map()
    for (const s of (rb.spent ?? []).slice(fresh ? 0 : (ra.spent ?? []).length)) {
      const id = String(s.client)
      if (!gone.has(id)) gone.set(id, [])
      if (s.why === 'repeat') {
        repeats.set(id, s.card)
      } else if (s.why === 'second_chance') {
        gone.get(id).push({
          kind: 'save',
          client: s.client,
          card: s.card,
          repeat: repeats.get(id) ?? null
        })
        repeats.delete(id)
      } else {
        const from = given && s.card.id === given.id ? 'play' : 'deck'
        gone.get(id).push({ kind: 'drop', client: s.client, card: s.card, from })
      }
    }

    const order = []
    const push = (client) => {
      if (client != null && !order.some((c) => same(c, client))) order.push(client)
    }
    push(holder)
    if (!fresh) push(ra.turn ?? ra.choice?.by)
    for (const p of dealOrder(rb)) push(p.client)

    const steps = []
    for (const client of order) {
      const cards = added.get(String(client)) ?? []
      const block = cards.map((card) => ({
        kind: 'card',
        client,
        card,
        from: given && card.id === given.id ? 'play' : 'deck'
      }))
      // What a Flip Three cost its target went after the card itself came, and a save after the
      // number it repeats when that number came in this change too.
      let at = cards.findIndex((c) => c.face === 'flip_three') + 1
      for (const step of gone.get(String(client)) ?? []) {
        const twin = step.repeat
          ? block.findIndex(
              (x) => x.kind === 'card' && isNumber(x.card) && x.card.value === step.repeat.value
            )
          : -1
        at = Math.max(at, twin + 1)
        block.splice(at, 0, step)
        at += 1
      }
      steps.push(...block)
    }

    const kind = kindOf(b)
    const ended = (kind === 'scoring' || kind === 'over') && (fresh || kindOf(a) === 'playing')
    const gains = new Map()
    if (ended) for (const p of rb.players) gains.set(String(p.client), p.score)

    const pick = rb.choice && (!given || given.id !== rb.choice.card.id) ? rb.choice.card : null
    const reshuffled = inGame(a) && b.deck > a.deck && b.discard < a.discard

    return { fresh, before, steps, stays, pick, ended, gains, reshuffled }
  }

  window.l7steps = {
    SEVEN,
    SEVEN_BONUS,
    GOAL,
    same,
    kindOf,
    inGame,
    isNumber,
    tally,
    arrange,
    repeats,
    dealOrder,
    diff
  }
})()
