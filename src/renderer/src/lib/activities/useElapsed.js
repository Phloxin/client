import { useEffect, useState } from 'react'

import { formatCallDuration } from '../callMessages.js'

// The start comes from the server's clock, so a start a little ahead of ours reads as 0:00.
export const elapsedText = (startedAt, now) => formatCallDuration(Math.max(0, now - startedAt))

// Time since `startedAt`, ticking once a second while `running`. Read fresh from the clock on
// every tick, so a throttled or hidden window catches up on its next tick.
export function useElapsed(startedAt, running) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!running) return undefined
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [running])
  return elapsedText(startedAt, now)
}
