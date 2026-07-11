import { Routes, Route } from 'react-router-dom'
import { MotionConfig } from 'motion/react'
import Main from './pages/Main'
import Admin from './pages/Admin'
import Settings from './pages/Settings'
import Popout from './pages/Popout'

function App() {
  return (
    // reducedMotion="user" makes every Motion animation respect the OS
    // prefers-reduced-motion setting on top of the in-app toggles.
    <MotionConfig reducedMotion="user">
      <Routes>
        <Route path="/" element={<Main />} />
        <Route path="/admin" element={<Admin />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/popout" element={<Popout />} />
      </Routes>
    </MotionConfig>
  )
}

export default App
