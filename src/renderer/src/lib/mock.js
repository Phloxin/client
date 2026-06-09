// ─── Dev Mode ───────────────────────────────────────────────────
export const DEV_MODE = import.meta.env.VITE_DEV_MODE === 'true'

// ─── Mock Data ──────────────────────────────────────────────────
export const MOCK_TOKEN = 'mock-token-dev'

export const MOCK_CLIENT = {
  id: 1,
  name: 'DevUser'
}

export const MOCK_CHANNELS = [
  { id: 1, name: 'League of Normals', clients: [1, 2] },
  { id: 2, name: 'Tel Aviv', clients: [] },
  { id: 3, name: 'Office Hours', clients: [3] },
]

export const MOCK_CLIENTS = [
  { id: 1, name: 'DevUser', channel_id: 1 },
  { id: 2, name: 'Alice', channel_id: 1 },
  { id: 3, name: 'Bob', channel_id: 3 },
  { id: 4, name: 'Charlie', channel_id: null },
]