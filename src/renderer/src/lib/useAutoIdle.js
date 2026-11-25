import { useCallback, useEffect, useRef, useState } from 'react'
import { useSettings } from '../context/SettingsContext'
import { createAutoIdleController, IDLE_POLL_INTERVAL_MS, idleSecondsWithVoice } from './autoIdle'

// `speaking`: we are talking unmuted in voice right now. It resets the idle
// clock like input does, so someone mid-conversation never drifts to Away.
export function useAutoIdle({ scope, connected, status, send, speaking = false }) {
  const { autoIdleSettings } = useSettings()
  const [controller] = useState(createAutoIdleController)
  // Read by the poll, so speech flips don't restart the polling effect.
  const speakingRef = useRef(speaking)
  const lastSpokeAtRef = useRef(null)

  // Keep ownership through a transient reconnect, but never across logouts,
  // account changes or server switches.
  useEffect(() => {
    controller.reset()
    lastSpokeAtRef.current = null
  }, [controller, scope])

  // Stamp the end of each burst of speech; while speaking the poll uses now.
  useEffect(() => {
    speakingRef.current = speaking
    if (!speaking) return
    lastSpokeAtRef.current = Date.now()
    return () => {
      lastSpokeAtRef.current = Date.now()
    }
  }, [speaking])

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    if (!connected || !ipc) return
    let cancelled = false
    let reading = false
    const poll = async () => {
      if (reading) return
      reading = true
      try {
        const systemIdle = autoIdleSettings.enabled ? await ipc.invoke('get-system-idle-time') : 0
        if (!cancelled) {
          const idleSeconds = idleSecondsWithVoice(systemIdle, {
            speaking: speakingRef.current,
            lastSpokeAt: lastSpokeAtRef.current,
            now: Date.now()
          })
          controller.tick({ status, idleSeconds, settings: autoIdleSettings, send })
        }
      } catch {
        // An unavailable system reading must not manufacture inactivity.
        // The next poll retries without repeatedly interrupting the user.
      } finally {
        reading = false
      }
    }
    // Main windows disable backgroundThrottling, so this also runs minimized.
    // Poll immediately when settings or presence change, including on reconnect.
    poll()
    const timer = setInterval(poll, IDLE_POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [controller, scope, connected, status, autoIdleSettings, send])

  return useCallback(() => controller.manualStatusSelected(), [controller])
}
