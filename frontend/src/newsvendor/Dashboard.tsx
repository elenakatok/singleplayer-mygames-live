import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  newsvendorGetReport, newsvendorScoreAndRecord, newsvendorSyncRoster, newsvendorInstructorSession,
  CLASSROOM_URL, type NewsvendorParams, type NewsvendorReportParticipant,
} from './api'
import { formatAverageUnits, formatMoney, formatUnits } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor instructor dashboard. Deliberately the SAME shape as the pennies, PD and
// pricing dashboards — shared InstructorChrome for the sticky action bar + nav, the
// shared SortableTable for the roster, Score & Record in the action bar, the instance
// banner ABOVE the table, and the explanatory footnote below it.
//
// ⚠ IT IS AN ASSIGNMENT-STATUS VIEW, not a live view. This game is played async
// across a week, so the question this page answers is "who still has not done it?" —
// which is why the status column distinguishes not started / in progress (with how
// far) / finished / finalized, and why the counts sit in the action bar where Elena
// reads them before chasing anyone.
//
// ⚠ FIVE COLUMNS, MATCHING PRICING'S DELIBERATE SHAPE. Total profit, the KC score, the
// participation score AND the optimality gap are all in the DATA and all render in the
// Tier-1 report — they are kept off this page because it is for chasing, not grading.
// The gap in particular does not belong on a page skimmed at speed: it is the thing
// worth discussing, not the thing worth ranking.
//
// PROFIT IS NOT GRADED — the average-profit column is an OUTCOME. Participation is
// scored on finishing the game.
// ═══════════════════════════════════════════════════════════════════════════════

const tnum = { fontVariantNumeric: 'tabular-nums' as const }
const units = (v: number | null) => (v == null ? '—' : formatAverageUnits(v))
const money = (v: number | null) => (v == null ? '—' : formatMoney(v))

/** Not started < in progress < finished < finalized, so the sort walks the week. */
const statusRank = (r: NewsvendorReportParticipant) =>
  r.finalized ? 3 : r.completed ? 2 : r.launched ? 1 : 0

const statusText = (r: NewsvendorReportParticipant) =>
  r.finalized ? 'Finalized'
    : r.completed ? 'Finished'
      : r.launched ? `In progress (${r.rounds_played} period${r.rounds_played === 1 ? '' : 's'})`
        : 'Not started'

type SortKey = 'name' | 'status' | 'periods' | 'avgOrder' | 'avgProfit'

const num = (v: number | null) => v ?? 0

const COLUMNS: readonly SortableColumn<NewsvendorReportParticipant, SortKey>[] = [
  {
    key: 'name', label: 'Name',
    render: r => r.name ?? '—',
    compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? ''),
  },
  {
    key: 'status', label: 'Status',
    render: statusText,
    compare: (a, b) => statusRank(a) - statusRank(b),
  },
  {
    key: 'periods', label: 'Periods played',
    render: r => <span style={tnum}>{r.rounds_played}</span>,
    compare: (a, b) => a.rounds_played - b.rounds_played,
  },
  {
    key: 'avgOrder', label: 'Avg order',
    render: r => <span style={tnum}>{units(r.average_order)}</span>,
    nullsLast: true, isNull: r => r.average_order == null,
    compare: (a, b) => num(a.average_order) - num(b.average_order),
  },
  {
    key: 'avgProfit', label: 'Avg profit / period',
    render: r => <span style={tnum}>{money(r.average_profit)}</span>,
    nullsLast: true, isNull: r => r.average_profit == null,
    compare: (a, b) => num(a.average_profit) - num(b.average_profit),
  },
]

const TITLE = 'Newsvendor — Dashboard'

