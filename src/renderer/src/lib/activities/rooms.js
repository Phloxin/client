// The open activity rooms this client can see, kept from Ready.rooms and the room events with the
// rules in docs/API.md "Activities": an Opened room already known replaces it, an Updated or Closed
// room not known is ignored, a deleted channel takes its rooms with it, and a new Ready replaces
// the list. Rooms keep the server's shape ({ id, channel_id, activity_id, creator, clients,
// opened_at, detail }). Pure; every function returns the same list when nothing changed.

const isRoom = (room) =>
  !!room && typeof room === 'object' && typeof room.id === 'string' && room.id !== ''

// A room's detail is a display string or nothing.
function withDetail(room, detail) {
  const next = { ...room }
  if (typeof detail === 'string') next.detail = detail
  else delete next.detail
  return next
}

const withClients = (room) =>
  withDetail({ ...room, clients: Array.isArray(room.clients) ? room.clients : [] }, room.detail)

export function roomsFromReady(rooms) {
  return Array.isArray(rooms) ? rooms.filter(isRoom).map(withClients) : []
}

export function roomOpened(list, room) {
  if (!isRoom(room)) return list
  const next = withClients(room)
  return list.some((r) => r.id === room.id)
    ? list.map((r) => (r.id === room.id ? next : r))
    : [...list, next]
}

export function roomUpdated(list, update) {
  const id = update?.room_id
  if (!list.some((r) => r.id === id)) return list
  const clients = Array.isArray(update.clients) ? update.clients : []
  return list.map((r) => (r.id === id ? withDetail({ ...r, clients }, update.detail) : r))
}

export function roomClosed(list, update) {
  const id = update?.room_id
  return list.some((r) => r.id === id) ? list.filter((r) => r.id !== id) : list
}

export function channelRoomsDeleted(list, channelId) {
  return list.some((r) => r.channel_id === channelId)
    ? list.filter((r) => r.channel_id !== channelId)
    : list
}

export const findRoom = (list, roomId) => list.find((r) => r.id === roomId) ?? null

// A channel's open rooms, oldest first.
export const roomsInChannel = (list, channelId) =>
  list
    .filter((r) => r.channel_id === channelId)
    .sort((a, b) => (a.opened_at ?? 0) - (b.opened_at ?? 0))
