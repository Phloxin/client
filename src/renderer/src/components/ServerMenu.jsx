import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop, scrimFade } from '../lib/motionPresets'
import SegmentedTabs from './SegmentedTabs'
import './ServerMenu.css'
import { httpFetch } from '../lib/http'
import { useMenuPosition } from '../lib/menuPosition'
import {
  IconPlus,
  IconX,
  IconPlugConnectedX,
  IconTrash,
  IconPencil,
  IconEye,
  IconEyeOff,
  IconActivity,
  IconInfoCircle,
  IconServer
} from '@tabler/icons-react'

// Initial state for the add-server form
const EMPTY_FORM = { nickname: '', host: '', username: '', password: '', confirmPassword: '' }

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
  onConnect,
  onDisconnect,
  onAddServer,
  onEditServer,
  onRemoveServer,
  onNotify,
  onViewServerTraffic,
  onViewServerSummary
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
    setShowAddModal(true)
  }

  const updateForm = (changes) => setForm((prev) => ({ ...prev, ...changes }))

  // Register mode shows the confirm-password field and the "Register" action.
  const isRegister = !editingId && mode === 'register'

  // Editing only persists the change. Adding an existing login also starts the
  // connection immediately; otherwise the Login tab deceptively only saves the
  // server and no /login request is made until the user clicks it again.
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
  // the server's /register. Each failure point sets a specific inline error:
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

    setFormError(null)
    setRegistering(true)
    let res
    try {
      res = await httpFetch(`https://${host}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, device_name: DEVICE_NAME })
      })
    } catch {
      setRegistering(false)
      setFormError(`Could not reach a server at ${host}.`)
      return
    }
    setRegistering(false)

    if (!res.ok) {
      const body = await res.json().catch(() => null)
      // Valid input the server still rejects means the name is taken; prefer the
      // server's own message when it sends one.
      setFormError(body?.error || `Username "${username}" is already taken on this server.`)
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

  const submit = () => (isRegister ? handleRegister() : handleSave())

  return (
    <div className={`server-menu${connected ? '' : ' disconnected'}`}>
      {/* Identity row. Right-click (connected) opens the traffic/summary menu. */}
      <div
        className="server-menu-trigger"
        onContextMenu={(e) => {
          // Right-click actions only apply to the connected server.
          if (!connected) return
          e.preventDefault()
          setCtxPos({ x: e.clientX, y: e.clientY })
        }}
        title={connected ? `Connected to ${connectedServer.nickname}` : 'Not connected'}
      >
        <span className={`server-status-dot${connected ? ' connected' : ''}`} />
        <span className="server-menu-label">
          {connected ? connectedServer.nickname : 'Not connected'}
        </span>
        {connected && (
          <button
            className="server-menu-disconnect"
            title="Disconnect from server"
            aria-label="Disconnect from server"
            onClick={handleDisconnect}
          >
            <IconPlugConnectedX size={16} />
          </button>
        )}
      </div>

      {/* Saved-server list — inline, fills the rail while disconnected. */}
      {!connected && (
        <div className="server-menu-list">
          <div className="server-menu-section-label">
            <span>Servers</span>
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
                      title="Edit server"
                      onClick={(e) => {
                        e.stopPropagation()
                        openEditModal(server)
                      }}
                    >
                      <IconPencil size={15} />
                    </button>
                    <button
                      className="server-menu-item-remove"
                      title="Remove server"
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
            <IconActivity size={16} /> View server traffic
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
                    ? 'Edit Server'
                    : isRegister
                      ? 'Register New Server'
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
                    }}
                    tabs={[
                      { id: 'register', label: 'Register' },
                      { id: 'login', label: 'Login' }
                    ]}
                  />
                )}
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
                <label className="add-server-field">
                  <span>Address</span>
                  <input
                    type="text"
                    value={form.host}
                    placeholder="1.2.3.4:3000"
                    onChange={(e) => updateForm({ host: e.target.value })}
                  />
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
                <label className="add-server-field">
                  <span>Password</span>
                  <div className="add-server-password">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      value={form.password}
                      placeholder="Enter password"
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
                {isRegister && (
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
                  {editingId ? 'Save Changes' : isRegister ? 'Register' : 'Login'}
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