export default function Dashboard() {
  const session = useInstructorSession(newsvendorInstructorSession)
  const navigate = useNavigate()
  const [rows, setRows] = useState<NewsvendorReportParticipant[] | null>(null)
  const [header, setHeader] = useState<{ params: NewsvendorParams; configError: string | null } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scoring, setScoring] = useState(false)
  const [scoreMsg, setScoreMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    newsvendorGetReport()
      .then(res => {
        setRows(res.participants)
        setHeader({ params: res.params, configError: res.configError })
      })
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load roster.'))
  }, [])

  useEffect(() => {
    if (session.kind !== 'ready') return
    // Pull the full course roster first (so never-started students appear and can be
    // graded −2), then load. `finally` so the table still loads with no classroom wired.
    newsvendorSyncRoster().catch(() => {}).finally(load)
  }, [session.kind, load])

  const handleScore = async () => {
    setScoring(true)
    setScoreMsg(null)
    try {
      const res = await newsvendorScoreAndRecord()
      // Report the PUSH, not merely "scored N". A silent {total: 0} push is a failure
      // mode this platform has actually shipped before, so it is stated on screen
      // rather than left to look like success.
      const push = res.push
      const pushed = push == null
        ? 'No classroom callback configured — nothing pushed.'
        : push.failed.length > 0
          ? `Pushed ${push.succeeded}/${push.total} to the gradebook — ${push.failed.length} FAILED.`
          : `Pushed ${push.succeeded}/${push.total} to the gradebook.`
      setScoreMsg(`Scored ${res.scored} student(s); ${res.finishers} finished. ${pushed}`)
      load()
    } catch (err) {
      setScoreMsg(err instanceof Error ? err.message : 'Score & Record failed.')
    } finally {
      setScoring(false)
    }
  }

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

  const finished = rows?.filter(r => r.completed).length ?? 0
  const started = rows?.filter(r => r.launched).length ?? 0

  const actions = (
    <>
      <button
        data-testid="nv-score-and-record"
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
      <span data-testid="nv-counts" style={{ color: colors.textSecondary }}>
        {rows ? `${finished} finished / ${started} started / ${rows.length} on roster` : ''}
      </span>
      {scoreMsg && <span data-testid="nv-score-msg" style={{ color: colors.text }}>{scoreMsg}</span>}
    </>
  )

  return (
    <InstructorChrome title={TITLE} actions={actions} navLinks={navLinks} onNavigate={navigate}>
      {header && <InstanceHeader params={header.params} configError={header.configError} />}
      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}
      {rows && (
        <div data-testid="nv-roster">
          <SortableTable<NewsvendorReportParticipant, SortKey>
            rows={rows}
            columns={COLUMNS}
            getRowKey={r => r.participant_id}
            initialSortKey="status"
            initialSortDir="asc"
            emptyMessage="No students on the roster yet — open the dashboard from the classroom to sync it."
            wrapHeaders
          />
          <p style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.6rem' }}>
            The profit column is an OUTCOME, never a grade — participation is scored on
            finishing the game, and the knowledge check is the assessed component. Total
            profit, the benchmark, the optimality gap, knowledge-check scores and
            participation scores are on the <strong>Reports</strong> page.
          </p>
        </div>
      )}
    </InstructorChrome>
  )
}

/**
 * The instance banner — which settings am I looking at? Shared by the dashboard and
 * the reports page so the two can never label the same instance differently.
 *
 * ⚠ IT STATES THE PARAMETERS, NOT THE BENCHMARK. Q* is on the Reports page beside the
 * chart it explains; a banner on every page is the wrong place for the answer.
 */
export function InstanceHeader({ params, configError }: {
  params: NewsvendorParams
  configError: string | null
}) {
  const demand = params.isNormal
    ? `Normal demand, mean ${formatUnits(params.mean)}, SD ${formatUnits(params.sd)}`
    : `Uniform demand between ${formatUnits(params.minD)} and ${formatUnits(params.maxD)}`
  return (
    <div
      data-testid="nv-instance-header"
      style={{
        border: `1px solid ${configError ? colors.warnBannerBorder : colors.infoBannerBorder}`,
        background: configError ? colors.warnBannerBg : colors.infoBannerBg,
        borderRadius: 8, padding: '0.7rem 1rem', marginBottom: '1rem', lineHeight: 1.55,
      }}
    >
      <strong data-testid="nv-instance-demand">{demand}</strong>
      <div data-testid="nv-instance-params" style={{ color: colors.text, marginTop: '0.2rem' }}>
        {params.periods} periods · price {formatMoney(params.P)} · cost {formatMoney(params.c)}
        {params.v !== 0 && <> · salvage {formatMoney(params.v)}</>}
        {params.h !== 0 && <> · holding {formatMoney(params.h)}</>}
        {params.g !== 0 && <> · shortage {formatMoney(params.g)}</>}
      </div>
      {configError && (
        <div data-testid="nv-config-error" style={{ color: colors.errorAction, marginTop: '0.35rem', fontWeight: 600 }}>
          {configError}
        </div>
      )}
    </div>
  )
}
