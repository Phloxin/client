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

// Parse a decimal permission string (allow/deny bitfield) to BigInt, tolerating
// null/undefined/garbage by returning 0.
export const toBits = (decimal) => {
  try {
    return BigInt(decimal ?? 0)
  } catch {
    return 0n
  }
}
