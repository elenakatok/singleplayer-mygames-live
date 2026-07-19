import { useEffect } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import PenniesPlay from './pennies/Play'
import PenniesDashboard from './pennies/Dashboard'
import PenniesSettings from './pennies/Settings'
import PenniesReports from './pennies/Reports'
import PollPlay from './poll/Play'
import PollDashboard from './poll/Dashboard'
import PollSettings from './poll/Settings'
import PollReports from './poll/Reports'

// ═══════════════════════════════════════════════════════════════════════════════
// ONE Vite app serves EVERY single-player game (architecture: one bundle, many
// hosting sites). Both pennies.mygames.live and poll.mygames.live serve this same
// build; the app picks which game to render from the hostname. Shared routes
// (/, /dashboard, /settings, /reports) resolve to the selected game's components.
//
// DEV override: ?game=poll (nav preserves the query string, so it carries across
// pages). Production keys off the hostname alone.
// ═══════════════════════════════════════════════════════════════════════════════

type Game = 'pennies' | 'poll'

function resolveGame(): Game {
  const host = window.location.hostname
  if (host.startsWith('poll')) return 'poll'
  if (import.meta.env.DEV && new URLSearchParams(window.location.search).get('game') === 'poll') return 'poll'
  return 'pennies'
}

const TITLES: Record<Game, string> = { pennies: 'Jar of Pennies', poll: 'Poll' }

export default function App() {
  const game = resolveGame()
  useEffect(() => { document.title = TITLES[game] }, [game])

  const poll = game === 'poll'
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={poll ? <PollPlay />      : <PenniesPlay />} />
        <Route path="/dashboard" element={poll ? <PollDashboard /> : <PenniesDashboard />} />
        <Route path="/settings"  element={poll ? <PollSettings />  : <PenniesSettings />} />
        <Route path="/reports"   element={poll ? <PollReports />   : <PenniesReports />} />
      </Routes>
    </BrowserRouter>
  )
}
