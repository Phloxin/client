// The layer for two-seat round games whose view's `status` is waiting, playing { turn },
// won { winner, winner_client, line }, draw or aborted { never_moved, never_moved_client } (the
// *_client id names the player), with a `rematch` action and a `rematch` list of the players who
// have asked for the next round: the status line, Watching, Rematch,
// whose turn it is, and what leaving would cost. The next round starts once both players ask.
// setup takes the two side names in seat order, as an array or as a function of the view
// returning one (for sides that swap between rounds), and the game's optional rules:
// forfeit(status), whether a `won` was a forfeit (default never), and statusText(status), a line
// of its own for a status (null or undefined: duel's own).
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
  const over = () => ['won', 'draw', 'aborted'].includes(status()?.kind)
  const sideOf = (seat) => sideList()?.[seat]
  const seatOfSide = (side) => sideList()?.indexOf(side) ?? -1
  const myTurn = () =>
    !!room.view && playing() && room.view.seats[seatOfSide(status().turn)] === room.you
  // Seated players stay put while a round is on.
  const canStand = () => !playing()

  // Whether a client has asked for the next round.
  const voted = (id) => id != null && room.view.rematch.map(String).includes(String(id))
  // The seat of the viewer's opponent, or -1.
  const opponentSeat = () => room.view.seats.findIndex((id) => id != null && id !== room.you)

  // The name of the player a finished round's result is about, or null when it is the viewer.
  // By client id, not seat, since a newcomer may sit in that seat after the round.
  const resultPlayer = (clientId) =>
    String(clientId) === String(room.you) ? null : room.nameOf(clientId)

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
      const name = resultPlayer(s.winner_client)
      const who = name == null ? 'You won' : `${name} won`
      return rules.forfeit?.(s) ? `${who} by forfeit` : who
    }
    if (s.kind === 'aborted') {
      const name = resultPlayer(s.never_moved_client)
      return `Aborted: ${name ?? 'you'} never moved`
    }
    // A kind neither duel nor the game knows.
    return ''
  }

  // The round's line, then who wants a rematch while the viewer has not asked for one.
  function statusLine() {
    const text = statusText()
    if (!over() || voted(room.you)) return text
    const asking = room.view.seats.filter((id) => id != null && id !== room.you && voted(id))
    if (asking.length !== 1) return text
    const wants = `${room.nameOf(asking[0])} wants a rematch`
    return text ? `${text} · ${wants}` : wants
  }

  $('action').addEventListener('click', () => room.send({ type: 'rematch' }))

  room.onRender(() => {
    if (!sides || !room.view) return
    bridge.setBusy(seats.isSeated() && playing())
    $('status').textContent = statusLine()
    $('watching').hidden = seats.isSeated()
    const full = room.view.seats.every((id) => id != null)
    const action = $('action')
    action.hidden = !(over() && full && seats.isSeated())
    if (action.hidden) return
    const opponent = opponentSeat()
    if (voted(room.you)) {
      action.textContent = `Waiting for ${seats.nameAt(opponent)}`
      action.disabled = true
    } else {
      action.textContent = voted(room.view.seats[opponent]) ? 'Accept rematch' : 'Rematch'
      action.disabled = !room.canAct()
    }
  })

  window.duel = {
    setup(sideNames, options = {}) {
      sides = sideNames
      rules = options
    },
    sideOf,
    seatOfSide,
    resultPlayer,
    myTurn,
    canStand
  }
})()
