import { useCallback, useEffect, useState } from 'react'
import {
  GameHeader, SortableTable, typography, colors, type SortableColumn,
} from '@mygames/game-ui'
import { useInstructorSession } from '../shared/useInstructorSession'
import { penniesGetReport, penniesScoreAndRecord, CLASSROOM_URL, type ReportParticipant } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// Instructor dashboard (spec §8.1). Roster: Name | Status | Outcome = THE BID.
// NO Group column (there are no groups). raw_score stays participation and is not
// shown here — it is load-bearing for grades.
//
// The bid column sorts NUMERICALLY on the underlying number (SortableColumn.compare
// runs on the number, never the "$1,200" string). Because this is a game-local
// dashboard (the shared InstructorDashboard hardcodes generic callable names that
// can't coexist in a shared project), the bid is a native numeric column, not a
// DOM-patched override — the twice-shipped string-sort bug cannot occur here.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n: number | null) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
    render: r => (r.submitted ? 'Completed' : 'Not submitted'),
    compare: (a, b) => Number(a.submitted) - Number(b.submitted),
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

export default function Dashboard() {
  const session = useInstructorSession()
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
    if (session.kind === 'ready') load()
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

  const shell = (body: React.ReactNode) => (
    <div style={{ fontFamily: typography.fontFamily }}>
      <GameHeader />
      <main style={{ padding: '1.5rem 1.25rem', maxWidth: 960, margin: '0 auto' }}>{body}</main>
    </div>
  )

  if (session.kind === 'loading') return shell(<p>Loading…</p>)
  if (session.kind === 'no-token') return shell(<p>Open the dashboard from the classroom.</p>)
  if (session.kind === 'error') {
    return shell(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }

  const submittedCount = rows?.filter(r => r.submitted).length ?? 0

  return shell(
    <>
      <h1 style={{ marginTop: 0, color: colors.text }}>Jar of Pennies — Dashboard</h1>

      <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap', marginBottom: '1rem' }}>
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
          {rows ? `${submittedCount} submitted / ${rows.length} launched` : ''}
        </span>
        {scoreMsg && <span data-testid="pennies-score-msg" style={{ color: colors.text }}>{scoreMsg}</span>}
      </div>

      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}
      {rows && (
        <SortableTable<ReportParticipant, SortKey>
          rows={rows}
          columns={columns}
          getRowKey={r => r.participant_id}
          initialSortKey="bid"
          initialSortDir="desc"
          emptyMessage="No students have launched yet."
        />
      )}
    </>,
  )
}
