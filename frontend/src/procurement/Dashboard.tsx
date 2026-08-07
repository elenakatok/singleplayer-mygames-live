import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { rowsByLastName } from './sortName'
import {
  procurementGetReport, procurementScoreAndRecord, procurementSyncRoster,
  procurementInstructorSession, instructorErrorMessage,
  FORMAT_LABEL, type ProcurementReport, type ProcurementReportRow,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — instructor dashboard. The same shape as the pennies, PD,
// pricing, newsvendor and forecast dashboards: shared InstructorChrome, a roster,
// Score & Record, and the counts in the action bar.
//
// ⚠ IT IS AN ASSIGNMENT-STATUS VIEW, not a live view. This game is played async (Part 1:
// live 11/01 for an 11/8 deadline), so the question this page answers is "who still has
// not done it?" — hence the status column distinguishing not started / in progress (with
// how far) / finished / finalized.
//
// ⚠ THE FORMAT IS IN THE HEADER, NOT A COLUMN. Two instances of this game run side by
// side with different mechanisms, and their numbers are not comparable. Naming the
// format once, at the top, is what stops someone reading a sealed roster as an open one.
//
// ⚠ PROFIT IS SHOWN BUT NEVER GRADED (Part 1 §11). It is here because an instructor
// chasing an assignment wants to see that the numbers look sane, not because it is an
// outcome measure — the markup decision is judged in the debrief and the Tier-3 scatter.
// ═══════════════════════════════════════════════════════════════════════════════


/** Not started < in progress < finished < finalized, so a sort walks the assignment. */
const statusRank = (r: ProcurementReportRow) =>
  r.normalizedScore !== null ? 3 : r.finished ? 2 : r.roundsPlayed > 0 ? 1 : 0

/**
 * ⚠⚠ THE ROSTER USES THE SHARED `SortableTable`, as pennies/poll/pd/pricing/newsvendor
 * already do. Procurement shipped a plain `<table>` and therefore never had column
 * sorting — see BUILD_NOTES §6k: this is an ADOPTION, not a restoration, and the audit
 * that established that is in the same note.
 *
 * ⚠ THE COLUMN SET IS FORMAT-NEUTRAL. Every column here is a roster fact that both
 * mechanisms produce — name, status, rounds, won, profit, KC — so the sorting is not
 * wired to a sealed-only or open-only column. If a format-specific column is ever added,
 * it goes in the array conditionally and its comparator travels with it.
 */
type SortKey = 'name' | 'status' | 'rounds' | 'won' | 'profit' | 'kc'

export const buildColumns = (
  totalRounds: number,
): readonly SortableColumn<ProcurementReportRow, SortKey>[] => [
  {
    key: 'name',
    label: 'Name',
    render: r => r.name ?? r.participantId,
    // ⚠⚠ BY LAST NAME, using the platform's own parsing rule (`sortName.ts`) — the same
    // one `game-ui`'s multiplayer roster has always used. Sorting the display string
    // sorts by FIRST name, which is not how anybody reads a class list.
    compare: rowsByLastName,
  },
  {
    key: 'status',
    label: 'Status',
    render: r => statusText(r, totalRounds),
    // ⚠ RANKED, NOT ALPHABETICAL. Alphabetically "Finished" sorts before "Not started",
    // which puts the class in an order that means nothing. `statusRank` walks the
    // assignment: not started → in progress → finished → finalized.
    // ⚠ EVERY COLUMN TIEBREAKS ON LAST NAME, exactly as the shared roster does. Without
    // it the 20 students who are all "Not started" fall in whatever order the server
    // sent, and the table reshuffles under the instructor on each refresh.
    compare: (a, b) => statusRank(a) - statusRank(b) || rowsByLastName(a, b),
  },
  { key: 'rounds', label: 'Rounds', render: r => r.roundsPlayed, compare: (a, b) => a.roundsPlayed - b.roundsPlayed || rowsByLastName(a, b) },
  { key: 'won', label: 'Won', render: r => r.roundsWon, compare: (a, b) => a.roundsWon - b.roundsWon || rowsByLastName(a, b) },
  // ⚠ NUMERIC, on the underlying number. The rendered cell is a string; comparing those
  // would sort 10 before 9 — the string-sort bug pennies' header records twice shipping.
  { key: 'profit', label: 'Profit', render: r => r.profitTotal, compare: (a, b) => a.profitTotal - b.profitTotal || rowsByLastName(a, b) },
  {
    key: 'kc',
    label: 'KC',
    render: r => r.knowledgeCheckScore === null ? '—' : `${Math.round(r.knowledgeCheckScore * 100)}%`,
    compare: (a, b) => (a.knowledgeCheckScore ?? 0) - (b.knowledgeCheckScore ?? 0) || rowsByLastName(a, b),
    // ⚠ A STUDENT WHO HAS NOT TAKEN THE KC IS NOT A ZERO — they are absent. Sorting them
    // among the zeroes would read as "scored nothing" rather than "has not sat it".
    nullsLast: true,
    isNull: r => r.knowledgeCheckScore === null,
    // ⚠ Reached only when BOTH rows are null (SortableTable:88), so the has-not-sat-it
    // block is itself ordered by last name rather than by arrival.
    tiebreak: rowsByLastName,
  },
]

const statusText = (r: ProcurementReportRow, total: number) =>
  r.normalizedScore !== null ? 'Finalized'
    : r.finished ? 'Finished'
      : r.roundsPlayed > 0 ? `In progress (${r.roundsPlayed} of ${total})`
        : 'Not started'

export default function Dashboard() {
  const session = useInstructorSession(procurementInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ProcurementReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await procurementGetReport()); setError(null) } catch (err) {
      setError(instructorErrorMessage(err))
    }
  }, [])

  useEffect(() => { if (session.kind === 'ready') void load() }, [session.kind, load])

  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key); setNote(null)
    try { setNote(await fn()); await load() } catch (err) {
      setNote(instructorErrorMessage(err))
    } finally { setBusy(null) }
  }

  // ⚠ THE QUERY STRING IS CARRIED FORWARD. `?token=`/`?_gid=` is how the instructor
  // session identifies the instance across pages; a nav link that dropped it would land
  // on a page with no session and no way to recover one — the "Missing token" bug
  // observed in production on forecast, 08-02.
  const navLinks = [
    { label: 'Settings →', href: `/settings${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  if (session.kind === 'loading') return <InstructorChrome title="Procurement Auction — dashboard"><p>Loading…</p></InstructorChrome>
  if (session.kind === 'no-token') {
    return (
      <InstructorChrome title="Procurement Auction — dashboard">
        <p>Open this page from the classroom so the link carries your instructor session.</p>
      </InstructorChrome>
    )
  }
  if (session.kind === 'error') {
    return (
      <InstructorChrome title="Procurement Auction — dashboard">
        <p>{session.message}</p>
      </InstructorChrome>
    )
  }

  // ⚠ NO PRE-SORT. `SortableTable` owns the order now — sorting here as well would mean
  // the initial view came from one rule and every click from another.
  const rows = data?.rows ?? []

  const actions = (
    <>
      {/* ⚠ REFRESH FIRST, as in forecast and newsvendor. The dashboard is watched during
          a live session while students finish; without it the only way to see progress
          is a full page reload, which drops the instructor session's place. */}
      <button
        data-testid="proc-dash-refresh"
        disabled={busy !== null}
        // ⚠ `run` already calls `load()` after the action, so refresh only has to be a
        // no-op with a message — re-loading here would fetch the report twice.
        onClick={() => run('refresh', async () => 'Refreshed.')}
      >{busy === 'refresh' ? 'Refreshing…' : 'Refresh'}</button>
      <button
        data-testid="proc-dash-roster"
        disabled={busy !== null}
        onClick={() => run('roster', async () => {
          const r = await procurementSyncRoster()
          return `Roster synced — ${r.synced} student(s).`
        })}
      >{busy === 'roster' ? 'Syncing…' : 'Sync roster'}</button>
      <button
        data-testid="proc-dash-score"
        disabled={busy !== null}
        onClick={() => run('score', async () => {
          const r = await procurementScoreAndRecord()
          return `Scored ${r.scored} student(s), ${r.finishers} finished.`
        })}
      >{busy === 'score' ? 'Recording…' : 'Score & record'}</button>
      <span style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
        {rows.length} student(s)
      </span>
    </>
  )

  return (
    <InstructorChrome
      title="Procurement Auction — dashboard"
      actions={actions}
      navLinks={navLinks}
      onNavigate={navigate}
    >
      {error && <p style={{ color: '#b00' }}>{error}</p>}
      {note && (
        <p data-testid="proc-dash-note" style={{ fontSize: '0.85rem', color: colors.textSecondary, marginBottom: '1rem' }}>
          {note}
        </p>
      )}

      {data && (
        <p style={{ fontSize: '0.85rem', color: colors.textSecondary, marginBottom: '1rem' }}>
          <strong>{FORMAT_LABEL[data.format]}</strong> · {data.rounds} rounds ·
          {' '}reserve {data.reserve} {data.currencyLabel}
        </p>
      )}

      <SortableTable<ProcurementReportRow, SortKey>
        rows={rows}
        columns={buildColumns(data?.rounds ?? 0)}
        getRowKey={r => r.participantId}
        // ⚠ THE DEFAULT VIEW IS THE ONE THE PLAIN TABLE ALWAYS SHOWED — status order,
        // so a live session still opens on "who has not started". Clicking changes it;
        // arriving does not.
        initialSortKey="status"
        tableTestId="proc-dash-roster-table"
        emptyMessage="No students yet — use Sync roster to pull the course list."
      />

    </InstructorChrome>
  )
}
