// The top of a pylon broadcasting from its beacon: signal strength is the
// number of lit arc pairs (0–3), the rest drawn faint so the scale stays
// readable. Framed tight on the beacon, so the legs run off the bottom edge
// (inline SVG clips to its box). Drawn on Tabler's 24×24 stroke grid so it sits
// alongside the other dock icons. Arcs are centred on the beacon at (12, 10)
// and span ±42°.
const ARCS = [
  { r: 4.25, dx: 3.16, dy: 2.84 },
  { r: 7.25, dx: 5.39, dy: 4.85 },
  { r: 10.25, dx: 7.62, dy: 6.86 }
]

// Two legs splaying from under the beacon past the frame, and one crossbar.
const TOWER = 'M12 12.25 L8 24 M12 12.25 L16 24 M9.7 19 H14.3'

export default function PylonSignalIcon({ level = 3, size = 22, stroke = 2, className }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={TOWER} />
      <circle cx="12" cy="10" r="1.75" fill="currentColor" stroke="none" />
      {ARCS.map(({ r, dx, dy }, i) => (
        <path
          key={r}
          className="pylon-signal-arc"
          opacity={i < level ? 1 : 0.25}
          d={
            `M${12 - dx} ${10 - dy} A${r} ${r} 0 0 0 ${12 - dx} ${10 + dy} ` +
            `M${12 + dx} ${10 - dy} A${r} ${r} 0 0 1 ${12 + dx} ${10 + dy}`
          }
        />
      ))}
    </svg>
  )
}
