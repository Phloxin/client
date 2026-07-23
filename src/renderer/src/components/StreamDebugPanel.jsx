import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { IconGripVertical, IconX } from '@tabler/icons-react'
import uPlot from 'uplot'
import 'uplot/dist/uPlot.min.css'
import { startStreamDebugStats } from '../lib/soup'
import './StreamDebugPanel.css'

// ── Tunables ────────────────────────────────────────────────────────────────
const CAP = 120 // ring-buffer length: 2 min at 1 sample/s
const MISS_LIMIT = 10 // consecutive absent ticks before a stream's history is dropped
const POLL_MS = 1000
const PANEL_W = 380
const PANEL_MIN_W = 300 // resize floor — charts stay readable down to here
const PANEL_MIN_H = 220 // header + filters + one chart
const DRAG_MARGIN = 40 // keep at least this much of the panel on-screen while dragging
const CHART_FALLBACK_W = 320 // used only if the canvas reports zero width at mount

// Heuristic "should not be this high" limits: each draws a dashed guide line on
// its chart and turns into a red badge while the latest sample exceeds it.
// They're rules of thumb for spotting trouble, not hard protocol limits. The
// audio jitter-buffer limit matches soup.js AUDIO_HEALTH_BAD_DELAY_SEC (0.4s),
// the point where the inbound self-heal machinery calls audio degraded.
const LIMITS = {
  rttMs: 150,
  jitterMs: 30,
  fractionLost: 0.02, // 2% — video artifacts / audio dropouts get likely above this
  encodeMsPerFrame: 33, // one 30fps frame interval: encoder can't keep realtime
  videoJitterBufferMs: 250,
  audioJitterBufferMs: 400,
  concealedPerTick: 2400 // 50ms of 48kHz audio concealed per 1s tick — audible PLC
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

const TYPE_LABELS = {
  Audio: 'Microphone',
  ScreenShare: 'Screen',
  ScreenShareAudio: 'Screen Audio',
  Camera: 'Camera'
}

// ── Small numeric guards — any metric may be null/undefined on any tick ───────
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const kbps = (v) => (typeof v === 'number' && Number.isFinite(v) ? v / 1000 : null)
const pct = (v) => (typeof v === 'number' && Number.isFinite(v) ? v * 100 : null)

// Headline counters: show '—' rather than a bare 0-vs-missing ambiguity.
const fmtInt = (v) => (v == null ? '—' : Math.round(v))
const fmtFixed = (v, d = 1) => (v == null ? '—' : v.toFixed(d))

// Resolve theme tokens to concrete color strings once, at mount. uPlot needs
// real colors (it can't read CSS custom properties), so we snapshot them.
// KNOWN LIMITATION: switching themes while the panel is open keeps these old
// chart colors until the panel is closed and reopened.
function readTheme() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback
  return {
    axis: v('--color-text-tertiary', '#788'),
    grid: v('--color-border', '#333'),
    font: v('--font-family-primary', 'system-ui, sans-serif'),
    primary: v('--color-primary', '#f0a63c'), // accent — primary series
    blue: v('--color-mention', '#79aee6'), // secondary series
    green: v('--color-success', '#5cc172'),
    amber: v('--color-warning', '#e0803a'),
    red: v('--color-danger', '#e5545a'),
    teal: v('--color-reaction', '#57b9a3')
  }
}

// Latest non-null value in a uPlot y-series (data[seriesIndex + 1]).
function lastValue(data, seriesIndex) {
  const arr = data[seriesIndex + 1]
  if (!arr) return null
  for (let i = arr.length - 1; i >= 0; i--) {
    if (arr[i] != null) return arr[i]
  }
  return null
}

function formatReadout(v) {
  if (v == null) return '—'
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v))
  return v.toFixed(1)
}

