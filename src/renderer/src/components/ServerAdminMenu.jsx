import { useCallback, useEffect, useState } from 'react'
import { IconCopy, IconLink, IconPlus, IconTicket, IconTrash } from '@tabler/icons-react'
import { authFetch } from '../lib/auth'
import { apiBase, throwIfError } from '../lib/serverConfig'
import { inviteLink } from '../lib/invite'
import './ServerAdminMenu.css'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const PRESETS = [
  { id: 'link', label: 'Link (7 days, unlimited)', request: { expires_in_ms: 7 * DAY } },
  {
    id: 'once',
    label: 'One-time code (10 min, 1 use)',
    request: { expires_in_ms: 10 * MINUTE, max_uses: 1 }
  }
]

// Expiry choices for a custom invite, inside the server's 1 minute to 30 days.
const EXPIRY_OPTIONS = [
  [10 * MINUTE, '10 minutes'],
  [HOUR, '1 hour'],
  [DAY, '1 day'],
  [7 * DAY, '7 days'],
  [30 * DAY, '30 days']
]

const formatTime = (ms) =>
  new Date(ms).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

function inviteStatus(invite, now) {
  if (invite.revoked_at != null) return 'Revoked'
  if (invite.expires_at <= now) return 'Expired'
  if (invite.max_uses != null && invite.uses >= invite.max_uses) return 'Used up'
  return 'Active'
}

