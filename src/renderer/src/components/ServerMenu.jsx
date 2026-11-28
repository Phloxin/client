import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop, scrimFade } from '../lib/motionPresets'
import SegmentedTabs from './SegmentedTabs'
import './ServerMenu.css'
import { httpFetch } from '../lib/http'
import { apiBaseForHost } from '../lib/serverConfig'
import { parseInviteInput } from '../lib/invite'
import { useMenuPosition } from '../lib/menuPosition'
import {
  IconPlus,
  IconCheck,
  IconX,
  IconPlugConnectedX,
  IconTrash,
  IconPencil,
  IconEye,
  IconEyeOff,
  IconActivity,
  IconInfoCircle,
  IconServer,
  IconBan,
  IconSettings
} from '@tabler/icons-react'

// Initial state for the add-server form
const EMPTY_FORM = {
  nickname: '',
  host: '',
  username: '',
  password: '',
  confirmPassword: '',
  invite: '',
  code: ''
}

// Register errors with a specific code, worded for this form.
const INVITE_REQUIRED_MESSAGE = 'This server is invite-only. Enter an invite code or link.'
const INVITE_INVALID_MESSAGE = 'That invite is not valid or has expired.'

// Mirrors the server's auth limits (MIN_PASSWORD_LEN / MAX_USERNAME_LEN in the
// backend) so Register can reject bad input before hitting the network. Kept in
// sync by hand — there's no shared source between the Rust server and this UI.
const MIN_PASSWORD_LEN = 8
const MAX_USERNAME_LEN = 64

// Sent as the LoginRequest.device_name on register, matching the connect path.
const DEVICE_NAME = 'Pylon Desktop'

