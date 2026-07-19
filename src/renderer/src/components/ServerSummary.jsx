import { useState, useEffect } from 'react'
import { IconServer } from '@tabler/icons-react'
import './ClientSummary.css'
import { apiBase } from '../lib/serverConfig'
import { authFetch } from '../lib/auth'

// Seconds → "2d 3h 14m" (drops leading zero units; always shows at least minutes).
function formatUptime(seconds) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d) parts.push(`${d}d`)
  if (h) parts.push(`${h}h`)
  parts.push(`${m}m`)
  return parts.join(' ')
}

// Server details shown in the main area when "View server summary" is picked from
// the server menu. Fetches GET /server once on open. Reuses ClientSummary.css so it
// matches the channel/client summary cards.
function ServerSummary() {
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    authFetch(`${apiBase()}/server`)
      .then((res) => {
        if (!res.ok) throw new Error(`Server responded ${res.status}`)
        return res.json()
      })
      .then((data) => alive && setInfo(data))
      .catch((err) => alive && setError(err.message))
    return () => {
      alive = false
    }
  }, [])

  return (
    <div className="client-summary">
      <div className="client-summary-card">
        <span className="client-summary-avatar">
          <IconServer size={28} stroke={2} />
        </span>
        <span className="client-summary-name">{info?.name ?? 'Server'}</span>
      </div>

      {error ? (
        <section className="client-summary-section">
          <p className="client-summary-placeholder">Could not load server info: {error}</p>
        </section>
      ) : (
        <>
          <section className="client-summary-section">
            <h3 className="client-summary-heading">Version</h3>
            <p className="client-summary-value">{info?.version ?? '…'}</p>
          </section>
          <section className="client-summary-section">
            <h3 className="client-summary-heading">Uptime</h3>
            <p className="client-summary-value">
              {info ? formatUptime(info.uptime) : '…'}
            </p>
          </section>
        </>
      )}
    </div>
  )
}

export default ServerSummary