// Reuse ClientIndicator's derivation (it renders `client.name` directly); fall
// back to the raw id when the producer isn't in the roster we were handed.
function clientLabel(clients, clientId) {
  const c = clients?.find((entry) => entry.id === clientId)
  return c?.name ?? String(clientId ?? 'Unknown')
}

// LIMITS breaches in a stream's LATEST sample, as short badge strings
// ('rtt 210ms'). Drives the red card badges and the filter chips' warning dots.
function activeWarnings(meta) {
  const m = meta.metrics || {}
  const over = (v, limit) => typeof v === 'number' && Number.isFinite(v) && v > limit
  const out = []
  if (meta.direction === 'send') {
    if (over(m.rttMs, LIMITS.rttMs)) out.push(`rtt ${Math.round(m.rttMs)}ms`)
    if (over(m.fractionLost, LIMITS.fractionLost))
      out.push(`loss ${(m.fractionLost * 100).toFixed(1)}%`)
    if (meta.kind === 'video' && over(m.encodeMsPerFrame, LIMITS.encodeMsPerFrame))
      out.push(`enc ${Math.round(m.encodeMsPerFrame)}ms`)
    if (meta.kind === 'audio' && over(m.jitterMs, LIMITS.jitterMs))
      out.push(`jitter ${Math.round(m.jitterMs)}ms`)
  } else {
    const bufLimit = meta.kind === 'audio' ? LIMITS.audioJitterBufferMs : LIMITS.videoJitterBufferMs
    if (over(m.jitterBufferMs, bufLimit)) out.push(`jitbuf ${Math.round(m.jitterBufferMs)}ms`)
    if (over(m.jitterMs, LIMITS.jitterMs)) out.push(`jitter ${Math.round(m.jitterMs)}ms`)
    if (meta.kind === 'audio' && over(m.concealedSamplesDelta, LIMITS.concealedPerTick))
      out.push(`plc ${Math.round(m.concealedSamplesDelta)}`)
  }
  return out
}

// Append the dashed threshold guide as one more series so uPlot's auto-range
// always keeps the limit in view (headroom below the line is part of the
// signal). The guide is deliberately absent from the `series` prop, so the
// legend readouts skip it.
function withThresholdData(data, threshold) {
  if (!threshold) return data
  return [...data, data[0].map(() => threshold.value)]
}

