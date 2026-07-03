import { createContext, useContext, useState } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  // Token/client are session-only now: the app always launches disconnected and
  // the user picks a saved server to connect to (see ServerMenu / Main). Nothing
  // is auto-loaded from disk, so there's no implicit reconnect on startup.
  const [token, setToken] = useState(null)
  const [client, setClient] = useState(null)

  return (
    <AuthContext.Provider value={{ token, setToken, client, setClient }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}
