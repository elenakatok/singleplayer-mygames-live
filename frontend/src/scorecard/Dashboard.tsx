import { useEffect, useState } from 'react'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { useInstructorSession } from '../shared/useInstructorSession'
import { InstructorChrome } from '../shared/InstructorChrome'
import { compareByLastName } from '../shared/sortName'
import {
  scorecardGetReport, scorecardInstructorSession, scorecardScoreAndRecord, scorecardSyncRoster,
  instructorErrorMessage,
  type ScorecardReport, type ScorecardReportParticipant,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// The instructor's live roster (architecture §6). One read of `scorecardGetReport` —
// the same callable the reports use, so the dashboard and Tier 1 can never disagree
// about who has played.
//
// ⚠ R1/R4 — `SortableTable` with the surname tiebreak INSIDE `compare` on every column,
// for the same reason as Reports.tsx: without it the roster reshuffles between refreshes.
// ═══════════════════════════════════════════════════════════════════════════════

const tnum: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const nameOf = (p: ScorecardReportParticipant) => p.name ?? ''
const tie = (a: ScorecardReportParticipant, b: ScorecardReportParticipant) =>
  compareByLastName(nameOf(a), nameOf(b))
const num = (v: number | null) => (v === null ? 0 : v)
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)

type Key = 'name' | 'status' | 'contracts' | 'gap' | 'earnings' | 'kc'

export default function Dashboard() {
  const session = useInstructorSession(scorecardInstructorSession)
  const [report, setReport] = useState<ScorecardReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = () => scorecardGetReport().then(setReport).catch(e => setError(instructorErrorMessage(e)))

  useEffect(() => { if (session.kind === 'ready') { void load() } }, [session])

  async function run(label: string, fn: () => Promise<unknown>) {
    setBusy(label); setNote(null); setError(null)
    try { const r = await fn() as Record<string, unknown>; setNote(`${label}: ${JSON.stringify(r)}`); await load() }
    catch (e) { setError(instructorErrorMessage(e)) }
    finally { setBusy(null) }
  }

  if (session.kind === 'loading') return <InstructorChrome title="Dashboard"><p>Loading…</p></InstructorChrome>
  if (session.kind === 'error') {
    return <InstructorChrome title="Dashboard"><p style={{ color: '#c00' }}>{session.message}</p></InstructorChrome>
  }
  if (!report) {
    return <InstructorChrome title="Dashboard">{error ? <p style={{ color: '#c00' }}>{error}</p> : <p>Loading…</p>}</InstructorChrome>
  }

  const { participants, treatment, params, botCount } = report
  const finished = participants.filter(p => p.completed).length

  const columns: readonly SortableColumn<ScorecardReportParticipant, Key>[] = [
    {
      key: 'name', label: 'Student',
      render: r => (r.name ?? <em style={{ color: colors.textSecondary }}>(no name on the roster)</em>),
      compare: (a, b) => compareByLastName(nameOf(a), nameOf(b)),
    },
    {
      key: 'status', label: 'Status',
      render: r => (r.completed ? 'Finished' : r.launched ? 'In progress' : 'Not started'),
      compare: (a, b) =>
        ((a.completed ? 2 : a.launched ? 1 : 0) - (b.completed ? 2 : b.launched ? 1 : 0)) || tie(a, b),
    },
    {
      key: 'contracts', label: `of ${params.contracts}`,
      render: r => <span style={tnum}>{r.contracts_completed}</span>,
      compare: (a, b) => (a.contracts_completed - b.contracts_completed) || tie(a, b),
    },
    {
      key: 'gap', label: 'Effort gap',
      render: r => <span style={tnum}>{r.effort_gap === null ? '—' : `${r.effort_gap > 0 ? '+' : ''}${Math.round(r.effort_gap * 100)}%`}</span>,
      nullsLast: true, isNull: r => r.effort_gap == null,
      compare: (a, b) => (num(a.effort_gap) - num(b.effort_gap)) || tie(a, b),
    },
    {
      key: 'earnings', label: `Total ${params.currency}`,
      render: r => <span style={tnum}>{Math.round(r.total_earnings)}</span>,
      compare: (a, b) => (a.total_earnings - b.total_earnings) || tie(a, b),
    },
    {
      key: 'kc', label: 'KC',
      render: r => <span style={tnum}>{pct(r.knowledge_check_score)}</span>,
      nullsLast: true, isNull: r => r.knowledge_check_score == null,
      compare: (a, b) => (num(a.knowledge_check_score) - num(b.knowledge_check_score)) || tie(a, b),
    },
  ]

  return (
    <InstructorChrome
      title="Supplier Scorecard — Dashboard"
      actions={
        <>
          <button disabled={busy !== null} onClick={() => run('Sync roster', scorecardSyncRoster)}>
            Sync roster
          </button>
          <button disabled={busy !== null} onClick={() => run('Score & Record', scorecardScoreAndRecord)}
            style={{ marginLeft: '0.5rem' }}>
            Score &amp; Record
          </button>
        </>
      }
    >
      <p style={{ fontSize: '0.87rem', color: colors.textSecondary }}>
        {participants.length} on the roster · {finished} finished ·{' '}
        {treatment.labelHigh} vs {treatment.labelLow}, {treatment.reliabilitySchedule}
        {botCount > 0 && <> · ⚠ {botCount} simulated students in this instance (not listed below)</>}
        {report.scored && <> · scored</>}
      </p>
      {note && <p style={{ fontSize: '0.8rem', color: colors.textSecondary }}>{note}</p>}
      {error && <p style={{ color: '#c00' }}>{error}</p>}
      <SortableTable
        rows={participants}
        columns={columns}
        getRowKey={r => r.participant_id}
        initialSortKey="name"
        initialSortDir="asc"
        tableTestId="sc-dashboard"
        emptyMessage="Nobody on the roster yet."
      />
    </InstructorChrome>
  )
}
