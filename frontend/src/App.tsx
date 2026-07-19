import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Play from './pennies/Play'
import Dashboard from './pennies/Dashboard'
import Settings from './pennies/Settings'
import Reports from './pennies/Reports'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — routes. Student entry at '/'; instructor pages (game-local, all
// calling penniesX callables) at /dashboard, /settings, /reports.
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Play />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/reports" element={<Reports />} />
      </Routes>
    </BrowserRouter>
  )
}
