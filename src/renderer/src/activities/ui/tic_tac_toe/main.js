// Tic-tac-toe: seat 0 is X, seat 1 is O, cell = row * 3 + column. The shared layers draw the
// seats, the status line and Rematch; this draws the board and sends `place`.
/* global room, seats, duel */
;(() => {
  const SIDES = ['x', 'o']
  const SIDE_NAMES = { x: 'X', o: 'O' }
  const SVG = {
    x: '<svg class="mark mark-x" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    o: '<svg class="mark mark-o" viewBox="0 0 24 24"><circle cx="12" cy="12" r="7"/></svg>'
  }
  const game = document.getElementById('game')
  const board = document.getElementById('board')

  const markEl = (side) => {
    const t = document.createElement('template')
    t.innerHTML = SVG[side]
    return t.content.firstChild
  }

  room.rejections({ cell_taken: 'That cell is taken' })
  duel.setup(SIDES, { forfeit: (s) => s.line == null })
  seats.setup({
    badge: (seat) => markEl(duel.sideOf(seat)),
    label: (seat) => SIDE_NAMES[duel.sideOf(seat)],
    active: (seat) => seat === duel.seatOfSide(room.view.status.turn),
    canStand: duel.canStand
  })

  const canPlace = (i) => room.canAct() && duel.myTurn() && room.view.board[i] == null

  const cells = Array.from({ length: 9 }, (_, i) => {
    const cell = document.createElement('button')
    cell.type = 'button'
    cell.className = 'cell'
    cell.dataset.mark = ''
    cell.addEventListener('click', () => {
      if (canPlace(i)) room.send({ type: 'place', cell: i })
    })
    board.appendChild(cell)
    return cell
  })

  room.onRender(() => {
    const view = room.view
    if (!view) return
    game.hidden = false
    const line = view.status.kind === 'won' && view.status.line ? view.status.line : []
    cells.forEach((cell, i) => {
      const mark = view.board[i] ?? ''
      if (cell.dataset.mark !== mark) {
        cell.dataset.mark = mark
        cell.innerHTML = mark ? SVG[mark] : ''
      }
      const open = canPlace(i)
      cell.classList.toggle('open', open)
      cell.classList.toggle('last', view.last === i)
      cell.classList.toggle('win', line.includes(i))
      cell.tabIndex = open ? 0 : -1
    })
  })
})()
