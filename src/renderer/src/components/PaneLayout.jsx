/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { motion, AnimatePresence } from 'motion/react'
import TabStrip from './TabStrip'
import { useAnimationCategory } from '../context/SettingsContext'
import {
  MAX_SPLIT_RATIO,
  MIN_PANE_HEIGHT,
  MIN_PANE_WIDTH,
  MIN_SPLIT_RATIO,
  canSplit,
  moveOrder,
  splitFits
} from '../lib/tabs'
import './PaneLayout.css'

// Pointer travel before a press on a tab becomes a drag.
const DRAG_THRESHOLD = 4
// How far in from each canvas edge (as a share of it) a drag offers a split.
const EDGE_ZONE = 0.25

const zoneFade = (enabled) =>
  enabled
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1, transition: { duration: 0.12, ease: 'easeOut' } },
        exit: { opacity: 0, transition: { duration: 0.1, ease: 'easeIn' } }
      }
    : { initial: false }

const within = (r, x, y) => x >= r.left && x < r.right && y >= r.top && y < r.bottom

const sameTarget = (a, b) =>
  a === b ||
  (!!a &&
    !!b &&
    a.kind === b.kind &&
    a.paneId === b.paneId &&
    a.index === b.index &&
    a.side === b.side)

// Where a dragged tab would land under the pointer: a strip slot { kind:
// 'strip', paneId, index }, the other pane's body { kind: 'body', paneId } (two
// panes; its own pane's body is no drop), a canvas edge { kind: 'edge', side }
// (one pane, when the tab can split off and the canvas has room that way), or
// null.
function dropTarget(root, layout, tabId, fromPaneId, x, y) {
  for (const strip of root.querySelectorAll('[data-pane-strip]')) {
    const r = strip.getBoundingClientRect()
    if (!within(r, x, y)) continue
    // Slots count the strip's other tabs whose middle is left of the pointer.
    let index = 0
    for (const el of strip.querySelectorAll('[data-tab-id]')) {
      if (el.dataset.tabId === tabId) continue
      if (r.left - strip.scrollLeft + el.offsetLeft + el.offsetWidth / 2 < x) index++
    }
    return { kind: 'strip', paneId: strip.dataset.paneStrip, index }
  }
  if (layout.panes.length > 1) {
    for (const pane of root.querySelectorAll('[data-pane-id]')) {
      if (within(pane.getBoundingClientRect(), x, y)) {
        const paneId = pane.dataset.paneId
        return paneId === fromPaneId ? null : { kind: 'body', paneId }
      }
    }
    return null
  }
  const r = root.getBoundingClientRect()
  if (!within(r, x, y) || !canSplit(layout, tabId)) return null
  // The nearest edge with room for a split, if the pointer is within its zone.
  const edges = [
    ['left', (x - r.left) / r.width],
    ['right', (r.right - x) / r.width],
    ['top', (y - r.top) / r.height],
    ['bottom', (r.bottom - y) / r.height]
  ].filter(([side]) => splitFits(side, r.width, r.height))
  if (!edges.length) return null
  const [side, depth] = edges.reduce((a, b) => (b[1] < a[1] ? b : a))
  return depth < EDGE_ZONE ? { kind: 'edge', side } : null
}

// A click lands right after the pointerup that ended a drag; it must not also
// activate whatever tab is under the pointer.
function swallowNextClick() {
  const stop = (e) => {
    e.stopPropagation()
    e.preventDefault()
  }
  window.addEventListener('click', stop, { capture: true, once: true })
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0)
}