// ── One time-series chart ─────────────────────────────────────────────────────
// The uPlot instance is created ONCE and only fed via setData per tick. `series`
// (labels + colors), `theme`, and `height` are constant for a given card
// instance, so the create effect reads them from the mount-time closure and a
// fresh `data`/`series` array identity each render never forces a recreate.
// `threshold` (optional): { value, seriesIndex = 0 } — draws a dashed guide at
// `value` and turns the guarded series' readout red while its latest sample
// exceeds it.
function UplotChart({ title, data, series, theme, height = 70, unit, threshold }) {
  const wrapRef = useRef(null)
  const uRef = useRef(null)

  // Create the uPlot instance exactly once. series/theme/height are constant for
  // a given card instance, so we read them from the mount-time closure; only
  // `data` changes per tick and is fed via setData (below), never a recreate.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const axisFont = `10px ${theme.font}`
    const opts = {
      width: el.clientWidth || CHART_FALLBACK_W,
      height,
      legend: { show: false },
      // Crosshair readout on hover; no drag-zoom (debug charts shouldn't rescale).
      cursor: { drag: { x: false, y: false }, points: { size: 5 } },
      scales: { x: { time: true } },
      axes: [
        {
          stroke: theme.axis,
          grid: { show: false },
          ticks: { show: false },
          size: 16,
          space: 55,
          font: axisFont
        },
        {
          stroke: theme.axis,
          grid: { show: true, stroke: theme.grid, width: 1 },
          ticks: { show: false },
          size: 32,
          font: axisFont
        }
      ],
      series: [
        {},
        ...series.map((c) => ({
          label: c.label,
          stroke: c.color,
          width: 1.4,
          points: { show: false }
        })),
        // Trailing dashed guide series when a threshold is set (see
        // withThresholdData — data gets a matching constant series appended).
        ...(threshold
          ? [{ label: 'limit', stroke: theme.red, width: 1, dash: [4, 4], points: { show: false } }]
          : [])
      ]
    }
    const u = new uPlot(opts, withThresholdData(data, threshold), el)
    uRef.current = u

    // Panel width is fixed, but keep the canvas honest if layout shifts.
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth
      if (w) u.setSize({ width: w, height })
    })
    ro.observe(el)

    return () => {
      ro.disconnect()
      u.destroy()
      uRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Per-tick updates — never a recreate.
  useEffect(() => {
    uRef.current?.setData(withThresholdData(data, threshold))
  }, [data, threshold])

  return (
    <div className="sdp-chart">
      <div className="sdp-chart-head">
        <span className="sdp-chart-title">{title}</span>
        <span className="sdp-chart-legend">
          {series.map((s, i) => {
            const latest = lastValue(data, i)
            const exceeded =
              threshold &&
              (threshold.seriesIndex ?? 0) === i &&
              latest != null &&
              latest > threshold.value
            return (
              <span
                key={s.label}
                className="sdp-legend-item"
                style={{ color: exceeded ? 'var(--color-danger)' : s.color }}
              >
                <span className="sdp-legend-dot" style={{ background: s.color }} />
                {formatReadout(latest)}
              </span>
            )
          })}
          {unit ? <span className="sdp-chart-unit">{unit}</span> : null}
        </span>
      </div>
      <div className="sdp-chart-canvas" ref={wrapRef} />
    </div>
  )
}

// Build aligned [xSeconds, ...ySeries] from a buffer. Each deriver maps a metrics
// object to a number|null; buf.ts and buf.samples stay length-aligned by
// construction, so gaps (nulls) render as breaks in the line.
function buildData(buf, derivers) {
  const xs = buf.ts.map((t) => t / 1000) // uPlot x is unix SECONDS
  return [xs, ...derivers.map((fn) => buf.samples.map(fn))]
}

function Badge({ children, tone }) {
  return <span className={`sdp-badge${tone ? ` sdp-badge-${tone}` : ''}`}>{children}</span>
}

function StatRow({ items }) {
  return (
    <div className="sdp-stats">
      {items.map((it) => (
        <span key={it.label} className="sdp-stat">
          <span className="sdp-stat-label">{it.label}</span>
          <span className="sdp-stat-value">{it.value}</span>
        </span>
      ))}
    </div>
  )
}

