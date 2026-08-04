import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors, typography } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
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

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

const th = {
  padding: '0.4rem 0.6rem', fontSize: '0.75rem', fontWeight: 600,
  color: colors.textSecondary, borderBottom: `1px solid ${colors.borderMid}`,
  textAlign: 'right' as const, whiteSpace: 'nowrap' as const,
}
const td = {
  padding: '0.35rem 0.6rem', fontSize: '0.85rem', textAlign: 'right' as const,
  ...tnum, borderBottom: '1px solid #eee',
}

/** Not started < in progress < finished < finalized, so a sort walks the assignment. */
const statusRank = (r: ProcurementReportRow) =>
  r.normalizedScore !== null ? 3 : r.finished ? 2 : r.roundsPlayed > 0 ? 1 : 0

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

  const rows = [...(data?.rows ?? [])].sort((a, b) =>
    statusRank(a) - statusRank(b) || (a.name ?? '').localeCompare(b.name ?? ''))

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

      <div style={{ overflowX: 'auto' }}>
        <table data-testid="proc-dash-roster-table" style={{ borderCollapse: 'collapse', width: '100%', fontFamily: typography.fontFamily }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Name</th>
              <th style={{ ...th, textAlign: 'left' }}>Status</th>
              <th style={th}>Rounds</th>
              <th style={th}>Won</th>
              <th style={th}>Profit</th>
              <th style={th}>KC</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.participantId}>
                <td style={{ ...td, textAlign: 'left' }}>{r.name ?? r.participantId}</td>
                <td style={{ ...td, textAlign: 'left' }}>{statusText(r, data?.rounds ?? 0)}</td>
                <td style={td}>{r.roundsPlayed}</td>
                <td style={td}>{r.roundsWon}</td>
                <td style={td}>{r.profitTotal}</td>
                <td style={td}>
                  {r.knowledgeCheckScore === null
                    ? '—'
                    : `${Math.round(r.knowledgeCheckScore * 100)}%`}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'left' }} colSpan={6}>
                No students yet — use <em>Sync roster</em> to pull the course list.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </InstructorChrome>
  )
}
