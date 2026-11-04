import { useCallback, useEffect, useState } from 'react'
import { useSettings } from '../context/SettingsContext'
import { createAutoIdleController, IDLE_POLL_INTERVAL_MS } from './autoIdle'

export function useAutoIdle({ scope, connected, status, send }) {
  const { autoIdleSettings } = useSettings()
  const [controller] = useState(createAutoIdleController)

  // Keep ownership through a transient reconnect, but never across logouts,
  // account changes or server switches.
  useEffect(() => controller.reset(), [controller, scope])

  useEffect(() => {
    const ipc = window.electron?.ipcRenderer
    if (!connected || !ipc) return
    let cancelled = false
    let reading = false
    const poll = async () => {
      if (reading) return
      reading = true
      try {
        const idleSeconds = autoIdleSettings.enabled ? await ipc.invoke('get-system-idle-time') : 0
        if (!cancelled) {
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
