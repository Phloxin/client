// Connect 4: seat 0 is red, seat 1 is yellow, 7 columns of 6 with columns[c][0] at the bottom.
// The shared layers draw the seats, the status line and Rematch; this draws the board and sends
// `drop`.
/* global room, seats, duel */
;(() => {
  const COLUMNS = 7
  const ROWS = 6
  const SIDES = ['red', 'yellow']
  const SIDE_NAMES = { red: 'Red', yellow: 'Yellow' }
  const game = document.getElementById('game')
  const board = document.getElementById('board')

  // The view last drawn, and the move that arrived with the view after it, which falls in once.
  // A first or replayed view does not fall.
  let drawnView = null
  let falling = null

  const disc = (color, extra = '') => {
    const el = document.createElement('span')
    el.className = `disc ${color} ${extra}`.trim()
    return el
  }

  room.rejections({ column_full: 'That column is full' })
  duel.setup(SIDES, { forfeit: (s) => s.line == null })
  seats.setup({
    badge: (seat) => disc(duel.sideOf(seat)),
    label: (seat) => SIDE_NAMES[duel.sideOf(seat)],
    active: (seat) => seat === duel.seatOfSide(room.view.status.turn),
    canStand: duel.canStand
  })

  const full = (c) => room.view.columns[c][ROWS - 1] != null
  const canDrop = (c) => room.canAct() && duel.myTurn() && !full(c)

  // columns[c] = { button, ghost, slots[row] } with row 0 at the bottom.
  const columns = Array.from({ length: COLUMNS }, (_, c) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'column'
    button.style.gridColumn = String(c + 1)
    const ghostSlot = document.createElement('span')
    ghostSlot.className = 'slot ghost-slot'
    const ghost = disc('red', 'ghost')
    ghostSlot.appendChild(ghost)
    button.appendChild(ghostSlot)
    const slots = []
    for (let row = ROWS - 1; row >= 0; row--) {
      const slot = document.createElement('span')
      slot.className = 'slot'
      slots[row] = slot
      button.appendChild(slot)
    }
    button.addEventListener('click', () => {
      if (canDrop(c)) room.send({ type: 'drop', column: c })
    })
    board.appendChild(button)
    return { button, ghost, slots }
  })

  room.onRender(() => {
    const view = room.view
    if (!view) return
    game.hidden = false
    if (view !== drawnView) {
      const before = drawnView?.last ?? null
      const last = view.last ?? null
      const moved =
        drawnView != null &&
        last != null &&
        (before?.column !== last.column || before?.row !== last.row)
      falling = moved ? last : null
      drawnView = view
    }

    const line = view.status.kind === 'won' && view.status.line ? view.status.line : []
    const inLine = (c, r) => line.some((cell) => cell.column === c && cell.row === r)
    const last = view.last
    const mine = duel.sideOf(seats.seatOf(room.you)) ?? null

    columns.forEach(({ button, ghost, slots }, c) => {
      const open = canDrop(c)
      button.classList.toggle('open', open)
      button.disabled = !open
      ghost.className = `disc ${mine ?? 'red'} ghost`
      ghost.hidden = !open || !mine
      for (let r = 0; r < ROWS; r++) {
        const color = view.columns[c][r]
        const slot = slots[r]
        const current = slot.firstChild
        if (!color) {
          if (current) slot.replaceChildren()
          continue
        }
        const isLast = last != null && last.column === c && last.row === r
        const classes = ['disc', color]
        if (isLast) classes.push('last')
        if (inLine(c, r)) classes.push('win')
        let el = current
        if (!el || !el.classList.contains(color)) {
          el = disc(color)
          slot.replaceChildren(el)
        }
        // A fall already running keeps going through re-renders.
        if (el.classList.contains('drop')) classes.push('drop')
        if (falling && falling.column === c && falling.row === r) {
          falling = null
          classes.push('drop')
          el.style.setProperty('--fall', String(ROWS - r))
          el.addEventListener('animationend', () => el.classList.remove('drop'), { once: true })
        }
        el.className = classes.join(' ')
      }
    })
  })
})()
