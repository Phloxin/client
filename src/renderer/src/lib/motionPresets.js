// Shared Motion (motion.dev) presets so every surface moves with the same
// physics. All consumers gate on useAnimationCategory(...) — pass its result
// into these helpers; when a category is off the helpers return zero-motion
// props so the element simply appears (never blocks or delays the action).

// Snappy interruptible spring for small UI (menus, pills, toasts).
export const spring = { type: 'spring', stiffness: 520, damping: 36, mass: 0.8 }

// Softer spring for large surfaces (modal panels, view swaps).
export const springSoft = { type: 'spring', stiffness: 330, damping: 32, mass: 0.9 }

// Overlay panel: pop up from slightly below at 96% scale. Exit is a quick fade
// so dismissal always feels instant.
export function overlayPop(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: { opacity: 0, scale: 0.96, y: 10 },
    animate: { opacity: 1, scale: 1, y: 0, transition: springSoft },
    exit: { opacity: 0, scale: 0.98, y: 6, transition: { duration: 0.12, ease: 'easeIn' } }
  }
}

// Backdrop scrim fade behind modals.
export function scrimFade(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: { opacity: 0 },
    animate: { opacity: 1, transition: { duration: 0.16, ease: 'easeOut' } },
    exit: { opacity: 0, transition: { duration: 0.12, ease: 'easeIn' } }
  }
}

// Anchored popover/menu: scale from its origin corner with a spring.
export function menuPop(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: { opacity: 0, scale: 0.92, y: -4 },
    animate: { opacity: 1, scale: 1, y: 0, transition: spring },
    exit: { opacity: 0, scale: 0.96, y: -2, transition: { duration: 0.1, ease: 'easeIn' } }
  }
}

// Toast: drop in from above with a spring, lift away on dismiss.
export function toastSlide(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: { opacity: 0, y: -18, scale: 0.98 },
    animate: { opacity: 1, y: 0, scale: 1, transition: spring },
    exit: { opacity: 0, y: -12, transition: { duration: 0.14, ease: 'easeIn' } }
  }
}

// Collapsible list section (a channel's user rows folding under its header).
// Height is sprung so the rows below settle naturally; the fade runs shorter
// than the fold so the rows are gone before the gap finishes closing. Exit is
// tighter than enter — collapsing should feel decisive, expanding relaxed.
export function collapseSection(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: { height: 0, opacity: 0 },
    animate: {
      height: 'auto',
      opacity: 1,
      transition: {
        height: { type: 'spring', stiffness: 440, damping: 40, mass: 0.7 },
        opacity: { duration: 0.16, ease: 'easeOut' }
      }
    },
    exit: {
      height: 0,
      opacity: 0,
      transition: {
        height: { duration: 0.2, ease: [0.4, 0, 0.2, 1] },
        opacity: { duration: 0.1, ease: 'easeIn' }
      }
    }
  }
}

// Collapsed-channel avatar stack: the avatars pop in one after another as the
// user rows fold away (and blink straight back out when they unfold). Children
// must carry `avatarStackItem` as their variants for the stagger to reach them.
export function avatarStack(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: 'hidden',
    animate: 'shown',
    exit: 'hidden',
    variants: {
      hidden: { opacity: 0, transition: { duration: 0.1, ease: 'easeIn' } },
      shown: {
        opacity: 1,
        transition: { duration: 0.12, delayChildren: 0.05, staggerChildren: 0.04 }
      }
    }
  }
}

// Per-avatar half of `avatarStack` — pass as `variants` on each stacked avatar.
export const avatarStackItem = {
  hidden: { opacity: 0, scale: 0.5, x: -6 },
  shown: { opacity: 1, scale: 1, x: 0, transition: spring }
}

// New chat message: slide up a few pixels and fade.
export function messageSlide(enabled) {
  if (!enabled) return { initial: false }
  return {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0, transition: { type: 'spring', stiffness: 480, damping: 40 } }
  }
}
