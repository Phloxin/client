// Invite codes and links, and admin-issued reset codes. Codes use the server's alphabet (no 0, O,
// 1, I or L) and are normalized the same way the server does before it compares them.

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'

// Uppercases and drops '-', spaces and tabs. Null when what is left is empty or holds a symbol
// outside the alphabet. ASCII-only uppercasing, like the server, so 'ß' never becomes 'SS'.
export function normalizeCode(text) {
  if (typeof text !== 'string') return null
  const code = text.replace(/[- \t]/g, '').replace(/[a-z]/g, (c) => c.toUpperCase())
  if (!code || ![...code].every((c) => CODE_ALPHABET.includes(c))) return null
  return code
}

// A bare code or a pylon://join link, as typed or pasted: { host?, code }, or null when neither
// parses.
export function parseInviteInput(text) {
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (/^pylon:/i.test(trimmed)) {
    let url
    try {
      url = new URL(trimmed)
    } catch {
      return null
    }
    if (url.protocol !== 'pylon:' || url.host !== 'join') return null
    const code = normalizeCode(url.searchParams.get('code') ?? '')
    if (!code) return null
    const host = url.searchParams.get('host')?.trim()
    return host ? { host, code } : { code }
  }
  const code = normalizeCode(trimmed)
  return code ? { code } : null
}

// The link an admin shares. `host` is the address exactly as it is typed in the Add server dialog.
export function inviteLink(host, code) {
  return `pylon://join?${new URLSearchParams({ host, code })}`
}

// Dashed groups of four, the way the server shows a reset code.
export function formatResetCode(code) {
  const normalized = normalizeCode(code) ?? (typeof code === 'string' ? code : '')
  return normalized.match(/.{1,4}/g)?.join('-') ?? ''
}
