// Level decisions for the local speaking detector and the voice gate, on the
// shared 0..100 speech-band scale (createSpeechLevelReader). No browser imports,
// so node:test can drive them.

// Opening level for the volume gate when nothing has set one.
export const DEFAULT_VOLUME_GATE_THRESHOLD = 15

// Active from the first level at or above `threshold`. Stays active while the
// level keeps reaching `threshold - hysteresis`, and for `holdMs` after the last
// time it did.
export function createLevelActivity({ holdMs, hysteresis = 0 }) {
  let active = false
  let lastAboveAt = 0
  return {
    update(level, threshold, now) {
      if (!active) {
        if (level >= threshold) {
          active = true
          lastAboveAt = now
        }
      } else if (level >= Math.max(0, threshold - hysteresis)) {
        lastAboveAt = now
      } else if (now - lastAboveAt >= holdMs) {
        active = false
      }
      return active
    },
    reset() {
      active = false
    },
    isActive: () => active
  }
}

// The lowest raw level of the last one to two buckets. Speech dips to the room's
// floor between syllables, so the minimum follows the noise and not the voice.
export function createNoiseFloorTracker({ bucketMs = 1500 } = {}) {
  let current = Infinity
  let previous = Infinity
  let bucketStartedAt = null
  return {
    update(rawLevel, now) {
      if (bucketStartedAt == null) {
        bucketStartedAt = now
      } else if (now - bucketStartedAt >= bucketMs) {
        previous = current
        current = Infinity
        bucketStartedAt = now
      }
      if (rawLevel < current) current = rawLevel
      return Math.min(current, previous)
    }
  }
}

// Speaking means standing clear of the noise floor, not clearing a fixed level:
// a fixed level latches on any mic whose noise rests near it.
export function createSpeakingActivity({
  threshold = 12,
  hysteresis = 3,
  holdMs = 250,
  floorMargin = 10,
  floorCap = 30,
  floorBucketMs = 1500
} = {}) {
  const activity = createLevelActivity({ holdMs, hysteresis })
  const floor = createNoiseFloorTracker({ bucketMs: floorBucketMs })
  return {
    // `level` is the smoothed reading, `rawLevel` the unsmoothed one.
    update(level, rawLevel, now) {
      const noiseFloor = Math.min(floor.update(rawLevel, now), floorCap)
      return activity.update(level, Math.max(threshold, noiseFloor + floorMargin), now)
    },
    isSpeaking: activity.isActive
  }
}

// Gate state shared by the live mic path and the settings test. The gate closes
// at the same level it opens at, so audio under the marker never holds it; the
// hold bridges syllable gaps and the gain ramps avoid clicks.
export function createLevelGateController(
  audioContext,
  gate,
  read,
  {
    threshold = DEFAULT_VOLUME_GATE_THRESHOLD,
    holdMs = 200,
    rampSeconds = 0.03,
    onOpenChange = () => {}
  } = {}
) {
  const activity = createLevelActivity({ holdMs })
  let open = false
  gate.gain.setValueAtTime(0, audioContext.currentTime)

  const setOpen = (next) => {
    if (next === open) return
    open = next
    const now = audioContext.currentTime
    const current = gate.gain.value
    gate.gain.cancelScheduledValues(now)
    gate.gain.setValueAtTime(current, now)
    gate.gain.linearRampToValueAtTime(next ? 1 : 0, now + rampSeconds)
    onOpenChange(next)
  }

  const update = (nextThreshold = threshold) => {
    const level = read()
    setOpen(activity.update(level, nextThreshold, performance.now()))
    return { level, open }
  }

  // For a chain being torn down: nothing ticks it again, so it has to say it
  // closed. The gain is left alone, its nodes are about to be disconnected.
  const release = () => {
    activity.reset()
    if (!open) return
    open = false
    onOpenChange(false)
  }

  return { update, isOpen: () => open, release }
}
