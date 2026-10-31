// Naming the other participants of a DM or group DM.

// Every participant but us, from `participant_ids` (server) or `recipients`
// (local), whose entries are plain ids or { id, name }.
export function dmOthers(channel, selfId) {
  const others = []
  for (const r of channel?.participant_ids || channel?.recipients || []) {
    const id = r && typeof r === 'object' ? r.id : r
    if (id !== selfId) others.push({ id, name: r && typeof r === 'object' ? r.name : undefined })
  }
  return others
}

export function dmDisplayName(channel, selfId, nameOf) {
  const names = dmOthers(channel, selfId).map((r) => r.name || nameOf?.(r.id) || 'Unknown')
  return names.length ? names.join(', ') : channel?.name || 'Direct Message'
}

// "Alice is in the call", "Alice and Bob are in the call", "Alice, Bob and Cara are in the call".
export function inCallText(names) {
  if (!names.length) return ''
  if (names.length === 1) return `${names[0]} is in the call`
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]} are in the call`
}
