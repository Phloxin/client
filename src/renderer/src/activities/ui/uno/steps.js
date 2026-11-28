// Uno's rules as the bundle needs them, with no DOM: which card may be played, how a hand is
// sorted, who is next, and what happened between two snapshots as an ordered list the table can
// play. The server sends whole snapshots only, so the move is worked out here. One global,
// `unosteps`.
;(() => {
  const COLORS = ['red', 'yellow', 'green', 'blue']
  const FACE_ORDER = { number: 0, skip: 1, reverse: 2, draw_two: 3, wild: 4, wild_draw_four: 5 }
  const DECK = 108
  // The cards a draw card gives the next player.
  const PENALTY = { draw_two: 2, wild_draw_four: 4 }

  const same = (a, b) => a != null && b != null && String(a) === String(b)
  const kindOf = (view) => view?.status?.kind ?? 'waiting'

  // Whether `card` may go on `round`'s pile: a wild, the colour in play, or the top card's face.
  function playable(card, round) {
    if (!round?.top) return false
    if (card.color == null || card.color === round.color) return true
    if (card.face !== round.top.face) return false
    return card.face !== 'number' || card.number === round.top.number
  }

  const sortKey = (card) => [
    card.color == null ? COLORS.length : COLORS.indexOf(card.color),
    FACE_ORDER[card.face] ?? 9,
    card.number ?? 0,
    card.id
  ]

  // A hand in the order it is shown: by colour, then numbers before action cards, wilds last.
  function sorted(cards) {
    return [...cards].sort((a, b) => {
      const ka = sortKey(a)
      const kb = sortKey(b)
      for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return ka[i] - kb[i]
      return 0
    })
  }

  // The index `steps` turns from `from` among `n` players, going `direction`.
  const along = (from, steps, direction, n) =>
    direction === 'backward' ? (from + n - (steps % n)) % n : (from + steps) % n

  // The cards on the discard pile, the top one included.
  const discards = (round) => DECK - round.deck - round.players.reduce((sum, p) => sum + p.cards, 0)

  const samePlayers = (ra, rb) =>
    ra.players.length === rb.players.length &&
    ra.players.every((p, i) => same(p.client, rb.players[i].client))

  // The cards player `i` holds in `rb` and did not in `ra`; null for each one the viewer is not
  // shown.
  function gained(ra, rb, i, count) {
    const before = ra.players[i].hand
    const after = rb.players[i].hand
    if (!before || !after) return Array(count).fill(null)
    const had = new Set(before.map((c) => c.id))
    const cards = after.filter((c) => !had.has(c.id))
    return cards.length === count ? cards : Array(count).fill(null)
  }

  // What the change from snapshot `a` to `b` plays, or null when `b` is drawn as it is: there is
  // no round, or the change is not one move (snapshots were missed).
  //   fresh: `b` is a round `a` did not show; every card on the table before it is swept away.
  //   deal: for a fresh round, the cards in the order they are dealt, one to each player in turn:
  //     { client, card, index }, `card` null for a hand the viewer is not shown, `index` the
  //     card's place among that player's.
  //   steps: for any other change, in the order they happen:
  //     { kind: 'play', client, card, color, was }  a card went from a hand to the pile; `color`
  //       is the colour in play after it and `was` the one before.
  //     { kind: 'last', client }  that player is down to one card.
  //     { kind: 'reverse', direction }  the order of play turned, to `direction`.
  //     { kind: 'skip', client }  that player lost the turn to a skip, or to a reverse between
  //       two players.
  //     { kind: 'draw', client, cards, why }  cards went from the deck to a hand, in order, each
  //       null when the viewer is not shown it. `why` is 'draw_two' or 'wild_draw_four' for the
  //       player a draw card hit, who loses the turn as well, and 'turn' for a player who drew
  //       instead of playing (or whose turn the server played after they left). `cards` is empty
  //       when no card was left to draw.
  //     { kind: 'win', client }  the round ended; `client` is null when everyone had left.
  //   turn: who is to move in `b`, null when the round is over; was: who was in `a`, null when
  //     fresh.
  //   reshuffled: the discard pile under its top card went back into the deck.
  function diff(a, b) {
    const rb = b?.round
    if (!a || !rb) return null
    const ra = a.round
    const playing = kindOf(b) === 'playing'
    const turn = playing ? rb.turn : null

    if (!ra || kindOf(a) !== 'playing') {
      if (!playing) {
        return ra ? { fresh: false, deal: [], steps: [], turn, was: null, reshuffled: false } : null
      }
      const deal = []
      const most = Math.max(...rb.players.map((p) => p.cards))
      for (let index = 0; index < most; index++) {
        for (const p of rb.players) {
          if (p.cards > index) deal.push({ client: p.client, card: p.hand?.[index] ?? null, index })
        }
      }
      return { fresh: true, deal, steps: [], turn, was: null, reshuffled: false }
    }
    if (!samePlayers(ra, rb)) return null

    const n = ra.players.length
    const mover = ra.players.findIndex((p) => same(p.client, ra.turn))
    if (mover < 0) return null
    const delta = rb.players.map((p, i) => p.cards - ra.players[i].cards)
    const untouched = (...but) => delta.every((d, i) => d === 0 || but.includes(i))
    const steps = []
    let drawn = 0

    if (ra.top.id !== rb.top.id) {
      const card = rb.top
      if (delta[mover] !== -1) return null
      steps.push({ kind: 'play', client: ra.turn, card, color: rb.color, was: ra.color })
      if (!playing) {
        if (!same(b.status.winner, ra.turn) || !untouched(mover)) return null
        steps.push({ kind: 'win', client: ra.turn })
      } else {
        const direction =
          card.face !== 'reverse'
            ? ra.direction
            : ra.direction === 'forward'
              ? 'backward'
              : 'forward'
        if (rb.direction !== direction) return null
        if (rb.players[mover].cards === 1) steps.push({ kind: 'last', client: ra.turn })
        if (card.face === 'reverse') steps.push({ kind: 'reverse', direction })
        const next = along(mover, 1, direction, n)
        const penalty = PENALTY[card.face] ?? 0
        const skips = penalty > 0 || card.face === 'skip' || (card.face === 'reverse' && n === 2)
        if (penalty) {
          // Fewer than the penalty when the deck and the pile ran out.
          if (delta[next] < 0 || delta[next] > penalty) return null
          drawn = delta[next]
          steps.push({
            kind: 'draw',
            client: rb.players[next].client,
            cards: gained(ra, rb, next, drawn),
            why: card.face
          })
        } else if (skips) {
          steps.push({ kind: 'skip', client: rb.players[next].client })
        }
        if (!untouched(mover, penalty ? next : mover)) return null
        if (!same(rb.turn, rb.players[along(mover, skips ? 2 : 1, direction, n)].client)) {
          return null
        }
      }
    } else if (!playing) {
      if (b.status.winner != null || !untouched()) return null
      steps.push({ kind: 'win', client: null })
    } else if (!same(ra.turn, rb.turn)) {
      if (rb.direction !== ra.direction || delta[mover] < 0 || delta[mover] > 1) return null
      if (!untouched(mover)) return null
      if (!same(rb.turn, rb.players[along(mover, 1, ra.direction, n)].client)) return null
      drawn = delta[mover]
      steps.push({
        kind: 'draw',
        client: ra.turn,
        cards: gained(ra, rb, mover, drawn),
        why: 'turn'
      })
    } else if (rb.direction !== ra.direction || rb.color !== ra.color || !untouched()) {
      return null
    }

    return {
      fresh: false,
      deal: [],
      steps,
      turn,
      was: ra.turn,
      reshuffled: rb.deck > ra.deck - drawn
    }
  }

  window.unosteps = { COLORS, same, kindOf, playable, sorted, along, discards, diff }
})()