// 'Server Settings' tab body, opened from the server header's right-click menu (Main renders its
// title in the tab's header). Registration, for ADMINISTRATOR only, switches between open sign-up
// and invite only. Invites, for CREATE_INVITES, lists every invite and creates, copies and revokes
// them. Links are built from `host`, the address as typed in the Add server dialog. The server
// stays authoritative on all of it.
function ServerAdminMenu({ isAdmin, canCreateInvites, host, clients = [], onError, onSuccess }) {
  const [registration, setRegistration] = useState(null)
  const [invites, setInvites] = useState([])
  // When the list was fetched, for its Expired status.
  const [listedAt, setListedAt] = useState(() => Date.now())
  const [busy, setBusy] = useState(false)
  const [custom, setCustom] = useState({ label: '', expiresInMs: 7 * DAY, maxUses: '' })

  const request = useCallback(async (path, options) => {
    const res = await throwIfError(await authFetch(`${apiBase()}${path}`, options))
    return res.status === 204 ? null : res.json()
  }, [])

  const loadInvites = useCallback(() => {
    request('/invites')
      .then((list) => {
        setInvites(Array.isArray(list) ? list : [])
        setListedAt(Date.now())
      })
      .catch((err) => onError?.(`Failed to load invites: ${err.message}`, err))
  }, [request, onError])

  useEffect(() => {
    if (!isAdmin) return
    request('/server/settings')
      .then((settings) => setRegistration(settings?.registration ?? null))
      .catch((err) => onError?.(`Failed to load server settings: ${err.message}`, err))
  }, [isAdmin, request, onError])

  useEffect(() => {
    if (canCreateInvites) loadInvites()
  }, [canCreateInvites, loadInvites])

  const setMode = async (mode) => {
    if (mode === registration || busy) return
    setBusy(true)
    try {
      const settings = await request('/server/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ registration: mode })
      })
      setRegistration(settings?.registration ?? mode)
      onSuccess?.(mode === 'invite' ? 'Registration is now invite only' : 'Registration is open')
    } catch (err) {
      onError?.(`Failed to change registration: ${err.message}`, err)
    } finally {
      setBusy(false)
    }
  }

  const createInvite = async (body) => {
    if (busy) return
    setBusy(true)
    try {
      const invite = await request('/invites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
      setInvites((prev) => [invite, ...prev])
    } catch (err) {
      onError?.(`Failed to create invite: ${err.message}`, err)
    } finally {
      setBusy(false)
    }
  }

  const createCustom = () =>
    createInvite({
      label: custom.label.trim() || null,
      expires_in_ms: custom.expiresInMs,
      max_uses: custom.maxUses === '' ? null : Number(custom.maxUses)
    })

  const revoke = async (id) => {
    try {
      await request(`/invites/${id}`, { method: 'DELETE' })
      loadInvites()
    } catch (err) {
      onError?.(`Failed to revoke invite: ${err.message}`, err)
    }
  }

  const copy = (text, what) =>
    navigator.clipboard.writeText(text).then(
      () => onSuccess?.(`${what} copied`),
      (err) => console.error(`Copy ${what} failed:`, err)
    )

  const creatorName = (id) => clients.find((c) => c.id === id)?.name ?? 'Unknown'

  return (
    <div className="sa-pane">
      <div className="sa-body">
        {isAdmin && (
          <section className="sa-section">
            <h3 className="sa-heading">Registration</h3>
            <div className="sa-radio-group" role="radiogroup" aria-label="Registration">
              {[
                ['open', 'Open', 'Anyone who can reach the server can create an account.'],
                ['invite', 'Invite only', 'New accounts need an invite code or link.']
              ].map(([mode, label, desc]) => (
                <label key={mode} className="sa-radio">
                  <input
                    type="radio"
                    name="registration"
                    checked={registration === mode}
                    disabled={registration == null || busy}
                    onChange={() => setMode(mode)}
                  />
                  <span className="sa-radio-copy">
                    <span className="sa-radio-label">{label}</span>
                    <span className="sa-meta">{desc}</span>
                  </span>
                </label>
              ))}
            </div>
          </section>
        )}

        {canCreateInvites && (
          <section className="sa-section">
            <h3 className="sa-heading">Invites</h3>
            <div className="sa-create">
              {PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className="sa-btn"
                  disabled={busy}
                  onClick={() => createInvite(preset.request)}
                >
                  <IconPlus size={15} />
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="sa-custom">
              <input
                className="sa-input"
                value={custom.label}
                placeholder="Label (optional)"
                maxLength={64}
                onChange={(e) => setCustom((prev) => ({ ...prev, label: e.target.value }))}
              />
              <select
                value={custom.expiresInMs}
                onChange={(e) =>
                  setCustom((prev) => ({ ...prev, expiresInMs: Number(e.target.value) }))
                }
              >
                {EXPIRY_OPTIONS.map(([ms, label]) => (
                  <option key={ms} value={ms}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                className="sa-input sa-input-uses"
                type="number"
                min={1}
                max={1000}
                value={custom.maxUses}
                placeholder="Max uses"
                onChange={(e) => setCustom((prev) => ({ ...prev, maxUses: e.target.value }))}
              />
              <button type="button" className="sa-btn" disabled={busy} onClick={createCustom}>
                <IconPlus size={15} />
                Create
              </button>
            </div>

            {invites.length === 0 ? (
              <div className="sa-empty">
                <IconTicket size={22} />
                No invites yet
              </div>
            ) : (
              invites.map((invite) => {
                const status = inviteStatus(invite, listedAt)
                return (
                  <div key={invite.id} className="sa-row">
                    <div className="sa-info">
                      <span className="sa-code">
                        {invite.code}
                        {invite.label && <span className="sa-label"> · {invite.label}</span>}
                      </span>
                      <span className="sa-meta">
                        {status} · {invite.uses}/{invite.max_uses ?? '∞'} uses · expires{' '}
                        {formatTime(invite.expires_at)} · by {creatorName(invite.created_by)}
                      </span>
                    </div>
                    <button
                      type="button"
                      className="sa-icon-btn"
                      title="Copy code"
                      onClick={() => copy(invite.code, 'Invite code')}
                    >
                      <IconCopy size={15} />
                    </button>
                    <button
                      type="button"
                      className="sa-icon-btn"
                      title="Copy link"
                      disabled={!host}
                      onClick={() => copy(inviteLink(host, invite.code), 'Invite link')}
                    >
                      <IconLink size={15} />
                    </button>
                    <button
                      type="button"
                      className="sa-icon-btn danger"
                      title="Revoke"
                      disabled={invite.revoked_at != null}
                      onClick={() => revoke(invite.id)}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                )
              })
            )}
          </section>
        )}
      </div>
    </div>
  )
}

export default ServerAdminMenu
