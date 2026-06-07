import { Routes, Route } from 'react-router-dom'
import Main from './pages/Main'
import Admin from './pages/Admin'
import Settings from './pages/Settings'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Main />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/settings" element={<Settings />} />
    </Routes>
  )
}

export default App