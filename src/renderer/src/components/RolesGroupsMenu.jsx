import { useState, useRef } from 'react'
import { motion } from 'motion/react'
import { useAnimationCategory } from '../context/SettingsContext'
import { overlayPop } from '../lib/motionPresets'
import SegmentedTabs from './SegmentedTabs'
import { RoleIcon } from '../lib/roleIcon'
import { fileToAvatarDataUrl } from '../lib/avatarFile'
import './RolesGroupsMenu.css'
import { IconUsersGroup, IconUserShield, IconPhotoUp, IconPlus, IconX } from '@tabler/icons-react'

// 'Roles and Groups' popup, opened from a client's context menu. Groups tab
// lists the server's vanity groups and creates new ones; Roles tab is a
// read-only list of the server's roles for now.
function RolesGroupsMenu({ roles = [], vanity = [], onCreateVanity, onClose }) {
  const [tab, setTab] = useState('groups')
  const [name, setName] = useState('')
  // Pending icon for the new group (data URL), sent with the create request.
  const [avatar, setAvatar] = useState(null)
  const iconInputRef = useRef(null)
  const overlayAnim = useAnimationCategory('overlays')

  // The new group shows up via the server's VanityCreated broadcast; just
  // reset the composer so another can be created.
  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    onCreateVanity?.(trimmed, avatar)
    setName('')
    setAvatar(null)
  }

  const handleIconFile = (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (file) fileToAvatarDataUrl(file, setAvatar)
  }

  return (
    <div className="rg-overlay" onClick={onClose}>
      <motion.div
        className="rg-modal"
        onClick={(e) => e.stopPropagation()}
        {...overlayPop(overlayAnim)}
      >
        <div className="rg-header">
          <span className="rg-title">Roles and Groups</span>
          <button type="button" className="rg-close" onClick={onClose} title="Close">
            <IconX size={16} />
          </button>
        </div>
        <div className="rg-tabs">
          <SegmentedTabs
            ariaLabel="Roles and Groups"
            active={tab}
            onChange={setTab}
            tabs={[
              { id: 'roles', label: 'Roles', icon: <IconUserShield size={15} /> },
              { id: 'groups', label: 'Groups', icon: <IconUsersGroup size={15} /> }
            ]}
          />
        </div>
        <div className="rg-body">
          {tab === 'groups' ? (
            <>
              {vanity.length === 0 && <div className="rg-empty">No groups yet</div>}
              {vanity.map((g) => (
                <div key={g.id} className="rg-row">
                  {g.avatar ? (
                    <img src={g.avatar} alt="" className="rg-row-icon" />
                  ) : (
                    <IconUsersGroup size={18} />
                  )}
                  <span className="rg-row-name">{g.name}</span>
                </div>
              ))}
              <div className="rg-create-row">
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={handleIconFile}
                />
                <button
                  type="button"
                  className="rg-icon-btn"
                  onClick={() => iconInputRef.current?.click()}
                  title={avatar ? 'Change icon' : 'Add icon (optional)'}
                >
                  {avatar ? (
                    <img src={avatar} alt="" className="rg-row-icon" />
                  ) : (
                    <IconPhotoUp size={16} />
                  )}
                </button>
                <input
                  className="rg-name-input"
                  value={name}
                  placeholder="New group name"
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submit()
                    }
                  }}
                />
                <button
                  type="button"
                  className="rg-icon-btn"
                  onClick={submit}
                  disabled={!name.trim()}
                  title="Create group"
                >
                  <IconPlus size={16} />
                </button>
              </div>
            </>
          ) : (
            <>
              {roles.length === 0 && <div className="rg-empty">No roles</div>}
              {roles.map((r) => (
                <div key={r.id} className="rg-row">
                  <RoleIcon role={r} size={18} />
                  <span className="rg-row-name">{r.name}</span>
                </div>
              ))}
            </>
          )}
        </div>
      </motion.div>
    </div>
  )
}

export default RolesGroupsMenu
