// ─── Dev Mode ───────────────────────────────────────────────────
export const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'

// ─── Mock Data ──────────────────────────────────────────────────
export const MOCK_TOKEN = 'mock-token-dev'

export const MOCK_CLIENT = {
  id: 1,
  name: 'DevUser'
}

export const MOCK_CHANNELS = [
  { id: 1, name: 'Voice Channel 1', clients: [1, 2] },
  { id: 2, name: 'Voice Channel 2', clients: [] },
  { id: 3, name: 'Voice Channel 3', clients: [3] },
]

export const MOCK_CLIENTS = [
  { id: 1, name: 'DevUser', channel_id: 1 },
  { id: 2, name: 'Chris', channel_id: 1 },
  { id: 3, name: 'John', channel_id: 3 },
  { id: 4, name: 'Tim', channel_id: null },
]