import { useState } from 'react'
import { authFetch } from '../lib/auth'
import { apiBase, throwIfError } from '../lib/serverConfig'
import './AccountSettings.css'

// Mirrors the server's MIN_PASSWORD_LEN, like the Add server form.
const MIN_PASSWORD_LEN = 8

// Settings → Account, shown while connected. Changes this account's password on the connected
// server, which signs out the account's other devices. `onChangePassword(newPassword)` runs after
// the server accepts it, so the saved login can be updated.
function AccountSettings({ username, onChangePassword }) {
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    if (saving) return
    if (!current || !next) {
      setError('Enter your current password and a new one.')
      return
    }
    if (next.length < MIN_PASSWORD_LEN) {
      setError(`The new password must be at least ${MIN_PASSWORD_LEN} characters.`)
      return
    }
    if (next !== confirm) {
      setError('The new passwords do not match.')
      return
    }
    setError(null)
    setSaving(true)
    try {
      const res = await authFetch(`${apiBase()}/auth/password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next })
      })
      await throwIfError(res)
      setCurrent('')
      setNext('')
      setConfirm('')
      onChangePassword?.(next)
    } catch (err) {
      setError(
        err.code === 'invalid_password' ? 'Your current password is incorrect.' : err.message
      )
    } finally {
      setSaving(false)
    }
  }

  const field = (id, label, value, setValue, autoComplete) => (
    <div className="settings-section">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        className="account-settings-input"
        type="password"
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => setValue(e.target.value)}
      />
    </div>
  )

  return (
    <div className="settings-panel-card">
      <div className="settings-panel-header">
        <div>
          <h2>Account</h2>
          <p>
            Signed in as <strong>{username}</strong>. Changing your password signs out your other
            devices.
          </p>
        </div>
      </div>
      <form className="settings-panel-group" onSubmit={submit}>
        {field(
          'account-current-password',
          'Current Password',
          current,
          setCurrent,
          'current-password'
        )}
        {field('account-new-password', 'New Password', next, setNext, 'new-password')}
        {field(
          'account-confirm-password',
          'Confirm New Password',
          confirm,
          setConfirm,
          'new-password'
        )}
        {error && <p className="account-settings-error">{error}</p>}
        <div className="settings-status-actions">
          <button type="submit" className="settings-apply-btn" disabled={saving}>
            {saving ? 'Changing…' : 'Change Password'}
          </button>
        </div>
      </form>
    </div>
  )
}

export default AccountSettings
