import { createContext, useCallback, useContext, useState } from 'react'
import { setAuthTokens, clearAuthTokens } from '../lib/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // Session-only: the app always launches disconnected and the user picks a
  // saved server to connect to. `token` marks a live session (set at login,
  // cleared at disconnect) — the *current* access token lives in lib/auth and
  // rotates underneath via refresh, so REST callers go through authFetch
  // instead of reading this.
  const [token, setToken] = useState(null)
  const [session, setSession] = useState(null)
  const [client, setClient] = useState(null)

  // Store a full login/register response: the rotating pair goes to the token
  // store, the rest into React state.
  const applyAuthResponse = useCallback((data) => {
    setAuthTokens(data)
    setToken(data.access_token)
    setSession(data.session)
    setClient(data.client)
    return data
  }, [])

  const clearAuth = useCallback(() => {
    clearAuthTokens()
    setToken(null)
    setSession(null)
    setClient(null)
  }, [])

  return (
    <AuthContext.Provider
      value={{
        token,
        setToken,
        session,
        applyAuthResponse,
        clearAuth,
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