// ── Produced (send) stream card ───────────────────────────────────────────────
function SendCard({ buf, theme }) {
  const meta = buf.meta
  const m = meta.metrics || {}
  const isVideo = meta.kind === 'video'
  const hw = m.hardware === true ? 'HW' : m.hardware === false ? 'SW' : '?'
  const qlr = m.qualityLimitationReason
  const warns = activeWarnings(meta)

  return (
    <div className={`sdp-card${warns.length ? ' sdp-card-warn' : ''}`}>
      <div className="sdp-card-head">
        <span className="sdp-card-title">
          {TYPE_LABELS[meta.producedType] || meta.producedType}
        </span>
        {meta.codec ? <Badge tone="codec">{String(meta.codec).toUpperCase()}</Badge> : null}
        {isVideo && m.width != null && m.height != null ? (
          <Badge>
            {m.width}×{m.height}
            {m.fps != null ? `@${Math.round(m.fps)}` : ''}
          </Badge>
        ) : null}
        {isVideo ? (
          <Badge tone={hw === 'HW' ? 'ok' : hw === 'SW' ? 'warn' : undefined}>{hw}</Badge>
        ) : null}
        {isVideo && qlr && qlr !== 'none' ? <Badge tone="warn">{qlr}</Badge> : null}
        {warns.map((w) => (
          <Badge key={w} tone="danger">
            {w}
          </Badge>
        ))}
      </div>

      {isVideo ? (
        <>
          <UplotChart
            title="Bitrate"
            unit="kbps"
            theme={theme}
            series={[
              { label: 'send', color: theme.primary },
              { label: 'avail', color: theme.blue }
            ]}
            data={buildData(buf, [(x) => num(x.sendKbps), (x) => kbps(x.availableOutgoingBitrate)])}
          />
          <UplotChart
            title="FPS / encode"
            unit=""
            theme={theme}
            series={[
              { label: 'fps', color: theme.green },
              { label: 'enc ms', color: theme.amber }
            ]}
            data={buildData(buf, [(x) => num(x.fps), (x) => num(x.encodeMsPerFrame)])}
          />
          <UplotChart
            title="RTT"
            unit="ms"
            theme={theme}
            threshold={{ value: LIMITS.rttMs }}
            series={[{ label: 'rtt', color: theme.amber }]}
            data={buildData(buf, [(x) => num(x.rttMs)])}
          />
          <UplotChart
            title="Loss"
            unit="%"
            theme={theme}
            threshold={{ value: LIMITS.fractionLost * 100 }}
            series={[{ label: 'lost', color: theme.red }]}
            data={buildData(buf, [(x) => pct(x.fractionLost)])}
          />
          <StatRow
            items={[
              { label: 'nack', value: fmtInt(m.nackCount) },
              { label: 'pli', value: fmtInt(m.pliCount) },
              { label: 'retx', value: fmtInt(m.retransmittedPacketsSent) },
              { label: 'lost', value: fmtInt(m.packetsLost) },
              { label: 'sent', value: fmtInt(m.packetsSent) },
              { label: 'impl', value: m.implementation || '—' }
            ]}
          />
        </>
      ) : (
        <>
          <UplotChart
            title="Bitrate"
            unit="kbps"
            theme={theme}
            series={[
              { label: 'send', color: theme.primary },
              { label: 'target', color: theme.blue }
            ]}
            data={buildData(buf, [(x) => num(x.sendKbps), (x) => kbps(x.targetBitrate)])}
          />
          <UplotChart
            title="RTT / jitter"
            unit="ms"
            theme={theme}
            threshold={{ value: LIMITS.rttMs }}
            series={[
              { label: 'rtt', color: theme.amber },
              { label: 'jitter', color: theme.blue }
            ]}
            data={buildData(buf, [(x) => num(x.rttMs), (x) => num(x.jitterMs)])}
          />
          <StatRow
            items={[
              { label: 'sent', value: fmtInt(m.packetsSent) },
              { label: 'lost', value: fmtInt(m.packetsLost) },
              { label: 'loss%', value: fmtFixed(pct(m.fractionLost)) }
            ]}
          />
        </>
      )}
    </div>
  )
}

