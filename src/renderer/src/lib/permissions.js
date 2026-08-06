// The server's Permissions bitflags (u64), mirrored for the channel-overwrite
// editor. Bits are BigInt because ADMINISTRATOR is 1<<62, past JS's safe int
// range, and allow/deny cross the wire as decimal strings.

// [flag, label, purpose] — only the permissions that actually apply to voice
// channels (the sole channel type that carries overwrites here). purpose is
// surfaced as the row tooltip in the editor.
export const PERMISSIONS = [
  ['VIEW_CHANNEL', 'View Channel', 'See/access the voice channel'],
  ['SEND_MESSAGES', 'Send Messages', 'Send messages in the voice channel chat'],
  ['EMBED_LINKS', 'Embed Links', 'Send links that embed in the voice channel chat'],
  ['MANAGE_CHANNELS', 'Manage Channel', 'Edit or manage the voice channel'],
  ['CONNECT', 'Connect', 'Join the voice channel'],
  ['MOVE_MEMBERS', 'Move Members', 'Move members between voice channels'],
  ['MUTE_MEMBERS', 'Mute Members', 'Server-mute members in voice'],
  ['MANAGE_ROLES', 'Manage Permissions', 'Manage channel permission overwrites'],
  ['SPEAK', 'Speak', 'Speak in the voice channel'],
  ['STREAM', 'Stream', 'Stream / Go Live in voice'],
  ['DEAFEN_MEMBERS', 'Deafen Members', 'Server-deafen members in voice']
]

// Bit index per flag, matching the server's `1 << n`.
const BITS = {
  VIEW_CHANNEL: 0,
  SEND_MESSAGES: 1,
  EMBED_LINKS: 2,
  MANAGE_MESSAGES: 3,
  CREATE_CHANNELS: 4,
  MANAGE_CHANNELS: 5,
  DELETE_CHANNELS: 6,
  CONNECT: 7,
  MOVE_MEMBERS: 8,
  MUTE_MEMBERS: 9,
  KICK_MEMBERS: 10,
  BAN_MEMBERS: 11,
  MANAGE_ROLES: 12,
  SPEAK: 13,
  STREAM: 14,
  DEAFEN_MEMBERS: 15,
  ADMINISTRATOR: 62
}

export const permBit = (flag) => 1n << BigInt(BITS[flag])

// The server's built-in default role (EVERYONE_ROLE_ID). Every client holds it
// implicitly, so it never appears in a client's role_ids — but it is a real
// overwrite target, and the one you deny to make a channel role-gated. String
// because ids cross the wire both ways; compare with String(r.id).
export const EVERYONE_ROLE_ID = '1'

// Parse a decimal permission string (allow/deny bitfield) to BigInt, tolerating
// null/undefined/garbage by returning 0.
export const toBits = (decimal) => {
  try {
    return BigInt(decimal ?? 0)
  } catch {
    return 0n
  }
}

// Resolve what a channel's overwrites alone say about VIEW_CHANNEL for us, in
// the server's precedence order: @everyone, then the roles we hold (an allow on
// any beats a deny on another), then our own user overwrite. Returns
// true / false / null, where null means no overwrite mentions the bit and our
// base role permissions decide.
//
// ponytail: deliberately ignores base role permissions, so this can only ever
// answer "explicitly denied" — the client can't compute a trustworthy base (the
// implicit @everyone role isn't in /server/roles), and guessing wrong there
// would hide channels the server actually grants. The server stays authoritative.
export function viewChannelOverride(overwrites = [], { roleIds = [], userId } = {}) {
  const bit = permBit('VIEW_CHANNEL')
  const says = (o, field) => (toBits(o[field]) & bit) !== 0n
  // deny first, then allow, so an overwrite setting both resolves to allow.
  const apply = (o, state) => (says(o, 'deny') ? false : says(o, 'allow') ? true : state)

  let state = null
  const roleOf = (id) => overwrites.find((o) => o.type === 'role' && String(o.id) === String(id))

  const everyone = roleOf(EVERYONE_ROLE_ID)
  if (everyone) state = apply(everyone, state)

  const mine = roleIds.map(roleOf).filter((o) => o && String(o.id) !== EVERYONE_ROLE_ID)
  if (mine.some((o) => says(o, 'deny'))) state = false
  if (mine.some((o) => says(o, 'allow'))) state = true

  const user = overwrites.find((o) => o.type === 'user' && String(o.id) === String(userId))
  if (user) state = apply(user, state)

  return state
}
