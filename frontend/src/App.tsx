import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Play from './pennies/Play'

// ═══════════════════════════════════════════════════════════════════════════════
// Jar of Pennies — routes. Part 1 ships only the student entry ('/'). The instructor
// dashboard, settings, and reports routes are family machinery added in Part 2.
// ═══════════════════════════════════════════════════════════════════════════════

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Play />} />
      </Routes>
    </BrowserRouter>
  )
}
