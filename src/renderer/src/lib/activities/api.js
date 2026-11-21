// The activity REST calls (docs/API.md "Activities"). Errors throw as throwIfError makes them,
// with the server's `code` and the HTTP `status` on the error.

import { authFetch } from '../auth.js'
import { apiBase, throwIfError } from '../serverConfig.js'

const json = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})

// What a room can be opened for: [{ id, name, required_clients: { min, max } }].
export async function listActivities() {
  const res = await authFetch(`${apiBase()}/activities`)
  await throwIfError(res)
  const list = await res.json()
  return Array.isArray(list) ? list : []
}

// Opens a room in the channel: { room, ticket, url?, ttl_ms }.
export async function openRoom(channelId, activityId) {
  const res = await authFetch(
    `${apiBase()}/channels/${encodeURIComponent(channelId)}/activities`,
    json({ activity_id: activityId })
  )
  await throwIfError(res)
  return res.json()
}

// A ticket for the room session: { ticket, url?, ttl_ms }.
export async function roomTicket(roomId) {
  const res = await authFetch(
    `${apiBase()}/activities/rooms/${encodeURIComponent(roomId)}/ticket`,
    { method: 'POST' }
  )
  await throwIfError(res)
  return res.json()
}

// Force closes a room.
export async function endRoom(roomId) {
  const res = await authFetch(`${apiBase()}/activities/rooms/${encodeURIComponent(roomId)}`, {
    method: 'DELETE'
  })
  await throwIfError(res)
}
