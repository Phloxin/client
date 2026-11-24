// Chess: the seat playing white is `white_seat` and swaps every round. The shared layers draw the
// seats, the status line and Rematch; this draws the board from the FEN, the clocks in the seat
// plates, the promotion picker, Offer draw and Resign, and sends `move`. The pieces are the
// cburnett set from pieces.js.
/* global room, seats, duel, chessPieces */
;(() => {
  const FILES = 'abcdefgh'
  const KINDS = 'kqrbnp'
  const PROMOTIONS = [
    ['queen', 'q'],
    ['rook', 'r'],
    ['bishop', 'b'],
    ['knight', 'n']
  ]
  const SIDE_NAMES = { white: 'White', black: 'Black' }
  const WON_BY = { checkmate: ' by checkmate', resignation: ' by resignation', timeout: ' on time' }
  const DRAW_BY = {
    stalemate: 'Draw by stalemate',
    agreement: 'Draw by agreement',
    repetition: 'Draw by repetition',
    fifty_moves: 'Draw by the fifty-move rule',
    insufficient_material: 'Draw by insufficient material',
    timeout: 'Draw on time'
  }
  const CONFIRM_MS = 3000
  const TICK_MS = 200
  const LOW_MS = 30000

  const $ = (id) => document.getElementById(id)
  const game = $('game')
  const board = $('board')
  const controls = $('controls')
  const drawButton = $('draw')
  const resignButton = $('resign')

  // The square the viewer has picked up, the move waiting on the promotion picker, and whether
  // Resign is asking to be confirmed.
  let selected = null
  let promotion = null
  let confirmTimer = null

  // A piece as inline SVG, by colour ('white' or 'black') and kind letter.
  const pieceEl = (color, kind) => {
    const el = document.createElement('span')
    el.className = `piece ${color}`
    el.innerHTML = chessPieces[(color === 'white' ? 'w' : 'b') + kind]
    return el
  }

  const clocks = {
    white: Object.assign(document.createElement('span'), { className: 'clock' }),
    black: Object.assign(document.createElement('span'), { className: 'clock' })
  }

  room.rejections({
    illegal_move: "That move isn't allowed",
    bad_promotion: 'Pick a piece to promote to',
    out_of_time: 'Out of time',
    draw_already_offered: 'You already offered a draw'
  })

  // The viewer's name for a side's player, or null when it is the viewer.
  const playerOf = (side) => {
    const seat = duel.seatOfSide(side)
    return room.view.seats[seat] === room.you ? null : seats.nameAt(seat)
  }

  function statusText(s) {
    const view = room.view
    if (s.kind === 'won') {
      // A forfeit, or a way duel does not know, falls through to duel's own line.
      if (!Object.hasOwn(WON_BY, s.by)) return null
      const name = playerOf(s.winner)
      return (name == null ? 'You won' : `${name} won`) + WON_BY[s.by]
    }
    if (s.kind === 'draw') return Object.hasOwn(DRAW_BY, s.by) ? DRAW_BY[s.by] : null
    if (s.kind === 'playing' && (view.check || view.draw_offer)) {
      const name = playerOf(s.turn)
      let text = name == null ? 'Your turn' : `${name}'s turn`
      if (view.check) text += ', check'
      if (view.draw_offer) {
        const offerer = playerOf(view.draw_offer)
        text += offerer == null ? ' · You offered a draw' : ` · ${offerer} offers a draw`
      }
      return text
    }
    return null
  }

  duel.setup((view) => (view.white_seat === 0 ? ['white', 'black'] : ['black', 'white']), {
    forfeit: (s) => s.by === 'forfeit',
    statusText
  })
  seats.setup({
    badge: (seat) => pieceEl(duel.sideOf(seat), 'k'),
    label: (seat) => SIDE_NAMES[duel.sideOf(seat)],
    active: (seat) => seat === duel.seatOfSide(room.view.status.turn),
    extra: (seat) => clocks[duel.sideOf(seat)] ?? null,
    canStand: duel.canStand
  })

  // ── Position ──────────────────────────────────────────────────────────────

  // Square index: a1 is 0, h8 is 63, as the server counts them.
  const nameOf = (i) => FILES[i % 8] + (Math.floor(i / 8) + 1)
  const indexOf = (name) => (Number(name[1]) - 1) * 8 + FILES.indexOf(name[0])

  let parsedFen = null
  let position = null
  // The FEN's pieces by square index and its side to move.
  function parse(fen) {
    if (fen === parsedFen) return position
    const [placement = '', turn = 'w'] = String(fen).split(' ')
    const squares = Array(64).fill(null)
    placement.split('/').forEach((row, i) => {
      const rank = 7 - i
      let file = 0
      for (const ch of row) {
        if (ch >= '1' && ch <= '8') {
          file += Number(ch)
          continue
        }
        const kind = ch.toLowerCase()
        if (rank >= 0 && file < 8 && KINDS.includes(kind)) {
          squares[rank * 8 + file] = { color: ch === kind ? 'black' : 'white', kind }
        }
        file++
      }
    })
    parsedFen = fen
    position = { squares, turn: turn === 'b' ? 'black' : 'white' }
    return position
  }

  const mySide = () => duel.sideOf(seats.seatOf(room.you)) ?? null
  const canMove = () => room.canAct() && duel.myTurn()
  const targets = (from) => (from && room.view.legal?.[from]) || []

  // A pawn reaching the far rank.
  function promotes(from, to) {
    const piece = parse(room.view.fen).squares[indexOf(from)]
    return piece?.kind === 'p' && (to[1] === '8' || to[1] === '1')
  }

  function move(from, to) {
    if (promotes(from, to)) {
      promotion = { from, to }
      draw()
      board.querySelector('.promo-choice')?.focus()
      return
    }
    selected = null
    room.send({ type: 'move', from, to, promotion: null })
  }

  function pick(name) {
    if (selected && targets(selected).includes(name)) {
      move(selected, name)
      return
    }
    selected = name !== selected && targets(name).length ? name : null
    draw()
  }

  // ── Board ─────────────────────────────────────────────────────────────────

  const squares = Array.from({ length: 64 }, (_, i) => {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'square'
    el.dataset.square = nameOf(i)
    board.appendChild(el)
    return el
  })
  const picker = document.createElement('div')
  picker.className = 'promo'
  picker.hidden = true
  board.appendChild(picker)

  // Where a square sits on screen: white's side at the bottom, or black's when flipped.
  const cellOf = (i, flipped) => {
    const file = i % 8
    const rank = Math.floor(i / 8)
    return flipped ? { col: 8 - file, row: rank + 1 } : { col: file + 1, row: 8 - rank }
  }

  function drawPicker(flipped, color) {
    picker.hidden = !promotion
    if (!promotion) return
    const { col, row } = cellOf(indexOf(promotion.to), flipped)
    // Four squares from the target toward the middle of the board.
    picker.style.gridColumn = String(col)
    picker.style.gridRow = row <= 4 ? `${row} / span 4` : `${row - 3} / span 4`
    picker.classList.toggle('up', row > 4)
    if (picker.dataset.color !== color) {
      picker.dataset.color = color
      picker.replaceChildren(
        ...PROMOTIONS.map(([kind, letter]) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'promo-choice'
          b.dataset.kind = kind
          b.appendChild(pieceEl(color, letter))
          return b
        })
      )
    }
  }

  function draw() {
    const view = room.view
    if (!view) return
    game.hidden = false
    const { squares: pieces, turn } = parse(view.fen)
    const flipped = mySide() === 'black'

    // A selection or an open picker lasts only while the move is still there to make.
    if (!canMove() || !targets(selected).length) selected = null
    if (promotion && (!canMove() || !targets(promotion.from).includes(promotion.to))) {
      promotion = null
    }
    const marked = new Set(targets(selected))
    const last = view.moves?.length ? view.moves[view.moves.length - 1] : null
    const lastFrom = last ? indexOf(last.slice(0, 2)) : -1
    const lastTo = last ? indexOf(last.slice(2, 4)) : -1
    const movable = canMove()

    squares.forEach((el, i) => {
      const name = nameOf(i)
      const piece = pieces[i]
      const { col, row } = cellOf(i, flipped)
      el.style.gridColumn = String(col)
      el.style.gridRow = String(row)
      el.classList.toggle('dark', (i % 8) % 2 === Math.floor(i / 8) % 2)
      el.classList.toggle('last', i === lastFrom || i === lastTo)
      el.classList.toggle('check', !!view.check && piece?.kind === 'k' && piece.color === turn)
      el.classList.toggle('selected', name === selected)
      el.classList.toggle('target', marked.has(name) && !piece)
      el.classList.toggle('capture', marked.has(name) && !!piece)
      const open = movable && (targets(name).length > 0 || marked.has(name))
      el.classList.toggle('open', open)
      el.tabIndex = open ? 0 : -1

      const content = []
      if (piece) content.push(pieceEl(piece.color, piece.kind))
      if (col === 1) {
        const rank = Object.assign(document.createElement('span'), { className: 'coord rank' })
        rank.textContent = name[1]
        content.push(rank)
      }
      if (row === 8) {
        const file = Object.assign(document.createElement('span'), { className: 'coord file' })
        file.textContent = name[0]
        content.push(file)
      }
      el.replaceChildren(...content)
    })
    drawPicker(flipped, turn)
    drawControls()
    tick()
  }

  // ── Offer draw, Resign ────────────────────────────────────────────────────

  function stopConfirm() {
    clearTimeout(confirmTimer)
    confirmTimer = null
  }

  function drawControls() {
    const view = room.view
    const show = seats.isSeated() && view.status.kind === 'playing'
    controls.hidden = !show
    if (!show) stopConfirm()
    const offer = view.draw_offer ?? null
    const side = mySide()
    drawButton.textContent = offer && offer !== side ? 'Accept draw' : 'Offer draw'
    drawButton.disabled = !room.canAct() || (offer != null && offer === side)
    resignButton.textContent = confirmTimer ? 'Confirm resign' : 'Resign'
    resignButton.classList.toggle('confirm', !!confirmTimer)
    resignButton.disabled = !room.canAct()
  }

  drawButton.addEventListener('click', () => room.send({ type: 'offer_draw' }))
  resignButton.addEventListener('click', () => {
    if (confirmTimer) {
      stopConfirm()
      room.send({ type: 'resign' })
    } else {
      confirmTimer = setTimeout(() => {
        confirmTimer = null
        if (room.view) drawControls()
      }, CONFIRM_MS)
    }
    drawControls()
  })

  // ── Clocks ────────────────────────────────────────────────────────────────

  const pad = (n) => String(n).padStart(2, '0')
  // m:ss, h:mm:ss from an hour, tenths under ten seconds, 0:00 at zero.
  function clockText(ms) {
    if (ms <= 0) return '0:00'
    if (ms < 10000) {
      const tenths = Math.floor(ms / 100)
      return `0:0${Math.floor(tenths / 10)}.${tenths % 10}`
    }
    const s = Math.floor(ms / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
  }

  // The side whose clock is running, or null.
  function runningSide() {
    const view = room.view
    return view.status.kind === 'playing' && view.clock?.at_ms != null ? view.status.turn : null
  }

  function left(side) {
    const clock = room.view.clock
    let ms = Number(clock?.[`${side}_ms`]) || 0
    if (runningSide() === side) ms -= Date.now() + room.clockOffsetMs - clock.at_ms
    return Math.max(0, ms)
  }

  function tick() {
    if (!room.view) return
    const running = runningSide()
    for (const side of ['white', 'black']) {
      const ms = left(side)
      const el = clocks[side]
      const text = clockText(ms)
      if (el.textContent !== text) el.textContent = text
      el.classList.toggle('low', ms < LOW_MS)
      el.classList.toggle('running', side === running)
    }
  }

  // The running clock counts down between snapshots. Once the room is closed it stays where it is.
  setInterval(() => {
    if (!room.closed) tick()
  }, TICK_MS)

  // ── Input ─────────────────────────────────────────────────────────────────

  // One handler for the board, the picker and a click anywhere else.
  document.addEventListener('click', (event) => {
    if (!room.view) return
    const choice = event.target.closest('.promo-choice')
    if (choice && promotion) {
      const { from, to } = promotion
      promotion = null
      selected = null
      room.send({ type: 'move', from, to, promotion: choice.dataset.kind })
      draw()
      return
    }
    if (promotion) {
      promotion = null
      selected = null
      draw()
      return
    }
    const square = event.target.closest('.square')
    if (square && canMove()) {
      pick(square.dataset.square)
      return
    }
    if (selected) {
      selected = null
      draw()
    }
  })

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && promotion && room.view) {
      promotion = null
      draw()
    }
  })

  room.onRender(draw)
})()
