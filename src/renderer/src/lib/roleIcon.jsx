import {
  IconShieldHalfFilled,
  IconShieldFilled,
  IconShieldCheckeredFilled
} from '@tabler/icons-react'

// Maps well-known role names to an icon by case-insensitive substring, so
// "Administrator" matches "admin" etc. First match wins; unknown roles get no
// icon (null). ponytail: name-based, switch to a server-supplied icon field if
// roles ever carry one.
const ROLE_ICONS = [
  ['owner', IconShieldCheckeredFilled],
  ['admin', IconShieldFilled],
  ['mod', IconShieldHalfFilled]
]

export function RoleIcon({ role, size = 16 }) {
  const name = role?.name?.toLowerCase() ?? ''
  const match = ROLE_ICONS.find(([key]) => name.includes(key))
  const Icon = match?.[1]
  return Icon ? <Icon size={size} /> : null
}
