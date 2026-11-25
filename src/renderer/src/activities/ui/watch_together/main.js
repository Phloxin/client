// Watch Together: a theatre where the room watches a queue
// of YouTube videos in sync. The shell hosts the video under this frame (shared/player.js); this
// leaves the scene's screen transparent over it, keeps the local player on the room's position
// (sync.js), and lays the viewers' portraits, the seats' hit targets, the control bar, the queue
// and the reactions over the illustrated house (scene.js).
/* global bridge, room, player, watchSync, icons, theatreScene */
;(() => {
  const $ = (id) => document.getElementById(id)
  const { icon } = icons
  const sync = watchSync

  // The scene: the art, the screen and the 40 seat anchors, in scene units.
  const S = theatreScene
  const ANCHORS = new Map(S.seats.map((a) => [a.seat, a]))
  const FULL_VIEW = { x: 0, y: 0, width: S.width, height: S.height }
  // Under this house width the scene is cropped to its middle.
  const CROP_UNDER = 560
  // Under this house width the bar is one row, with a "more" popover.
  const NARROW_UNDER = 480
  // The bar's foot on the stage's front edge and the zone it may take above it, in scene units,
  // and its height cap in px.
  const BAR_FOOT_Y = 690
  const BAR_ZONE = 90
  const BAR_MAX_H = 40
  const STANDING_H = 28
  const RATES = [25, 50, 75, 100, 125, 150, 175, 200]
  const EMOJI = [
    '\u{1F44F}',
    '\u{1F602}',
    '\u{1F62E}',
    '\u{1F622}',
    '\u{2764}\u{FE0F}',
    '\u{1F525}',
    '\u{1F389}',
    '\u{1F44E}'
  ]
  const REACTION_GAP_MS = 250
  const REACTION_MS = 2000
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)')
  const BAR_HIDE_MS = 3000
  const KEY_SEEK_MS = 5000
  const COLUMN_MIN_WIDTH = 720
  const MAX_STANDING_AVATARS = 5
  const CONTROL_LOCKED = 'Only the leader can control playback'

  room.rejections({
    not_leader: 'Only the leader can do that',
    controls_locked: CONTROL_LOCKED,
    not_yours: 'You can only remove videos you added',
    bad_video: "That isn't a YouTube link",
    queue_full: 'The queue is full',
    too_many_queued: 'You have 10 videos queued already',
    unknown_entry: 'That video is no longer in the queue',
    nothing_playing: 'Nothing is playing',
    seat_taken: 'That seat is taken',
    not_in_room: 'They left the room',
    adding_locked: 'Only the leader can add videos',
    bad_rate: "That speed isn't available"
  })

  // ── State ────────────────────────────────────────────────────────────────

  // The viewer's own: theatre, expanded or fullscreen, and what fullscreen was
  // entered from.
  let viewMode = 'theatre'
  let beforeFullscreen = 'theatre'
  let queueOpen = false
  let columnHidden = false
  let historyOpen = false
  let speedOpen = false
  let reactOpen = false
  let moreOpen = false
  let seatCard = null
  let volume = 100
  let muted = false
  let ready = false
  let status = null
  let statusAt = 0
  let mem = sync.initialMemory()
  let scrubbing = null
  let barTimer = null
  let barHidden = false
  let lastReactionAt = -Infinity
  let addBusy = false
  let addMessage = ''
  let dragging = null

  const view = () => room.view
  const current = () => view()?.current ?? null
  const now = () => Date.now() + room.clockOffsetMs
  const isLeader = () => view() != null && view().leader === room.you
  const canControl = () => isLeader() || view()?.controls === 'everyone'
  const canAdd = () => isLeader() || view()?.adding !== 'leader'
  const live = () => room.connected && !room.closed
  const expanded = () => viewMode !== 'theatre'

  // ── Small builders ───────────────────────────────────────────────────────

  function el(tag, className, ...children) {
    const e = document.createElement(tag)
    if (className) e.className = className
    for (const c of children) if (c != null) e.append(c)
    return e
  }
  function button(className, content, onClick, title) {
    const b = el('button', className)
    b.type = 'button'
    if (content != null) b.append(content)
    if (title) {
      b.title = title
      b.setAttribute('aria-label', title)
    }
    if (onClick) b.addEventListener('click', onClick)
    return b
  }
  // What is inside a control is replaced only when what it shows changes, so a
  // redraw between a press and its release never takes away the element that was pressed.
  const shownAs = new WeakMap()
  function rebuild(host, key, build) {
    const k = JSON.stringify(key)
    if (shownAs.get(host) === k) return
    shownAs.set(host, k)
    host.replaceChildren()
    build()
  }
  const setIcon = (host, name) => rebuild(host, name, () => host.append(icon(name)))
  // What a client looks like here: the avatar and name drawn for them.
  const who = (id) => [id, room.nameOf(id), room.avatarOf(id)]
  const iconButton = (name, onClick, title) => {
    const b = button('icon-btn', null, onClick, title)
    setIcon(b, name)
    return b
  }

  function formatTime(ms) {
    const s = Math.max(0, Math.floor(ms / 1000))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const ss = String(s % 60).padStart(2, '0')
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
  }
  const rateLabel = (rate) => `${rate / 100}×`
  const thumb = (videoId) => {
    const img = el('img', 'thumb')
    img.alt = ''
    img.loading = 'lazy'
    img.src = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`
    return img
  }
  const titleOf = (entry) => entry.title || 'YouTube video'

  // ── The house ────────────────────────────────────────────────────────────

  const app = $('app')
  const houseEl = $('house')
  const sceneBox = $('scene-box')
  const screenEl = $('screen')
  const standingEl = $('standing')
  const barSlot = $('bar-slot')
  const flyLayer = $('fly')
  const seatEls = new Map()

  // The scene's markup, once. Its lights and curtains switch by class on its root.
  $('scene-host').innerHTML = S.svg
  const sceneSvg = $('scene-host').querySelector('svg')
  const NS = 'http://www.w3.org/2000/svg'
  // The count over the scene's closed curtains.
  const countText = document.createElementNS(NS, 'text')
  for (const [k, v] of Object.entries({
    x: S.screen.x + S.screen.width / 2,
    y: S.screen.y + S.screen.height / 2 + 10,
    'text-anchor': 'middle',
    'dominant-baseline': 'central',
    'font-family': 'Noto Serif, Georgia, serif',
    'font-weight': '900',
    'font-size': '300',
    fill: '#f2c14e',
    stroke: '#3a1606',
    'stroke-width': '10',
    'paint-order': 'stroke',
    style: 'filter:drop-shadow(0 8px 10px rgba(0,0,0,.5))'
  }))
    countText.setAttribute(k, String(v))
  sceneSvg.querySelector('#wt-overlay').append(countText)
  // The pause glyph on the scrim.
  $('scrim').append(icon('player-pause-filled'))

  const cropped = () => !expanded() && houseEl.clientWidth < CROP_UNDER
  const narrow = () => !expanded() && houseEl.clientWidth < NARROW_UNDER
  const viewBoxNow = () => (cropped() ? S.crop : FULL_VIEW)
  // A seat is on show when the scene has its anchor and the crop does not leave it out.
  const drawn = (seat) => {
    const a = ANCHORS.get(seat)
    return !!a && (!cropped() || a.section === 'orchestra')
  }

  // One hit target per anchor, laid over the scene; layout() places them.
  const chairs = $('chairs')
  for (const a of S.seats) {
    const seatEl = el('button', 'chair')
    seatEl.type = 'button'
    seatEl.dataset.seat = String(a.seat)
    seatEl.dataset.section = a.section
    seatEl.addEventListener('click', (e) => onSeatClick(a.seat, seatEl, e))
    chairs.append(seatEl)
    seatEls.set(a.seat, seatEl)
  }

  function onSeatClick(seat, seatEl, e) {
    e.stopPropagation()
    const v = view()
    if (!v) return
    const holder = v.seats[seat]
    if (holder == null) {
      closeSeatCard()
      room.send({ type: 'sit', seat })
      return
    }
    seatCard = seatCard?.seat === seat ? null : { seat, client: holder }
    render()
  }
  const closeSeatCard = () => {
    if (!seatCard) return
    seatCard = null
    render()
  }

  function renderSeats() {
    const v = view()
    const clients = room.clients
    for (const [seat, seatEl] of seatEls) {
      const holder = v.seats[seat] ?? null
      seatEl.hidden = !drawn(seat)
      if (holder == null) {
        seatEl.className = 'chair empty'
        seatEl.title = 'Sit here'
        seatEl.disabled = !live()
        rebuild(seatEl, null, () => {})
        continue
      }
      const classes = ['chair', 'taken']
      if (holder === room.you) classes.push('mine')
      if (!clients.includes(holder)) classes.push('dimmed')
      seatEl.className = classes.join(' ')
      seatEl.disabled = false
      seatEl.title = room.nameOf(holder)
      const leads = holder === v.leader
      const cannotPlay = (v.unplayable ?? []).includes(holder)
      rebuild(seatEl, [who(holder), leads, cannotPlay], () => {
        seatEl.append(room.avatarEl(holder))
        if (leads) seatEl.append(el('span', 'crown', icon('crown-filled')))
        if (cannotPlay) seatEl.append(el('span', 'warn', icon('alert-triangle')))
      })
    }
    // Everyone without a seat on show stands at the back; in the crop that
    // includes the boxes, as "+N more".
    const seated = new Set()
    v.seats.forEach((id, seat) => id != null && drawn(seat) && seated.add(id))
    const standing = v.audience.filter((id) => !seated.has(id))
    standingEl.hidden = standing.length === 0 || expanded()
    const shown = standing.slice(0, MAX_STANDING_AVATARS)
    const label = cropped() ? `+${standing.length} more` : `+${standing.length} standing`
    rebuild(standingEl, standing.length ? [shown.map(who), label] : null, () => {
      if (!standing.length) return
      const stack = el('span', 'stack')
      for (const id of shown) {
        const a = room.avatarEl(id)
        a.title = room.nameOf(id)
        stack.append(a)
      }
      standingEl.append(stack, el('span', 'standing-count', label))
    })
  }

  function renderSeatCard() {
    const card = $('seat-card')
    const v = view()
    if (!seatCard || !v || v.seats[seatCard.seat] !== seatCard.client) {
      seatCard = null
      card.hidden = true
      return
    }
    const seatEl = seatEls.get(seatCard.seat)
    const canPass = isLeader() && seatCard.client !== room.you
    rebuild(card, [who(seatCard.client), canPass, room.canAct()], () => {
      card.append(el('div', 'seat-card-name', room.nameOf(seatCard.client)))
      if (!canPass) return
      const make = button('btn', 'Make leader', () => {
        const to = seatCard.client
        seatCard = null
        room.send({ type: 'pass_leader', to })
      })
      make.disabled = !room.canAct()
      card.append(make)
    })
    card.hidden = false
    const r = seatEl.getBoundingClientRect()
    const w = card.offsetWidth
    const h = card.offsetHeight
    card.style.left = `${Math.max(4, Math.min(innerWidth - w - 4, r.left + r.width / 2 - w / 2))}px`
    const above = r.top - h - 6
    card.style.top = `${above >= 4 ? above : r.bottom + 6}px`
  }

  // ── The stage and the screen ─────────────────────────────────────────────

  function errorText(code) {
    if (code === 100) return 'This video is unavailable'
    if (code === 101 || code === 150) return "This video can't be played outside YouTube"
    return 'This video failed to play'
  }

  function renderScreen() {
    const cur = current()
    const v = view()
    const t = now()
    const msg = $('screen-msg')
    let opaque = true
    let message = false
    if (!cur) {
      rebuild(msg, 'nothing', () =>
        msg.append(
          el('div', 'screen-title', 'Nothing playing'),
          el('div', 'screen-sub', 'Add a video to start')
        )
      )
      message = true
    } else if (mem.error != null && mem.loadedEntry === cur.entry.id) {
      const n = (v.unplayable ?? []).length
      const key = ['error', errorText(mem.error), n, v.audience.length, isLeader(), room.canAct()]
      rebuild(msg, key, () => {
        msg.append(el('div', 'screen-title', errorText(mem.error)))
        if (n > 0)
          msg.append(el('div', 'screen-sub', `${n} of ${v.audience.length} can't play this`))
        if (isLeader()) {
          const skip = button('btn primary', 'Skip', () => room.send({ type: 'skip' }))
          skip.disabled = !room.canAct()
          msg.append(skip)
        } else {
          msg.append(el('div', 'screen-sub', 'Waiting for the leader to skip'))
        }
      })
      message = true
    } else if (mem.stalled) {
      rebuild(msg, 'stalled', () =>
        msg.append(
          el('div', 'screen-title', 'Playback stalled'),
          button('btn primary', 'Retry', () => {
            mem = sync.retry(mem)
            reconcile()
          })
        )
      )
      message = true
    } else {
      rebuild(msg, null, () => {})
      opaque = false
    }
    msg.hidden = !message
    screenEl.classList.toggle('opaque', opaque)
    // The curtains are drawn across the screen through the lead-in: the scene's own in the
    // theatre, the drapes in the expanded view.
    const seconds = sync.leadInSeconds(cur, t)
    const leadIn = seconds > 0 && !message
    screenEl.classList.toggle('closed', leadIn)
    $('countdown').textContent = leadIn ? String(seconds) : ''
    sceneSvg.classList.toggle('wt-curtains-closed', leadIn)
    countText.textContent = leadIn ? String(seconds) : ''
    // The house lights are down only while a video plays.
    sceneSvg.classList.toggle('wt-lights-dim', !!cur && cur.playing && !sync.inLeadIn(cur, t))
    // The pause scrim.
    $('scrim').hidden = !(cur && !cur.playing && !message)
    screenEl.classList.toggle('can-control', !!cur && canControl() && live() && !message)
  }

  // ── The control bar ──────────────────────────────────────────────────────

  const bar = $('bar')
  const playBtn = iconButton('player-play-filled', () => togglePlay(), 'Play')
  const playLock = el('span', 'lock-badge', icon('lock'))
  const playWrap = el('span', 'play-wrap', playBtn, playLock)
  const timeEl = el('span', 'time')
  const scrub = el('input', 'scrub')
  scrub.type = 'range'
  scrub.min = '0'
  scrub.step = '1000'
  const muteBtn = iconButton(
    'volume',
    () => {
      muted = !muted
      player.setVolume(volume, muted)
      render()
    },
    'Mute'
  )
  const volumeEl = el('input', 'volume')
  volumeEl.type = 'range'
  volumeEl.min = '0'
  volumeEl.max = '100'
  volumeEl.setAttribute('aria-label', 'Volume')
  const speedBtn = button('speed-btn', '1×', () => {
    if (!canControl() || !current()) return
    speedOpen = !speedOpen
    render()
  })
  const speedMenu = el('div', 'menu speed-menu')
  speedMenu.hidden = true
  const lockBtn = iconButton('lock-open', () => {
    if (!isLeader()) return
    room.send({ type: 'set_controls', who: view().controls === 'leader' ? 'everyone' : 'leader' })
  })
  const reactBtn = iconButton(
    'mood-smile',
    () => {
      reactOpen = !reactOpen
      render()
    },
    'Reactions'
  )
  const reactMenu = el('div', 'menu react-menu')
  reactMenu.hidden = true
  // Speed, the controls lock and the reactions go in here when the bar is narrow.
  const moreBtn = iconButton(
    'dots',
    () => {
      moreOpen = !moreOpen
      render()
    },
    'More'
  )
  const moreMenu = el('div', 'menu more-menu')
  moreMenu.hidden = true
  const moreAnchor = el('span', 'menu-anchor more-anchor', moreBtn, moreMenu)
  const reactionsRow = el('div', 'reactions-row')
  const speedAnchor = el('span', 'menu-anchor speed-anchor', speedBtn, speedMenu)
  const reactAnchor = el('span', 'menu-anchor react-anchor', reactBtn, reactMenu)
  const queueBtn = iconButton(
    'list',
    () => {
      if (columnMode()) columnHidden = !columnHidden
      else queueOpen = !queueOpen
      render()
    },
    'Queue'
  )
  const expandBtn = iconButton(
    'arrows-maximize',
    () => setView(viewMode === 'theatre' ? 'expanded' : 'theatre'),
    'Expand'
  )
  const fullBtn = iconButton(
    'maximize',
    () => player.setFullscreen(viewMode !== 'fullscreen'),
    'Full screen'
  )
  bar.append(
    playWrap,
    timeEl,
    scrub,
    el('span', 'volume-group', muteBtn, volumeEl),
    speedAnchor,
    lockBtn,
    reactAnchor,
    moreAnchor,
    queueBtn,
    expandBtn,
    fullBtn,
    reactionsRow
  )

  // Where speed, the lock and the reactions sit: 'bar' (all in the bar, the reactions at its
  // right end), 'reactions' (the reactions in More) or 'narrow' (all three in More).
  let barArrangement = null
  function arrangeBar(mode) {
    if (mode === barArrangement) return
    barArrangement = mode
    if (mode === 'narrow') {
      moreMenu.append(speedAnchor, lockBtn, reactionsRow)
    } else {
      // Moved only out of More: a node moved under a press loses its click.
      if (speedAnchor.parentNode !== bar) bar.insertBefore(speedAnchor, reactAnchor)
      if (lockBtn.parentNode !== bar) bar.insertBefore(lockBtn, reactAnchor)
      if (mode === 'bar') bar.append(reactionsRow)
      else moreMenu.append(reactionsRow)
    }
  }
  for (const rate of RATES) {
    speedMenu.append(
      button('menu-item', rateLabel(rate), () => {
        speedOpen = false
        if (rate !== (current()?.rate ?? 100)) room.send({ type: 'set_rate', rate })
        render()
      })
    )
  }
  const reactButtons = (container, after) => {
    for (const emoji of EMOJI) {
      container.append(
        button('emoji', emoji, () => {
          react(emoji)
          after?.()
        })
      )
    }
  }
  reactButtons(reactionsRow, () => {
    if (!moreOpen) return
    moreOpen = false
    render()
  })
  reactButtons(reactMenu, () => {
    reactOpen = false
    render()
  })

  scrub.addEventListener('input', () => {
    scrubbing = Number(scrub.value)
    renderBar()
  })
  scrub.addEventListener('change', () => {
    const to = Number(scrub.value)
    scrubbing = null
    if (canControl() && current()) room.send({ type: 'seek', position_ms: Math.round(to) })
    renderBar()
  })
  volumeEl.addEventListener('input', () => {
    volume = Number(volumeEl.value)
    if (volume > 0) muted = false
    player.setVolume(volume, muted)
    renderBar()
  })

  const durationMs = () =>
    status && mem.loadedEntry === current()?.entry.id ? status.durationMs : 0

  function renderBar() {
    const cur = current()
    const control = canControl() && live() && !!cur
    const roomPlaying = !!cur && cur.playing
    setIcon(playBtn, roomPlaying ? 'player-pause-filled' : 'player-play-filled')
    const playTitle = canControl() ? (roomPlaying ? 'Pause' : 'Play') : CONTROL_LOCKED
    playBtn.title = playTitle
    playBtn.setAttribute('aria-label', playTitle)
    playBtn.disabled = !control
    playLock.hidden = canControl()
    const duration = durationMs()
    const position = scrubbing ?? Math.min(sync.targetMs(cur, now()), duration || Infinity)
    timeEl.textContent = cur
      ? mem.live
        ? formatTime(position)
        : `${formatTime(position)} / ${formatTime(duration)}`
      : '0:00 / 0:00'
    scrub.hidden = mem.live
    scrub.max = String(Math.max(duration, 1))
    if (scrubbing == null) scrub.value = String(cur ? Math.round(position) : 0)
    scrub.disabled = !control || duration === 0
    scrub.title = canControl() ? '' : CONTROL_LOCKED
    scrub.style.setProperty(
      '--fill',
      `${duration ? (Math.min(position, duration) / duration) * 100 : 0}%`
    )
    bar.classList.toggle('locked', !canControl())
    setIcon(muteBtn, muted || volume === 0 ? 'volume-off' : 'volume')
    const muteTitle = muted ? 'Unmute' : 'Mute'
    muteBtn.title = muteTitle
    muteBtn.setAttribute('aria-label', muteTitle)
    volumeEl.value = String(muted ? 0 : volume)
    speedBtn.textContent = rateLabel(cur?.rate ?? 100)
    speedBtn.classList.toggle('inert', !canControl() || !cur)
    speedBtn.title = canControl() ? 'Speed' : CONTROL_LOCKED
    speedBtn.setAttribute('aria-label', `Speed ${rateLabel(cur?.rate ?? 100)}`)
    speedMenu.hidden = !(speedOpen && canControl() && cur)
    for (const item of speedMenu.children)
      item.classList.toggle('on', item.textContent === rateLabel(cur?.rate ?? 100))
    const locked = view()?.controls === 'leader'
    setIcon(lockBtn, locked ? 'lock' : 'lock-open')
    const lockTitle = locked
      ? isLeader()
        ? 'Only you can control playback'
        : CONTROL_LOCKED
      : 'Everyone can control playback'
    lockBtn.title = lockTitle
    lockBtn.setAttribute('aria-label', lockTitle)
    lockBtn.disabled = !isLeader() || !room.canAct()
    lockBtn.classList.toggle('on', locked)
    reactAnchor.hidden = !expanded()
    reactMenu.hidden = !(reactOpen && expanded())
    // In the expanded view the smiley holds the reactions, and More is not used.
    const more = !expanded() && barArrangement !== 'bar'
    moreAnchor.hidden = !more
    moreMenu.hidden = !(moreOpen && more)
    moreBtn.classList.toggle('on', moreOpen && more)
    reactionsRow.hidden = expanded()
    queueBtn.classList.toggle('on', columnMode() ? !columnHidden : queueOpen)
    setIcon(expandBtn, viewMode === 'theatre' ? 'arrows-maximize' : 'arrows-minimize')
    const expandTitle = viewMode === 'theatre' ? 'Expand' : 'Theatre'
    expandBtn.title = expandTitle
    expandBtn.setAttribute('aria-label', expandTitle)
    setIcon(fullBtn, viewMode === 'fullscreen' ? 'minimize' : 'maximize')
    const fullTitle = viewMode === 'fullscreen' ? 'Exit full screen' : 'Full screen'
    fullBtn.title = fullTitle
    fullBtn.setAttribute('aria-label', fullTitle)
    fitMore()
  }

  // The More popover, anchored to the More button, is moved sideways as far as it
  // takes to stay inside the frame.
  const MENU_EDGE = 4
  function fitMore() {
    moreMenu.style.translate = ''
    if (moreMenu.hidden) return
    const r = moreMenu.getBoundingClientRect()
    if (!r.width) return
    const dx = Math.max(0, MENU_EDGE - r.left) || Math.min(0, innerWidth - MENU_EDGE - r.right)
    if (dx) moreMenu.style.translate = `${dx}px 0`
  }

  function togglePlay() {
    const cur = current()
    if (!cur || !canControl()) return
    room.send({ type: cur.playing ? 'pause' : 'play' })
  }

  function seekBy(deltaMs) {
    const cur = current()
    if (!cur || !canControl() || mem.live) return
    const duration = durationMs()
    let to = sync.targetMs(cur, now()) + deltaMs
    to = Math.max(0, duration ? Math.min(duration, to) : to)
    room.send({ type: 'seek', position_ms: Math.round(to) })
  }

  // In expanded and fullscreen the bar hides after 3 s without pointer movement.
  function wakeBar() {
    clearTimeout(barTimer)
    if (barHidden) {
      barHidden = false
      app.classList.remove('bar-hidden')
    }
    if (!expanded()) return
    barTimer = setTimeout(() => {
      if (speedOpen || reactOpen || moreOpen || scrubbing != null) return wakeBar()
      barHidden = true
      app.classList.add('bar-hidden')
    }, BAR_HIDE_MS)
  }
  document.addEventListener('pointermove', wakeBar)
  document.addEventListener('pointerdown', wakeBar)

  // ── Views ────────────────────────────────────────────────────────────────

  function setView(next) {
    viewMode = next
    if (next === 'theatre') queueOpen = false
    speedOpen = false
    reactOpen = false
    moreOpen = false
    app.dataset.view = next
    // One bar: on the stage lip in the theatre, over the bottom of the video otherwise.
    ;(expanded() ? screenEl : barSlot).append(bar)
    wakeBar()
    render()
  }

  player.onFullscreen((on) => {
    if (on && viewMode !== 'fullscreen') {
      beforeFullscreen = viewMode
      setView('fullscreen')
    } else if (!on && viewMode === 'fullscreen') {
      setView(beforeFullscreen)
    }
  })

  // ── Layout ───────────────────────────────────────────────────────────────

  const columnMode = () => viewMode === 'theatre' && innerWidth >= COLUMN_MIN_WIDTH

  const box = (e, x, y, w, h) =>
    Object.assign(e.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` })

  // The scene fitted to the house by width, the space above it in the arch's
  // darkest wood and below it in the carpet's colour; a house wider than the scene fits it by
  // height instead, with the sides in the wood. The screen, the seats' targets and the bar are
  // laid over it from the scene's own coordinates. Nothing scrolls.
  function layout() {
    const W = houseEl.clientWidth
    const H = houseEl.clientHeight
    if (!W || !H) return
    app.classList.toggle('narrow', narrow())
    app.classList.toggle('cropped', cropped())
    if (expanded()) {
      const sw = Math.min(W, (H * 16) / 9)
      const sh = (sw * 9) / 16
      box(screenEl, (W - sw) / 2, (H - sh) / 2, sw, sh)
      arrangeBar('bar')
      place()
      return
    }
    const vb = viewBoxNow()
    const standH = standingEl.hidden ? 0 : STANDING_H
    let k = W / vb.width
    if (vb.height * k + standH > H) k = (H - standH) / vb.height
    const w = vb.width * k
    const h = vb.height * k
    const left = (W - w) / 2
    const top = Math.max(0, (H - standH - h) / 2)
    sceneSvg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`)
    box(sceneBox, left, top, w, h)
    box($('fill-top'), 0, 0, W, top)
    box($('fill-bottom'), 0, top + h, W, H - top - h)
    box($('fill-left'), 0, top, left, h)
    box($('fill-right'), left + w, top, W - left - w, h)
    const sx = (x) => left + (x - vb.x) * k
    const sy = (y) => top + (y - vb.y) * k
    box(screenEl, sx(S.screen.x), sy(S.screen.y), S.screen.width * k, S.screen.height * k)
    for (const [seat, seatEl] of seatEls) {
      const a = ANCHORS.get(seat)
      const d = 2 * S.portraitRadius * a.scale * k
      box(seatEl, (a.x - vb.x) * k - d / 2, (a.y - vb.y) * k - d / 2, d, d)
      seatEl.style.setProperty('--d', `${d}px`)
    }
    box(standingEl, 0, top + h + 2, W, Math.max(0, standH - 4))
    // The bar along the stage's front edge, as wide as the screen and wider when
    // it needs to be, never over the screen.
    const bh = Math.min(BAR_MAX_H, BAR_ZONE * k)
    app.style.setProperty('--bar-h', `${bh}px`)
    const minW = S.screen.width * k
    const maxW = W - 8
    Object.assign(barSlot.style, {
      left: `${sx(S.screen.x + S.screen.width / 2)}px`,
      top: `${sy(BAR_FOOT_Y) - bh}px`,
      height: `${bh}px`,
      minWidth: `${Math.min(minW, maxW)}px`
    })
    if (narrow()) {
      arrangeBar('narrow')
      barSlot.style.maxWidth = `${maxW}px`
      barSlot.style.width = `${Math.min(minW, maxW)}px`
    } else {
      // The reactions at the bar's right end when the bar can hold them, otherwise in More.
      // The bar is measured with the reactions in it. When they are in More, a copy stands in
      // for them while it is measured, so nothing a press may be on is moved.
      if (barArrangement !== 'reactions') arrangeBar('bar')
      barSlot.style.maxWidth = 'none'
      barSlot.style.width = 'max-content'
      const stand =
        barArrangement === 'reactions' ? bar.appendChild(reactionsRow.cloneNode(true)) : null
      const fits = barSlot.offsetWidth <= maxW
      stand?.remove()
      arrangeBar(fits ? 'bar' : 'reactions')
      barSlot.style.maxWidth = `${maxW}px`
    }
    fitMore()
    place()
  }

  let placed = ''
  function place() {
    const cur = current()
    const showing = !!cur && mem.loadedEntry === cur.entry.id
    const r = screenEl.getBoundingClientRect()
    const rect =
      showing && r.width > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null
    const key = JSON.stringify(rect && Object.values(rect).map(Math.round))
    if (key === placed) return
    placed = key
    player.place(rect)
  }

  new ResizeObserver(() => {
    layout()
    render()
  }).observe(document.body)

  // ── The queue ────────────────────────────────────────────────────────────

  const queueEl = $('queue')
  const nowEl = $('now')
  const addInput = $('add-input')
  const addBtn = $('add-btn')
  const addLock = $('add-lock')
  const addMsg = $('add-msg')
  const upCount = $('up-count')
  const upList = $('up-list')
  const clearBtn = $('clear-btn')
  const playedToggle = $('played-toggle')
  const playedCount = $('played-count')
  const playedList = $('played-list')

  addBtn.addEventListener('click', () => addLink())
  addInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLink()
  })
  addInput.addEventListener('input', () => {
    if (!addMessage) return
    addMessage = ''
    renderQueue()
  })
  setIcon(addLock, 'lock-open')
  addLock.addEventListener('click', () => {
    if (!isLeader()) return
    room.send({ type: 'set_adding', who: view().adding === 'leader' ? 'everyone' : 'leader' })
  })
  clearBtn.addEventListener('click', () => room.send({ type: 'clear' }))
  const queueClose = $('queue-close')
  setIcon(queueClose, 'x')
  queueClose.addEventListener('click', () => {
    queueOpen = false
    render()
  })
  // The Played toggle's chevron is the only part of it that changes.
  playedToggle.append(icon('chevron-right'), el('span', null, 'Played'), playedCount)
  let playedChevron = 'chevron-right'
  playedToggle.addEventListener('click', () => {
    historyOpen = !historyOpen
    renderQueue()
  })

  async function addLink() {
    if (addBusy || !canAdd() || !room.canAct()) return
    const videoId = sync.parseVideoLink(addInput.value)
    if (!videoId) {
      addMessage = "That isn't a YouTube link"
      renderQueue()
      return
    }
    addBusy = true
    addMessage = ''
    renderQueue()
    const { title, playable } = await player.describe(videoId)
    addBusy = false
    if (!playable) {
      addMessage = "That video can't be played here"
      renderQueue()
      return
    }
    addInput.value = ''
    renderQueue()
    room.send({ type: 'add', video_id: videoId, title: title ?? '' })
  }

  function adder(entry) {
    const a = room.avatarEl(entry.added_by)
    return el('span', 'adder', a, el('span', 'adder-name', room.nameOf(entry.added_by)))
  }

  // A queue or history row: the thumbnail, the title over the adder and the row's actions.
  function entryRow(entry, actions) {
    const row = el('li', 'entry')
    row.dataset.entry = String(entry.id)
    const title = el('div', 'entry-title', titleOf(entry))
    title.title = titleOf(entry)
    const text = el('div', 'entry-text', title, el('div', 'entry-meta', adder(entry), actions))
    row.append(thumb(entry.video_id), text)
    return row
  }

  function renderNow() {
    const cur = current()
    const v = view()
    nowEl.hidden = !cur
    if (!cur) {
      rebuild(nowEl, null, () => {})
      return
    }
    const votes = (v.skip_votes ?? []).length
    const voted = (v.skip_votes ?? []).includes(room.you)
    const { entry } = cur
    const key = [entry.id, entry.video_id, entry.title, who(entry.added_by)]
    key.push(isLeader(), votes, v.skip_needed, voted, room.canAct())
    rebuild(nowEl, key, () => {
      const actions = el('div', 'now-actions')
      const count = el('span', 'vote-count', `${votes}/${v.skip_needed}`)
      if (isLeader()) {
        const skip = button('btn', 'Skip', () => room.send({ type: 'skip' }))
        skip.disabled = !room.canAct()
        actions.append(skip)
        if (votes > 0) actions.append(count)
      } else {
        const vote = button(`btn${voted ? ' on' : ''}`, voted ? 'Voted' : 'Vote to skip', () =>
          room.send({ type: 'vote_skip', on: !voted })
        )
        vote.disabled = !room.canAct()
        actions.append(vote, count)
      }
      nowEl.append(
        el('div', 'section-title', 'Now playing'),
        el(
          'div',
          'now-body',
          thumb(entry.video_id),
          el('div', 'entry-text', el('div', 'entry-title', titleOf(entry)), adder(entry))
        ),
        actions
      )
    })
  }

  function renderQueue() {
    const v = view()
    renderNow()
    const lockedOut = !canAdd()
    addInput.disabled = lockedOut || addBusy || !live()
    addInput.placeholder = lockedOut ? 'Only the leader can add videos' : 'Paste a YouTube link'
    addBtn.disabled = lockedOut || addBusy || !live()
    addLock.hidden = !isLeader()
    const addLocked = v.adding === 'leader'
    setIcon(addLock, addLocked ? 'lock' : 'lock-open')
    const addTitle = addLocked ? 'Only you can add videos' : 'Everyone can add videos'
    addLock.title = addTitle
    addLock.setAttribute('aria-label', addTitle)
    addLock.classList.toggle('on', addLocked)
    addLock.disabled = !room.canAct()
    addMsg.textContent = addMessage

    upCount.textContent = String(v.queue.length)
    const rowKey = (entry) => [entry.id, entry.video_id, entry.title, who(entry.added_by)]
    const upKey = [isLeader(), room.you, room.canAct(), v.queue.map(rowKey)]
    rebuild(upList, upKey, () => renderUpList(v))
    clearBtn.hidden = !(isLeader() && v.queue.length > 0)
    clearBtn.disabled = !room.canAct()

    const history = v.history ?? []
    playedCount.textContent = String(history.length)
    const chevron = historyOpen ? 'chevron-down' : 'chevron-right'
    if (chevron !== playedChevron) {
      playedChevron = chevron
      playedToggle.firstChild.replaceWith(icon(chevron))
    }
    playedToggle.setAttribute('aria-expanded', String(historyOpen))
    playedList.hidden = !historyOpen
    rebuild(playedList, [lockedOut, room.canAct(), history.map(rowKey)], () => {
      for (const entry of history) {
        const again = button('btn small', 'Queue again', () =>
          room.send({ type: 'add', video_id: entry.video_id, title: entry.title })
        )
        again.disabled = lockedOut || !room.canAct()
        playedList.append(entryRow(entry, el('div', 'entry-actions', again)))
      }
    })
    queueEl.classList.toggle('open', queueOpen)
  }

  function renderUpList(v) {
    for (const [index, entry] of v.queue.entries()) {
      const actions = el('div', 'entry-actions')
      if (isLeader()) {
        const now = button('btn small', 'Play now', () =>
          room.send({ type: 'play_now', entry_id: entry.id })
        )
        now.disabled = !room.canAct()
        actions.append(now)
      }
      if (isLeader() || entry.added_by === room.you) {
        const remove = iconButton(
          'trash',
          () => room.send({ type: 'remove', entry_id: entry.id }),
          'Remove'
        )
        remove.disabled = !room.canAct()
        actions.append(remove)
      }
      const row = entryRow(entry, actions)
      if (isLeader()) {
        const handle = el('span', 'handle', icon('grip-vertical'))
        handle.addEventListener('pointerdown', (e) => startDrag(e, entry, index, row))
        row.prepend(handle)
      }
      upList.append(row)
    }
  }

  // The leader drags a row by its handle; the drop sends one move.
  function startDrag(e, entry, index, row) {
    if (!room.canAct()) return
    e.preventDefault()
    const rows = [...upList.children]
    const tops = rows.map((r) => r.getBoundingClientRect())
    dragging = { entry, from: index, to: index }
    row.classList.add('dragging')
    const move = (ev) => {
      const y = ev.clientY
      let to = tops.findIndex((r) => y < r.top + r.height / 2)
      if (to < 0) to = rows.length - 1
      else if (to > index) to -= 1
      dragging.to = Math.max(0, Math.min(rows.length - 1, to))
      for (const [i, r] of rows.entries())
        r.classList.toggle('drop-before', i === dragging.to && dragging.to < index ? true : false)
      for (const [i, r] of rows.entries())
        r.classList.toggle('drop-after', i === dragging.to && dragging.to > index)
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      removeEventListener('pointercancel', up)
      const { to } = dragging
      dragging = null
      row.classList.remove('dragging')
      for (const r of rows) r.classList.remove('drop-before', 'drop-after')
      if (to !== index) room.send({ type: 'move', entry_id: entry.id, index: to })
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    addEventListener('pointercancel', up)
  }

  // ── Reactions ─────────────────────────────────────────────

  function react(emoji) {
    const t = Date.now()
    if (t - lastReactionAt < REACTION_GAP_MS || !live()) return
    lastReactionAt = t
    fly(room.you, emoji)
    bridge.input({ type: 'react', emoji })
  }

  bridge.onVolatile((data) => {
    if (data?.type !== 'reaction' || typeof data.emoji !== 'string') return
    fly(String(data.from), data.emoji)
  })

  function fly(from, emoji) {
    const v = view()
    if (!v) return
    const seat = v.seats.indexOf(from)
    const seatEl = seat >= 0 ? seatEls.get(seat) : null
    const item = el('span', 'flying', el('span', 'flying-emoji', emoji))
    let x
    let y
    if (!expanded() && seatEl && !seatEl.hidden) {
      const r = seatEl.getBoundingClientRect()
      x = r.left + r.width / 2
      y = r.top
    } else {
      // From the bottom edge of the screen, with the sender beside it.
      const r = screenEl.getBoundingClientRect()
      x = r.left + r.width * (0.15 + Math.random() * 0.7)
      y = r.bottom - 8
      item.prepend(room.avatarEl(from))
      item.classList.add('from-screen')
    }
    item.style.left = `${x}px`
    item.style.top = `${y}px`
    flyLayer.append(item)
    // Web Animations, not CSS: base.css turns CSS animation off for reduced motion, and there
    // the reaction still fades, in place.
    const base = 'translate(-50%, -100%)'
    const rise = Math.round(Math.max(80, Math.min(180, innerHeight * 0.25)))
    const frames = reducedMotion.matches
      ? [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }]
      : [
          { transform: base, opacity: 0 },
          { opacity: 1, offset: 0.12 },
          { opacity: 1, offset: 0.6 },
          { transform: `${base} translateY(-${rise}px)`, opacity: 0 }
        ]
    item.animate(frames, { duration: REACTION_MS, easing: 'ease-out', fill: 'forwards' })
    setTimeout(() => item.remove(), REACTION_MS)
  }

  // ── Keys ──────────────────────────────────────────────────

  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLInputElement && e.target.type === 'text') return
    // A focused slider takes its own arrow keys; its change sends the one seek.
    const slider = e.target instanceof HTMLInputElement && e.target.type === 'range'
    if (slider && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) return
    if (e.ctrlKey || e.metaKey || e.altKey) return
    switch (e.key) {
      case ' ':
        e.preventDefault()
        togglePlay()
        break
      case 'ArrowLeft':
        e.preventDefault()
        seekBy(-KEY_SEEK_MS)
        break
      case 'ArrowRight':
        e.preventDefault()
        seekBy(KEY_SEEK_MS)
        break
      case 'f':
      case 'F':
        player.setFullscreen(viewMode !== 'fullscreen')
        break
      case 'm':
      case 'M':
        muted = !muted
        player.setVolume(volume, muted)
        render()
        break
      case 'Escape':
        if (seatCard || speedOpen || reactOpen || moreOpen) {
          seatCard = null
          speedOpen = false
          reactOpen = false
          moreOpen = false
          render()
        } else if (viewMode === 'expanded') setView('theatre')
        break
      default:
        break
    }
  })

  screenEl.addEventListener('click', (e) => {
    if (e.target !== screenEl && !e.target.closest('#scrim')) return
    togglePlay()
  })
  document.addEventListener('click', (e) => {
    if (seatCard && !e.target.closest('#seat-card')) closeSeatCard()
    // The drawer closes on a click outside it, except on the toggle that opened it.
    if (
      queueOpen &&
      !columnMode() &&
      !e.target.closest('#queue') &&
      !e.target.closest('[aria-label="Queue"]')
    ) {
      queueOpen = false
      render()
    }
    if (moreOpen && !e.target.closest('.more-anchor')) {
      moreOpen = false
      render()
    }
    if (speedOpen && !e.target.closest('.speed-anchor')) {
      speedOpen = false
      render()
    }
    if (reactOpen && !e.target.closest('.react-anchor')) {
      reactOpen = false
      render()
    }
  })

  // ── Sync ─────────────────────────────────────────────────────────────────

  function run(commands) {
    for (const c of commands) {
      if (c.action) {
        // Not clicked by the user, so no lock and no notice.
        bridge.action(c.action).catch(() => {})
        continue
      }
      switch (c.op) {
        case 'load':
          player.load(c.videoId, c.startMs, c.play)
          break
        case 'seek':
          player.seek(c.positionMs)
          break
        case 'rate':
          player.setRate(c.rate)
          break
        default:
          player[c.op]()
      }
    }
  }

  function reconcile() {
    if (!view()) return
    const before = mem.loadedEntry
    const out = sync.reconcile(mem, {
      current: current(),
      now: now(),
      local: Date.now(),
      ready,
      status: mem.loadedEntry === current()?.entry.id ? status : null,
      statusAt
    })
    mem = out.mem
    if (mem.loadedEntry !== before) status = null
    run(out.commands)
    scheduleLeadIn()
  }

  // Play when the lead-in ends, not at the next tick.
  let leadInTimer = null
  function scheduleLeadIn() {
    clearTimeout(leadInTimer)
    const cur = current()
    if (!sync.inLeadIn(cur, now())) return
    leadInTimer = setTimeout(
      () => {
        reconcile()
        render()
      },
      cur.at_ms - now() + 20
    )
  }

  player.onReady((r) => {
    ready = true
    volume = typeof r.volume === 'number' ? r.volume : 100
    muted = !!r.muted
    reconcile()
    render()
  })
  // A status changes only what the screen and the bar show, as the tick does.
  player.onStatus((s) => {
    status = s
    statusAt = Date.now()
    reconcile()
    if (!view()) return
    renderScreen()
    renderBar()
    layout()
  })
  player.onError((code) => {
    const out = sync.onPlayerError(mem, Number(code), {
      current: current(),
      now: now(),
      local: Date.now()
    })
    mem = out.mem
    run(out.commands)
    render()
  })

  // ── Render ───────────────────────────────────────────────────────────────

  function render() {
    const v = view()
    if (!v) return
    app.hidden = false
    app.classList.toggle('column', columnMode() && !columnHidden)
    app.classList.toggle('over', !live())
    renderSeats()
    renderScreen()
    renderBar()
    renderQueue()
    renderSeatCard()
    layout()
  }

  room.onRender(() => {
    reconcile()
    render()
  })

  setInterval(() => {
    reconcile()
    if (view()) {
      renderScreen()
      renderBar()
    }
  }, 1000)
  // The time and the scrub bar move between ticks.
  setInterval(() => view() && renderBar(), 250)

  setView('theatre')
})()