// ── Consumed (recv) stream card ───────────────────────────────────────────────
function RecvCard({ buf, theme, clients }) {
  const meta = buf.meta
  const m = meta.metrics || {}
  const isVideo = meta.kind === 'video'
  const name = clientLabel(clients, meta.clientId)
  const warns = activeWarnings(meta)

  return (
    <div className={`sdp-card${warns.length ? ' sdp-card-warn' : ''}`}>
      <div className="sdp-card-head">
        <span className="sdp-card-title">{name}</span>
        <span className="sdp-card-sub">{TYPE_LABELS[meta.producedType] || meta.producedType}</span>
        {meta.codec ? <Badge tone="codec">{String(meta.codec).toUpperCase()}</Badge> : null}
        {isVideo && meta.paused === true ? <Badge tone="warn">paused</Badge> : null}
        {isVideo && meta.viewRole ? <Badge>{meta.viewRole}</Badge> : null}
        {warns.map((w) => (
          <Badge key={w} tone="danger">
            {w}
          </Badge>
        ))}
      </div>

      {isVideo ? (
        <>
          <UplotChart
            title="Bitrate"
            unit="kbps"
            theme={theme}
            series={[{ label: 'recv', color: theme.primary }]}
            data={buildData(buf, [(x) => num(x.recvKbps)])}
          />
          <UplotChart
            title="FPS"
            unit=""
            theme={theme}
            series={[{ label: 'fps', color: theme.green }]}
            data={buildData(buf, [(x) => num(x.fps)])}
          />
          <UplotChart
            title="Jitter buffer"
            unit="ms"
            theme={theme}
            threshold={{ value: LIMITS.videoJitterBufferMs }}
            series={[
              { label: 'buf', color: theme.blue },
              { label: 'jitter', color: theme.amber }
            ]}
            data={buildData(buf, [(x) => num(x.jitterBufferMs), (x) => num(x.jitterMs)])}
          />
          <UplotChart
            title="Freezes"
            unit=""
            theme={theme}
            series={[{ label: 'freezes', color: theme.red }]}
            data={buildData(buf, [(x) => num(x.freezeCount)])}
          />
          <StatRow
            items={[
              { label: 'decoded', value: fmtInt(m.framesDecoded) },
              { label: 'dropped', value: fmtInt(m.framesDropped) },
              { label: 'keyframes', value: fmtInt(m.keyFramesDecoded) },
              { label: 'pli', value: fmtInt(m.pliCount) },
              { label: 'nack', value: fmtInt(m.nackCount) },
              { label: 'lost', value: fmtInt(m.packetsLost) },
              { label: 'decoder', value: m.decoderImplementation || '—' }
            ]}
          />
        </>
      ) : (
        <>
          <UplotChart
            title="Bitrate"
            unit="kbps"
            theme={theme}
            series={[{ label: 'recv', color: theme.primary }]}
            data={buildData(buf, [(x) => num(x.recvKbps)])}
          />
          <UplotChart
            title="Jitter buffer"
            unit="ms"
            theme={theme}
            threshold={{ value: LIMITS.audioJitterBufferMs }}
            series={[{ label: 'buf', color: theme.blue }]}
            data={buildData(buf, [(x) => num(x.jitterBufferMs)])}
          />
          <UplotChart
            title="Concealed"
            unit=""
            theme={theme}
            threshold={{ value: LIMITS.concealedPerTick }}
            series={[{ label: 'concealed', color: theme.amber }]}
            data={buildData(buf, [(x) => num(x.concealedSamplesDelta)])}
          />
          <StatRow
            items={[
              { label: 'recv', value: fmtInt(m.packetsReceived) },
              { label: 'lost', value: fmtInt(m.packetsLost) },
              { label: 'jitter', value: fmtFixed(num(m.jitterMs)) },
              { label: 'conceal ev', value: fmtInt(m.concealmentEvents) },
              { label: 'level', value: fmtFixed(num(m.audioLevel), 2) }
            ]}
          />
        </>
      )}
    </div>
  )
}

