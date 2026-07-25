import { useNavigate } from 'react-router-dom'
import { colors } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { pdInstructorSession, CLASSROOM_URL } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// PD instructor reports.
//
// SLICE 0 (SCAFFOLD): shell only, so the "Reports →" nav link resolves. The three
// tiers (Reports Contract v1) need pdGetReport and are built last: Tier 1 outcomes
// roster, Tier 2 the debrief paragraphs, Tier 3 per-round cooperation rate split by
// bot strategy. No ReportBoard yet — there is nothing to put in a tile.
// ═══════════════════════════════════════════════════════════════════════════════

const TITLE = 'Repeated Prisoner’s Dilemma — Reports'

export default function Reports() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]

  if (session.kind === 'loading') return <InstructorChrome title={TITLE}><p>Loading…</p></InstructorChrome>
  if (session.kind === 'no-token') return <InstructorChrome title={TITLE}><p>Open reports from the classroom.</p></InstructorChrome>
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
        Scaffold. Reports are not built yet.
      </p>
    </InstructorChrome>
  )
}
