import { createContext, useCallback, useContext, useState } from 'react'
import { setAuthTokens, clearAuthTokens } from '../lib/auth'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // Session-only: the app always launches disconnected and the user picks a
  // saved server to connect to. `token` marks a live session (set at login,
  // cleared at disconnect): an opaque per-login marker, not a credential. The
  // token pair lives in the main process (see lib/auth) and rotates underneath
  // via refresh, so REST callers go through authFetch instead of reading this.
  const [token, setToken] = useState(null)
  const [session, setSession] = useState(null)
  const [client, setClient] = useState(null)

  // Store a full login/register response: the rotating pair goes to the main
  // process's session, the rest into React state. Resolves once main holds the
  // pair, so nothing keyed on `token` can send a request without it.
  const applyAuthResponse = useCallback(async (data) => {
    await setAuthTokens(data)
    setToken({})
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
        session,
        applyAuthResponse,
        clearAuth,
        client
      }}
    >
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
