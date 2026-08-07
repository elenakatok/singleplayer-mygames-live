import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, typography, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  forecastGetReport, forecastScoreAndRecord, forecastSyncRoster, forecastInstructorSession,
  instructorErrorMessage,
  type ForecastReportData, type ForecastReportParticipant,
} from './api'
import { formatBig, formatMetric } from './format'
import { compareByLastName } from '../shared/sortName'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — instructor dashboard. The same shape as the pennies, PD, pricing and
// newsvendor dashboards: shared InstructorChrome, a roster, Score & Record, and the
// counts in the action bar.
//
// ⚠ IT IS AN ASSIGNMENT-STATUS VIEW, not a live view. This game is played async across
// a week (syllabus slot: due 10/11), so the question this page answers is "who still
// has not done it?" — which is why the status column distinguishes not started / in
// progress (with how far) / finished / finalized.
//
// ⚠ FEW COLUMNS, DELIBERATELY. MSE, MAE, MAPE, the bonus, the bias, the Y6-vs-Y7 split
// and the KC score are all in the DATA and all render on the Tier-1 report. They are
// kept off this page because it is for CHASING, not grading — and because MSE in
// particular is the thing worth discussing in the debrief, not the thing worth skimming
// down a column and ranking. Accuracy is never graded (spec §6).
// ═══════════════════════════════════════════════════════════════════════════════

// ⚠ The local `th`/`td` styles went with the plain table — `SortableTable` owns cell
// presentation now, which is the point of sharing it.

/** Not started < in progress < finished < finalized, so a sort walks the week. */
const statusRank = (r: ForecastReportParticipant) =>
  r.finalized ? 3 : r.completed ? 2 : r.launched ? 1 : 0

const statusText = (r: ForecastReportParticipant, total: number) =>
  r.finalized ? 'Finalized'
    : r.completed ? 'Finished'
      : r.launched ? `In progress (${r.months_played} of ${total})`
        : 'Not started'

/**
 * ⚠ THE LAST-NAME TIEBREAK EVERY COLUMN FALLS BACK TO (Elena, 08-07). Without it the
 * twenty students who are all "Not started" land in whatever order the server sent, and
 * the roster reshuffles under the instructor between refreshes — which reads as the table
 * jumping around during a live class.
 *
 * ⚠ The `?? participant_id` fallback is this game's own and is UNCHANGED; only the
 * ordering rule is shared. See procurement BUILD_NOTES §6m.
 */
const tie = (a: ForecastReportParticipant, b: ForecastReportParticipant) =>
  compareByLastName(a.name ?? a.participant_id, b.name ?? b.participant_id)

/**
 * ⚠⚠ THIS DASHBOARD WAS THE LAST ROSTER IN THE FAMILY WITHOUT COLUMN SORTING (Elena,
 * 08-07). Every other single-player dashboard and report has used the shared
 * `SortableTable` for some time; forecast's report did too, but its dashboard rendered a
 * plain `<table>`. Recorded in procurement BUILD_NOTES §6k as a known gap and fixed here,
 * so all seven games now behave the same way.
 *
 * ⚠ COLUMNS MATCH WHAT THE PLAIN TABLE SHOWED — name, status, months, MSE, std error. The
 * fuller outcome set stays on the reports page; this is a sorting change, not a
 * presentation change.
 */
type SortKey = 'name' | 'status' | 'months' | 'mse' | 'se'

export const buildColumns = (
  totalRounds: number,
): readonly SortableColumn<ForecastReportParticipant, SortKey>[] => [
  {
    key: 'name',
    label: 'Name',
    render: r => r.name ?? r.participant_id,
    headerStyle: { textAlign: 'left' },
    // ⚠ BY LAST NAME, the platform's own parsing rule (`shared/sortName.ts`).
    compare: tie,
  },
  {
    key: 'status',
    label: 'Status',
    render: r => statusText(r, totalRounds),
    headerStyle: { textAlign: 'left' },
    // ⚠ RANKED, NOT ALPHABETICAL — alphabetically "Finished" precedes "Not started",
    // ordering the class by nothing anybody cares about.
    compare: (a, b) => statusRank(a) - statusRank(b) || tie(a, b),
  },
  {
    key: 'months',
    label: 'Months',
    render: r => r.months_played,
    compare: (a, b) => a.months_played - b.months_played || tie(a, b),
  },
  {
    key: 'mse',
    label: 'MSE',
    render: r => r.mse === null ? '—' : formatBig(r.mse),
    // ⚠ NUMERIC, on the underlying number — the cell is a formatted string and comparing
    // those would sort 10 before 9.
    compare: (a, b) => (a.mse ?? 0) - (b.mse ?? 0) || tie(a, b),
    // ⚠ A STUDENT WITH NO MSE HAS NOT PLAYED — they are not the best forecaster in the
    // class. Sorting them among the low scores would read as a perfect result.
    nullsLast: true,
    isNull: r => r.mse === null,
    tiebreak: tie,
  },
  {
    key: 'se',
    label: 'Std Error',
    render: r => r.standard_error === null ? '—' : formatMetric(r.standard_error),
    compare: (a, b) => (a.standard_error ?? 0) - (b.standard_error ?? 0) || tie(a, b),
    nullsLast: true,
    isNull: r => r.standard_error === null,
    tiebreak: tie,
  },
]

