import { useEffect } from 'react'
import type { ComponentType } from 'react'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import PenniesPlay from './pennies/Play'
import PenniesDashboard from './pennies/Dashboard'
import PenniesSettings from './pennies/Settings'
import PenniesReports from './pennies/Reports'
import PollPlay from './poll/Play'
import PollDashboard from './poll/Dashboard'
import PollSettings from './poll/Settings'
import PollReports from './poll/Reports'
import PdPlay from './pd/Play'
import PdDashboard from './pd/Dashboard'
import PdSettings from './pd/Settings'
import PdReports from './pd/Reports'
import PricingPlay from './pricing/Play'
import PricingDashboard from './pricing/Dashboard'
import PricingSettings from './pricing/Settings'
import PricingReports from './pricing/Reports'
import NewsvendorPlay from './newsvendor/Play'
import NewsvendorDashboard from './newsvendor/Dashboard'
import NewsvendorSettings from './newsvendor/Settings'
import NewsvendorReports from './newsvendor/Reports'
import ForecastPlay from './forecast/Play'
import ForecastDashboard from './forecast/Dashboard'
import ForecastSettings from './forecast/Settings'
import ForecastReports from './forecast/Reports'

// ═══════════════════════════════════════════════════════════════════════════════
// ONE Vite app serves EVERY single-player game (architecture: one bundle, many
// hosting sites). pennies.mygames.live, poll.mygames.live, and pd.mygames.live all
// serve this same build; the app picks which game to render from the hostname.
// Shared routes (/, /dashboard, /settings, /reports) resolve to the selected game's
// components.
//
// ⚠ Because it is ONE bundle, adding a game changes the artifact that the OTHER
// games' sites serve on their next hosting deploy. Adding a game must therefore
// never change another game's routing — hence the explicit per-game map below.
//
// DEV override: ?game=poll / ?game=pd / ?game=pricing / ?game=newsvendor / ?game=forecast (nav preserves
// the query string, so it carries across pages). Production keys off the hostname alone.
// ═══════════════════════════════════════════════════════════════════════════════

type Game = 'pennies' | 'poll' | 'pd' | 'pricing' | 'newsvendor' | 'forecast'

/** Hostname prefix → game. Checked in order; the first match wins. These are
 *  PREFIXES, not exact labels, because a site's default domain carries a suffix
 *  (e.g. the poll site is `poll-mygames.web.app`, pd's is `pd-mygames-live.web.app`). */
const HOST_PREFIXES: ReadonlyArray<readonly [string, Game]> = [
  ['pennies', 'pennies'],
  ['poll', 'poll'],
  ['pd', 'pd'],
  ['pricing', 'pricing'],
  ['newsvendor', 'newsvendor'],
  ['forecast', 'forecast'],
]

function resolveGame(): Game {
  const host = window.location.hostname
  for (const [prefix, game] of HOST_PREFIXES) {
    if (host.startsWith(prefix)) return game
  }
  if (import.meta.env.DEV) {
    const q = new URLSearchParams(window.location.search).get('game')
    if (q === 'poll') return 'poll'
    if (q === 'pd') return 'pd'
    if (q === 'pricing') return 'pricing'
    if (q === 'newsvendor') return 'newsvendor'
    if (q === 'forecast') return 'forecast'
  }
  return 'pennies'
}

type GameScreens = {
  title: string
  Play: ComponentType
  Dashboard: ComponentType
  Settings: ComponentType
  Reports: ComponentType
}

const GAMES: Record<Game, GameScreens> = {
  pennies: {
    title: 'Jar of Pennies',
    Play: PenniesPlay, Dashboard: PenniesDashboard, Settings: PenniesSettings, Reports: PenniesReports,
  },
  poll: {
    title: 'Poll',
    Play: PollPlay, Dashboard: PollDashboard, Settings: PollSettings, Reports: PollReports,
  },
  pd: {
    title: 'Repeated Prisoner’s Dilemma',
    Play: PdPlay, Dashboard: PdDashboard, Settings: PdSettings, Reports: PdReports,
  },
  pricing: {
    title: 'Cheyenne Shipping',
    Play: PricingPlay, Dashboard: PricingDashboard, Settings: PricingSettings, Reports: PricingReports,
  },
  newsvendor: {
    title: 'Newsvendor',
    Play: NewsvendorPlay, Dashboard: NewsvendorDashboard, Settings: NewsvendorSettings, Reports: NewsvendorReports,
  },
  forecast: {
    title: 'The Forecasting Game',
    Play: ForecastPlay, Dashboard: ForecastDashboard, Settings: ForecastSettings, Reports: ForecastReports,
  },
}

export default function App() {
  const game = resolveGame()
  const { title, Play, Dashboard, Settings, Reports } = GAMES[game]
  useEffect(() => { document.title = title }, [title])

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/"          element={<Play />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/settings"  element={<Settings />} />
        <Route path="/reports"   element={<Reports />} />
      </Routes>
    </BrowserRouter>
  )
}
