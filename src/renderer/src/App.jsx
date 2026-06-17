import { Routes, Route } from 'react-router-dom'
import Main from './pages/Main'
import Admin from './pages/Admin'
import Settings from './pages/Settings'
import Popout from './pages/Popout'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Main />} />
      <Route path="/admin" element={<Admin />} />
      <Route path="/settings" element={<Settings />} />
      <Route path="/popout" element={<Popout />} />
    </Routes>
  )
}

export default App