// The layer for two-seat round games whose view's `status` is waiting, playing { turn },
// won { winner, line } or draw, with a `rematch` action: the status line, Watching, Rematch,
// whose turn it is, and what leaving would cost. setup takes the two side names in seat order, as
// an array or as a function of the view returning one (for sides that swap between rounds), and
// the game's optional rules: forfeit(status), whether a `won` was a forfeit (default never), and
// statusText(status), a line of its own for a status (null or undefined: duel's own).
/* global bridge, room, seats */
;(() => {
  let sides = null
  let rules = {}
  const $ = (id) => document.getElementById(id)
  // The side names in seat order for the view held now.
  const sideList = () =>
    typeof sides === 'function' ? (room.view ? sides(room.view) : null) : sides

  room.rejections({
    not_your_turn: 'Not your turn',
    round_in_progress: 'Finish the round first',
    need_two_players: 'Waiting for a second player'
  })

  const status = () => room.view?.status
  const playing = () => status()?.kind === 'playing'
  const sideOf = (seat) => sideList()?.[seat]
  const seatOfSide = (side) => sideList()?.indexOf(side) ?? -1
  const myTurn = () =>
    !!room.view && playing() && room.view.seats[seatOfSide(status().turn)] === room.you
  // Seated players stay put while a round is on.
  const canStand = () => !playing()

  function statusText() {
    const s = status()
    const own = rules.statusText?.(s)
    if (own != null) return own
    if (s.kind === 'waiting') return 'Waiting for a second player'
    if (s.kind === 'draw') return 'Draw'
    if (s.kind === 'playing') {
      const seat = seatOfSide(s.turn)
      return room.view.seats[seat] === room.you ? 'Your turn' : `${seats.nameAt(seat)}'s turn`
    }
    if (s.kind === 'won') {
      const seat = seatOfSide(s.winner)
      const who = room.view.seats[seat] === room.you ? 'You won' : `${seats.nameAt(seat)} won`
      return rules.forfeit?.(s) ? `${who} by forfeit` : who
    }
    // A kind neither duel nor the game knows.
    return ''
  }

  $('action').addEventListener('click', () => room.send({ type: 'rematch' }))

  room.onRender(() => {
    if (!sides || !room.view) return
    bridge.setBusy(seats.isSeated() && playing())
    $('status').textContent = statusText()
    $('watching').hidden = seats.isSeated()
    const over = status().kind === 'won' || status().kind === 'draw'
    const full = room.view.seats.every((id) => id != null)
    $('action').hidden = !(over && full && seats.isSeated())
    $('action').disabled = !room.canAct()
  })

  window.duel = {
    setup(sideNames, options = {}) {
      sides = sideNames
      rules = options
    },
    sideOf,
    seatOfSide,
    myTurn,
    canStand
  }
})()
