// The layer for activities whose view has `seats` (client id or null, any number of them) and
// optionally `wins`: one seat plate per seat in the page's `.seats` row, Sit and Stand, the win
// counts. The game supplies per seat, through setup's options: badge(seat) (an element or
// null), label(seat) (an empty seat's name), active(seat) (highlighted), extra(seat) (an element
// or null after the name and wins, asked on every render), canSit() and canStand() (both default
// to always). emptySeats is 'all' (default) or 'one': the taken seats and, only when the viewer
// may sit, a single empty one. emptyLabel (default false) shows label(seat) on an empty plate.
/* global room */
;(() => {
  const TROPHY =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 21h8M12 17v4M7 4h10M17 4v8a5 5 0 0 1-10 0V4"/><circle cx="5" cy="9" r="2"/><circle cx="19" cy="9" r="2"/></svg>'
  let options = null
  // The plates already in the row, in the order shown, kept so a highlight change animates.
  const plates = []

  room.rejections({ no_free_seat: 'Every seat is taken' })

  const seatOf = (clientId) => (room.view?.seats ?? []).indexOf(clientId)
  const isSeated = () => room.you != null && seatOf(room.you) >= 0
  // The seat holder's name, or the game's name for the seat while it is empty.
  const nameAt = (seat) => {
    const id = room.view.seats[seat]
    return id == null ? options.label(seat) : room.nameOf(id)
  }

  function button(text, action) {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'btn'
    b.textContent = text
    b.disabled = !room.canAct()
    b.addEventListener('click', () => room.send(action))
    return b
  }

  function fill(plate, seat) {
    const id = room.view.seats[seat]
    plate.className = 'seat'
    plate.classList.toggle('empty', id == null)
    plate.classList.toggle('active', !!options.active?.(seat))
    plate.replaceChildren()

    const badge = options.badge?.(seat)
    if (badge) {
      const mark = document.createElement('span')
      mark.className = 'seat-mark'
      mark.appendChild(badge)
      plate.appendChild(mark)
    }

    if (id == null) {
      const avatar = document.createElement('span')
      avatar.className = 'avatar'
      plate.appendChild(avatar)
    } else {
      plate.appendChild(room.avatarEl(id))
    }

    const text = document.createElement('span')
    text.className = 'seat-text'
    if (id != null || options.emptyLabel) {
      const name = document.createElement('span')
      name.className = 'seat-name'
      name.textContent = nameAt(seat)
      text.appendChild(name)
    }
    if (id != null) {
      if (room.view.wins && typeof room.view.wins === 'object') {
        const wins = document.createElement('span')
        wins.className = 'seat-wins'
        wins.innerHTML = TROPHY
        wins.append(String(room.view.wins[id] ?? 0))
        text.appendChild(wins)
      }
    }
    plate.appendChild(text)

    const extra = options.extra?.(seat)
    if (extra) plate.appendChild(extra)

    if (id == null && !isSeated() && options.canSit())
      plate.appendChild(button('Sit', { type: 'sit' }))
    else if (id != null && id === room.you && options.canStand()) {
      plate.appendChild(button('Stand', { type: 'stand' }))
    }
  }

  // The seats that get a plate, in seat order.
  function shown() {
    const all = room.view.seats.map((_, seat) => seat)
    if (options.emptySeats !== 'one') return all
    const taken = all.filter((seat) => room.view.seats[seat] != null)
    const free = all.find((seat) => room.view.seats[seat] == null)
    if (free == null || isSeated() || !options.canSit()) return taken
    return taken.concat(free).sort((a, b) => a - b)
  }

  room.onRender(() => {
    const row = document.querySelector('.seats')
    if (!options || !room.view || !row) return
    const list = shown()
    while (plates.length < list.length) {
      const plate = document.createElement('div')
      plates.push(plate)
      row.appendChild(plate)
    }
    while (plates.length > list.length) plates.pop().remove()
    plates.forEach((plate, i) => fill(plate, list[i]))
  })

  window.seats = {
    setup(opts) {
      options = {
        canSit: () => true,
        canStand: () => true,
        emptySeats: 'all',
        emptyLabel: false,
        ...opts
      }
    },
    seatOf,
    isSeated,
    nameAt
  }
})()
