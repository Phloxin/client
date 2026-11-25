/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence, animate, useMotionValue } from 'motion/react'
import {
  IconChevronDown,
  IconHeadphonesOff,
  IconMicrophoneOff,
  IconPhoneCall,
  IconPhoneFilled,
  IconVideoFilled
} from '@tabler/icons-react'
import { useAnimationCategory } from '../context/SettingsContext'
import { formatCallDuration } from '../lib/callMessages'
import { collapseSection, spring } from '../lib/motionPresets'
import './DmCallBar.css'

// Slim-row metrics, matching DmCallBar.css: an avatar, the gap between two in
// the avatars-only row, the extra gap before the first one not in the call,
// and the row's side padding.
const AVATAR = 28
const AVATAR_GAP = 6
const AWAY_GAP = 8
const TRACK_PAD = 6

// The card growing into the stage and back, and everyone finding their place.
const grow = { type: 'spring', stiffness: 420, damping: 38, mass: 0.8 }

// A participant arriving or leaving.
const chipPop = (enabled) =>
  enabled
    ? {
        initial: { opacity: 0, scale: 0.6 },
        animate: { opacity: 1, scale: 1, transition: spring },
        exit: { opacity: 0, scale: 0.6, transition: { duration: 0.12, ease: 'easeIn' } }
      }
    : { initial: false }

// Text that only one of the two forms shows.
const fadeIn = (enabled, delay = 0.06) =>
  enabled
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.18, ease: 'easeOut', delay } }
      }
    : { initial: false }

function CallTimer({ startedAt }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="dcb-timer">{formatCallDuration(now - startedAt)}</span>
}

// The tooltip of a participant: their name and what stands out about them.
function describe(e) {
  if (!e.inCall) {
    if (e.status === 'ringing') return `${e.name} · Ringing…`
    return e.status === 'offline' ? `${e.name} · Offline` : `${e.name} · Not in the call`
  }
  if (e.deafened) return `${e.name} · Deafened`
  return e.muted ? `${e.name} · Muted` : e.name
}