export default function Dashboard() {
  const session = useInstructorSession(forecastInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ForecastReportData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await forecastGetReport()); setError(null) } catch (err) {
      setError(instructorErrorMessage(err))
    }
  }, [])

  useEffect(() => { if (session.kind === 'ready') void load() }, [session, load])

  const onSync = async () => {
    setBusy('sync'); setNote(null)
    try {
      const r = await forecastSyncRoster()
      setNote(`Roster synced — ${r.synced} students.`)
      await load()
    } catch (err) {
      setNote(instructorErrorMessage(err))
    } finally { setBusy(null) }
  }

  const onScore = async () => {
    setBusy('score'); setNote(null)
    try {
      const r = await forecastScoreAndRecord()
      setNote(
        `Scored ${r.scored} students (${r.finishers} finished).`
        + (r.push ? ` Pushed ${r.push.succeeded}/${r.push.total} to the gradebook.` : ' No gradebook configured.'),
      )
      await load()
    } catch (err) {
      setNote(instructorErrorMessage(err))
    } finally { setBusy(null) }
  }

  if (session.kind !== 'ready' || (!data && !error)) {
    return <InstructorChrome title="Forecasting Game — dashboard"><p>Loading…</p></InstructorChrome>
  }
  if (error || !data) {
    return (
      <InstructorChrome title="Forecasting Game — dashboard">
        <p style={{ color: '#c00' }}>{error}</p>
      </InstructorChrome>
    )
  }

  // ⚠ NO LONGER PRE-SORTED HERE — `SortableTable` owns the order now (status first, then
  // last name via each column's tiebreak). Sorting twice would just mean the pre-sort is
  // silently discarded on first render.
  const rows = data.participants
  const finished = rows.filter(r => r.completed).length
  const started = rows.filter(r => r.launched).length

  // ⚠ THE QUERY STRING IS CARRIED FORWARD. `?token=`/`?_gid=` is how the instructor
  // session identifies the instance across pages; a nav link that dropped it would land
  // on a page with no session and no way to recover one.
  const navLinks = [
    { label: 'Settings →', href: `/settings${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  const button = (label: string, key: string, onClick: () => void) => (
    <button
      data-testid={`fc-dash-${key}`}
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

  // The action bar's contents. ⚠ PASSED AS `actions` so they land in the STICKY bar
  // with the nav, rather than scrolling away in the page body.
  const actions = (
    <>
      {button('Refresh', 'refresh', () => void load())}
      {button('Sync roster', 'sync', () => void onSync())}
      {button('Score & Record', 'score', () => void onScore())}
      <span data-testid="fc-dash-counts" style={{ marginLeft: '0.5rem', fontSize: '0.85rem', color: colors.textSecondary }}>
        {finished} finished · {started} started · {rows.length} enrolled
        {data.scored && ' · finalized'}
      </span>
    </>
  )

  return (
    <InstructorChrome
      title="Forecasting Game — dashboard"
      actions={actions}
      navLinks={navLinks}
      onNavigate={navigate}
    >
      {note && (
        <p data-testid="fc-dash-note" style={{ fontSize: '0.85rem', color: colors.textSecondary, marginBottom: '1rem' }}>
          {note}
        </p>
      )}

      {/* ⚠ THE SHARED WIDGET (Elena, 08-07), replacing the plain table this dashboard had
          rendered since it shipped. `initialSortKey="status"` keeps the view the plain
          table always opened on — status order, so a live session still opens on "who has
          not started" — and every header is now clickable. */}
      <SortableTable<ForecastReportParticipant, SortKey>
        rows={rows}
        columns={buildColumns(data.params.rounds)}
        getRowKey={r => r.participant_id}
        initialSortKey="status"
        tableTestId="fc-dash-roster"
        emptyMessage="No students yet — use Sync roster to pull the course list."
      />

      <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: colors.textSecondary, fontFamily: typography.fontFamily }}>
        MSE is shown here as an outcome, not a grade — participation is scored on finishing
        the game (spec §6). The full outcome columns, the debrief answers and the class
        charts are on the reports page.
      </p>
    </InstructorChrome>
  )
}
