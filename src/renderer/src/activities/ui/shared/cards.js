// Shared by the casino bundles (blackjack, poker): playing cards and chip stacks as elements, the
// turn-timer ring, a keyed child sync, and `stage`, which plays one render's moves over the table
// and ends them all at once when the next snapshot arrives. One global, `casino`. Styles are in
// casino.css.
;(() => {
  const RANK_TEXT = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' }
  const RANK_NAME = { 11: 'Jack', 12: 'Queen', 13: 'King', 14: 'Ace' }
  const DENOMS = [1000, 500, 100, 50, 25, 10, 5, 1]
  const STACK = 5
  const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)'
  const FADE_MS = 140
  const HOT_MS = 5000

  const SPRITE =
    '<svg class="casino-sprite" width="0" height="0" aria-hidden="true"><defs>' +
    '<symbol id="cs-hearts" viewBox="0 0 100 100"><path d="M50 91C22 68 6 50 6 32a22 22 0 0 1 44-6 22 22 0 0 1 44 6c0 18-16 36-44 59z"/></symbol>' +
    '<symbol id="cs-diamonds" viewBox="0 0 100 100"><path d="M50 4q16 26 36 46-20 20-36 46-16-26-36-46 20-20 36-46z"/></symbol>' +
    '<symbol id="cs-spades" viewBox="0 0 100 100"><path d="M50 5c0 0 42 34 42 57a21 21 0 0 1-38 12c2 9 6 16 12 21H34c6-5 10-12 12-21A21 21 0 0 1 8 62C8 39 50 5 50 5z"/></symbol>' +
    '<symbol id="cs-clubs" viewBox="0 0 100 100"><circle cx="50" cy="27" r="20"/><circle cx="27" cy="58" r="20"/><circle cx="73" cy="58" r="20"/><path d="M50 44c0 26-4 42-14 51h28c-10-9-14-25-14-51z"/><circle cx="50" cy="50" r="12"/></symbol>' +
    '<symbol id="cs-crown" viewBox="0 0 100 100"><path d="M10 70 6 28l24 20 20-30 20 30 24-20-4 42zM12 77h76v10H12z"/></symbol>' +
    '</defs></svg>'

  const L = 33
  const C = 50
  const R = 67
  // Pip centres for the number cards on a 100 by 140 face: [x, y, turned].
  const PIPS = {
    2: [
      [C, 30],
      [C, 110, 1]
    ],
    3: [
      [C, 30],
      [C, 70],
      [C, 110, 1]
    ],
    4: [
      [L, 30],
      [R, 30],
      [L, 110, 1],
      [R, 110, 1]
    ],
    5: [
      [L, 30],
      [R, 30],
      [C, 70],
      [L, 110, 1],
      [R, 110, 1]
    ],
    6: [
      [L, 30],
      [R, 30],
      [L, 70],
      [R, 70],
      [L, 110, 1],
      [R, 110, 1]
    ],
    7: [
      [L, 30],
      [R, 30],
      [C, 50],
      [L, 70],
      [R, 70],
      [L, 110, 1],
      [R, 110, 1]
    ],
    8: [
      [L, 30],
      [R, 30],
      [C, 50],
      [L, 70],
      [R, 70],
      [C, 90, 1],
      [L, 110, 1],
      [R, 110, 1]
    ],
    9: [
      [L, 30],
      [R, 30],
      [L, 57],
      [R, 57],
      [C, 70],
      [L, 83, 1],
      [R, 83, 1],
      [L, 110, 1],
      [R, 110, 1]
    ],
    10: [
      [L, 30],
      [R, 30],
      [C, 43],
      [L, 57],
      [R, 57],
      [L, 83, 1],
      [R, 83, 1],
      [C, 97, 1],
      [L, 110, 1],
      [R, 110, 1]
    ]
  }

  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)')
  const motion = {
    // true or false overrides the system setting; null follows it.
    force: null,
    get reduced() {
      return motion.force ?? motionQuery.matches
    }
  }

  const rankText = (rank) => RANK_TEXT[rank] ?? String(rank)
  const money = (n) => Number(n || 0).toLocaleString('en-US')

  function ensureSprite() {
    if (document.querySelector('.casino-sprite')) return
    document.body.insertAdjacentHTML('afterbegin', SPRITE)
  }

  const sym = (id, x, y, size, turned) =>
    `<use href="#cs-${id}" x="${x - size / 2}" y="${y - size / 2}" width="${size}" height="${size}"` +
    (turned ? ` transform="rotate(180 ${x} ${y})"` : '') +
    '/>'

  // A face has two drawings; casino.css shows `f-mini` on a card under 56 px wide and `f-full`
  // on the rest.
  function faceSvg(card) {
    const rank = rankText(card.rank)
    const suit = card.suit
    const ten = card.rank === 10 ? ' ten' : ''
    const index = `<text class="idx${ten}" x="13" y="26">${rank}</text>` + sym(suit, 13, 39, 14)
    let art
    if (card.rank === 14) {
      art = sym(suit, 50, 70, 46)
    } else if (card.rank > 10) {
      art =
        '<rect class="court" x="27" y="22" width="46" height="96" rx="5"/>' +
        (card.rank === 11 ? sym(suit, 50, 43, 20) : sym('crown', 50, 42, 26)) +
        (card.rank === 13 ? '<circle cx="50" cy="27.5" r="3.2"/>' : '') +
        `<text class="court-letter" x="50" y="100">${rank}</text>`
    } else {
      art = PIPS[card.rank].map(([x, y, turned]) => sym(suit, x, y, 17, turned)).join('')
    }
    return (
      '<svg viewBox="0 0 100 140" aria-hidden="true">' +
      `<g class="f-full">${index}<g transform="rotate(180 50 70)">${index}</g>${art}</g>` +
      `<g class="f-mini"><g class="wash">${sym(suit, 50, 97, 64)}</g>` +
      `<text class="big${ten}" x="27" y="53">${rank}</text>${sym(suit, card.rank === 10 ? 76 : 72, 33, card.rank === 10 ? 34 : 40)}</g>` +
      '</svg>'
    )
  }

  // Shows `card` on the element, or turns it face down for null. No animation; stage.flip plays
  // the turn.
  function setCard(el, card) {
    const code = card ? `${card.rank}${card.suit[0]}` : ''
    if (el.dataset.card === code) return
    el.dataset.card = code
    el.classList.toggle('down', !card)
    const face = el.querySelector('.card-face')
    if (!card) {
      face.replaceChildren()
      delete el.dataset.suit
      el.setAttribute('aria-label', 'Face-down card')
      return
    }
    el.dataset.suit = card.suit
    face.innerHTML = faceSvg(card)
    el.setAttribute('aria-label', `${RANK_NAME[card.rank] ?? card.rank} of ${card.suit}`)
  }

  // A card element, face down when `card` is null. Its width is the CSS variable --card-w.
  function card(card, key) {
    ensureSprite()
    const el = document.createElement('div')
    el.className = 'card'
    el.setAttribute('role', 'img')
    if (key != null) el.dataset.key = String(key)
    el.innerHTML =
      '<div class="card-in"><div class="card-face"></div><div class="card-back"></div></div>'
    setCard(el, card)
    return el
  }

  // The chips that show `amount`, largest first, at most `max`; the smallest are left out when
  // there are more, since the amount is written beside the stack.
  function chipsFor(amount, max) {
    const out = []
    let rest = Math.max(0, Math.floor(amount))
    for (const d of DENOMS) {
      while (rest >= d && out.length < max) {
        out.push(d)
        rest -= d
      }
    }
    return out
  }

  // Redraws a `.chips` element for `amount`: up to `stacks` towers of five.
  function setChips(el, amount, stacks = 1) {
    const mark = `${amount}/${stacks}`
    if (el.dataset.amount === mark) return
    el.dataset.amount = mark
    const list = chipsFor(amount, stacks * STACK)
    const towers = []
    for (let i = 0; i < list.length; i += STACK) {
      const tower = document.createElement('span')
      tower.className = 'stack'
      for (const d of list.slice(i, i + STACK)) {
        const chip = document.createElement('span')
        chip.className = 'chip'
        chip.dataset.d = String(d)
        tower.appendChild(chip)
      }
      towers.push(tower)
    }
    el.replaceChildren(...towers)
  }

  function chips(amount, stacks = 1) {
    const el = document.createElement('span')
    el.className = 'chips'
    setChips(el, amount, stacks)
    return el
  }

  // One large chip as a button, its value written on it, for the betting rack.
  function rackChip(denom) {
    const el = document.createElement('button')
    el.type = 'button'
    el.className = 'chip rack'
    el.dataset.d = String(denom)
    el.textContent = String(denom)
    el.setAttribute('aria-label', `Add ${denom}`)
    return el
  }

  function crown() {
    ensureSprite()
    const el = document.createElement('span')
    el.className = 'crown'
    el.title = 'Leader'
    el.innerHTML = '<svg viewBox="0 0 100 100" aria-hidden="true"><use href="#cs-crown"/></svg>'
    return el
  }

  // ── Turn timer ────────────────────────────────────────────────────────────

  const timers = new WeakMap()

  // The ring that goes around an avatar; `timer` runs it.
  function ring() {
    const el = document.createElement('span')
    el.className = 'ring'
    el.hidden = true
    const half = '<i><b></b></i><i><b></b></i>'
    el.innerHTML = `<span class="ring-ok">${half}</span><span class="ring-hot">${half}</span>`
    return el
  }

  // Runs the ring down to `untilMs` (server time; `offsetMs` is server minus local), as a share of
  // `totalMs`, and turns it to the danger colour for the last five seconds. null hides it. The
  // browser drives it from here; nothing is redrawn per tick.
  function timer(el, untilMs, offsetMs = 0, totalMs = 30000) {
    for (const anim of timers.get(el) ?? []) anim.cancel()
    timers.delete(el)
    el.hidden = untilMs == null
    if (untilMs == null) return
    const left = Math.max(0, untilMs - (Date.now() + offsetMs))
    const total = Math.max(totalMs, left, 1)
    const sweep = {
      duration: total,
      fill: 'both',
      easing: motion.reduced ? `steps(${Math.max(1, Math.round(total / 1000))})` : 'linear'
    }
    const first = [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(180deg)', offset: 0.5 },
      { transform: 'rotate(180deg)' }
    ]
    const second = [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(0deg)', offset: 0.5 },
      { transform: 'rotate(180deg)' }
    ]
    const hot = Math.max(0, 1 - HOT_MS / total)
    const anims = []
    for (const layer of el.children) {
      const [a, b] = layer.querySelectorAll('b')
      anims.push(a.animate(first, sweep), b.animate(second, sweep))
    }
    anims.push(
      el
        .querySelector('.ring-hot')
        .animate(
          [
            { opacity: 0 },
            { opacity: 0, offset: hot },
            { opacity: 1, offset: Math.min(1, hot + 0.004) },
            { opacity: 1 }
          ],
          { duration: total, fill: 'both' }
        )
    )
    for (const anim of anims) anim.currentTime = total - left
    timers.set(el, anims)
  }

  // ── Keyed children ────────────────────────────────────────────────────────

  // Makes `parent`'s children match `keys`, in order. A child whose data-key is wanted stays the
  // same element, `make(key)` builds a missing one, the rest are taken out. Returns the added
  // elements and the removed ones with the place each last had, for stage.fly.
  function sync(parent, keys, make) {
    const want = keys.map(String)
    const wanted = new Set(want)
    const have = new Map()
    const removed = []
    for (const el of [...parent.children]) {
      if (wanted.has(el.dataset.key)) {
        have.set(el.dataset.key, el)
      } else {
        removed.push({ el, rect: el.getBoundingClientRect() })
        el.remove()
      }
    }
    const added = []
    let prev = null
    for (const key of want) {
      let el = have.get(key)
      if (!el) {
        el = make(key)
        el.dataset.key = key
        added.push(el)
      }
      const next = prev ? prev.nextElementSibling : parent.firstElementChild
      if (next !== el) parent.insertBefore(el, next)
      prev = el
    }
    return { added, removed }
  }

  // ── Stage ─────────────────────────────────────────────────────────────────

  const boxOf = (x) => (x instanceof Element ? x.getBoundingClientRect() : (x ?? null))
  const midX = (r) => r.left + r.width / 2
  const midY = (r) => r.top + r.height / 2

  // The moves of one render. `layer` is the table's `.fx` element, which covers the table and
  // holds the copies that fly. Every call takes `delay` and `duration` in ms; the DOM is already in
  // its end state when a move is asked for, and `snap()` drops every move so only that end state
  // is left.
  function stage(layer) {
    const live = new Set()

    function job(end) {
      const j = {
        end() {
          if (live.delete(j)) end()
        }
      }
      live.add(j)
      return j
    }

    function play(el, frames, timing, after) {
      const anim = el.animate(frames, { fill: 'backwards', easing: EASE, ...timing })
      const j = job(() => {
        anim.onfinish = null
        anim.cancel()
        after?.()
      })
      anim.onfinish = () => j.end()
      return j
    }

    // Ends every running move now, in the order they were asked for.
    function snap() {
      for (const j of [...live]) j.end()
    }

    // Runs `fn` after `ms`, or at once on snap().
    function at(ms, fn) {
      const j = job(() => {
        clearTimeout(id)
        fn()
      })
      const id = setTimeout(() => j.end(), ms)
      return j
    }

    // Plays `el` from `frame` (transform and opacity) to how it is now. Until `delay` has passed
    // it shows `frame`.
    function from(el, frame, o = {}) {
      const delay = o.delay ?? 0
      const duration = o.duration ?? 220
      if (!motion.reduced) {
        return play(el, [{ ...frame, offset: 0 }], { delay, duration, easing: o.easing ?? EASE })
      }
      if ('opacity' in frame) {
        return play(el, [{ opacity: frame.opacity, offset: 0 }], {
          delay,
          duration: Math.min(duration, FADE_MS),
          easing: 'linear'
        })
      }
      return play(el, [{ ...frame, offset: 0 }], { delay, duration: 1, easing: 'steps(1, end)' })
    }

    // An entrance: 'fade', 'pop' (grows in) or 'rise' (comes up into place).
    function show(el, o = {}) {
      const frame = { opacity: 0 }
      if (o.kind === 'pop') frame.transform = 'scale(0.5)'
      if (o.kind === 'rise') frame.transform = 'translateY(40%)'
      return from(el, frame, { duration: 200, ...o })
    }

    // Turns a card over where it lies: it shows its other side until `delay`, then turns to the
    // side it has now.
    function flip(cardEl, o = {}) {
      const inner = cardEl.querySelector('.card-in')
      const other = cardEl.classList.contains('down') ? 'rotateY(0deg)' : 'rotateY(180deg)'
      return from(inner, { transform: other }, { duration: 320, easing: 'ease-in-out', ...o })
    }

    // A move without a change of state: 'shake', 'bump' or 'blink'.
    function pulse(el, kind, o = {}) {
      if (motion.reduced) return null
      const frames = {
        shake: [0, -4, 4, -3, 3, 0].map((x) => ({ transform: `translateX(${x}px)` })),
        bump: [1, 1.2, 1].map((s) => ({ transform: `scale(${s})` })),
        blink: [1, 0.25, 1, 0.25, 1].map((opacity) => ({ opacity }))
      }[kind]
      return play(el, frames, {
        delay: o.delay ?? 0,
        duration: o.duration ?? 380,
        easing: 'ease-in-out',
        fill: 'none',
        composite: kind === 'blink' ? 'replace' : 'add'
      })
    }

    // Counts the number in `el` from `a` to `b`. It shows `a` until `delay`.
    function count(el, a, b, o = {}) {
      const format = o.format ?? money
      const delay = o.delay ?? 0
      const duration = motion.reduced ? 0 : (o.duration ?? 400)
      const start = performance.now() + delay
      let frame = 0
      el.textContent = format(a)
      const j = job(() => {
        cancelAnimationFrame(frame)
        el.textContent = format(b)
      })
      const tick = (now) => {
        const t = duration ? (now - start) / duration : now >= start ? 1 : 0
        if (t >= 1) return j.end()
        if (t > 0) el.textContent = format(Math.round(a + (b - a) * t))
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      return j
    }

    // Remembers where `els` are; the function it returns, called after the DOM has changed,
    // slides each one from where it was to where it is.
    function mark(els) {
      const before = new Map()
      for (const el of els) before.set(el, el.getBoundingClientRect())
      return (o = {}) => {
        if (motion.reduced) return
        for (const [el, was] of before) {
          if (!el.isConnected) continue
          const now = el.getBoundingClientRect()
          const dx = was.left - now.left
          const dy = was.top - now.top
          if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue
          play(el, [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
            delay: o.delay ?? 0,
            duration: o.duration ?? 260,
            composite: 'add'
          })
        }
      }
    }

    // Flies a copy of `el` over the table from `from` to `to`, each an element, a rect, or left
    // out for the place `el` has now.
    //   Arriving (no `to`): `el` is in its new place and stays hidden until the copy lands; the
    //     copy is not seen before `delay`.
    //   Leaving (a `to`): `el` may already be out of the DOM, in which case `from` is the rect it
    //     had; the copy waits at `from` in view until `delay`, then goes.
    //   wait: 'hidden' | 'shown' says otherwise about the time before `delay`.
    //   fade: 'out' fades the copy at the end of its way.
    //   turn: 'onway' turns a card over as it flies, to the side `el` shows now; 'later' flies it
    //     showing its other side, for a stage.flip that follows.
    //   spin, tilt: the degrees the copy starts and ends turned by.
    //   match: scale the copy to the widths of `from` and `to` (a card leaving a deck of another
    //     size). chip: the --chip size in px for a detached chip stack.
    //   auto: a detached `el` keeps the size its content gives it, not the size of `from`.
    //   cover: another element to keep hidden while the copy is out.
    function fly(el, o = {}) {
      const arriving = o.to == null
      const own = el.isConnected ? el.getBoundingClientRect() : null
      const a = boxOf(o.from) ?? own
      const b = boxOf(o.to) ?? own
      const auto = !own && !!o.auto
      const w = own ? el.offsetWidth : a.width
      const h = own ? el.offsetHeight : a.height
      const delay = o.delay ?? 0
      const cover = o.cover ?? (arriving ? el : null)
      const hidden = (o.wait ?? (arriving ? 'hidden' : 'shown')) === 'hidden'

      if (motion.reduced && arriving) {
        const j = from(el, { opacity: 0 }, { delay })
        if (o.cover) hide(o.cover, j)
        return j
      }

      const ghost = el.cloneNode(true)
      ghost.classList.add('ghost')
      ghost.removeAttribute('id')
      const base = layer.getBoundingClientRect()
      ghost.style.visibility = ''
      ghost.style.left = `${midX(b) - (auto ? 0 : w / 2) - base.left}px`
      ghost.style.top = `${midY(b) - (auto ? 0 : h / 2) - base.top}px`
      if (!auto) {
        ghost.style.width = `${w}px`
        ghost.style.height = `${h}px`
      }
      if (own) ghost.style.fontSize = getComputedStyle(el).fontSize
      if (ghost.classList.contains('card')) ghost.style.setProperty('--card-w', `${w}px`)
      const chip = own ? el.querySelector('.chip')?.offsetWidth : o.chip
      if (chip) ghost.style.setProperty('--chip', `${chip}px`)
      layer.appendChild(ghost)

      const widthOf = (x, r) => (x instanceof Element ? x.offsetWidth : r.width)
      const place = (x, r, turn) =>
        `translate(${midX(r) - midX(b)}px, ${midY(r) - midY(b)}px)` +
        (auto ? ' translate(-50%, -50%)' : '') +
        ` rotate(${turn}deg)` +
        (o.match && !auto ? ` scale(${widthOf(x ?? el, r) / w})` : '')
      const start = place(o.from, a, o.spin ?? 0)
      const end = place(o.to, b, o.tilt ?? 0)
      let frames
      let duration = o.duration ?? 380
      if (motion.reduced) {
        frames = [
          { transform: start, opacity: 1 },
          { transform: start, opacity: 0 }
        ]
        duration = FADE_MS
      } else {
        frames = [
          { transform: start, opacity: hidden ? 0 : 1 },
          { transform: start, opacity: 1, offset: hidden ? 0.02 : 0 },
          { opacity: 1, offset: o.fade === 'out' ? 0.7 : 1 },
          { transform: end, opacity: o.fade === 'out' ? 0 : 1 }
        ]
        const inner = o.turn && ghost.querySelector('.card-in')
        if (inner) {
          const down = ghost.classList.contains('down')
          const other = down ? 'rotateY(0deg)' : 'rotateY(180deg)'
          const shown = o.turn === 'later' ? other : down ? 'rotateY(180deg)' : 'rotateY(0deg)'
          inner.animate(
            [{ transform: other }, { transform: other, offset: 0.35 }, { transform: shown }],
            { delay, duration, fill: 'both', easing: 'ease-in-out' }
          )
        }
      }
      const j = play(
        ghost,
        frames,
        { delay, duration, easing: o.easing ?? EASE, fill: 'both' },
        () => ghost.remove()
      )
      if (cover) hide(cover, j)
      return j
    }

    // Keeps `el` out of sight until the move `j` ends.
    function hide(el, j) {
      el.style.visibility = 'hidden'
      const end = j.end
      j.end = () => {
        if (!live.has(j)) return
        el.style.visibility = ''
        end()
      }
    }

    return {
      snap,
      at,
      from,
      show,
      flip,
      pulse,
      count,
      mark,
      fly,
      get busy() {
        return live.size > 0
      }
    }
  }

  window.casino = {
    card,
    setCard,
    chips,
    setChips,
    rackChip,
    crown,
    ring,
    timer,
    sync,
    stage,
    motion,
    money,
    rankText
  }
})()
