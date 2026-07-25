import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pdGetReport, pdScoreAndRecord, pdSyncRoster, pdInstructorSession, CLASSROOM_URL,
  type PdReportParticipant,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// PD instructor dashboard (spec §9 Tier 1). Deliberately the SAME shape as the
// pennies dashboard — shared InstructorChrome for the sticky action bar + nav, the
// shared SortableTable for the roster, Score & Record in the action bar. PD is a
// single-player game like its two siblings and should read like one; only the
// COLUMNS are PD-specific. (The shared multiplayer InstructorDashboard is
// wrong-shaped for this family — RTDB presence, matching, attendance — which is why
// all three assemble their own page from the same theme tokens.)
//
// ⚠ THIS PAGE SHOWS THE STRATEGY, and that is correct: it is instructor-only, behind
// an instructor session, served by pdGetReport alone. No student screen can obtain it
// (see api.ts). The no-leak rule governs student play, not the instructor's roster.
//
// THE PAYOFF TOTAL IS NOT GRADED (spec §6) — the "Avg <unit> / round" column is an
// OUTCOME sitting BESIDE, never inside, the participation score. Both are on screen
// precisely so the instructor can see the two are independent. The column is labelled
// with the instance's configured unit, and states no direction.
// ═══════════════════════════════════════════════════════════════════════════════

const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const oneDp = (v: number | null) => (v == null ? '—' : v.toFixed(1))
const STRATEGY_LABEL: Record<string, string> = { tft: 'Tit-for-tat', grim: 'GRIM' }

const statusRank = (r: PdReportParticipant) => (r.completed ? 2 : r.launched ? 1 : 0)
const statusText = (r: PdReportParticipant) =>
  r.completed ? 'Completed' : r.launched ? `In progress (${r.rounds_played})` : 'Not launched'

type SortKey = 'name' | 'status' | 'rounds' | 'coop' | 'avgYears' | 'strategy' | 'kc' | 'participation'

const num = (v: number | null) => v ?? 0
const tnum = { fontVariantNumeric: 'tabular-nums' as const }

const buildColumns = (unit: string): readonly SortableColumn<PdReportParticipant, SortKey>[] => [
  {
    key: 'name', label: 'Name',
    render: r => r.name ?? '—',
    compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
  },
  {
    key: 'status', label: 'Status',
    render: statusText,
    // Rank so the sort orders Not launched < In progress < Completed.
    compare: (a, b) => statusRank(a) - statusRank(b),
  },
  {
    key: 'rounds', label: 'Rounds played',
    render: r => <span style={tnum}>{r.rounds_played}</span>,
    compare: (a, b) => a.rounds_played - b.rounds_played,
  },
  {
    key: 'coop', label: 'Cooperation rate',
    render: r => <span style={tnum}>{pct(r.cooperation_rate)}</span>,
    nullsLast: true,
    isNull: r => r.cooperation_rate == null,
    compare: (a, b) => num(a.cooperation_rate) - num(b.cooperation_rate),
  },
  {
    key: 'avgYears', label: `Avg ${unit} / round`,
    render: r => <span style={tnum}>{oneDp(r.avg_years)}</span>,
    nullsLast: true,
    isNull: r => r.avg_years == null,
    compare: (a, b) => num(a.avg_years) - num(b.avg_years),
  },
  {
    key: 'strategy', label: 'Opponent faced',
    render: r => (r.strategy ? STRATEGY_LABEL[r.strategy] : '—'),
    nullsLast: true,
    isNull: r => r.strategy == null,
    compare: (a, b) => (a.strategy ?? '').localeCompare(b.strategy ?? ''),
  },
  {
    key: 'kc', label: 'KC score',
    render: r => (
      <span style={tnum}>
        {r.knowledge_check_score == null ? '—' : `${Math.round(r.knowledge_check_score * 100)}%`}
      </span>
    ),
    nullsLast: true,
    isNull: r => r.knowledge_check_score == null,
    compare: (a, b) => num(a.knowledge_check_score) - num(b.knowledge_check_score),
  },
  {
    key: 'participation', label: 'Participation',
    render: r => <span style={tnum}>{r.participation_score == null ? '—' : r.participation_score}</span>,
    nullsLast: true,
    isNull: r => r.participation_score == null,
    compare: (a, b) => num(a.participation_score) - num(b.participation_score),
  },
]

const TITLE = 'Repeated Prisoner’s Dilemma — Dashboard'

export default function Dashboard() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()
  const [rows, setRows] = useState<PdReportParticipant[] | null>(null)
  const [unit, setUnit] = useState('years')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scoring, setScoring] = useState(false)
  const [scoreMsg, setScoreMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    pdGetReport()
      .then(res => { setRows(res.participants); setUnit(res.unit) })
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load roster.'))
  }, [])

  useEffect(() => {
    if (session.kind !== 'ready') return
    // Pull the full course roster first (so never-launched students appear and can be
    // graded −2), then load. `finally` so the table still loads with no classroom wired.
    pdSyncRoster().catch(() => {}).finally(load)
  }, [session.kind, load])

  const handleScore = async () => {
    setScoring(true)
    setScoreMsg(null)
    try {
      const res = await pdScoreAndRecord()
      // Report the PUSH, not merely "scored N". A silent {total: 0} push is a failure
      // mode this platform has actually shipped before, so it is stated on screen
      // rather than left to look like success.
      const push = res.push
      const pushed = push == null
        ? 'No classroom callback configured — nothing pushed.'
        : push.failed.length > 0
          ? `Pushed ${push.succeeded}/${push.total} to the gradebook — ${push.failed.length} FAILED.`
          : `Pushed ${push.succeeded}/${push.total} to the gradebook.`
      setScoreMsg(`Scored ${res.scored} student(s); ${res.finishers} completed. ${pushed}`)
      load()
    } catch (err) {
      setScoreMsg(err instanceof Error ? err.message : 'Score & Record failed.')
    } finally {
      setScoring(false)
    }
  }

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

  const completed = rows?.filter(r => r.completed).length ?? 0
  const launched = rows?.filter(r => r.launched).length ?? 0

  const actions = (
    <>
      <button
        data-testid="pd-score-and-record"
        onClick={() => void handleScore()}
        disabled={scoring}
        style={{
          padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600,
          cursor: scoring ? 'not-allowed' : 'pointer',
          backgroundColor: scoring ? '#999' : colors.text, color: colors.white,
          border: 'none', borderRadius: 6,
        }}
      >
        {scoring ? 'Scoring…' : 'Score & Record'}
      </button>
      <span style={{ color: colors.textSecondary }}>
        {rows ? `${completed} completed / ${launched} launched / ${rows.length} on roster` : ''}
      </span>
      {scoreMsg && <span data-testid="pd-score-msg" style={{ color: colors.text }}>{scoreMsg}</span>}
    </>
  )

  return (
    <InstructorChrome title={TITLE} actions={actions} navLinks={navLinks} onNavigate={navigate}>
      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}
      {rows && (
        <div data-testid="pd-roster">
          <SortableTable<PdReportParticipant, SortKey>
            rows={rows}
            columns={buildColumns(unit)}
            getRowKey={r => r.participant_id}
            initialSortKey="status"
            initialSortDir="desc"
            emptyMessage="No students on the roster yet — open the dashboard from the classroom to sync it."
            wrapHeaders
          />
          <p style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.6rem' }}>
            The {unit} column is an OUTCOME, never a grade — participation is scored on
            finishing the game (spec §6).
          </p>
        </div>
      )}
    </InstructorChrome>
  )
}
