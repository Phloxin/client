import { useId } from 'react'
import { motion } from 'motion/react'
import { useSettings } from '../context/SettingsContext'
import { prefersReducedMotion } from '../lib/animation'
import { spring } from '../lib/motionPresets'

// Segmented control with a spring-animated active pill (Motion layoutId, so the
// pill glides between tabs and is fully interruptible). With animations off or
// reduced motion, the pill just jumps — selection itself is never delayed.
// tabs: [{ id, label, icon?, disabled?, title? }]
function SegmentedTabs({ tabs, active, onChange, ariaLabel, className = '' }) {
  const groupId = useId()
  const { animationSettings } = useSettings()
  const animate = animationSettings.enabled && !prefersReducedMotion()

  return (
    <div className={`seg-tabs ${className}`.trim()} role="tablist" aria-label={ariaLabel}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={active === tab.id}
          className={`seg-tab${active === tab.id ? ' active' : ''}`}
          disabled={tab.disabled}
          title={tab.title}
          onClick={() => onChange(tab.id)}
        >
          {active === tab.id && (
            <motion.span
              layoutId={`${groupId}-pill`}
              className="seg-pill"
              transition={animate ? spring : { duration: 0 }}
              aria-hidden="true"
            />
          )}
          <span className="seg-tab-label">
            {tab.icon}
            {tab.label}
          </span>
        </button>
      ))}
    </div>
  )
}

export default SegmentedTabs