export default function StreamDebugPanel({ clients, onClose }) {
  // Theme colors snapshotted once at mount (see readTheme's known-limitation
  // note). Lazy initializer runs a single time.
  const [theme] = useState(readTheme)

  // key -> { meta, ts:number[], samples:object[], missedTicks:number }. The ref
  // is the source of truth (mutated in place by the subscription); each tick we
  // publish a fresh array snapshot to state to drive one re-render. Charts then
  // rebuild their data arrays from these buffers.
  const bufsRef = useRef(new Map())
  const [buffers, setBuffers] = useState([])

  const rootRef = useRef(null)
  const dragRef = useRef(null)
  const resizeRef = useRef(null)
  const [dragging, setDragging] = useState(false)

  // Initial position ≈ top-right (top:56, right:24). Drag writes left/top, so
  // derive the starting left from the current viewport width.
  const [pos, setPos] = useState(() => ({
    left: Math.max(DRAG_MARGIN, window.innerWidth - PANEL_W - 24),
    top: 56
  }))

  // height === null means "auto, capped by the CSS max-height" until the user
  // resizes; after that the explicit size wins.
  const [size, setSize] = useState({ width: PANEL_W, height: null })

  // 'all' | 'self' (our produced streams) | a clientId (that user's consumed
  // streams only).
  const [filter, setFilter] = useState('all')

  // ── Stats subscription ─────────────────────────────────────────────────────
  useEffect(() => {
    const onSample = (sample) => {
      const bufs = bufsRef.current
      const seen = new Set()
      for (const s of sample.streams || []) {
        seen.add(s.key)
        let buf = bufs.get(s.key)
        if (!buf) {
          buf = { meta: s, ts: [], samples: [], missedTicks: 0 }
          bufs.set(s.key, buf)
        }
        buf.meta = s // refresh codec/dims/paused/etc.
        buf.missedTicks = 0
        buf.ts.push(sample.ts)
        buf.samples.push(s.metrics || {})
        if (buf.ts.length > CAP) {
          buf.ts.shift()
          buf.samples.shift()
        }
      }
      // A single failed getStats tick must not wipe history — only drop a buffer
      // after MISS_LIMIT consecutive absences.
      for (const [key, buf] of bufs) {
        if (!seen.has(key)) {
          buf.missedTicks += 1
          if (buf.missedTicks >= MISS_LIMIT) bufs.delete(key)
        }
      }
      setBuffers([...bufs.values()])
      // Drop a stale selection (shared screen stopped / user left) back to All.
      // Done here off the tick — not in a render effect — and the ring buffers'
      // MISS_LIMIT grace means it only fires once a party is genuinely gone,
      // not on a transient getStats miss.
      setFilter((cur) => {
        if (cur === 'all') return cur
        const entries = [...bufs.values()]
        const stillPresent =
          cur === 'self'
            ? entries.some((b) => b.meta.direction === 'send')
            : entries.some((b) => b.meta.direction === 'recv' && b.meta.clientId === cur)
        return stillPresent ? cur : 'all'
      })
    }

    const stop = startStreamDebugStats(onSample, POLL_MS)
    return () => {
      if (typeof stop === 'function') stop()
    }
  }, [])

  // ── Drag (header only; charts + body scrolling never initiate it) ───────────
  const onPointerDown = (e) => {
    if (e.target.closest('button')) return // never drag from the close button
    const rect = rootRef.current.getBoundingClientRect()
    dragRef.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
  }

  const onPointerMove = (e) => {
    if (!dragRef.current) return
    const root = rootRef.current
    const w = root.offsetWidth
    // Keep at least DRAG_MARGIN of the panel/header on-screen so it can't be lost.
    const left = clamp(
      e.clientX - dragRef.current.dx,
      DRAG_MARGIN - w,
      window.innerWidth - DRAG_MARGIN
    )
    const top = clamp(e.clientY - dragRef.current.dy, 0, window.innerHeight - DRAG_MARGIN)
    root.style.left = `${left}px`
    root.style.top = `${top}px`
  }

  const onPointerUp = (e) => {
    if (!dragRef.current) return
    dragRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const root = rootRef.current
    setPos({ left: parseFloat(root.style.left), top: parseFloat(root.style.top) })
    setDragging(false)
  }

  // ── Resize (bottom-right grip; same write-through-ref pattern as drag) ──────
  // Charts follow along on their own: each UplotChart has a ResizeObserver on
  // its wrapper calling setSize.
  const onResizeDown = (e) => {
    const rect = rootRef.current.getBoundingClientRect()
    resizeRef.current = { startX: e.clientX, startY: e.clientY, w: rect.width, h: rect.height }
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onResizeMove = (e) => {
    const r = resizeRef.current
    if (!r) return
    const root = rootRef.current
    const rect = root.getBoundingClientRect()
    const width = clamp(r.w + e.clientX - r.startX, PANEL_MIN_W, window.innerWidth - rect.left - 8)
    const height = clamp(r.h + e.clientY - r.startY, PANEL_MIN_H, window.innerHeight - rect.top - 8)
    root.style.width = `${width}px`
    root.style.height = `${height}px`
    root.style.maxHeight = 'none'
  }

  const onResizeUp = (e) => {
    if (!resizeRef.current) return
    resizeRef.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    const rect = rootRef.current.getBoundingClientRect()
    setSize({ width: Math.round(rect.width), height: Math.round(rect.height) })
  }

  const sends = buffers.filter((b) => b.meta.direction === 'send')
  const recvs = buffers.filter((b) => b.meta.direction === 'recv')
  const empty = sends.length === 0 && recvs.length === 0

  // Filter chips: 'You' for everything we produce, one entry per remote user we
  // consume from. A chip gets a warning dot while any of that party's streams
  // currently breach a LIMITS threshold, so the problem user is findable
  // without scrolling.
  const groups = []
  if (sends.length > 0) {
    groups.push({
      id: 'self',
      label: 'You',
      warn: sends.some((b) => activeWarnings(b.meta).length > 0)
    })
  }
  for (const b of recvs) {
    const id = b.meta.clientId
    const warn = activeWarnings(b.meta).length > 0
    const existing = groups.find((g) => g.id === id)
    if (existing) existing.warn ||= warn
    else groups.push({ id, label: clientLabel(clients, id), warn })
  }

  const visibleSends = filter === 'all' || filter === 'self' ? sends : []
  const visibleRecvs =
    filter === 'all'
      ? recvs
      : filter === 'self'
        ? []
        : recvs.filter((b) => b.meta.clientId === filter)

  return (
    <div
      ref={rootRef}
      className={`stream-debug-panel${dragging ? ' sdp-dragging' : ''}`}
      style={{
        left: pos.left,
        top: pos.top,
        width: size.width,
        ...(size.height != null ? { height: size.height, maxHeight: 'none' } : {})
      }}
    >
      <div
        className="sdp-header"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        <IconGripVertical size={16} className="sdp-grip" />
        <span className="sdp-header-title">Stream Debug</span>
        <button type="button" className="sdp-close" onClick={onClose} title="Close">
          <IconX size={16} />
        </button>
      </div>

      {groups.length > 1 && (
        <div className="sdp-filters">
          {[{ id: 'all', label: 'All', warn: false }, ...groups].map((g) => (
            <button
              key={g.id}
              type="button"
              className={`sdp-filter-chip${filter === g.id ? ' sdp-filter-active' : ''}`}
              onClick={() => setFilter(filter === g.id ? 'all' : g.id)}
            >
              {g.warn ? <span className="sdp-chip-dot" /> : null}
              {g.label}
            </button>
          ))}
        </div>
      )}

      <div className="sdp-body">
        {empty ? (
          <div className="sdp-empty">No active streams</div>
        ) : (
          <>
            {visibleSends.length > 0 && (
              <>
                <div className="sdp-section">Produced</div>
                {visibleSends.map((buf) => (
                  <SendCard key={buf.meta.key} buf={buf} theme={theme} />
                ))}
              </>
            )}
            {visibleRecvs.length > 0 && (
              <>
                <div className="sdp-section">Consumed</div>
                {visibleRecvs.map((buf) => (
                  <RecvCard key={buf.meta.key} buf={buf} theme={theme} clients={clients} />
                ))}
              </>
            )}
          </>
        )}
      </div>

      <div
        className="sdp-resize"
        onPointerDown={onResizeDown}
        onPointerMove={onResizeMove}
        onPointerUp={onResizeUp}
        title="Resize"
      />
    </div>
  )
}
