import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { menuPop, overlayPop, scrimFade } from '../lib/motionPresets'
import './ServerMenu.css'
import {
  IconChevronDown,
  IconPlus,
  IconX,
  IconPlugConnected,
  IconTrash,
  IconPencil
} from '@tabler/icons-react'

// Initial state for the add-server form
const EMPTY_FORM = { nickname: '', host: '', username: '', password: '' }

// Sidebar header control: shows the connection status + the active/"Connect"
// label, and opens a dropdown of saved servers with add / connect / remove /
// disconnect actions.
function ServerMenu({
  servers,
  connectedServer,
  onConnect,
  onDisconnect,
  onAddServer,
  onEditServer,
  onRemoveServer
}) {
  const [open, setOpen] = useState(false)
  const [showAddModal, setShowAddModal] = useState(false)
  // Holds the id of the server being edited, or null when adding a new one
  const [editingId, setEditingId] = useState(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [formError, setFormError] = useState(null)
  const menuRef = useRef(null)
  const overlayAnim = useAnimationCategory('overlays')

  const connected = !!connectedServer

  // Close the dropdown when clicking outside it
  useEffect(() => {
    if (!open) return
    const onClick = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const handleConnect = (server) => {
    setOpen(false)
    onConnect(server)
  }

  const handleDisconnect = () => {
    setOpen(false)
    onDisconnect()
  }

  const openAddModal = () => {
    setEditingId(null)
    setForm(EMPTY_FORM)
    setFormError(null)
    setShowAddModal(true)
  }

  const openEditModal = (server) => {
    setEditingId(server.id)
    setForm({
      nickname: server.nickname,
      host: server.host,
      username: server.username,
      password: server.password ?? ''
    })
    setFormError(null)
    setShowAddModal(true)
  }

  const updateForm = (changes) => setForm((prev) => ({ ...prev, ...changes }))

  const handleSave = () => {
    const nickname = form.nickname.trim()
    const host = form.host.trim()
    const username = form.username.trim()
    if (!nickname || !host || !username) {
      setFormError('Nickname, address, and username are required.')
      return
    }
    if (editingId) {
      onEditServer({ id: editingId, nickname, host, username, password: form.password })
    } else {
      onAddServer({ id: crypto.randomUUID(), nickname, host, username, password: form.password })
    }
    setShowAddModal(false)
    setOpen(true)
  }

  return (
    <div className="server-menu" ref={menuRef}>
      <button
        className="server-menu-trigger"
        onClick={() => setOpen((o) => !o)}
        title={connected ? `Connected to ${connectedServer.nickname}` : 'Not connected'}
      >
        <span className={`server-status-dot${connected ? ' connected' : ''}`} />
        <span className="server-menu-label">
          {connected ? connectedServer.nickname : 'Connect'}
        </span>
        <IconChevronDown size={16} className={`server-menu-chevron${open ? ' open' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div className="server-menu-dropdown" {...menuPop(overlayAnim)}>
            {connected && (
              <button className="server-menu-action disconnect" onClick={handleDisconnect}>
                <IconPlugConnected size={16} /> Disconnect
              </button>
            )}
            <div className="server-menu-section-label">
              <span>Servers</span>
              <span className="server-menu-section-divider" aria-hidden="true" />
              <button className="server-menu-add-btn" title="Add server" onClick={openAddModal}>
                <IconPlus size={15} />
              </button>
            </div>

            {servers.length === 0 && <div className="server-menu-empty">No saved servers yet</div>}

            {servers.map((server) => {
              const isActive = connectedServer?.id === server.id
              return (
                <div
                  key={server.id}
                  className={`server-menu-item${isActive ? ' active' : ''}`}
                  onClick={() => !isActive && handleConnect(server)}
                >
                  <div className="server-menu-item-info">
                    <span className="server-menu-item-name">{server.nickname}</span>
                    <span className="server-menu-item-host">{server.host}</span>
                  </div>
                  <div className="server-menu-item-actions">
                    {isActive && <span className="server-menu-item-badge">Connected</span>}
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
                    {!isActive && (
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
                    )}
                  </div>
                </div>
              )
            })}
          </motion.div>
        )}
      </AnimatePresence>

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
                <span className="add-server-title">{editingId ? 'Edit Server' : 'Add Server'}</span>
                <button className="add-server-close" onClick={() => setShowAddModal(false)}>
                  <IconX size={18} />
                </button>
              </div>

              <div className="add-server-body">
                <label className="add-server-field">
                  <span>Nickname</span>
                  <input
                    type="text"
                    value={form.nickname}
                    placeholder="My Server"
                    onChange={(e) => updateForm({ nickname: e.target.value })}
                    autoFocus
                  />
                </label>
                <label className="add-server-field">
                  <span>Address (ip:port)</span>
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
                  <input
                    type="password"
                    value={form.password}
                    placeholder="Enter password"
                    onChange={(e) => updateForm({ password: e.target.value })}
                    onKeyDown={(e) => e.key === 'Enter' && handleSave()}
                  />
                </label>
                {formError && <div className="add-server-error">{formError}</div>}
              </div>

              <div className="add-server-footer">
                <button className="add-server-btn secondary" onClick={() => setShowAddModal(false)}>
                  Cancel
                </button>
                <button className="add-server-btn primary" onClick={handleSave}>
                  {editingId ? 'Save Changes' : 'Save'}
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
