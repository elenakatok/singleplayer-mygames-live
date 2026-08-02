import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors, typography } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  forecastGetReport, forecastScoreAndRecord, forecastSyncRoster, forecastInstructorSession,
  instructorErrorMessage,
  type ForecastReportData, type ForecastReportParticipant,
} from './api'
import { formatBig, formatMetric } from './format'

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

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

const th = {
  padding: '0.4rem 0.6rem', fontSize: '0.75rem', fontWeight: 600,
  color: colors.textSecondary, borderBottom: `1px solid ${colors.borderMid}`,
  textAlign: 'right' as const, whiteSpace: 'nowrap' as const,
}
const td = {
  padding: '0.35rem 0.6rem', fontSize: '0.85rem', textAlign: 'right' as const,
  ...tnum, borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`,
}

/** Not started < in progress < finished < finalized, so a sort walks the week. */
const statusRank = (r: ForecastReportParticipant) =>
  r.finalized ? 3 : r.completed ? 2 : r.launched ? 1 : 0

const statusText = (r: ForecastReportParticipant, total: number) =>
  r.finalized ? 'Finalized'
    : r.completed ? 'Finished'
      : r.launched ? `In progress (${r.months_played} of ${total})`
        : 'Not started'

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

  const rows = [...data.participants].sort((a, b) =>
    statusRank(a) - statusRank(b) || (a.name ?? a.participant_id).localeCompare(b.name ?? b.participant_id))
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

      <div style={{ overflowX: 'auto' }}>
        <table data-testid="fc-dash-roster" style={{ borderCollapse: 'collapse', width: '100%', fontFamily: typography.fontFamily }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Name</th>
              <th style={{ ...th, textAlign: 'left' }}>Status</th>
              <th style={th}>Months</th>
              <th style={th}>MSE</th>
              <th style={th}>Std Error</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.participant_id} data-testid={`fc-dash-row-${r.participant_id}`}>
                <td style={{ ...td, textAlign: 'left' }}>{r.name ?? r.participant_id}</td>
                <td style={{ ...td, textAlign: 'left', color: r.completed ? colors.text : colors.textSecondary }}>
                  {statusText(r, data.params.rounds)}
                </td>
                <td style={td}>{r.months_played}</td>
                <td style={td}>{r.mse === null ? '—' : formatBig(r.mse)}</td>
                <td style={td}>{r.standard_error === null ? '—' : formatMetric(r.standard_error)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p style={{ marginTop: '1rem', fontSize: '0.78rem', color: colors.textSecondary, fontFamily: typography.fontFamily }}>
        MSE is shown here as an outcome, not a grade — participation is scored on finishing
        the game (spec §6). The full outcome columns, the debrief answers and the class
        charts are on the reports page.
      </p>
    </InstructorChrome>
  )
}
