import { useMemo, useState } from 'react'
import { IconX, IconCheck, IconMinus, IconTrash, IconPencil } from '@tabler/icons-react'
import { PERMISSIONS, permBit, toBits } from '../lib/permissions'
import './ChannelPermissions.css'

// Tri-state of a single permission within one overwrite: allowed, denied, or
// inherited (neutral). Derived from the allow/deny bitfields.
function stateFor(flag, allow, deny) {
  const bit = permBit(flag)
  if (allow & bit) return 'allow'
  if (deny & bit) return 'deny'
  return 'neutral'
}

// The per-permission allow/neutral/deny editor for one target (role or user).
function OverwriteEditor({ targetName, targetKind, allow, deny, onSave, onCancel }) {
  const [states, setStates] = useState(() =>
    Object.fromEntries(PERMISSIONS.map(([flag]) => [flag, stateFor(flag, allow, deny)]))
  )

  const save = () => {
    let allowBits = 0n
    let denyBits = 0n
    for (const [flag] of PERMISSIONS) {
      if (states[flag] === 'allow') allowBits |= permBit(flag)
      else if (states[flag] === 'deny') denyBits |= permBit(flag)
    }
    onSave(allowBits.toString(), denyBits.toString())
  }

  return (
    <div className="chan-perm-editor">
      <div className="chan-perm-editor-head">
        Editing <strong>{targetName}</strong>
        <span className="chan-perm-kind">{targetKind === 'role' ? 'Role' : 'User'}</span>
      </div>
      <ul className="chan-perm-list">
        {PERMISSIONS.map(([flag, label, purpose]) => (
          <li key={flag} className="chan-perm-row">
            <span className="chan-perm-label" title={purpose}>
              {label}
            </span>
            <div className="chan-perm-toggle" role="group" aria-label={label}>
              {[
                ['deny', IconX, 'Deny'],
                ['neutral', IconMinus, 'Inherit'],
                ['allow', IconCheck, 'Allow']
              ].map(([val, Icon, title]) => (
                <button
                  key={val}
                  type="button"
                  title={title}
                  className={`chan-perm-seg ${val}${states[flag] === val ? ' on' : ''}`}
                  onClick={() => setStates((s) => ({ ...s, [flag]: val }))}
                >
                  <Icon size={15} />
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="chan-perm-actions">
        <button type="button" className="chan-perm-btn" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="chan-perm-btn primary" onClick={save}>
          Save
        </button>
      </div>
    </div>
  )
}

// Channel permission overwrites: mask a role's or user's permissions for one
// channel. Lists existing overwrites and (when the viewer can manage the
// channel) lets them add, edit, or remove them. Wire shape per overwrite:
// { id (target id), type: 'role'|'user', allow, deny } — allow/deny are decimal
// bitfield strings.
function ChannelPermissions({ channel, roles = [], clients = [], canManage, onSet, onDelete }) {
  const overwrites = channel?.overwrites || []
  // { id, type } currently open in the editor, or null.
  const [editing, setEditing] = useState(null)

  const nameFor = (o) => {
    if (o.type === 'role') return roles.find((r) => String(r.id) === String(o.id))?.name || 'Role'
    return clients.find((c) => String(c.id) === String(o.id))?.name || 'User'
  }

  // Targets that don't yet have an overwrite, for the "Add override" picker.
  const addable = useMemo(() => {
    const taken = new Set(overwrites.map((o) => `${o.type}:${o.id}`))
    const roleOpts = roles.map((r) => ({ id: String(r.id), type: 'role', name: r.name }))
    const userOpts = clients.map((c) => ({ id: String(c.id), type: 'user', name: c.name }))
    return [...roleOpts, ...userOpts].filter((t) => !taken.has(`${t.type}:${t.id}`))
  }, [overwrites, roles, clients])

  const editTarget =
    editing &&
    overwrites.find((o) => o.type === editing.type && String(o.id) === String(editing.id))

  return (
    <section className="client-summary-section">
      <h3 className="client-summary-heading">Permissions</h3>

      {editing ? (
        <OverwriteEditor
          targetName={nameFor(editing)}
          targetKind={editing.type}
          allow={toBits(editTarget?.allow)}
          deny={toBits(editTarget?.deny)}
          onCancel={() => setEditing(null)}
          onSave={(allow, deny) => {
            onSet?.(channel.id, editing.id, editing.type, allow, deny)
            setEditing(null)
          }}
        />
      ) : (
        <>
          {overwrites.length === 0 ? (
            <p className="client-summary-placeholder">No permission overrides.</p>
          ) : (
            <ul className="chan-perm-overwrites">
              {overwrites.map((o) => (
                <li key={`${o.type}:${o.id}`} className="chan-perm-overwrite">
                  <span className="chan-perm-target">{nameFor(o)}</span>
                  <span className="chan-perm-kind">{o.type === 'role' ? 'Role' : 'User'}</span>
                  {canManage && (
                    <span className="chan-perm-overwrite-actions">
                      <button
                        type="button"
                        title="Edit"
                        onClick={() => setEditing({ id: o.id, type: o.type })}
                      >
                        <IconPencil size={15} />
                      </button>
                      <button
                        type="button"
                        title="Remove"
                        className="danger"
                        onClick={() => onDelete?.(channel.id, o.id)}
                      >
                        <IconTrash size={15} />
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {canManage && addable.length > 0 && (
            <select
              className="chan-perm-add"
              value=""
              onChange={(e) => {
                const t = addable.find((a) => `${a.type}:${a.id}` === e.target.value)
                if (t) setEditing({ id: t.id, type: t.type })
              }}
            >
              <option value="" disabled>
                Add override…
              </option>
              <optgroup label="Roles">
                {addable
                  .filter((a) => a.type === 'role')
                  .map((a) => (
                    <option key={`role:${a.id}`} value={`role:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
              <optgroup label="Users">
                {addable
                  .filter((a) => a.type === 'user')
                  .map((a) => (
                    <option key={`user:${a.id}`} value={`user:${a.id}`}>
                      {a.name}
                    </option>
                  ))}
              </optgroup>
            </select>
          )}
        </>
      )}
    </section>
  )
}

export default ChannelPermissions
