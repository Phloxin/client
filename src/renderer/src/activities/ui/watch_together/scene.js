// Watch Together theatre scene: an original illustrated house seen from the back, in one SVG.
// Plain script, no imports. Defines one global, `theatreScene`:
//   viewBox   '0 0 1600 1000'
//   screen    { x, y, width, height }  the 16:9 hole the video shows through (nothing is painted
//             inside it except the closed curtains)
//   crop      { x, y, width, height }  the narrow-frame viewBox (stage and orchestra, boxes out)
//   portraitRadius  radius of a seat portrait at scale 1, in scene units
//   svg       the scene markup. Stable ids:
//             #wt-scene (root <svg>; classes wt-lights-dim, wt-curtains-closed switch the states)
//             #wt-curtains-open (gathered side curtains), #wt-curtains-closed (drawn across)
//             #wt-seats (40 <use class="wt-seat" data-seat=N data-section=..>)
//             #wt-dim (the house-lights overlay, a full-scene path with the screen cut out)
//             #wt-lamps (lamp glows, above the overlay, turned low when dimmed)
//             #wt-portraits (empty: the page puts portraits here, above the overlay)
//             #wt-overlay (empty: the page puts the countdown here)
//   seats     40 anchors { seat, section, row, x, y, scale, turn } in scene units. (x, y) is the
//             portrait centre; the portrait radius is portraitRadius * scale. `turn` is the seat's
//             in-plane rotation in degrees (orchestra fan), informational.
;(function () {
  const W = 1600
  const H = 1000
  const SCREEN = { x: 352, y: 88, width: 896, height: 504 }
  const SB = SCREEN.y + SCREEN.height // 592
  const SR = SCREEN.x + SCREEN.width // 1248
  const PR = 30 // portrait radius at seat scale 1
  const VX = 800
  const VY = 400 // vanishing point

  const f = (n) => Math.round(n * 10) / 10
  const P = (pts) => pts.map(([x, y], i) => (i ? 'L' : 'M') + f(x) + ' ' + f(y)).join('') + 'Z'

  // A point on a side wall: x on screen, h metres above the house floor (60 px per metre at the
  // proscenium plane, x = 232, where the floor meets the wall at y = 692).
  const wallY = (x, h) => VY + (292 - 60 * h) * ((VX - x) / (VX - 232))
  // Screen x of a wall depth d (0 at the proscenium, toward the viewer).
  const wallX = (d) => VX - (VX - 232) / (1 - d)

  // ---------------------------------------------------------------- defs
  const defs = `
<linearGradient id="wt-g-wood" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#7d4527"/><stop offset="1" stop-color="#4a2314"/></linearGradient>
<linearGradient id="wt-g-wood-h" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="#3a190c"/><stop offset=".22" stop-color="#7a4426"/>
  <stop offset=".5" stop-color="#93582f"/><stop offset=".78" stop-color="#6c391f"/>
  <stop offset="1" stop-color="#36170b"/></linearGradient>
<linearGradient id="wt-g-wood-dark" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#4b2414"/><stop offset="1" stop-color="#2a1209"/></linearGradient>
<linearGradient id="wt-g-brass" x1="0" y1="0" x2="1" y2="1">
  <stop offset="0" stop-color="#7d5b20"/><stop offset=".42" stop-color="#e2bb5e"/>
  <stop offset=".52" stop-color="#fbe7a6"/><stop offset=".64" stop-color="#c99a40"/>
  <stop offset="1" stop-color="#77561d"/></linearGradient>
<linearGradient id="wt-g-brass-v" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#f6dc8e"/><stop offset=".5" stop-color="#c89a42"/>
  <stop offset="1" stop-color="#7a581e"/></linearGradient>
<radialGradient id="wt-g-velvet" cx=".5" cy=".3" r=".8">
  <stop offset="0" stop-color="#d23346"/><stop offset=".55" stop-color="#9c1830"/>
  <stop offset="1" stop-color="#5c0a19"/></radialGradient>
<linearGradient id="wt-g-cushion" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#c4283e"/><stop offset="1" stop-color="#6a0d1d"/></linearGradient>
<linearGradient id="wt-g-shell" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="#3a180b"/><stop offset=".3" stop-color="#7a4224"/>
  <stop offset=".55" stop-color="#8c5230"/><stop offset="1" stop-color="#3a180b"/></linearGradient>
<linearGradient id="wt-g-arm" x1="0" y1="0" x2="1" y2="0">
  <stop offset="0" stop-color="#3b1b0d"/><stop offset=".45" stop-color="#9a6238"/>
  <stop offset="1" stop-color="#4a2412"/></linearGradient>
<linearGradient id="wt-g-fold" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="26" y2="0" spreadMethod="repeat">
  <stop offset="0" stop-color="#530a15"/><stop offset=".3" stop-color="#94182b"/>
  <stop offset=".48" stop-color="#c22b3e"/><stop offset=".66" stop-color="#8a1527"/>
  <stop offset="1" stop-color="#530a15"/></linearGradient>
<linearGradient id="wt-g-fold-wide" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="42" y2="0" spreadMethod="repeat">
  <stop offset="0" stop-color="#4e0913"/><stop offset=".28" stop-color="#8e172a"/>
  <stop offset=".5" stop-color="#bf2a3d"/><stop offset=".7" stop-color="#851426"/>
  <stop offset="1" stop-color="#4e0913"/></linearGradient>
<linearGradient id="wt-g-drape-shade" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#1a0205" stop-opacity=".55"/><stop offset=".25" stop-color="#1a0205" stop-opacity="0"/>
  <stop offset=".8" stop-color="#1a0205" stop-opacity="0"/><stop offset="1" stop-color="#1a0205" stop-opacity=".45"/></linearGradient>
<linearGradient id="wt-g-valance" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#6e0f1e"/><stop offset=".6" stop-color="#a81f33"/>
  <stop offset="1" stop-color="#7a1222"/></linearGradient>
<linearGradient id="wt-g-stage" gradientUnits="userSpaceOnUse" x1="0" y1="598" x2="0" y2="660">
  <stop offset="0" stop-color="#5e381e"/><stop offset="1" stop-color="#b07a44"/></linearGradient>
<linearGradient id="wt-g-apron" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#4f2816"/><stop offset="1" stop-color="#26100a"/></linearGradient>
<linearGradient id="wt-g-carpet" gradientUnits="userSpaceOnUse" x1="0" y1="692" x2="0" y2="1000">
  <stop offset="0" stop-color="#0f2627"/><stop offset="1" stop-color="#1d4445"/></linearGradient>
<linearGradient id="wt-g-runner" gradientUnits="userSpaceOnUse" x1="0" y1="692" x2="0" y2="1000">
  <stop offset="0" stop-color="#3e0e17"/><stop offset="1" stop-color="#6a1a26"/></linearGradient>
<linearGradient id="wt-g-wall" gradientUnits="userSpaceOnUse" x1="232" y1="0" x2="0" y2="0">
  <stop offset="0" stop-color="#3a1012"/><stop offset="1" stop-color="#5c1c1d"/></linearGradient>
<linearGradient id="wt-g-wainscot" gradientUnits="userSpaceOnUse" x1="232" y1="0" x2="0" y2="0">
  <stop offset="0" stop-color="#3c1b0e"/><stop offset="1" stop-color="#6a3a20"/></linearGradient>
<linearGradient id="wt-g-boxint" x1="0" y1="0" x2="0" y2="1">
  <stop offset="0" stop-color="#22070a"/><stop offset="1" stop-color="#4c1519"/></linearGradient>
<radialGradient id="wt-g-glow">
  <stop offset="0" stop-color="#fff4cf" stop-opacity="1"/><stop offset=".18" stop-color="#ffd27a" stop-opacity=".85"/>
  <stop offset=".5" stop-color="#ff9e3d" stop-opacity=".25"/><stop offset="1" stop-color="#ff8a2a" stop-opacity="0"/></radialGradient>
<radialGradient id="wt-g-pool">
  <stop offset="0" stop-color="#ffb860" stop-opacity=".5"/><stop offset="1" stop-color="#ffb860" stop-opacity="0"/></radialGradient>
<radialGradient id="wt-g-housewarm" cx=".5" cy=".75" r=".75">
  <stop offset="0" stop-color="#ffcf8a" stop-opacity=".10"/><stop offset="1" stop-color="#ffcf8a" stop-opacity="0"/></radialGradient>
<radialGradient id="wt-g-spill" cx=".5" cy="0" r=".5">
  <stop offset="0" stop-color="#c9d6ff" stop-opacity=".2"/><stop offset=".5" stop-color="#c9d6ff" stop-opacity=".07"/><stop offset="1" stop-color="#c9d6ff" stop-opacity="0"/></radialGradient>
<clipPath id="wt-c-stage"><path d="M296 598H1304L1368 640Q800 660 232 640Z"/></clipPath>
<clipPath id="wt-c-carpet"><path d="M0 811L232 692Q800 708 1368 692L1600 811V1000H0Z"/></clipPath>
${seatArt()}
`

  // ---------------------------------------------------------------- the seat
  // Seen from behind. Origin is the portrait centre; scale 1 is the nearest row's size, 100 wide
  // including the shared armrests (pitch 100).
  function seatArt() {
    const studs = []
    for (let i = 0; i < 9; i++) {
      const t = i / 8
      const x = -32 + 64 * t
      const y = -38.5 - 5 * Math.sin(Math.PI * t) + 4 * Math.pow(Math.abs(t - 0.5) * 2, 3)
      studs.push(`<circle cx="${f(x)}" cy="${f(y)}" r="1.5"/>`)
    }
    const panel = 'M-33 48L-37 -12C-38 -28 -28 -34 -16 -36Q0 -41 16 -36C28 -34 38 -28 37 -12L33 48Z'
    return `
<g id="wt-seat-art">
  <ellipse cx="0" cy="59" rx="58" ry="6" fill="#000" opacity=".35"/>
  <path d="M-50 30Q-50 21 -40 21H40Q50 21 50 30V50Q50 56 42 56H-42Q-50 56 -50 50Z" fill="url(#wt-g-cushion)"/>
  <path d="M-49 50Q0 55 49 50" stroke="#e8b85a" stroke-width="1.2" fill="none" opacity=".7"/>
  <g>
    <rect x="-57" y="9" width="13" height="49" rx="4" fill="url(#wt-g-arm)"/>
    <rect x="-59" y="3" width="17" height="11" rx="5.5" fill="#8a5330"/>
    <rect x="-58" y="3.5" width="15" height="4" rx="2" fill="#c08250" opacity=".8"/>
    <circle cx="-50.5" cy="20" r="2.2" fill="url(#wt-g-brass)"/>
    <rect x="44" y="9" width="13" height="49" rx="4" fill="url(#wt-g-arm)"/>
    <rect x="42" y="3" width="17" height="11" rx="5.5" fill="#8a5330"/>
    <rect x="43" y="3.5" width="15" height="4" rx="2" fill="#c08250" opacity=".8"/>
    <circle cx="50.5" cy="20" r="2.2" fill="url(#wt-g-brass)"/>
  </g>
  <path d="M-38 54L-43 -14C-44 -32 -32 -40 -18 -42Q0 -48 18 -42C32 -40 44 -32 43 -14L38 54Z" fill="url(#wt-g-shell)"/>
  <path d="M-18 -42Q0 -48 18 -42C30 -40 40 -34 42 -24Q20 -40 0 -41Q-20 -40 -42 -24C-40 -34 -30 -40 -18 -42Z" fill="#c38955" opacity=".55"/>
  <path d="${panel}" fill="url(#wt-g-velvet)"/>
  <path d="M-12 -33V44M12 -33V44" stroke="#4e0815" stroke-width="1.6" opacity=".5"/>
  <path d="M-11 -33V44M13 -33V44" stroke="#e0566a" stroke-width=".8" opacity=".35"/>
  <path d="${panel}" fill="none" stroke="url(#wt-g-brass)" stroke-width="1.8"/>
  <g fill="url(#wt-g-brass)">${studs.join('')}</g>
  <rect x="-10" y="36" width="20" height="8" rx="2" fill="url(#wt-g-brass)" stroke="#5e4113" stroke-width=".8"/>
  <path d="M-6 40H6" stroke="#5e4113" stroke-width="1" opacity=".7"/>
</g>`
  }

  // ---------------------------------------------------------------- seat anchors
  const ROWS = [
    { row: 1, s: 0.72, y: 737 },
    { row: 2, s: 0.82, y: 797 },
    { row: 3, s: 0.92, y: 866 },
    { row: 4, s: 1.02, y: 940 }
  ]
  const CENTRE_OUT = [
    [-1, 0],
    [1, 0],
    [-1, 1],
    [1, 1],
    [-1, 2],
    [1, 2],
    [-1, 3],
    [1, 3]
  ]
  const seats = []
  const orchPlace = (r, side, i) => {
    const s = r.s
    return {
      section: 'orchestra',
      row: r.row,
      x: f(VX + side * (36 + 50 + 100 * i) * s),
      y: f(r.y - 2.2 * i * i * s),
      scale: s,
      turn: f(-side * 1.0 * i)
    }
  }
  // Box seats, left box, nearest the stage first. The right box mirrors them.
  const BOX = [
    { x: 246, y: 372, s: 0.64 },
    { x: 195, y: 378, s: 0.67 },
    { x: 143, y: 383, s: 0.7 },
    { x: 90, y: 387, s: 0.73 }
  ]
  let n = 0
  for (const rowNo of [2, 1, 3, 4]) {
    const r = ROWS.find((x) => x.row === rowNo)
    for (const [side, i] of CENTRE_OUT) seats.push({ seat: n++, ...orchPlace(r, side, i) })
  }
  for (let i = 0; i < 4; i++) {
    const b = BOX[i]
    seats.push({ seat: n++, section: 'box-left', row: 1, x: b.x, y: b.y, scale: b.s, turn: 0 })
    seats.push({ seat: n++, section: 'box-right', row: 1, x: W - b.x, y: b.y, scale: b.s, turn: 0 })
  }

  function seatUse(a) {
    let tr
    if (a.section === 'orchestra')
      tr = `translate(${a.x} ${a.y}) rotate(${a.turn}) scale(${a.scale})`
    else {
      const sk = a.section === 'box-left' ? -10 : 10
      tr = `translate(${a.x} ${a.y}) skewY(${sk}) scale(${f(a.scale * 0.82 * 100) / 100} ${a.scale})`
    }
    return `<use href="#wt-seat-art" class="wt-seat" data-seat="${a.seat}" data-section="${a.section}" transform="${tr}"/>`
  }
  const seatsSvg = () => {
    // Far rows first so nearer rows overlap them; boxes far seat first.
    const order = [...seats].sort((a, b) => {
      if (a.section !== b.section) return a.section === 'orchestra' ? 1 : -1
      if (a.section === 'orchestra') return a.row - b.row || Math.abs(b.x - VX) - Math.abs(a.x - VX)
      return a.scale - b.scale
    })
    return order.map(seatUse).join('')
  }

  // ---------------------------------------------------------------- walls (left; right mirrors)
  function lamp(x, y, s = 1) {
    // A sconce on the left wall, its arm reaching into the room. (x, y) is the shade's centre.
    return `<g transform="translate(${x} ${y}) scale(${s})">
  <ellipse cx="0" cy="34" rx="64" ry="70" fill="url(#wt-g-pool)" class="wt-lamp-pool"/>
  <rect x="-14" y="2" width="7" height="26" rx="3.5" fill="url(#wt-g-brass-v)" stroke="#5a3e12" stroke-width=".8"/>
  <path d="M-10 18C-4 20 0 16 0 8" stroke="url(#wt-g-brass)" stroke-width="3" fill="none"/>
  <circle cx="0" cy="8" r="3" fill="url(#wt-g-brass)"/>
  <path d="M-9 4Q-9 -14 0 -20Q9 -14 9 4Q0 8 -9 4Z" fill="#ffe6a6"/>
  <path d="M-9 4Q-9 -14 0 -20Q9 -14 9 4" fill="none" stroke="#c99a40" stroke-width="1.4"/>
  <path d="M-4 -10Q0 -16 4 -10" stroke="#fff8e0" stroke-width="2" fill="none" opacity=".8"/>
</g>`
  }
  const LAMPS = [
    { x: 160, y: 612, s: 1.1 },
    { x: 26, y: 536, s: 1.25 }
  ]

  function leftWall() {
    const out = []
    const top = (x) => wallY(x, 11.2)
    const rail = (x) => wallY(x, 1.25)
    const floor = (x) => wallY(x, 0)
    // Ceiling sliver above the cornice.
    out.push(
      `<path d="M0 0H232V${f(top(232))}L${f(VX - (VX - 232) * (VY / (VY - top(232))))} 0Z" fill="#1e0d0a"/>`
    )
    // Upper wall: striped fabric.
    out.push(
      `<path d="${P([
        [0, 0],
        [232, 0],
        [232, rail(232)],
        [0, rail(0)]
      ])}" fill="url(#wt-g-wall)"/>`
    )
    const stripes = []
    for (let k = 0; ; k++) {
      const d0 = k * 0.018
      const x0 = wallX(d0)
      const x1 = wallX(d0 + 0.009)
      if (x0 < 0) break
      stripes.push(
        `<path d="${P([
          [x0, 0],
          [Math.max(0, x1), 0],
          [Math.max(0, x1), rail(Math.max(0, x1))],
          [x0, rail(x0)]
        ])}"/>`
      )
    }
    out.push(`<g fill="#6e2426" opacity=".38">${stripes.join('')}</g>`)
    // Wood pilasters on the wall at a few depths, with brass caps.
    for (const d of [0.02, 0.15, 0.27]) {
      const xa = wallX(d)
      const xb = wallX(d + 0.022)
      if (xb < -40) continue
      out.push(
        `<path d="${P([
          [xa, top(xa)],
          [xb, top(xb)],
          [xb, rail(xb)],
          [xa, rail(xa)]
        ])}" fill="url(#wt-g-wood-h)"/>`
      )
      out.push(
        `<path d="M${f(xa + (xb - xa) * 0.5)} ${f(top(xa) + 10)}V${f(rail(xa) - 6)}" stroke="#c99a40" stroke-width="1.2" opacity=".55"/>`
      )
    }
    // Cornice: a moulded band along the top.
    const c1 = (x) => wallY(x, 10.7)
    const c2 = (x) => wallY(x, 10.2)
    out.push(
      `<path d="${P([
        [232, top(232)],
        [0, top(0)],
        [0, c2(0)],
        [232, c2(232)]
      ])}" fill="url(#wt-g-wood-dark)"/>`
    )
    out.push(
      `<path d="M232 ${f(c1(232))}L0 ${f(c1(0))}" stroke="url(#wt-g-brass)" stroke-width="3"/>`
    )
    out.push(`<path d="M232 ${f(c2(232))}L0 ${f(c2(0))}" stroke="#2a1208" stroke-width="2"/>`)
    // Wainscot with panels.
    out.push(
      `<path d="${P([
        [232, rail(232)],
        [0, rail(0)],
        [0, floor(0)],
        [232, floor(232)]
      ])}" fill="url(#wt-g-wainscot)"/>`
    )
    const ds = [0, 0.045, 0.1, 0.165, 0.24, 0.33]
    for (let i = 0; i + 1 < ds.length; i++) {
      const xa = wallX(ds[i]) - 5
      const xb = wallX(ds[i + 1]) + 5
      const xbC = Math.max(xb, -10)
      const mt = (x) => wallY(x, 1.05)
      const mb = (x) => wallY(x, 0.3)
      out.push(
        `<path d="${P([
          [xa, mt(xa)],
          [xbC, mt(xbC)],
          [xbC, mb(xbC)],
          [xa, mb(xa)]
        ])}" fill="#2e1309" opacity=".45" stroke="#b5873e" stroke-opacity=".45" stroke-width="1.2"/>`
      )
    }
    // Chair rail and baseboard.
    out.push(
      `<path d="M232 ${f(rail(232))}L0 ${f(rail(0))}" stroke="url(#wt-g-brass)" stroke-width="4"/>`
    )
    out.push(
      `<path d="M232 ${f(rail(232) + 3)}L0 ${f(rail(0) + 4)}" stroke="#2a1208" stroke-width="2"/>`
    )
    out.push(
      `<path d="${P([
        [232, wallY(232, 0.22)],
        [0, wallY(0, 0.22)],
        [0, floor(0)],
        [232, floor(232)]
      ])}" fill="#2a1209"/>`
    )
    // Shadow in the corner where the wall meets the proscenium.
    out.push(
      `<path d="${P([
        [214, 0],
        [232, 0],
        [232, floor(232)],
        [214, floor(214)]
      ])}" fill="#0a0303" opacity=".35"/>`
    )
    for (const l of LAMPS) out.push(lamp(l.x, l.y, l.s))
    return out.join('\n')
  }

  // The left box, behind its seats: interior, hood, drape, columns.
  function leftBoxBack() {
    return `
<path d="M58 258L272 276L272 404L58 416Z" fill="url(#wt-g-fold)" opacity=".75"/>
<path d="M58 258L272 276L272 404L58 416Z" fill="url(#wt-g-boxint)" opacity=".7"/>
<path d="M58 258L272 276L272 404L58 416Z" fill="url(#wt-g-drape-shade)"/>
<ellipse cx="160" cy="318" rx="96" ry="46" fill="url(#wt-g-pool)" opacity=".55"/>
<path d="M36 236Q160 152 288 248L288 262Q160 178 36 252Z" fill="url(#wt-g-wood)"/>
<path d="M36 236Q160 152 288 248" stroke="url(#wt-g-brass)" stroke-width="3.5" fill="none"/>
<path d="M40 250Q160 174 286 258" stroke="#2a1208" stroke-width="1.5" fill="none" opacity=".7"/>
<g transform="translate(166 186)">
  <path d="M-16 6Q0 -14 16 6Q0 2 -16 6Z" fill="url(#wt-g-brass)"/>
  <circle cx="0" cy="-8" r="5" fill="url(#wt-g-brass)" stroke="#6a4a16" stroke-width=".8"/>
  <path d="M0 -20V-13" stroke="url(#wt-g-brass)" stroke-width="2.5"/>
</g>
<path d="M44 252L288 266L288 282Q262 300 236 284Q206 304 172 284Q138 306 104 282Q74 300 44 278Z" fill="url(#wt-g-valance)"/>
<path d="M44 278Q74 300 104 282Q138 306 172 284Q206 304 236 284Q262 300 288 282" fill="none" stroke="#e2b85a" stroke-width="3" stroke-dasharray="1.6 1.8"/>
<path d="M44 256L288 270" stroke="url(#wt-g-brass)" stroke-width="2.5"/>
<g fill="url(#wt-g-brass)"><circle cx="104" cy="286" r="3.2"/><circle cx="172" cy="288" r="3.2"/><circle cx="236" cy="288" r="3.2"/></g>
<rect x="46" y="262" width="16" height="160" fill="url(#wt-g-wood-h)"/>
<rect x="43" y="258" width="22" height="9" rx="2" fill="url(#wt-g-brass)"/>
<rect x="268" y="276" width="12" height="122" fill="url(#wt-g-wood-h)"/>
<rect x="265" y="272" width="18" height="8" rx="2" fill="url(#wt-g-brass)"/>`
  }

  // The left box's rail and front, drawn over its seats.
  function leftBoxFront() {
    return `
<path d="M38 418Q170 413 300 388L304 446Q172 488 42 480Z" fill="url(#wt-g-wood)"/>
<path d="M44 432Q172 428 300 404" stroke="#2a1208" stroke-width="2" fill="none" opacity=".6"/>
<path d="M66 444Q110 444 132 442L136 470Q100 472 70 470Z" fill="#3a1a0c" stroke="url(#wt-g-brass)" stroke-width="1.6"/>
<path d="M208 434Q240 428 266 420L270 452Q242 462 212 466Z" fill="#3a1a0c" stroke="url(#wt-g-brass)" stroke-width="1.6"/>
<ellipse cx="172" cy="452" rx="22" ry="17" fill="#2e1309" stroke="url(#wt-g-brass)" stroke-width="2.5"/>
<g transform="translate(172 452)" fill="url(#wt-g-brass)">
  <circle r="5"/><ellipse cx="0" cy="-10" rx="3" ry="5"/><ellipse cx="0" cy="10" rx="3" ry="5"/>
  <ellipse cx="-11" cy="0" rx="5" ry="3"/><ellipse cx="11" cy="0" rx="5" ry="3"/>
</g>
<path d="M36 412Q170 407 302 382L302 392Q170 418 38 424Z" fill="url(#wt-g-cushion)"/>
<path d="M34 411Q170 405 304 380" stroke="url(#wt-g-brass)" stroke-width="6" fill="none" stroke-linecap="round"/>
<path d="M34 409Q170 403 304 378" stroke="#fff0b8" stroke-width="1.4" fill="none" opacity=".7"/>
<path d="M42 478Q172 486 304 444L304 452Q172 498 42 488Z" fill="url(#wt-g-brass)"/>
<path d="M66 486Q170 498 282 460Q262 498 210 514Q172 524 132 518Q90 510 66 486Z" fill="url(#wt-g-wood-dark)"/>
<path d="M88 494Q170 504 262 474Q240 500 200 508Q170 514 136 510Q104 504 88 494Z" fill="none" stroke="#b5873e" stroke-width="1.4" opacity=".7"/>
<g fill="url(#wt-g-brass)"><circle cx="172" cy="522" r="4"/><path d="M168 525L172 540L176 525Z"/></g>`
  }

  // ---------------------------------------------------------------- the proscenium
  const ARCH_IN = 'M296 130C296 76 322 54 384 50Q800 34 1216 50C1278 54 1304 76 1304 130'
  const ARCH_OUT = 'M232 130C232 50 270 16 360 12Q800 -2 1240 12C1330 16 1368 50 1368 130'
  const bez3 = (p0, p1, p2, p3, t) => {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
  }
  const bez2 = (p0, p1, p2, t) => (1 - t) * (1 - t) * p0 + 2 * (1 - t) * t * p1 + t * t * p2
  // Point on the arch band at parameter u in [0, 1] along its length (left springing to right),
  // and fraction w across it (0 inner, 1 outer).
  function archPt(u, w) {
    const inner = archCurve(u, [296, 130, 296, 76, 322, 54, 384, 50], [384, 50, 800, 34, 1216, 50])
    const outer = archCurve(u, [232, 130, 232, 50, 270, 16, 360, 12], [360, 12, 800, -2, 1240, 12])
    return [inner[0] + (outer[0] - inner[0]) * w, inner[1] + (outer[1] - inner[1]) * w]
  }
  function archCurve(u, c, q) {
    // u in [0, .18] left corner, [.18, .82] the flat top, [.82, 1] right corner (mirrored).
    if (u > 0.5) {
      const p = archCurve(1 - u, c, q)
      return [1600 - p[0], p[1]]
    }
    if (u < 0.18) {
      const t = u / 0.18
      return [bez3(c[0], c[2], c[4], c[6], t), bez3(c[1], c[3], c[5], c[7], t)]
    }
    const t = ((u - 0.18) / 0.64) * 1
    return [bez2(q[0], q[2], q[4], t), bez2(q[1], q[3], q[5], t)]
  }
  function proscenium() {
    const o = []
    // Spandrels: the frontal wall above the arch.
    o.push(
      `<path d="M232 0H1368V130C1368 50 1330 16 1240 12Q800 -2 360 12C270 16 232 50 232 130Z" fill="url(#wt-g-wood-dark)"/>`
    )
    for (const x of [248, 1352]) {
      o.push(
        `<g transform="translate(${x} 22)"><circle r="7.5" fill="#2a1208" stroke="url(#wt-g-brass)" stroke-width="2"/><circle r="3" fill="url(#wt-g-brass)"/></g>`
      )
    }
    // The arch band.
    o.push(
      `<path d="${ARCH_OUT}L1304 130C1304 76 1278 54 1216 50Q800 34 384 50C322 54 296 76 296 130Z" fill="url(#wt-g-wood)"/>`
    )
    // Panel divisions and rosettes along the band.
    const N = 22
    for (let k = 1; k < N; k++) {
      const u = k / N
      const a = archPt(u, 0.12)
      const b = archPt(u, 0.86)
      o.push(
        `<path d="M${f(a[0])} ${f(a[1])}L${f(b[0])} ${f(b[1])}" stroke="#2a1208" stroke-width="2.2" opacity=".75"/>`
      )
      o.push(
        `<path d="M${f(a[0] + 1.6)} ${f(a[1])}L${f(b[0] + 1.6)} ${f(b[1])}" stroke="#b07a48" stroke-width="1" opacity=".5"/>`
      )
    }
    for (let k = 0; k < N; k++) {
      const u = (k + 0.5) / N
      if (Math.abs(u - 0.5) < 0.03) continue
      const m = archPt(u, 0.5)
      o.push(
        `<circle cx="${f(m[0])}" cy="${f(m[1])}" r="3.4" fill="url(#wt-g-brass)" stroke="#5e4113" stroke-width=".6"/>`
      )
    }
    // Brass beading on the inner and outer edges.
    o.push(`<path d="${ARCH_IN}" stroke="url(#wt-g-brass)" stroke-width="5" fill="none"/>`)
    o.push(
      `<path d="${ARCH_IN}" stroke="#fff0b8" stroke-width="1" fill="none" opacity=".55" stroke-dasharray="2 5"/>`
    )
    o.push(`<path d="${ARCH_OUT}" stroke="url(#wt-g-brass)" stroke-width="3" fill="none"/>`)
    // Keystone with a brass fan.
    const rays = []
    for (let i = 0; i <= 8; i++) {
      const a = Math.PI * (1.08 + (0.84 * i) / 8)
      rays.push(`<path d="M0 40L${f(Math.cos(a) * 24)} ${f(40 + Math.sin(a) * 24)}" />`)
    }
    o.push(`<g transform="translate(800 0)">
  <path d="M-34 0H34L24 56H-24Z" fill="url(#wt-g-wood-h)" stroke="#2a1208" stroke-width="2"/>
  <path d="M-34 0H34L24 56H-24Z" fill="none" stroke="url(#wt-g-brass)" stroke-width="2.5"/>
  <path d="M-22 40A22 22 0 0 1 22 40Z" fill="#2a1208"/>
  <g stroke="url(#wt-g-brass)" stroke-width="2.6">${rays.join('')}</g>
  <circle cx="0" cy="40" r="6" fill="url(#wt-g-brass)" stroke="#5e4113" stroke-width=".8"/>
  <path d="M-24 56H24" stroke="url(#wt-g-brass)" stroke-width="3"/>
</g>`)
    // Pilasters.
    for (const x0 of [232, 1304]) {
      o.push(`<g>
  <rect x="${x0}" y="130" width="64" height="482" fill="url(#wt-g-wood-h)"/>
  <rect x="${x0 + 11}" y="170" width="42" height="400" rx="3" fill="#2e1309" opacity=".55"/>
  <rect x="${x0 + 11}" y="170" width="42" height="400" rx="3" fill="none" stroke="url(#wt-g-brass-v)" stroke-width="2"/>
  <rect x="${x0 + 17}" y="180" width="30" height="380" rx="2" fill="none" stroke="#b07a48" stroke-width="1" opacity=".5"/>
  ${[196, 536]
    .map(
      (y) =>
        `<path d="M${x0 + 32} ${y - 14}L${x0 + 42} ${y}L${x0 + 32} ${y + 14}L${x0 + 22} ${y}Z" fill="url(#wt-g-brass)" stroke="#5e4113" stroke-width=".8"/>`
    )
    .join('')}
  <rect x="${x0 - 8}" y="120" width="80" height="16" rx="2" fill="url(#wt-g-wood-dark)"/>
  <rect x="${x0 - 8}" y="132" width="80" height="6" fill="url(#wt-g-brass)"/>
  <rect x="${x0 - 4}" y="138" width="72" height="10" fill="#3a1a0c"/>
  <rect x="${x0 - 8}" y="598" width="80" height="44" rx="2" fill="url(#wt-g-wood-dark)"/>
  <rect x="${x0 - 8}" y="598" width="80" height="5" fill="url(#wt-g-brass)"/>
  <rect x="${x0 - 2}" y="610" width="68" height="24" rx="2" fill="none" stroke="#b07a48" stroke-width="1" opacity=".6"/>
</g>`)
    }
    // Curtain holdbacks on the pilasters' inner edges.
    for (const [x, dir] of [
      [292, 1],
      [1308, -1]
    ]) {
      o.push(`<g transform="translate(${x} 402) scale(${dir} 1)">
  <path d="M0 0Q16 -6 30 2Q16 10 0 6Z" fill="#e2b85a"/>
  <path d="M0 3Q16 -2 30 4" stroke="#7a5a20" stroke-width="1" fill="none"/>
  <circle cx="0" cy="3" r="8" fill="url(#wt-g-brass)" stroke="#5e4113" stroke-width="1"/>
  <circle cx="0" cy="3" r="3" fill="#fff0b8" opacity=".7"/>
  <path d="M26 6Q30 16 27 28" stroke="#e2b85a" stroke-width="2.5" fill="none"/>
  <path d="M22 28H32L34 46H20Z" fill="#d4a548"/>
  <path d="M23 30V45M27 30V46M31 30V45" stroke="#8a6420" stroke-width="1"/>
</g>`)
    }
    return o.join('\n')
  }

  // ---------------------------------------------------------------- curtains and valance
  function sideCurtain() {
    // Left one; the right mirrors it. Inner edge stays at x <= 350, off the screen.
    const body =
      'M282 42L350 42L350 150C350 262 334 348 324 402C334 462 349 540 350 598Q342 606 330 600Q316 608 304 600Q292 606 282 600Z'
    const folds = []
    for (let i = 0; i < 5; i++) {
      const xt = 290 + i * 14
      const xm = 300 + i * 6
      const xb = 288 + i * 15
      folds.push(`M${xt} 44C${xt} 200 ${xm} 330 ${xm} 402C${xm} 470 ${xb} 540 ${xb} 600`)
    }
    return `<g>
  <path d="${body}" fill="url(#wt-g-fold)"/>
  <path d="${folds.join('')}" stroke="#3e0610" stroke-width="2.2" fill="none" opacity=".55"/>
  <path d="${body}" fill="url(#wt-g-drape-shade)"/>
  <path d="M350 150C350 262 334 348 324 402C334 462 349 540 350 598" stroke="#e05064" stroke-width="1.6" fill="none" opacity=".5"/>
  <path d="M286 396Q306 404 330 398L330 410Q306 414 286 408Z" fill="#e2b85a"/>
</g>`
  }
  function closedCurtains() {
    const panel = (x0, x1) => {
      const hem = []
      const n = 12
      for (let i = 0; i <= n; i++) {
        const x = x1 + ((x0 - x1) * i) / n
        hem.push(`${i ? 'L' : ''}${f(x)} ${i % 2 ? 606 : 600}`)
      }
      return `M${x0} 40L${x1} 40L${x1} 600${hem.slice(1).join('')}Z`
    }
    const left = panel(282, 806)
    const right = panel(1318, 794)
    const trim = `M282 570H806M282 580H806M794 570H1318M794 580H1318`
    return `<g id="wt-curtains-closed">
  <path d="${left}" fill="url(#wt-g-fold-wide)"/>
  <path d="${right}" fill="url(#wt-g-fold-wide)"/>
  <path d="${left}" fill="url(#wt-g-drape-shade)"/>
  <path d="${right}" fill="url(#wt-g-drape-shade)"/>
  <path d="${trim}" stroke="#d4a548" stroke-width="3" opacity=".9"/>
  <path d="M806 40V602" stroke="#2a0409" stroke-width="5" opacity=".65"/>
  <path d="M794 40V602" stroke="#e05064" stroke-width="1.4" opacity=".55"/>
</g>`
  }
  function valance() {
    const n = 7
    const x0 = 348
    const x1 = 1252
    const w = (x1 - x0) / n
    let bottom = ''
    let fringe = ''
    const folds = []
    const tassels = []
    for (let i = 0; i < n; i++) {
      const a = x1 - i * w
      const b = a - w
      const m = (a + b) / 2
      bottom += `Q${f(m)} 98 ${f(b)} 70`
      fringe += `${i ? '' : `M${f(a)} 68`}Q${f(m)} 94 ${f(b)} 68`
      folds.push(
        `M${f(a - 8)} 62Q${f(m)} 82 ${f(b + 8)} 62`,
        `M${f(a - 22)} 54Q${f(m)} 68 ${f(b + 22)} 54`
      )
      if (i > 0) tassels.push(a)
    }
    const body = `${ARCH_IN}L1304 252L1286 230L1272 244L1252 206L${x1} 70${bottom}L${x0} 206L328 244L314 230L296 252Z`
    return `<g>
  <path d="${body}" fill="url(#wt-g-valance)"/>
  <path d="${folds.join('')}" stroke="#55091a" stroke-width="2" fill="none" opacity=".6"/>
  <path d="${fringe}" stroke="#e2b85a" stroke-width="4" fill="none" stroke-dasharray="1.4 1.6"/>
  <path d="M296 252L314 230L328 244L348 206M1304 252L1286 230L1272 244L1252 206" stroke="#e2b85a" stroke-width="3" fill="none" stroke-dasharray="1.4 1.6"/>
  <path d="M300 64H1300" stroke="#55091a" stroke-width="0" />
  ${tassels
    .map(
      (x) =>
        `<g transform="translate(${f(x)} 66)"><circle r="3.6" fill="url(#wt-g-brass)"/><path d="M-3 2L3 2L4 16L-4 16Z" fill="#d4a548"/></g>`
    )
    .join('')}
  <g transform="translate(348 68)"><circle r="4" fill="url(#wt-g-brass)"/></g>
  <g transform="translate(1252 68)"><circle r="4" fill="url(#wt-g-brass)"/></g>
</g>`
  }

  // ---------------------------------------------------------------- stage, apron, house floor
  function stage() {
    const o = []
    o.push(`<path d="M296 598H1304L1368 640Q800 660 232 640Z" fill="url(#wt-g-stage)"/>`)
    const boards = []
    const r = (652 - VY) / (598 - VY)
    for (let xb = 296 - 36 * 4; xb <= 1304 + 36 * 4; xb += 36) {
      const xf = VX + (xb - VX) * r
      boards.push(`M${f(xb)} 598L${f(xf)} 660`)
    }
    const joints = []
    let seed = 7
    const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280
    for (let xb = 296; xb < 1304; xb += 36) {
      const t = 0.15 + rnd() * 0.7
      const y = 598 + t * 50
      const k = (y - VY) / (598 - VY)
      const xa = VX + (xb - VX) * k
      const xc = VX + (xb + 36 - VX) * k
      joints.push(`M${f(xa)} ${f(y)}L${f(xc)} ${f(y)}`)
    }
    o.push(`<g clip-path="url(#wt-c-stage)">
  <path d="${boards.join('')}" stroke="#3e2210" stroke-width="1.6" opacity=".8"/>
  <path d="${joints.join('')}" stroke="#3e2210" stroke-width="1.2" opacity=".7"/>
  <path d="M296 598H1304V604H296Z" fill="#000" opacity=".35"/>
</g>`)
    // Apron face.
    o.push(
      `<path d="M232 640Q800 660 1368 640L1368 692Q800 708 232 692Z" fill="url(#wt-g-apron)"/>`
    )
    const posts = []
    for (let i = 0; i <= 12; i++) {
      const t = i / 12
      const x = 232 + 1136 * t
      const y1 = 640 + 40 * t * (1 - t) + 5
      const y2 = 692 + 32 * t * (1 - t) - 3
      posts.push(`M${f(x)} ${f(y1)}L${f(x)} ${f(y2)}`)
    }
    o.push(`<path d="${posts.join('')}" stroke="#1a0905" stroke-width="3" opacity=".7"/>`)
    o.push(
      `<path d="${posts.join('').replace(/M([\d.]+)/g, (m, x) => 'M' + f(+x + 2))}" stroke="#a06a3c" stroke-width="1" opacity=".35"/>`
    )
    o.push(
      `<path d="M232 640Q800 660 1368 640" stroke="url(#wt-g-brass)" stroke-width="5" fill="none"/>`
    )
    o.push(`<path d="M232 692Q800 708 1368 692" stroke="#140604" stroke-width="3" fill="none"/>`)
    // Footlights along the lip.
    const lights = []
    for (let i = 0; i <= 20; i++) {
      const t = i / 20
      const x = 250 + 1100 * t
      const tt = (x - 232) / 1136
      const y = 640 + 40 * tt * (1 - tt)
      lights.push(
        `<g transform="translate(${f(x)} ${f(y - 1)})"><ellipse cx="0" cy="-3" rx="16" ry="8" fill="#ffd27a" opacity=".22"/><path d="M-8 0Q-8 -7 0 -7Q8 -7 8 0Z" fill="url(#wt-g-brass)"/><path d="M-5 -1H5" stroke="#fff2c0" stroke-width="2"/></g>`
      )
    }
    o.push(`<g>${lights.join('')}</g>`)
    return o.join('\n')
  }
  function carpet() {
    const o = []
    o.push(`<path d="M0 811L232 692Q800 708 1368 692L1600 811V1000H0Z" fill="url(#wt-g-carpet)"/>`)
    const D = 1300
    const famA = []
    const famB = []
    const step = 120
    for (let x = -4000; x <= 5600; x += step) {
      famA.push(`M${VX + D} ${VY}L${x} 1000`)
      famB.push(`M${VX - D} ${VY}L${x} 1000`)
    }
    // Motifs at the lattice crossings, sized by depth.
    const dots = []
    const lineX = (vx, x0, y) => vx + (x0 - vx) * ((y - VY) / (1000 - VY))
    for (let i = -40; i < 60; i++) {
      for (let j = -40; j < 60; j++) {
        const a = -4000 + i * step
        const b = -4000 + j * step
        // Intersection of A(a) and B(b): x = VX + D + (a - VX - D) * k = VX - D + (b - VX + D) * k
        const k = (2 * D) / (b - VX + D - (a - VX - D))
        if (!(k > 0) || k > 1.02) continue
        const y = VY + (1000 - VY) * k
        if (y < 700) continue
        const x = lineX(VX + D, a, y)
        if (x < -10 || x > W + 10) continue
        const sc = (y - VY) / 600
        dots.push(
          `<g transform="translate(${f(x)} ${f(y)}) scale(${f(sc * 100) / 100} ${f(sc * 60) / 100})"><path d="M0 -9L4 0L0 9L-4 0Z" fill="#c29a4a"/><circle r="2.6" fill="#a8432e"/></g>`
        )
      }
    }
    o.push(`<g clip-path="url(#wt-c-carpet)">
  <path d="${famA.join('')}${famB.join('')}" stroke="#b8903f" stroke-width="1.3" opacity=".32"/>
  <g opacity=".75">${dots.join('')}</g>
  <path d="M${VX - 23} 692L${VX + 23} 692L${VX + 50} 1000L${VX - 50} 1000Z" fill="url(#wt-g-runner)"/>
  <path d="M${VX - 19} 692L${VX - 43} 1000M${VX + 19} 692L${VX + 43} 1000" stroke="#d4a548" stroke-width="2" opacity=".7"/>
  <path d="M0 811L232 692L232 700L0 822Z M1600 811L1368 692L1368 700L1600 822Z" fill="#000" opacity=".3"/>
  <path d="M232 692Q800 708 1368 692L1368 720Q800 736 232 720Z" fill="#000" opacity=".25"/>
</g>`)
    return o.join('\n')
  }

  // ---------------------------------------------------------------- lamps above the dim layer
  function lampGlows() {
    const all = []
    for (const l of LAMPS) {
      for (const x of [l.x, W - l.x]) {
        all.push(
          `<g transform="translate(${x} ${l.y - 6})"><circle r="${f(54 * l.s)}" fill="url(#wt-g-glow)" class="wt-lamp-halo"/><circle r="${f(5 * l.s)}" fill="#fff6d8" class="wt-lamp-core"/></g>`
        )
      }
    }
    return all.join('')
  }

  // ---------------------------------------------------------------- assemble
  const screenHole = `M${SCREEN.x} ${SCREEN.y}V${SB}H${SR}V${SCREEN.y}Z`
  const style = `<style>
#wt-scene #wt-dim{opacity:0;transition:opacity .6s ease}
#wt-scene #wt-lamps .wt-lamp-halo{opacity:1;transition:opacity .6s ease}
#wt-scene #wt-lamps .wt-lamp-core{opacity:1;transition:opacity .6s ease}
#wt-scene #wt-spill{opacity:0;transition:opacity .6s ease}
#wt-scene.wt-lights-dim #wt-dim{opacity:.52}
#wt-scene.wt-lights-dim #wt-lamps .wt-lamp-halo{opacity:.32}
#wt-scene.wt-lights-dim #wt-lamps .wt-lamp-core{opacity:.55}
#wt-scene.wt-lights-dim #wt-spill{opacity:1}
#wt-scene #wt-curtains-closed{display:none}
#wt-scene.wt-curtains-closed #wt-curtains-closed{display:inline}
#wt-scene.wt-curtains-closed #wt-curtains-open{display:none}
@media (prefers-reduced-motion: reduce){#wt-scene *{transition:none!important}}
</style>`
  const svg = `<svg id="wt-scene" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
${style}
<defs>${defs}</defs>
<path d="M0 0H${W}V${H}H0Z${screenHole}" fill="#160908" fill-rule="evenodd"/>
<g id="wt-walls">
  <g id="wt-wall-left">${leftWall()}</g>
  <g id="wt-wall-right" transform="translate(${W} 0) scale(-1 1)">${leftWall()}</g>
</g>
<path d="M282 36H1318V604H282Z${screenHole}" fill="#0c0504" fill-rule="evenodd"/>
<path d="M${SCREEN.x - 7} ${SCREEN.y - 7}H${SR + 7}V${SB + 7}H${SCREEN.x - 7}Z${screenHole}" fill="#050202" fill-rule="evenodd"/>
<g id="wt-stage">${stage()}</g>
<g id="wt-curtains-open">${sideCurtain()}<g transform="translate(${W} 0) scale(-1 1)">${sideCurtain()}</g></g>
${closedCurtains()}
<g id="wt-valance">${valance()}</g>
<g id="wt-proscenium">${proscenium()}</g>
<g id="wt-floor">${carpet()}</g>
<path d="M0 0H${W}V${H}H0Z${screenHole}" fill="url(#wt-g-housewarm)" fill-rule="evenodd"/>
<g id="wt-boxes-back">${leftBoxBack()}<g transform="translate(${W} 0) scale(-1 1)">${leftBoxBack()}</g></g>
<g id="wt-seats">${seatsSvg()}</g>
<g id="wt-boxes-front">${leftBoxFront()}<g transform="translate(${W} 0) scale(-1 1)">${leftBoxFront()}</g></g>
<path id="wt-dim" d="M0 0H${W}V${H}H0Z${screenHole}" fill="#07030a" fill-rule="evenodd"/>
<path id="wt-spill" d="M80 ${SB + 7}A720 330 0 0 0 1520 ${SB + 7}Z" fill="url(#wt-g-spill)" style="mix-blend-mode:screen"/>
<g id="wt-lamps">${lampGlows()}</g>
<g id="wt-portraits"></g>
<g id="wt-overlay"></g>
</svg>`

  globalThis.theatreScene = {
    viewBox: `0 0 ${W} ${H}`,
    width: W,
    height: H,
    screen: { ...SCREEN },
    crop: { x: 300, y: 0, width: 1000, height: 1000 },
    portraitRadius: PR,
    svg,
    seats
  }
})()
