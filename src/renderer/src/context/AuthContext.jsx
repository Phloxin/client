import { createContext, useCallback, useContext, useState } from 'react'
import { apiBase } from '../lib/serverConfig'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // Token/client are session-only now: the app always launches disconnected and
  // the user picks a saved server to connect to (see ServerMenu / Main). Nothing
  // is auto-loaded from disk, so there's no implicit reconnect on startup.
  const [token, setToken] = useState(null)
  const [refreshToken, setRefreshToken] = useState(null)
  const [accessExpiresAt, setAccessExpiresAt] = useState(null)
  const [refreshExpiresAt, setRefreshExpiresAt] = useState(null)
  const [session, setSession] = useState(null)
  const [client, setClient] = useState(null)

  const applyAuthResponse = useCallback((data) => {
    setToken(data.access_token)
    setRefreshToken(data.refresh_token)
    setAccessExpiresAt(data.access_expires_at)
    setRefreshExpiresAt(data.refresh_expires_at)
    setSession(data.session)
    setClient(data.client)
    return data
  }, [])

  // Refresh tokens are single-use. The server atomically rotates both tokens;
  // callers must replace the complete auth response, never reuse the old pair.
  const refreshAuth = useCallback(async () => {
    if (!refreshToken) throw new Error('No refresh token')
    const response = await fetch(`${apiBase()}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.access_token) {
      throw new Error(data.error || `Server responded ${response.status}`)
    }
    return applyAuthResponse(data)
  }, [applyAuthResponse, refreshToken])

  return (
    <AuthContext.Provider
      value={{
        token,
        setToken,
        refreshToken,
        setRefreshToken,
        accessExpiresAt,
        setAccessExpiresAt,
        refreshExpiresAt,
        setRefreshExpiresAt,
        session,
        setSession,
        applyAuthResponse,
        refreshAuth,
        client,
        setClient
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
