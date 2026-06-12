import { IconMicrophoneOff, IconHeadphonesOff } from '@tabler/icons-react'

function ClientIndicator({ client, speaking, micMuted, deafened }) {
  const initial = client.name?.charAt(0).toUpperCase() ?? '?'

  let statusIcon
  if (deafened) {
    statusIcon = <IconHeadphonesOff size={14} className="mic-indicator deafened" aria-label="Deafened" />
  } else if (micMuted) {
    statusIcon = <IconMicrophoneOff size={14} className="mic-indicator muted" aria-label="Muted" />
  } else {
    statusIcon = <span className={`mic-indicator${speaking ? ' speaking' : ''}`} aria-hidden="true" />
  }

  return (
    <div className="client-indicator">
      {statusIcon}
      <span className="client-avatar" aria-hidden="true">{initial}</span>
      {client.name}
      <span className="client-status" title="Online" />
    </div>
  )
}

export default ClientIndicator