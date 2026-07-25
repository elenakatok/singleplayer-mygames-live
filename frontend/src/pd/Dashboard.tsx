import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { pdInstructorSession, CLASSROOM_URL } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// PD instructor dashboard.
//
// SLICE 0 (SCAFFOLD): the InstructorChrome shell and a working instructor session,
// nothing more. No roster table, no Score & Record button, no tiles — those need
// pdSyncRoster / pdGetReport / pdScoreAndRecord, which later slices add. What this
// proves today is that an instructor can land here from the classroom, exchange the
// JWT via pdInstructorSession, and be authenticated for the pd_ collections.
// ═══════════════════════════════════════════════════════════════════════════════

const TITLE = 'Repeated Prisoner’s Dilemma — Dashboard'

export default function Dashboard() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()

  // Nav links preserve the current ?token=/?_gid= params so the next instructor page
  // can re-establish its session.
  const navLinks = [
    { label: 'Settings →', href: `/settings${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  if (session.kind === 'loading') return <InstructorChrome title={TITLE}><p>Loading…</p></InstructorChrome>
  if (session.kind === 'no-token') return <InstructorChrome title={TITLE}><p>Open the dashboard from the classroom.</p></InstructorChrome>
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
        Scaffold. The roster, Score &amp; Record, and reports are not built yet.
      </p>
    </InstructorChrome>
  )
}
