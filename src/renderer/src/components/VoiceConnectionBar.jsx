import { useEffect, useState, useSyncExternalStore } from 'react'
import { IconChartLine, IconLockFilled, IconShieldExclamation } from '@tabler/icons-react'
import { startVoiceConnectionStats } from '../lib/soup'
import { e2eeListeners, getE2eeStatus, subscribeE2ee } from '../lib/e2ee'
import { voiceConnectionQuality } from '../lib/streamStats'
import PylonSignalIcon from './PylonSignalIcon'

const POLL_MS = 2000

// Lit arc pairs on the pylon for each quality bucket.
const QUALITY_LEVEL = {
  good: 3,
  fair: 2,
  poor: 1,
  unknown: 3
}

const QUALITY_LABEL = {
  good: 'Good',
  fair: 'Fair',
  poor: 'Poor',
  unknown: 'Measuring'
}

const pct = (fraction) => (fraction == null ? '—' : `${(fraction * 100).toFixed(1)}%`)

// Voice connection strip at the top of the control dock, shown while we're in a
// voice channel. Polls transport-level stats (RTT + audio loss) on its own
// light timer for the signal bars and ping readout; the full per-stream graphs
// live in the Connection Info panel this strip toggles.
export default function VoiceConnectionBar({
  channelName,
  clients,
  selfId,
  mediaState,
  connectionInfoOpen,
  onToggleConnectionInfo
}) {
  const [sample, setSample] = useState(null)

  useEffect(() => startVoiceConnectionStats(setSample, POLL_MS), [])

  // The call code itself lives in Connection Info, but a failed key exchange or
  // an unrecognised listener must stay visible without opening it.
  const e2ee = useSyncExternalStore(subscribeE2ee, getE2eeStatus)
  const unknownListeners = e2eeListeners(e2ee, clients, selfId).unknown.length
  const e2eeWarning =
    e2ee.status === 'failed'
      ? 'Encryption failed'
      : unknownListeners > 0
        ? `${unknownListeners} unknown listener${unknownListeners > 1 ? 's' : ''} can decrypt this call`
        : null

  const reconnecting = mediaState === 'reconnecting'
  const failed = mediaState === 'failed'
  // Stale numbers from before a drop would read as a healthy link.
  const live = reconnecting || failed ? null : sample
  const loss = Math.max(live?.inboundLoss ?? 0, live?.outboundLoss ?? 0)
  const quality = voiceConnectionQuality({ rttMs: live?.rttMs, lossFraction: loss })

  let tone = quality
  let label = 'Voice Connected'
  let level = QUALITY_LEVEL[quality]
  if (reconnecting) {
    tone = 'fair'
    label = 'Reconnecting…'
    level = 0
  } else if (failed) {
    tone = 'poor'
    label = 'Voice Failed'
    level = 0
  }

  // Keyed and holding a call code: media on this call is end-to-end encrypted.
  // Hidden while voice is down, since there's no call to vouch for.
  const encrypted = !reconnecting && !failed && e2ee.status !== 'failed' && e2ee.callCode != null

  const ping = live?.rttMs != null ? `${Math.round(live.rttMs)} ms` : null
  const details = live
    ? [
        `Connection: ${QUALITY_LABEL[quality]}`,
        `Ping: ${ping ?? '—'}`,
        `Packet loss: ${pct(live.inboundLoss)} in / ${pct(live.outboundLoss)} out`,
        ...(encrypted ? [`End-to-end encrypted · call code ${e2ee.callCode}`] : [])
      ].join('\n')
    : label

  return (
    <div className={`voice-connection-bar tone-${tone}`}>
      <button
        type="button"
        className="voice-connection-status"
        title={details}
        onClick={onToggleConnectionInfo}
      >
        <span className="voice-connection-icon">
          <PylonSignalIcon level={level} />
          {encrypted && (
            <IconLockFilled
              className={`voice-connection-lock${e2eeWarning ? ' warning' : ''}`}
              size={10}
            />
          )}
        </span>
        <span className="voice-connection-text">
          <span className="voice-connection-label">{label}</span>
          <span className="voice-connection-channel">
            {encrypted && <span className="voice-connection-encrypted">Encrypted · </span>}
            {channelName}
          </span>
        </span>
        {ping && <span className="voice-connection-ping">{ping}</span>}
      </button>
      {e2eeWarning && (
        <button
          type="button"
          className="voice-connection-info-btn warning"
          title={`${e2eeWarning} — open Connection Info`}
          onClick={connectionInfoOpen ? undefined : onToggleConnectionInfo}
        >
          <IconShieldExclamation size={16} />
        </button>
      )}
      <button
        type="button"
        className={`voice-connection-info-btn${connectionInfoOpen ? ' active' : ''}`}
        title={connectionInfoOpen ? 'Hide Connection Info' : 'Connection Info'}
        aria-pressed={!!connectionInfoOpen}
        onClick={onToggleConnectionInfo}
      >
        <IconChartLine size={16} />
      </button>
    </div>
  )
}
