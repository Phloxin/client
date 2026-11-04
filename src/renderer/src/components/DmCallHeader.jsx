import { useState } from 'react'
import { IconMicrophoneOff, IconHeadphonesOff, IconVideoFilled } from '@tabler/icons-react'
import './DmCallHeader.css'

// The strip of a DM call's participants, for the header of the call's chat.

function Avatar({ client, className }) {
  return (
    <span className={className}>
      {client.avatar ? (
        <img src={client.avatar} alt="" aria-hidden="true" />
      ) : (
        (client.name || '?').charAt(0).toUpperCase()
      )}
    </span>
  )
}

// One entry per participant: in the call (speaking ring, mute/deafen, stream),
// or dimmed with a Ring button, "Ringing…" or "Offline".
export function DmMemberStrip({ entries, onRing, onWatchStream }) {
  // Recipients with a ring request in flight, so the button can't double-fire.
  const [pending, setPending] = useState(() => new Set())

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

  return (
    <span className="dm-strip">
      {entries.map((e) => (
        <span
          key={e.id}
          className={`dm-strip-member${e.inCall ? '' : ' absent'}${e.speaking ? ' speaking' : ''}`}
          title={e.name}
        >
          <span className="dm-strip-avatar-wrap">
            <Avatar client={e} className="dm-strip-avatar" />
            {e.inCall && (e.deafened || e.muted) && (
              <span className="dm-strip-badge" aria-label={e.deafened ? 'Deafened' : 'Muted'}>
                {e.deafened ? <IconHeadphonesOff size={9} /> : <IconMicrophoneOff size={9} />}
              </span>
            )}
          </span>
          {e.inCall &&
            e.streaming &&
            (e.watchable ? (
              <button
                type="button"
                className="dm-strip-stream"
                title={`Watch ${e.name}'s stream`}
                onClick={() => onWatchStream(e.id)}
              >
                <IconVideoFilled size={13} aria-label="Streaming" />
              </button>
            ) : (
              <span className="dm-strip-stream" title={`${e.name} is streaming`}>
                <IconVideoFilled size={13} aria-label="Streaming" />
              </span>
            ))}
          {!e.inCall &&
            (e.status === 'ring' ? (
              <button
                type="button"
                className="dm-strip-ring"
                title={`Ring ${e.name}`}
                disabled={pending.has(e.id)}
                onClick={() => ring(e.id)}
              >
                Ring
              </button>
            ) : (
              <span className="dm-strip-status">
                {e.status === 'ringing' ? 'Ringing…' : 'Offline'}
              </span>
            ))}
        </span>
      ))}
    </span>
  )
}