// The content canvas: one pane, or two side by side ('row') or stacked
// ('column'), each a tab strip over its view. Owns the tab drag (reorder, move
// to the other pane, drop on an edge to split) and the divider between panes.
// panes: [{ id, tabs, header, error, body, bodyKey }] in layout order; `tabs`
// are TabStrip descriptions and `header`, `error`, `body` elements Main has
// rendered, so a drag in progress never re-renders the views.
function PaneLayout({ layout, panes, menuItems, dispatch }) {
  const rootRef = useRef(null)
  const ghostRef = useRef(null)
  // The press or drag under way: pointer bookkeeping read by window listeners.
  const sessionRef = useRef(null)
  // What a drag shows: { tab, fromPaneId, width, target } once it has started.
  const [drag, setDrag] = useState(null)
  // The divider's ratio while it is being dragged; committed on release.
  const [liveRatio, setLiveRatio] = useState(null)
  const slide = useAnimationCategory('tabs')
  const layoutRef = useRef(layout)
  useEffect(() => {
    layoutRef.current = layout
  })

  // End any drag if the canvas goes away under it (a disconnect).
  useEffect(() => () => sessionRef.current?.cancel(), [])

  // The ghost appears at the dragged tab's place; pointer moves then move it
  // directly, without a render.
  const dragging = drag != null
  useLayoutEffect(() => {
    const s = sessionRef.current
    if (dragging && s && ghostRef.current) {
      ghostRef.current.style.transform = `translate(${s.x}px, ${s.y}px)`
    }
  }, [dragging])

  const drop = (tabId, target) => {
    if (target.kind === 'edge') {
      dispatch({ type: 'splitWith', tabId, side: target.side })
    } else {
      const index = target.kind === 'strip' ? target.index : Infinity
      dispatch({ type: 'move', tabId, toPaneId: target.paneId, index })
    }
  }

  // Pointer pressed on a tab: track it until release; past the threshold it
  // is a drag. Escape, a lost pointer or a lost window cancel it.
  const startDrag = (e, tab, paneId) => {
    if (sessionRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    const s = {
      tab,
      fromPaneId: paneId,
      pointerId: e.pointerId,
      x0: e.clientX,
      y0: e.clientY,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
      width: rect.width,
      x: rect.left,
      y: rect.top,
      started: false,
      target: null
    }
    const finish = (commit) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onCancel)
      window.removeEventListener('blur', onCancel)
      window.removeEventListener('keydown', onKey, true)
      sessionRef.current = null
      if (!s.started) return
      document.documentElement.classList.remove('tab-dragging')
      setDrag(null)
      if (!commit) return
      swallowNextClick()
      if (s.target) drop(s.tab.id, s.target)
    }
    const onMove = (ev) => {
      if (ev.pointerId !== s.pointerId) return
      if (!s.started) {
        if (Math.hypot(ev.clientX - s.x0, ev.clientY - s.y0) < DRAG_THRESHOLD) return
        s.started = true
        document.documentElement.classList.add('tab-dragging')
      }
      s.x = ev.clientX - s.grabX
      s.y = ev.clientY - s.grabY
      if (ghostRef.current) ghostRef.current.style.transform = `translate(${s.x}px, ${s.y}px)`
      const target = rootRef.current
        ? dropTarget(
            rootRef.current,
            layoutRef.current,
            s.tab.id,
            s.fromPaneId,
            ev.clientX,
            ev.clientY
          )
        : null
      if (s.shown && sameTarget(target, s.target)) return
      s.shown = true
      s.target = target
      setDrag({ tab: s.tab, fromPaneId: s.fromPaneId, width: s.width, target })
    }
    const onUp = (ev) => {
      if (ev.pointerId === s.pointerId) finish(true)
    }
    const onCancel = () => finish(false)
    // Claimed in the capture phase so the app's Escape (closing a preview tab)
    // never sees it.
    const onKey = (ev) => {
      if (ev.key !== 'Escape' || !s.started) return
      ev.preventDefault()
      ev.stopPropagation()
      finish(false)
    }
    s.cancel = onCancel
    sessionRef.current = s
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onCancel)
    window.addEventListener('blur', onCancel)
    window.addEventListener('keydown', onKey, true)
  }

  // Divider drag: the first pane's share follows the pointer within the
  // ratio bounds and the per-pane minimums (when the canvas has room for them).
  const startResize = (e) => {
    if (e.button !== 0) return
    e.preventDefault()
    const el = e.currentTarget
    const row = layout.splitDirection === 'row'
    const cursorClass = row ? 'pane-resizing-row' : 'pane-resizing-column'
    let ratio = null
    el.setPointerCapture(e.pointerId)
    document.documentElement.classList.add(cursorClass)
    const onMove = (ev) => {
      const r = rootRef.current.getBoundingClientRect()
      const size = row ? r.width : r.height
      const floor = (row ? MIN_PANE_WIDTH : MIN_PANE_HEIGHT) / size
      const lo = Math.max(MIN_SPLIT_RATIO, floor)
      const hi = Math.min(MAX_SPLIT_RATIO, 1 - floor)
      if (lo > hi) return
      const at = (row ? ev.clientX - r.left : ev.clientY - r.top) / size
      ratio = Math.min(hi, Math.max(lo, at))
      setLiveRatio(ratio)
    }
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      document.documentElement.classList.remove(cursorClass)
      if (ratio != null) dispatch({ type: 'setSplitRatio', ratio })
      setLiveRatio(null)
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  // A press anywhere in a pane makes it the one sidebar clicks open into.
  const focusPane = (pane) => {
    if (pane.id !== layout.activePaneId && pane.activeTabId != null) {
      dispatch({ type: 'activate', tabId: pane.activeTabId })
    }
  }

  // How a strip shows the drag: the drop's order where it would land, the
  // source closing its gap while the tab is headed elsewhere.
  const target = drag?.target ?? null
  const landsIn = target && target.kind !== 'edge' ? target.paneId : null
  const stripDrag = (pane) => {
    if (!drag) return null
    const tabId = drag.tab.id
    if (landsIn === pane.id) {
      const index = target.kind === 'strip' ? target.index : Infinity
      return { tab: drag.tab, order: moveOrder(layout, { tabId, toPaneId: pane.id, index }) }
    }
    if (pane.id === drag.fromPaneId && target) {
      return { tab: drag.tab, order: pane.tabIds.filter((id) => id !== tabId) }
    }
    return { tab: drag.tab, order: null }
  }

  const split = panes.length > 1
  const ratio = liveRatio ?? layout.splitRatio
  const direction = layout.splitDirection

  return (
    <div className={`pane-layout ${direction}`} ref={rootRef}>
      {panes.map((view, i) => {
        const pane = layout.panes.find((p) => p.id === view.id)
        return (
          <Fragment key={view.id}>
            {i > 0 && (
              <div
                className="pane-divider"
                role="separator"
                aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
                aria-label="Resize panes"
                onPointerDown={startResize}
              />
            )}
            <section
              className="pane"
              data-pane-id={view.id}
              style={split ? { flexGrow: i === 0 ? ratio : 1 - ratio } : undefined}
              onPointerDownCapture={() => focusPane(pane)}
            >
              <div className="pane-bar">
                <TabStrip
                  paneId={view.id}
                  tabs={view.tabs}
                  drag={stripDrag(pane)}
                  slide={slide && dragging}
                  dimmed={split && view.id !== layout.activePaneId}
                  onDragStart={(e, tab) => startDrag(e, tab, view.id)}
                  onActivate={(tabId) => dispatch({ type: 'activate', tabId })}
                  onClose={(tabId) => dispatch({ type: 'close', tabId })}
                  onPin={(tabId) => dispatch({ type: 'pin', tabId })}
                  onUnpin={(tabId) => dispatch({ type: 'unpin', tabId })}
                  menuItems={menuItems}
                  ariaLabel={split ? `Open views, pane ${i + 1}` : 'Open views'}
                />
                {view.header && <div className="pane-bar-actions">{view.header}</div>}
              </div>
              <div className="pane-body">
                {view.error}
                {/* Keyed so a change of content remounts and replays the
                    switch animation (see Main's bodyKey). */}
                <div className="chat-switch-region" key={view.bodyKey}>
                  {view.body}
                </div>
                <AnimatePresence>
                  {target?.kind === 'body' && target.paneId === view.id && (
                    <motion.div key="body" className="pane-drop-zone body" {...zoneFade(slide)} />
                  )}
                </AnimatePresence>
              </div>
            </section>
          </Fragment>
        )
      })}
      <AnimatePresence>
        {target?.kind === 'edge' && (
          <motion.div
            key={target.side}
            className={`pane-drop-zone edge-${target.side}`}
            {...zoneFade(slide)}
          />
        )}
      </AnimatePresence>
      {drag &&
        createPortal(
          <div
            ref={ghostRef}
            className={`tab tab-ghost${drag.tab.preview ? ' preview' : ''}`}
            style={{ width: drag.width }}
            aria-hidden="true"
          >
            <span className="tab-icon">{drag.tab.icon}</span>
            <span className="tab-title">{drag.tab.title}</span>
          </div>,
          document.body
        )}
    </div>
  )
}

export default PaneLayout
