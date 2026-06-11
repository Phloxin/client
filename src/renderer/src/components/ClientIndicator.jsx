function ClientIndicator({ client }) {
  const initial = client.name?.charAt(0).toUpperCase() ?? '?'

  return (
    <div className="client-indicator">
      <span className="client-avatar" aria-hidden="true">{initial}</span>
      {client.name}
      <span className="client-status" title="Online" />
    </div>
  )
}

export default ClientIndicator