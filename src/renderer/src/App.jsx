import { Routes, Route } from 'react-router-dom'
import Main from './pages/Main'
import Admin from './pages/Admin'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Main />} />
      <Route path="/admin" element={<Admin />} />
    </Routes>
  )
}

export default App