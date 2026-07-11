import './ClientSummary.css'
import { IconUsersGroup } from '@tabler/icons-react'
import { RoleIcon } from '../lib/roleIcon'
import { useImageColors, bannerGradient } from '../lib/imageColors'

// Profile/summary shown in the main area when a client is single-clicked. The
// name lives in the page header; this is the body. Activity stats (e.g. last
// online) get filled in once the server exposes them.
function ClientSummary({ client, roles = [], vanity = [] }) {
  const initial = client?.name?.charAt(0).toUpperCase() ?? '?'
  // The roles this client has explicitly been granted (role_ids), resolved to
  // names. 'everyone' is implicit and not in role_ids, so it won't appear here.
  const assignedRoles = roles.filter((r) => (client?.role_ids || []).includes(r.id))
  // Vanity groups this client is in (vanity_ids), resolved the same way.
  const assignedGroups = vanity.filter((g) => (client?.vanity_ids || []).includes(g.id))

  // Banner gradient sampled from the avatar, same as ChannelSummary's icon
  // banner. Null (no avatar / unreadable image) renders the plain card.
  const bannerColors = useImageColors(client?.avatar)

  return (
    <div className="client-summary">
      <div
        className={`client-summary-card${bannerColors ? ' channel-summary-banner' : ''}`}
        style={bannerGradient(bannerColors)}
      >
        <span className="client-summary-avatar" aria-hidden="true">
          {client?.avatar ? (
            <img className="client-summary-avatar-img" src={client.avatar} alt="" />
          ) : (
            initial
          )}
        </span>
        <span className="client-summary-name">{client?.name ?? 'Unknown user'}</span>
      </div>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Server Roles</h3>
        {assignedRoles.length > 0 ? (
          <ul className="client-summary-roles">
            {assignedRoles.map((r) => (
              <li key={r.id} className="client-summary-role">
                <RoleIcon role={r} size={14} />
                {r.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="client-summary-placeholder">No roles to show yet.</p>
        )}
      </section>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Server Groups</h3>
        {assignedGroups.length > 0 ? (
          <ul className="client-summary-roles">
            {assignedGroups.map((g) => (
              <li key={g.id} className="client-summary-role">
                {g.avatar ? (
                  <img src={g.avatar} alt="" className="client-summary-group-icon" />
                ) : (
                  <IconUsersGroup size={14} />
                )}
                {g.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="client-summary-placeholder">No groups to show yet.</p>
        )}
      </section>

      <section className="client-summary-section">
        <h3 className="client-summary-heading">Activity</h3>
        <p className="client-summary-placeholder">Last online and other stats will appear here.</p>
      </section>
    </div>
  )
}

export default ClientSummary
