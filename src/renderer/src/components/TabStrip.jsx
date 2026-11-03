/* eslint-disable react/prop-types -- The renderer does not use runtime PropTypes. */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { IconPin, IconPinFilled, IconX } from '@tabler/icons-react'
import { useAnimationCategory } from '../context/SettingsContext'
import { menuPop, spring } from '../lib/motionPresets'
import { useMenuPosition } from '../lib/menuPosition'
import './TabStrip.css'

// Siblings sliding out of a dragged tab's way.
const TAB_SLIDE = { layout: spring }

// Right-click menu for one tab. items: [{ key, label, icon, danger?, onSelect }]
// or 'divider'.
function TabMenu({ pos, items, onClose }) {
  const ref = useRef(null)
  const style = useMenuPosition(ref, pos)
  const anim = useAnimationCategory('overlays')

  // Escape is marked handled so the app-level Escape doesn't also close the
  // preview tab underneath.
  useEffect(() => {
    const onDown = (e) => {
      if (ref.current && !ref.current.contains(e.target)) onClose()
    }
    const onKey = (e) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault()
        onClose()
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return (
    <motion.div className="tab-context-menu" role="menu" ref={ref} style={style} {...menuPop(anim)}>
      {items.map((item, i) =>
        item === 'divider' ? (
          <div key={`divider-${i}`} className="tab-context-divider" aria-hidden="true" />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            className={`tab-context-item${item.danger ? ' danger' : ''}`}
            onClick={() => {
              onClose()
              item.onSelect()
            }}
          >
            {item.icon}
            {item.label}
          </button>
        )
      )}
    </motion.div>
  )
}

// One pane's browser-style tab strip. Main describes each tab and supplies the
// menu items; PaneLayout runs the drag and tells this how to show it.
// tabs: [{ id, title, icon, active, preview, pinned, unread, group, narrow,
// closable, pinnable }]
// drag: while a tab is dragged anywhere, { tab, order }: the dragged tab's
// description, and the tab ids to show in place of `tabs` (null keeps them),
// which may include the dragged tab from the other pane.
// slide: animate tabs into their new places (a drag is under way).
// dimmed: this is the inactive pane of two, so its active tab is dimmed.
function TabStrip({
  paneId,
  tabs,
  drag,
  slide,
  dimmed,
  onDragStart,
  onActivate,
  onClose,
  onPin,
  onUnpin,
  menuItems,
  ariaLabel
}) {
  const stripRef = useRef(null)
  const [menu, setMenu] = useState(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const activeId = tabs.find((t) => t.active)?.id ?? null

  // Keep the active tab in view when it changes (or the strip overflows).
  useLayoutEffect(() => {
    const strip = stripRef.current
    const el = strip?.querySelector('.tab.active')
    if (!el) return
    const s = strip.getBoundingClientRect()
    const r = el.getBoundingClientRect()
    if (r.left < s.left) strip.scrollLeft -= s.left - r.left
    else if (r.right > s.right) strip.scrollLeft += r.right - s.right
  }, [activeId, tabs.length])

  // A vertical wheel scrolls the strip sideways.
  const onWheel = (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) stripRef.current.scrollLeft += e.deltaY
  }

  const openMenu = (e, tab) => {
    e.preventDefault()
    const items = menuItems?.(tab.id) ?? []
    if (items.length) setMenu({ tabId: tab.id, items, pos: { x: e.clientX, y: e.clientY } })
  }

  const renderTab = (tab) => (
    <motion.div
      key={tab.id}
      layout={slide ? 'position' : false}
      transition={TAB_SLIDE}
      data-tab-id={tab.id}
      role="tab"
      tabIndex={0}
      aria-selected={tab.active}
      title={tab.title}
      className={`tab${tab.active ? ' active' : ''}${tab.preview ? ' preview' : ''}${
        tab.pinned ? ' pinned' : ''
      }${tab.narrow ? ' narrow' : ''}${drag?.tab.id === tab.id ? ' dragging' : ''}`}
      onClick={() => onActivate(tab.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onActivate(tab.id)
        }
      }}
      onDoubleClick={() => {
        if (tab.pinnable && tab.preview) onPin(tab.id)
      }}
      // Primary press away from the glyph buttons may become a drag.
      onPointerDown={(e) => {
        if (e.button === 0 && !e.target.closest('button')) onDragStart?.(e, tab)
      }}
      // Middle button: no autoscroll on press, close on release.
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault()
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && tab.closable) onClose(tab.id)
      }}
      onContextMenu={(e) => openMenu(e, tab)}
    >
      <span className="tab-icon">{tab.icon}</span>
      <span className="tab-title">{tab.title}</span>
      {tab.unread && <span className="tab-unread" role="img" aria-label="Unread messages" />}
      {tab.pinnable && (
        <button
          type="button"
          className={`tab-btn tab-pin${tab.pinned ? ' on' : ''}`}
          title={tab.pinned ? 'Unpin tab' : 'Pin tab'}
          aria-label={tab.pinned ? 'Unpin tab' : 'Pin tab'}
          onClick={(e) => {
            e.stopPropagation()
            if (tab.pinned) onUnpin(tab.id)
            else onPin(tab.id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          {tab.pinned ? <IconPinFilled size={14} /> : <IconPin size={14} />}
        </button>
      )}
      {tab.closable && (
        <button
          type="button"
          className="tab-btn tab-close"
          title="Close tab"
          aria-label="Close tab"
          onClick={(e) => {
            e.stopPropagation()
            onClose(tab.id)
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        >
          <IconX size={14} />
        </button>
      )}
    </motion.div>
  )

  let shown = tabs
  if (drag?.order) {
    const byId = new Map(tabs.map((t) => [t.id, t]))
    if (!byId.has(drag.tab.id)) byId.set(drag.tab.id, drag.tab)
    shown = drag.order.map((id) => byId.get(id)).filter(Boolean)
  }
  const group = shown.filter((t) => t.group)
  const rest = shown.filter((t) => !t.group)

  return (
    <div
      className={`tab-strip${dimmed ? ' dimmed' : ''}`}
      role="tablist"
      aria-label={ariaLabel}
      data-pane-strip={paneId}
      ref={stripRef}
      onWheel={onWheel}
    >
      {group.length > 0 && (
        <div
          className="tab-group"
          style={{
            '--group-wide': group.filter((t) => !t.narrow).length,
            '--group-narrow': group.filter((t) => t.narrow).length
          }}
        >
          {group.map(renderTab)}
        </div>
      )}
      {rest.map(renderTab)}
      <AnimatePresence>
        {menu && (
          <TabMenu
            key={`${menu.tabId}:${menu.pos.x},${menu.pos.y}`}
            pos={menu.pos}
            items={menu.items}
            onClose={closeMenu}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

export default TabStrip
