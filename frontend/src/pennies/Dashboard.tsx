import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { penniesGetReport, penniesScoreAndRecord, penniesSyncRoster, penniesInstructorSession, CLASSROOM_URL, type ReportParticipant } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// Instructor dashboard (spec §8.1). Roster: Name | Status | Outcome = THE BID.
// NO Group column (there are no groups). raw_score stays participation and is not
// shown here — it is load-bearing for grades.
//
// The bid column sorts NUMERICALLY on the underlying number (SortableColumn.compare
// runs on the number, never the "$1,200" string) — a native SortableTable column,
// not a DOM-patched override, so the twice-shipped string-sort bug cannot occur.
// The page chrome (sticky action bar + nav) is the shared, presentational
// InstructorChrome — the shared multiplayer InstructorDashboard is wrong-shaped for
// this family (RTDB presence, matching, attendance), so we assemble our own from the
// same theme tokens instead.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n: number | null) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

const statusRank = (r: ReportParticipant) => (r.submitted ? 2 : r.launched ? 1 : 0)

type SortKey = 'name' | 'status' | 'bid'

const columns: readonly SortableColumn<ReportParticipant, SortKey>[] = [
  {
    key: 'name',
    label: 'Name',
    render: r => r.name ?? '—',
    compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
  },
  {
    key: 'status',
    label: 'Status',
    render: r => (r.submitted ? 'Submitted' : r.launched ? 'Launched — no bid' : 'Not launched'),
    // Rank so the sort orders Not launched < Launched-no-bid < Submitted.
    compare: (a, b) => statusRank(a) - statusRank(b),
  },
  {
    key: 'bid',
    label: 'Outcome (bid)',
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.bid)}</span>,
    nullsLast: true,
    isNull: r => r.bid == null,
    compare: (a, b) => (a.bid ?? 0) - (b.bid ?? 0),
  },
]

const TITLE = 'Jar of Pennies — Dashboard'

export default function Dashboard() {
  const session = useInstructorSession(penniesInstructorSession)
  const navigate = useNavigate()
  const [rows, setRows] = useState<ReportParticipant[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scoring, setScoring] = useState(false)
  const [scoreMsg, setScoreMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    penniesGetReport()
      .then(res => setRows(res.participants))
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load roster.'))
  }, [])

  useEffect(() => {
    if (session.kind !== 'ready') return
    // Pull the full course roster first (so never-launched students appear + can be
    // graded), then load. `finally` so the table still loads if no classroom is wired.
    penniesSyncRoster().catch(() => {}).finally(load)
  }, [session.kind, load])

  const handleScore = async () => {
    setScoring(true)
    setScoreMsg(null)
    try {
      const res = await penniesScoreAndRecord()
      const winnerName = res.winner ? (res.names[res.winner] ?? res.winner) : null
      setScoreMsg(
        winnerName
          ? `Scored ${res.scored} student(s). Winner: ${winnerName}.`
          : `Scored ${res.scored} student(s). No submissions to determine a winner.`,
      )
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

  const submittedCount = rows?.filter(r => r.submitted).length ?? 0
  const launchedCount = rows?.filter(r => r.launched).length ?? 0

  const actions = (
    <>
      <button
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
        {rows ? `${submittedCount} submitted / ${launchedCount} launched / ${rows.length} on roster` : ''}
      </span>
      {scoreMsg && <span data-testid="pennies-score-msg" style={{ color: colors.text }}>{scoreMsg}</span>}
    </>
  )

  return (
    <InstructorChrome title={TITLE} actions={actions} navLinks={navLinks} onNavigate={navigate}>
      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}
      {rows && (
        <SortableTable<ReportParticipant, SortKey>
          rows={rows}
          columns={columns}
          getRowKey={r => r.participant_id}
          initialSortKey="bid"
          initialSortDir="desc"
          emptyMessage="No students on the roster yet — open the dashboard from the classroom to sync it."
        />
      )}
    </InstructorChrome>
  )
}
