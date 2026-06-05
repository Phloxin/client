import { createContext, useContext, useState, useEffect } from 'react'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [token, setToken] = useState(null)
  const [client, setClient] = useState(null)

  useEffect(() => {
    window.electron.ipcRenderer.invoke('get-token').then((t) => {
      if (t) setToken(t)
    })
    window.electron.ipcRenderer.invoke('get-client').then((c) => {
      if (c) setClient(c)
    })
  }, [])

  const saveToken = (t) => {
    setToken(t)
    window.electron.ipcRenderer.send('store-token', t)
  }

  const saveClient = (c) => {
    setClient(c)
    window.electron.ipcRenderer.send('store-client', JSON.stringify(c))
  }

  return (
    <AuthContext.Provider value={{ token, setToken: saveToken, client, setClient: saveClient }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth() {
  return useContext(AuthContext)
}