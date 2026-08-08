import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
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
  const navigate = useNavigate()

  const load = () => scorecardGetReport().then(setReport).catch(e => setError(instructorErrorMessage(e)))

  useEffect(() => { if (session.kind === 'ready') { void load() } }, [session])

  // ⚠ A GENERIC `JSON.stringify(r)` USED TO GO STRAIGHT TO THE SCREEN, and on a real
  // class that meant dumping every participant id and name into the action bar — the
  // Score & Record response carries a `names` map keyed by participant id. Unreadable,
  // and it put internal ids on a screen that had no reason to show them.
  //
  // Each action now formats its OWN summary, matching forecast and the rest of the family.
  const onSync = async () => {
    setBusy('sync'); setNote(null); setError(null)
    try {
      const r = await scorecardSyncRoster()
      setNote(`Roster synced — ${r.synced} students.`)
      await load()
    } catch (e) { setError(instructorErrorMessage(e)) }
    finally { setBusy(null) }
  }

  const onScore = async () => {
    setBusy('score'); setNote(null); setError(null)
    try {
      const r = await scorecardScoreAndRecord()
      const push = r.push
      setNote(
        `Scored ${r.scored} students (${r.finishers} finished).`
        + (push
          ? ` Pushed ${push.succeeded}/${push.total} to the gradebook.`
            // ⚠ A FAILED PUSH IS NAMED, not folded into the success count. A partial push
            // that read as a success is how a student ends up ungraded silently.
            + (push.failed?.length ? ` ⚠ ${push.failed.length} FAILED — see the console.` : '')
          : ' No gradebook configured.'),
      )
      if (push?.failed?.length) console.error('[scorecard] gradebook push failures:', push.failed)
      await load()
    } catch (e) { setError(instructorErrorMessage(e)) }
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
      // ⚠⚠ THE CONTESTED GAP, matching Tier 1 (spec §11). It was showing the RAW
      // all-period gap under the same "Effort gap" label, so the dashboard and the reports
      // printed DIFFERENT NUMBERS for a column with the same name — and the raw one is the
      // one that manufactures a signal out of students who never thought about
      // reliability. Two surfaces, one definition.
      key: 'gap', label: 'Contested gap',
      render: r => (
        <span style={tnum}>
          {r.contested_gap === null
            ? '—'
            : `${r.contested_gap > 0 ? '+' : ''}${Math.round(r.contested_gap * 100)}%`}
        </span>
      ),
      nullsLast: true, isNull: r => r.contested_gap == null,
      compare: (a, b) => (num(a.contested_gap) - num(b.contested_gap)) || tie(a, b),
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

  // ⚠⚠ THE QUERY STRING IS CARRIED FORWARD. `?token=`/`?_gid=` is how the instructor
  // session identifies the instance across pages; a nav link that dropped it would land on
  // a page with no session and no way to recover one.
  const navLinks = [
    { label: 'Settings →', href: `/settings${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  const button = (label: string, key: string, onClick: () => void) => (
    <button
      data-testid={`sc-dash-${key}`}
      onClick={onClick}
      disabled={busy !== null}
      style={{
        padding: '0.5rem 1rem', fontSize: '0.85rem', fontWeight: 600, marginRight: '0.5rem',
        cursor: busy ? 'not-allowed' : 'pointer',
        background: colors.white, color: colors.text,
        border: `1px solid ${colors.borderMid}`, borderRadius: 6,
      }}
    >
      {busy === key ? 'Working…' : label}
    </button>
  )

  // ⚠ PASSED AS `actions` so they land in the STICKY bar with the nav rather than
  // scrolling away in the page body — matching forecast, procurement and the rest.
  const actions = (
    <>
      {button('Refresh', 'refresh', () => void load())}
      {button('Sync roster', 'sync', () => void onSync())}
      {button('Score & Record', 'score', () => void onScore())}
      <span data-testid="sc-dash-counts"
        style={{ marginLeft: '0.5rem', fontSize: '0.85rem', color: colors.textSecondary }}>
        {finished} finished · {participants.length} enrolled
        {report.scored && ' · finalized'}
      </span>
    </>
  )

  return (
    <InstructorChrome
      title="Supplier Scorecard — dashboard"
      actions={actions}
      navLinks={navLinks}
      onNavigate={navigate}
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