// One participant per chip: in the call (speaking ring, mute or deafen badge,
// stream), or dimmed with a Ring button, "Ringing…" or "Offline". Slim, the
// chips sit in a row that never scrolls: names are dropped when they don't
// fit, then the avatars that don't fit fold into a "+N". Expanded, the card
// grows into a stage of larger avatars that wraps. `compact` keeps it slim.
export function DmCallBar({
  entries,
  joined,
  startedAt,
  compact,
  expanded,
  onToggleExpanded,
  join,
  onRing,
  onWatchStream
}) {
  const anim = useAnimationCategory('callBar')
  const innerRef = useRef(null)
  const peopleRef = useRef(null)
  const captionRef = useRef(null)
  const sizerRef = useRef(null)
  // What the slim row has room for: every name, or else this many avatars.
  const [fit, setFit] = useState(() => ({ names: true, count: entries.length }))
  // The card's height: its content's, sprung to when that changes.
  const cardHeight = useMotionValue('auto')
  const lastHeight = useRef(null)
  // Whether the card is still on its way to a new height.
  const [growing, setGrowing] = useState(false)
  const growRef = useRef(0)
  // Recipients with a ring request in flight, so the button can't double-fire.
  const [pending, setPending] = useState(() => new Set())
  const stage = expanded && !compact
  // The avatars-only row sets those not in the call a little apart.
  const split = joined && entries.some((e) => !e.inCall)

  // The caption holds the row's place while the people are on the stage, so
  // the row's room is known in both forms.
  const measure = useCallback(() => {
    const inner = innerRef.current
    const lead = captionRef.current ?? peopleRef.current
    const sizer = sizerRef.current
    if (!inner || !lead || !sizer) return
    const room = lead.clientWidth - 2 * TRACK_PAD
    const names = sizer.offsetWidth <= room
    const count = Math.max(
      1,
      Math.floor((room - (split ? AWAY_GAP : 0) + AVATAR_GAP) / (AVATAR + AVATAR_GAP))
    )
    setFit((prev) => (prev.names === names && prev.count === count ? prev : { names, count }))
    // The stage is capped by the view it sits in.
    const view = inner.closest('.dm-call-slot')?.parentElement
    if (view) inner.style.setProperty('--dcb-view-height', `${view.clientHeight}px`)

    const height = inner.offsetHeight
    if (!anim) {
      lastHeight.current = null
      cardHeight.set('auto')
    } else if (lastHeight.current == null) {
      lastHeight.current = height
      cardHeight.set(height)
    } else if (height !== lastHeight.current) {
      lastHeight.current = height
      const run = ++growRef.current
      setGrowing(true)
      animate(cardHeight, height, grow).then(() => {
        if (growRef.current === run) setGrowing(false)
      })
    }
  }, [anim, split, cardHeight])

  useLayoutEffect(measure)

  useEffect(() => {
    const observer = new ResizeObserver(measure)
    const view = innerRef.current.closest('.dm-call-slot')?.parentElement
    for (const el of [
      innerRef.current,
      captionRef.current ?? peopleRef.current,
      sizerRef.current,
      view
    ]) {
      if (el) observer.observe(el)
    }
    return () => observer.disconnect()
  }, [measure, stage])

  const ring = async (id) => {
    setPending((prev) => new Set(prev).add(id))
    try {
      await onRing(id)
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }
  }

  const view = stage ? 'stage' : fit.names ? 'names' : 'avatars'
  let shown = entries
  if (view === 'avatars' && entries.length > fit.count) {
    shown = entries.slice(0, fit.count - 1)
  }
  const more = entries.length - shown.length
  const inCall = entries.filter((e) => e.inCall).length
  const away = entries.length - inCall

  // Places are re-measured, and moved to on a spring, only when one of these
  // changes; a speaking ring or a badge never moves anyone.
  const placement = `${view}|${more}|${shown
    .map((e) => `${e.id}:${e.status ?? ''}:${e.streaming ? 1 : 0}`)
    .join(',')}`
  const placed = { layoutDependency: placement, transition: { layout: grow } }

  const stream = (e, badge) => {
    if (!e.streaming) return null
    const className = `dcb-live${badge ? ' badge' : ''}`
    return e.watchable ? (
      <button
        type="button"
        className={className}
        title={`Watch ${e.name}'s stream`}
        aria-label={`Watch ${e.name}'s stream`}
        onClick={() => onWatchStream(e.id)}
      >
        <IconVideoFilled />
      </button>
    ) : (
      <span className={className} role="img" aria-label="Streaming" title="Streaming">
        <IconVideoFilled />
      </span>
    )
  }

  const status = (e) => {
    if (e.inCall) return null
    return e.status === 'ring' ? (
      <button
        type="button"
        className="dcb-ring"
        title={`Ring ${e.name}`}
        disabled={pending.has(e.id)}
        onClick={() => ring(e.id)}
      >
        Ring
      </button>
    ) : (
      <span className="dcb-status">{e.status === 'ringing' ? 'Ringing…' : 'Offline'}</span>
    )
  }

  const chip = (e) => (
    <motion.div
      key={e.id}
      className={`dcb-chip${e.inCall ? '' : ' absent'}${e.speaking ? ' speaking' : ''}${
        e.status === 'ringing' ? ' ringing' : ''
      }`}
      title={describe(e)}
      layout={anim}
      {...placed}
      {...chipPop(anim)}
    >
      <motion.span className="dcb-avatar" layout={anim} {...placed}>
        <span className="dcb-face">
          {e.avatar ? (
            <img src={e.avatar} alt="" draggable={false} />
          ) : (
            (e.name || '?').charAt(0).toUpperCase()
          )}
        </span>
        {e.inCall && (e.deafened || e.muted) && (
          <span className="dcb-badge" role="img" aria-label={e.deafened ? 'Deafened' : 'Muted'}>
            {e.deafened ? <IconHeadphonesOff /> : <IconMicrophoneOff />}
          </span>
        )}
        {view === 'avatars' && stream(e, true)}
        {/* With no room for a Ring button, the avatar is one. */}
        {view === 'avatars' && e.status === 'ring' && (
          <button
            type="button"
            className="dcb-avatar-ring"
            title={`Ring ${e.name}`}
            aria-label={`Ring ${e.name}`}
            disabled={pending.has(e.id)}
            onClick={() => ring(e.id)}
          >
            <IconPhoneCall />
          </button>
        )}
      </motion.span>
      {view !== 'avatars' && (
        <motion.span
          className="dcb-label"
          layout={anim ? 'position' : false}
          {...placed}
          {...fadeIn(anim)}
        >
          <span className="dcb-nameline">
            <span className="dcb-name">{e.name}</span>
            {stream(e, false)}
          </span>
          {status(e)}
        </motion.span>
      )}
    </motion.div>
  )

  const moreProps = {
    className: 'dcb-more',
    layout: anim,
    ...placed,
    ...chipPop(anim)
  }

  return (
    <motion.div className="dcb" role="group" aria-label="Call" style={{ height: cardHeight }}>
      <div className={`dcb-inner ${view}`} ref={innerRef}>
        {stage && (
          <motion.span className="dcb-caption" ref={captionRef} {...fadeIn(anim, 0.16)}>
            {inCall} in call{away > 0 && ` · ${away} not here`}
          </motion.span>
        )}
        <motion.div
          className={`dcb-people ${view}${growing ? ' growing' : ''}`}
          ref={peopleRef}
          layoutScroll
        >
          <AnimatePresence initial={false} mode="popLayout">
            {shown.map(chip)}
            {more > 0 &&
              (compact ? (
                <motion.span
                  key="more"
                  {...moreProps}
                  title={entries
                    .slice(shown.length)
                    .map((e) => e.name)
                    .join(', ')}
                >
                  +{more}
                </motion.span>
              ) : (
                <motion.button
                  key="more"
                  {...moreProps}
                  type="button"
                  title={`Show all ${entries.length}`}
                  onClick={onToggleExpanded}
                >
                  +{more}
                </motion.button>
              ))}
          </AnimatePresence>
        </motion.div>
        <div className="dcb-meta">
          <span className="dcb-clock" title={joined ? 'In call' : 'Call in progress'}>
            <IconPhoneFilled size={14} />
            {startedAt != null && <CallTimer startedAt={startedAt} />}
          </span>
          {join && (
            <button
              type="button"
              className="dcb-join"
              title={join.title}
              disabled={join.disabled}
              onClick={join.onClick}
            >
              {join.label}
            </button>
          )}
          {!compact && (
            <button
              type="button"
              className="dcb-toggle"
              title={expanded ? 'Collapse' : 'Expand'}
              aria-label={expanded ? 'Collapse call' : 'Expand call'}
              aria-expanded={expanded}
              onClick={onToggleExpanded}
            >
              <motion.span
                className="dcb-chevron"
                initial={false}
                animate={{ rotate: expanded ? 180 : 0 }}
                transition={anim ? spring : { duration: 0 }}
              >
                <IconChevronDown size={16} />
              </motion.span>
            </button>
          )}
        </div>
        {/* Every chip with its name, unseen: how wide the row would have to be. */}
        <div className="dcb-sizer" ref={sizerRef} aria-hidden="true">
          {entries.map((e) => (
            <span key={e.id} className="dcb-chip">
              <span className="dcb-avatar" />
              <span className="dcb-label">
                <span className="dcb-nameline">
                  <span className="dcb-name">{e.name}</span>
                  {e.streaming && <span className="dcb-live" />}
                </span>
                {!e.inCall &&
                  (e.status === 'ring' ? (
                    <span className="dcb-ring">Ring</span>
                  ) : (
                    <span className="dcb-status">
                      {e.status === 'ringing' ? 'Ringing…' : 'Offline'}
                    </span>
                  ))}
              </span>
            </span>
          ))}
        </div>
      </div>
    </motion.div>
  )
}

// A pane's place for the call bar, above its view. Always rendered, so the bar
// folds in and out as a call starts and ends; keyed by the view, so a switch of
// views brings its bar (or none) with it at once.
export function DmCallBarSlot({ viewKey, call }) {
  const anim = useAnimationCategory('callBar')
  return (
    <AnimatePresence key={viewKey} initial={false}>
      {call && (
        <motion.div key="bar" className="dm-call-slot" {...collapseSection(anim)}>
          <div className="dm-call-pad">
            <DmCallBar key={call.channelId} {...call} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
