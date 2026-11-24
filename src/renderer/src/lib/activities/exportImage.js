// The shell's side of a bundle's `export` capability, for a message readUiMessage passed: save
// the PNG where the viewer chooses, or share it to the room's channel as a message with that one
// attachment. Answers { ok: true } or { ok: false, error }, the error one of canceled,
// export_too_large, export_failed and not_connected.

import { authFetch } from '../auth.js'
import { getServerLimits } from '../attachments.js'
import { apiBase, throwIfError } from '../serverConfig.js'

// Through the main process's save dialog when there is one, otherwise through an anchor, where
// the browser decides. Answers as the `download-file` IPC does.
export async function savePng({ name, data }) {
  const ipc = globalThis.window?.electron?.ipcRenderer
  if (ipc) return ipc.invoke('save-png', { name, data })
  const url = URL.createObjectURL(new Blob([data], { type: 'image/png' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
  return { ok: true }
}

const DEPS = { savePng, authFetch, apiBase, getServerLimits }
const failed = { ok: false, error: 'export_failed' }

async function save({ name, data }, deps) {
  try {
    const result = await deps.savePng({ name, data })
    if (result?.ok) return { ok: true }
    if (result?.canceled) return { ok: false, error: 'canceled' }
    console.warn('[Activity] Saving the picture failed:', result?.error)
  } catch (err) {
    console.warn('[Activity] Saving the picture failed:', err)
  }
  return failed
}

async function share({ name, data }, channelId, deps) {
  const limits = deps.getServerLimits()
  if (!limits) return { ok: false, error: 'not_connected' }
  if (data.length > limits.attachment_bytes || data.length > limits.message_upload_bytes) {
    return { ok: false, error: 'export_too_large' }
  }
  if (channelId == null) return failed
  const payload = { content: null, attachments: [{ ref: 0, filename: name, description: null }] }
  const form = new FormData()
  form.append('payload_json', new Blob([JSON.stringify(payload)], { type: 'application/json' }))
  form.append('files[0]', new Blob([data], { type: 'image/png' }), name)
  try {
    const res = await deps.authFetch(`${deps.apiBase()}/channels/${channelId}/messages`, {
      method: 'POST',
      body: form
    })
    await throwIfError(res)
    return { ok: true }
  } catch (err) {
    console.warn('[Activity] Sharing the picture failed:', err)
    return failed
  }
}

export function exportImage(message, { channelId }, deps = DEPS) {
  return message.op === 'save' ? save(message, deps) : share(message, channelId, deps)
}