// Sidebar server control. Connected: an identity row with a disconnect button.
// Disconnected: the same row plus the saved-server list rendered inline, filling
// the rail so you can add / connect / edit / remove without a dropdown.
function ServerMenu({
  servers,
  connectedServer,
  serverName,
  onConnect,
  onRecovered,
  onDisconnect,
  onAddServer,
  onEditServer,
  onRemoveServer,
  onNotify,
  onViewServerTraffic,
  onViewServerSummary,
  canBanMembers,
  onOpenBanList,
  canManageServer,
  onOpenServerAdmin,
  joinRequest,
  onJoinConsumed
}) {
  // Right-click context menu on the trigger (connected only): { x, y } or null.
  const [ctxPos, setCtxPos] = useState(null)
  const ctxRef = useRef(null)
  const ctxStyle = useMenuPosition(ctxRef, ctxPos)
  const [showAddModal, setShowAddModal] = useState(false)
  // Holds the id of the server being edited, or null when adding a new one
  const [editingId, setEditingId] = useState(null)
  // Add mode: 'register' creates a new account on the server; 'login' just saves
  // an existing account. Ignored while editing (that's always a plain save).
  const [mode, setMode] = useState('register')
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(null)
  // True while the register request is in flight (disables the button).
  const [registering, setRegistering] = useState(false)
  // Reveal the password field (eye toggle). Reset whenever the modal closes so a
  // reopened form never starts with the password already visible.
  const [showPassword, setShowPassword] = useState(false)
  useEffect(() => {
    if (!showAddModal) setShowPassword(false)
  }, [showAddModal])
  const overlayAnim = useAnimationCategory('overlays')
  // What GET /server said about the address in the form:
  //   { host, status: 'checking' | 'ok' | 'down', name, mode }
  // name and mode (registration, 'open' or 'invite') are null unless status is 'ok'. Fetched on
  // address blur, on a tab change, when Edit opens, and when a join link fills the address.
  const [probe, setProbe] = useState(null)
  const probeRef = useRef(null)
  const pendingProbe = (host) => ({ host, status: 'checking', name: null, mode: null })
  // Asks GET /server for a host already marked pending in probeRef. State only changes once the
  // request settles, so an effect may call it.
  const askServer = useCallback(async (host) => {
    let next = { host, status: 'down', name: null, mode: null }
    try {
      // No answer in 4s reads as down: a wrong LAN address can hang until the OS gives up.
      const res = await httpFetch(`${apiBaseForHost(host)}/server`, {
        signal: AbortSignal.timeout(4000)
      })
      if (res.ok) {
        const info = await res.json()
        next = { host, status: 'ok', name: info?.name || null, mode: info?.registration ?? null }
      }
    } catch {
      // Unreachable, timed out, or not a Pylon server. Register reports it if it stays that way.
    }
    // A later host replaced this one while the request was in flight.
    if (probeRef.current?.host !== host) return
    probeRef.current = next
    setProbe(next)
  }, [])
  // Marks the address pending and asks. force asks again even when this host was already
  // answered, for a freshly opened form. Event handlers only: it sets state right away.
  const checkServer = (rawHost, { force = false } = {}) => {
    const host = rawHost.trim()
    const current = probeRef.current
    // Already answered or still asking for this host. A 'down' host is asked again, it may be up now.
    if (!force && host && current?.host === host && current.status !== 'down') return
    const pending = host ? pendingProbe(host) : null
    probeRef.current = pending
    setProbe(pending)
    if (host) askServer(host)
  }
  // Forget the last answer, so a reopened form never shows one for an address it hasn't asked.
  const resetProbe = () => {
    probeRef.current = null
    setProbe(null)
  }

  const connected = !!connectedServer

  // Close the context menu on an outside click.
  useEffect(() => {
    if (!ctxPos) return
    const onClick = (e) => {
      if (ctxRef.current && !ctxRef.current.contains(e.target)) setCtxPos(null)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [ctxPos])

  const handleConnect = (server) => {
    onConnect(server)
  }

  const handleDisconnect = () => {
    onDisconnect()
  }

  // New server defaults to Register (the flow for a brand-new account).
  const openAddModal = () => {
    setEditingId(null)
    setMode('register')
    setForm(EMPTY_FORM)
    setFormError(null)
    setRegistering(false)
    resetProbe()
    setShowAddModal(true)
  }

  const openEditModal = (server) => {
    setEditingId(server.id)
    setMode('login')
    setForm({
      nickname: server.nickname,
      host: server.host,
      username: server.username,
      password: server.password ?? '',
      confirmPassword: ''
    })
    setFormError(null)
    checkServer(server.host, { force: true })
    setShowAddModal(true)
  }

  const updateForm = (changes) => setForm((prev) => ({ ...prev, ...changes }))

  // Register mode shows the confirm-password and invite fields and the "Register" action.
  const isRegister = !editingId && mode === 'register'
  // The probe answer for the address as it reads now, null while it's empty or unasked.
  const hostProbe = probe && probe.host === form.host.trim() ? probe : null
  const inviteRequired = isRegister && hostProbe?.mode === 'invite'
  // Name an unnamed bookmark after the server, once per answer, so clearing the nickname sticks.
  const [namedFrom, setNamedFrom] = useState(null)
  if (hostProbe?.name && hostProbe !== namedFrom) {
    setNamedFrom(hostProbe)
    if (!form.nickname.trim()) setForm({ ...form, nickname: hostProbe.name })
  }
  // Forgot password, reached from the Login tab: no nickname, a reset code and a new password.
  const isRecover = !editingId && mode === 'recover'

  // A pylon://join link opened the app: start registering on its host with its code. The form
  // opens during render, on the new request, and the effect then hands the request back.
  const [joinShown, setJoinShown] = useState(null)
  if (joinRequest && joinRequest !== joinShown) {
    setJoinShown(joinRequest)
    setEditingId(null)
    setMode('register')
    setForm({ ...EMPTY_FORM, host: joinRequest.host ?? '', invite: joinRequest.code })
    setFormError(null)
    setRegistering(false)
    // The effect below asks. A link without a host leaves the address empty, showing no answer.
    setProbe(joinRequest.host ? pendingProbe(joinRequest.host.trim()) : null)
    setShowAddModal(true)
  }
  useEffect(() => {
    if (!joinRequest) return
    const host = joinRequest.host?.trim()
    probeRef.current = host ? pendingProbe(host) : null
    if (host) askServer(host)
    onJoinConsumed?.()
  }, [joinRequest, onJoinConsumed, askServer])

  // A pasted pylon://join link fills the host too. Anything else is kept as typed.
  const handleInviteChange = (value) => {
    const link = /^\s*pylon:/i.test(value) ? parseInviteInput(value) : null
    if (!link) {
      updateForm({ invite: value })
      return
    }
    updateForm(link.host ? { invite: link.code, host: link.host } : { invite: link.code })
    if (link.host) checkServer(link.host)
  }

  // Editing only persists the change. Adding an existing login also starts the
  // connection immediately; otherwise the Login tab deceptively only saves the
  // server and no /auth/login request is made until the user clicks it again.
  const handleSave = () => {
    const nickname = form.nickname.trim()
    const host = form.host.trim()
    const username = form.username.trim()
    if (!nickname || !host || !username) {
      setFormError('Server nickname, address, and username are required.')
      return
    }
    const server = {
      id: editingId || crypto.randomUUID(),
      nickname,
      host,
      username,
      password: form.password
    }
    if (editingId) onEditServer(server)
    else onAddServer(server)
    setShowAddModal(false)
    // Adding via the Login tab also connects immediately; Register-tab saves and
    // edits just update the inline list.
    if (!editingId && mode === 'login') onConnect(server)
  }

  // Register: validate locally (passwords match + length limits), then POST to
  // the server's /auth/register. Each failure point sets a specific inline error:
  //   • unreachable host            → the fetch throws
  //   • username already registered → the server rejects the POST
  //   • passwords mismatch          → caught locally before any request
  const handleRegister = async () => {
    if (registering) return
    const nickname = form.nickname.trim()
    const host = form.host.trim()
    const username = form.username.trim()
    const { password, confirmPassword } = form

    if (!nickname || !host || !username || !password) {
      setFormError('All fields are required.')
      return
    }
    if (username.length > MAX_USERNAME_LEN) {
      setFormError(`Username must be ${MAX_USERNAME_LEN} characters or fewer.`)
      return
    }
    if (password.length < MIN_PASSWORD_LEN) {
      setFormError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`)
      return
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.')
      return
    }
    const inviteText = form.invite.trim()
    if (inviteRequired && !inviteText) {
      setFormError(INVITE_REQUIRED_MESSAGE)
      return
    }
    // The server normalizes too. A code that does not parse is sent as typed for it to reject.
    const invite = inviteText ? (parseInviteInput(inviteText)?.code ?? inviteText) : null

    setFormError(null)
    setRegistering(true)
    let res
    try {
      res = await httpFetch(`${apiBaseForHost(host)}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          password,
          device_name: DEVICE_NAME,
          ...(invite ? { invite } : {})
        })
      })
    } catch {
      setRegistering(false)
      setFormError(`Could not reach a server at ${host}.`)
      return
    }
    setRegistering(false)

    if (!res.ok) {
      const body = await res.json().catch(() => null)
      if (body?.code === 'invite_required') {
        // The server answered, so it is up and invite-only whatever the probe said before.
        const known = probeRef.current?.host === host ? probeRef.current : null
        const next = { host, status: 'ok', name: known?.name ?? null, mode: 'invite' }
        probeRef.current = next
        setProbe(next)
        setFormError(INVITE_REQUIRED_MESSAGE)
      } else if (body?.code === 'invite_invalid') {
        setFormError(INVITE_INVALID_MESSAGE)
      } else if (body?.code === 'username_taken') {
        setFormError(`Username "${username}" is already taken on this server.`)
      } else {
        setFormError(body?.message || `Registration failed (${res.status}).`)
      }
      return
    }

    const server = { id: crypto.randomUUID(), nickname, host, username, password }
    onAddServer(server)
    onNotify?.(`Registered "${username}" on ${nickname}`)
    setShowAddModal(false)
    // Continue with the server we just registered against, rather than leaving
    // the user to pick from the list (where the first entry may be a different
    // host than the one just registered on).
    onConnect(server)
  }

  // An admin's reset code sets a new password and logs in. The saved login for this host and
  // username gets the new password, or one is saved with the host as its nickname.
  const handleRecover = async () => {
    if (registering) return
    const host = form.host.trim()
    const username = form.username.trim()
    const code = form.code.trim()
    const { password, confirmPassword } = form

    if (!host || !username || !code || !password) {
      setFormError('All fields are required.')
      return
    }
    if (password.length < MIN_PASSWORD_LEN) {
      setFormError(`Password must be at least ${MIN_PASSWORD_LEN} characters.`)
      return
    }
    if (password !== confirmPassword) {
      setFormError('Passwords do not match.')
      return
    }

    setFormError(null)
    setRegistering(true)
    let res
    try {
      res = await httpFetch(`${apiBaseForHost(host)}/auth/recovery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username,
          code,
          new_password: password,
          device_name: DEVICE_NAME
        })
      })
    } catch {
      setRegistering(false)
      setFormError(`Could not reach a server at ${host}.`)
      return
    }
    setRegistering(false)

    const body = await res.json().catch(() => null)
    if (!res.ok) {
      if (body?.code === 'invalid_reset_code') {
        setFormError('That reset code is not valid or has expired.')
      } else if (body?.code === 'user_banned') {
        setFormError('This account is banned on that server.')
      } else {
        setFormError(body?.message || `Password reset failed (${res.status}).`)
      }
      return
    }

    const saved = servers.find((s) => s.host === host && s.username === username)
    const server = saved
      ? { ...saved, password }
      : { id: crypto.randomUUID(), nickname: host, host, username, password }
    if (saved) onEditServer(server)
    else onAddServer(server)
    setShowAddModal(false)
    onRecovered?.(server, body)
  }

  const submit = () => (isRegister ? handleRegister() : isRecover ? handleRecover() : handleSave())

  return (
    <div className={`server-menu${connected ? '' : ' disconnected'}`}>
      {/* Identity row. Left-click (connected) opens the server logs; right-click
          opens the logs/summary menu. */}
      <div
        className="server-menu-trigger"
        onClick={() => connected && onViewServerTraffic?.()}
        onContextMenu={(e) => {
          // Right-click actions only apply to the connected server.
          if (!connected) return
          e.preventDefault()
          setCtxPos({ x: e.clientX, y: e.clientY })
        }}
        title={
          connected ? `Connected to ${serverName || connectedServer.nickname}` : 'Not connected'
        }
      >
        <span className={`server-status-dot${connected ? ' connected' : ''}`} />
        <span className="server-menu-label">
          {connected ? serverName || connectedServer.nickname : 'Not connected'}
        </span>
        {connected && (
          <button
            className="server-menu-disconnect"
            title="Disconnect from server"
            aria-label="Disconnect from server"
            onClick={(e) => {
              // Don't also trip the row's open-logs click.
              e.stopPropagation()
              handleDisconnect()
            }}
          >
            <IconPlugConnectedX size={16} />
          </button>
        )}
      </div>

      {/* Saved-server list — inline, fills the rail while disconnected. */}
      {!connected && (
        <div className="server-menu-list">
          <div className="server-menu-section-label">
            <span>Server Bookmarks</span>
            <span className="server-menu-section-divider" aria-hidden="true" />
            <button className="server-menu-add-btn" title="Add server" onClick={openAddModal}>
              <IconPlus size={15} />
            </button>
          </div>

          {servers.length === 0 ? (
            <div className="server-menu-empty">No saved servers yet</div>
          ) : (
            <div className="server-menu-list-scroll">
              {servers.map((server) => (
                <div
                  key={server.id}
                  className="server-menu-item"
                  onClick={() => handleConnect(server)}
                >
                  {/* Placeholder until the server sends its own icon on connect,
                      at which point server.icon carries the image URL. */}
                  <span className="server-menu-item-icon">
                    {server.icon ? (
                      <img src={server.icon} alt="" />
                    ) : (
                      <IconServer size={18} stroke={2} />
                    )}
                  </span>
                  <div className="server-menu-item-info">
                    <span className="server-menu-item-name">{server.nickname}</span>
                    <span className="server-menu-item-host">{server.host}</span>
                  </div>
                  <div className="server-menu-item-actions">
                    <button
                      className="server-menu-item-edit"
                      title="Edit server bookmark"
                      onClick={(e) => {
                        e.stopPropagation()
                        openEditModal(server)
                      }}
                    >
                      <IconPencil size={15} />
                    </button>
                    <button
                      className="server-menu-item-remove"
                      title="Delete server bookmark"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRemoveServer(server.id)
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {ctxPos && (
        <div className="channel-context-menu" ref={ctxRef} style={ctxStyle}>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setCtxPos(null)
              onViewServerTraffic?.()
            }}
          >
            <IconActivity size={16} /> Server logs
          </button>
          <button
            type="button"
            className="channel-context-item"
            onClick={() => {
              setCtxPos(null)
              onViewServerSummary?.()
            }}
          >
            <IconInfoCircle size={16} /> View server summary
          </button>
          {canBanMembers && (
            <button
              type="button"
              className="channel-context-item"
              onClick={() => {
                setCtxPos(null)
                onOpenBanList?.()
              }}
            >
              <IconBan size={16} /> Ban list
            </button>
          )}
          {canManageServer && (
            <button
              type="button"
              className="channel-context-item"
              onClick={() => {
                setCtxPos(null)
                onOpenServerAdmin?.()
              }}
            >
              <IconSettings size={16} /> Server settings
            </button>
          )}
          <button
            type="button"
            className="channel-context-item danger"
            onClick={() => {
              setCtxPos(null)
              handleDisconnect()
            }}
          >
            <IconPlugConnectedX size={16} /> Disconnect
          </button>
        </div>
      )}

      <AnimatePresence>
        {showAddModal && (
          <motion.div
            className="add-server-overlay"
            onClick={() => setShowAddModal(false)}
            {...scrimFade(overlayAnim)}
          >
            <motion.div
              className="add-server-modal"
              onClick={(e) => e.stopPropagation()}
              {...overlayPop(overlayAnim)}
            >
              <div className="add-server-header">
                <span className="add-server-title">
                  {editingId
                    ? 'Edit Server Bookmark'
                    : isRegister
                      ? 'Register New Server'
                      : isRecover
                        ? 'Reset Password'
                        : 'Add Existing Login'}
                </span>
                <button className="add-server-close" onClick={() => setShowAddModal(false)}>
                  <IconX size={18} />
                </button>
              </div>

              <div className="add-server-body">
                {!editingId && (
                  <SegmentedTabs
                    className="add-server-mode-tabs"
                    ariaLabel="Register or login"
                    active={mode}
                    onChange={(m) => {
                      setMode(m)
                      setFormError(null)
                      checkServer(form.host)
                    }}
                    tabs={[
                      { id: 'register', label: 'Register' },
                      { id: 'login', label: 'Login' }
                    ]}
                  />
                )}
                {!isRecover && (
                  <label className="add-server-field">
                    <span>Server Nickname</span>
                    <input
                      type="text"
                      value={form.nickname}
                      placeholder="My Server"
                      onChange={(e) => updateForm({ nickname: e.target.value })}
                      autoFocus
                    />
                  </label>
                )}
                <label className="add-server-field">
                  <span>Address</span>
                  <input
                    type="text"
                    value={form.host}
                    placeholder="1.2.3.4:3000"
                    onChange={(e) => updateForm({ host: e.target.value })}
                    onBlur={() => checkServer(form.host)}
                  />
                  {hostProbe && (
                    <span
                      className={`add-server-hint add-server-probe add-server-probe-${hostProbe.status}`}
                      role="status"
                    >
                      {hostProbe.status === 'checking' && 'Checking…'}
                      {hostProbe.status === 'ok' && (
                        <>
                          <IconCheck size={13} stroke={2.5} aria-hidden="true" />
                          {hostProbe.name ?? 'Server is responding'}
                        </>
                      )}
                      {hostProbe.status === 'down' && 'Server not responding'}
                    </span>
                  )}
                </label>
                <label className="add-server-field">
                  <span>Username</span>
                  <input
                    type="text"
                    value={form.username}
                    placeholder="Enter username"
                    onChange={(e) => updateForm({ username: e.target.value })}
                  />
                </label>
                {isRecover && (
                  <label className="add-server-field">
                    <span>Reset Code</span>
                    <input
                      type="text"
                      value={form.code}
                      placeholder="XXXX-XXXX-XXXX"
                      onChange={(e) => updateForm({ code: e.target.value })}
                    />
                    <span className="add-server-hint">An admin of the server can issue one.</span>
                  </label>
                )}
                <label className="add-server-field">
                  <span>{isRecover ? 'New Password' : 'Password'}</span>
                  <div className="add-server-password">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      placeholder={isRecover ? 'Enter new password' : 'Enter password'}
                      onChange={(e) => updateForm({ password: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && submit()}
                    />
                    <button
                      type="button"
                      className="add-server-password-toggle"
                      title={showPassword ? 'Hide password' : 'Show password'}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((v) => !v)}
                    >
                      {showPassword ? <IconEyeOff size={16} /> : <IconEye size={16} />}
                    </button>
                  </div>
                </label>
                {!editingId && mode === 'login' && (
                  <button
                    type="button"
                    className="add-server-link"
                    onClick={() => {
                      setMode('recover')
                      setFormError(null)
                    }}
                  >
                    Forgot password?
                  </button>
                )}
                {(isRegister || isRecover) && (
                  <label className="add-server-field">
                    <span>Confirm Password</span>
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={form.confirmPassword}
                      placeholder="Re-enter password"
                      onChange={(e) => updateForm({ confirmPassword: e.target.value })}
                      onKeyDown={(e) => e.key === 'Enter' && submit()}
                    />
                  </label>
                )}
                {isRegister && (
                  <label className="add-server-field">
                    <span>Invite code or link</span>
                    <input
                      type="text"
                      value={form.invite}
                      placeholder={inviteRequired ? 'Required' : 'Optional'}
                      onChange={(e) => handleInviteChange(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && submit()}
                    />
                    <span className="add-server-hint">
                      {inviteRequired
                        ? 'This server is invite-only.'
                        : 'Optional. Paste a pylon://join link to fill in the address too.'}
                    </span>
                  </label>
                )}
              </div>

              <div className="add-server-footer">
                {formError && <div className="add-server-error">{formError}</div>}
                <button className="add-server-btn secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button
                  className="add-server-btn primary"
                  onClick={submit}
                  disabled={registering}
                >
                  {editingId
                    ? 'Save Changes'
                    : isRegister
                      ? 'Register'
                      : isRecover
                        ? 'Reset Password'
                        : 'Login'}
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}

export default ServerMenu
