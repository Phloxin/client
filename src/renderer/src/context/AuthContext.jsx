import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null)

  useEffect(() => {
    window.electron.ipcRenderer.invoke('get-token').then((t) => {
      if (t) setToken(t)
    })
  }, [])

  const saveToken = (t) => {
    setToken(t)
    window.electron.ipcRenderer.send('store-token', t)
  }

  return (
    <AuthContext.Provider value={{ token, setToken: saveToken }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}