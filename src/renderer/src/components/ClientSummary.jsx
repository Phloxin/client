import './ClientSummary.css'

// Profile/summary shown in the main area when a client is single-clicked. The
// name lives in the page header; this is the body. For now it's a scaffold —
// the server groups and activity stats (e.g. last online) get filled in once
// the server exposes them.
function ClientSummary({ client }) {
  const initial = client?.name?.charAt(0).toUpperCase() ?? '?'

  return (
    <div className="client-summary">
      <div className="client-summary-card">
        <span className="client-summary-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="client-summary-name">{client?.name ?? 'Unknown user'}</span>
      </div>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Server Groups</h3>
        <p className="client-summary-placeholder">No groups to show yet.</p>
      </section>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Activity</h3>
        <p className="client-summary-placeholder">Last online and other stats will appear here.</p>
      </section>
    </div>
  )
}

export default ClientSummary
