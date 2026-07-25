import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { pdInstructorSession, CLASSROOM_URL } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// PD instructor settings.
//
// SLICE 0 (SCAFFOLD): shell only, so the dashboard's "Settings →" nav link resolves
// to a real page instead of a blank route. The editable settings — the four payoff
// values (config/main) and the drawn round count (truth/main) — need pdGetConfig /
// pdUpdateConfig, which Slice 1 adds along with the game's config model.
// ═══════════════════════════════════════════════════════════════════════════════

const TITLE = 'Repeated Prisoner’s Dilemma — Settings'

export default function Settings() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  if (session.kind === 'loading') return <InstructorChrome title={TITLE}><p>Loading…</p></InstructorChrome>
  if (session.kind === 'no-token') return <InstructorChrome title={TITLE}><p>Open settings from the classroom.</p></InstructorChrome>
  if (session.kind === 'error') {
    return (
      <InstructorChrome title={TITLE}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </InstructorChrome>
    )
  }

  return (
    <InstructorChrome title={TITLE} navLinks={navLinks} onNavigate={navigate}>
      <p style={{ color: colors.textSecondary }}>
        Scaffold. The payoff matrix and round-count settings are not built yet.
      </p>
    </InstructorChrome>
  )
}
