import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pricingGetReport, pricingScoreAndRecord, pricingSyncRoster, pricingInstructorSession,
  CLASSROOM_URL, type PricingReportParticipant,
} from './api'
import { formatPrice, formatProfitM } from './format'
import { compareByLastName } from '../shared/sortName'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing instructor dashboard (spec §10 Tier 1). Deliberately the SAME shape as the
// pennies and PD dashboards — shared InstructorChrome for the sticky action bar +
// nav, the shared SortableTable for the roster, Score & Record in the action bar.
//
// ⚠ IT IS AN ASSIGNMENT-STATUS VIEW, not a live view. This game is played async
// across a week, so the question this page answers is "who still has not done it?" —
// which is why the status column distinguishes not started / in progress (with how
// far) / finished / finalized, and why the counts sit in the action bar where Elena
// reads them before chasing anyone.
//
// ⚠ THE HEADER STATES THE MODE AND THE COMPETITOR RULE. Two instances of this game
// run in the same course in the same week, and they differ ONLY in a config flag —
// so a dashboard that did not say which one you were looking at would be genuinely
// ambiguous. The rule is instructor-only and correct to show here (spec §10).
//
// PROFIT IS NOT GRADED (spec §7) — the average-profit column is an OUTCOME, and the
// participation score is deliberately NOT on this page at all, so the two can never
// read as one number. Grading lives on the Reports page; this page is for chasing.
// ═══════════════════════════════════════════════════════════════════════════════

const tnum = { fontVariantNumeric: 'tabular-nums' as const }
const price = (v: number | null) => (v == null ? '—' : formatPrice(v))
const profit = (v: number | null) => (v == null ? '—' : formatProfitM(v))

/** Not started < in progress < finished < finalized, so the sort walks the week. */
const statusRank = (r: PricingReportParticipant) =>
  r.finalized ? 3 : r.completed ? 2 : r.launched ? 1 : 0

const statusText = (r: PricingReportParticipant) =>
  r.finalized ? 'Finalized'
    : r.completed ? 'Finished'
      : r.launched ? `In progress (${r.rounds_played} round${r.rounds_played === 1 ? '' : 's'})`
        : 'Not started'

// ⚠ FIVE COLUMNS, DELIBERATELY. Total profit, the KC score and the participation
// score were here and were REMOVED: this page answers one mid-week question — who
// still has not done it — and three more numeric columns pushed the status and the
// progress off the readable width without helping answer it. Nothing was deleted from
// the DATA: all three are still in pricingGetReport and still render in the Tier-1
// report, which is where an instructor goes to grade rather than to chase.
type SortKey = 'name' | 'status' | 'rounds' | 'avgPrice' | 'avgProfit'


/**
 * ⚠ THE LAST-NAME TIEBREAK EVERY COLUMN FALLS BACK TO (Elena, 08-07). Without it students
 * who tie on a column — every "Not started" row, every 0-profit row — land in whatever
 * order the server sent, and the roster reshuffles between refreshes, which reads as the
 * table jumping around during a live class.
 *
 * ⚠ This game's own `?? ''` fallback is UNCHANGED; only the ORDERING rule is shared.
 * See procurement BUILD_NOTES §6m.
 */
const tie = (a: PricingReportParticipant, b: PricingReportParticipant) => compareByLastName(a.name ?? '', b.name ?? '')

const num = (v: number | null) => v ?? 0

const COLUMNS: readonly SortableColumn<PricingReportParticipant, SortKey>[] = [
  {
    key: 'name', label: 'Name',
    render: r => r.name ?? '—',
    compare: (a, b) => compareByLastName(a.name ?? '', b.name ?? ''),
  },
  {
    key: 'status', label: 'Status',
    render: statusText,
    compare: (a, b) => statusRank(a) - statusRank(b) || tie(a, b),
  },
  {
    key: 'rounds', label: 'Rounds played',
    render: r => <span style={tnum}>{r.rounds_played}</span>,
    compare: (a, b) => a.rounds_played - b.rounds_played || tie(a, b),
  },
  {
    key: 'avgPrice', label: 'Avg posted price',
    render: r => <span style={tnum}>{price(r.average_price)}</span>,
    nullsLast: true, isNull: r => r.average_price == null,
    compare: (a, b) => num(a.average_price) - num(b.average_price) || tie(a, b),
  },
  {
    key: 'avgProfit', label: 'Avg profit / round',
    render: r => <span style={tnum}>{profit(r.average_profit)}</span>,
    nullsLast: true, isNull: r => r.average_profit == null,
    compare: (a, b) => num(a.average_profit) - num(b.average_profit) || tie(a, b),
  },
]

const TITLE = 'Cheyenne Shipping — Dashboard'

export default function Dashboard() {
  const session = useInstructorSession(pricingInstructorSession)
  const navigate = useNavigate()
  const [rows, setRows] = useState<PricingReportParticipant[] | null>(null)
  const [header, setHeader] = useState<{ pmg: boolean; rule: string } | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [scoring, setScoring] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [scoreMsg, setScoreMsg] = useState<string | null>(null)

  const load = useCallback(() => {
    pricingGetReport()
      .then(res => {
        setRows(res.participants)
        setHeader({ pmg: res.pmg, rule: res.competitorRule.description })
      })
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load roster.'))
  }, [])

  useEffect(() => {
    if (session.kind !== 'ready') return
    // Pull the full course roster first (so never-started students appear and can be
    // graded −2), then load. `finally` so the table still loads with no classroom wired.
    pricingSyncRoster().catch(() => {}).finally(load)
  }, [session.kind, load])

  /**
   * Manual refresh — the mount load, on demand.
   *
   * These dashboards are one-shot fetches: they show what was true when the page opened
   * and do not follow the class. Rather than a live listener (tried on newsvendor and
   * rolled back — it needed a security-rule change and did not update reliably), the
   * button simply re-runs what opening the page runs. Poll has shipped exactly this
   * since its first slice; this is that same handler, and no new permission is involved.
   *
   * `syncRoster` stays best-effort, as on mount: with no classroom wired it fails, and
   * the table must still refresh regardless.
   */
  const handleRefresh = async () => {
    setRefreshing(true)
    try { await pricingSyncRoster().catch(() => {}); load() } finally { setRefreshing(false) }
  }

  const handleScore = async () => {
    setScoring(true)
    setScoreMsg(null)
    try {
      const res = await pricingScoreAndRecord()
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
        data-testid="pricing-score-and-record"
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
      <button
        data-testid="pricing-refresh"
        onClick={() => void handleRefresh()}
        disabled={refreshing}
        style={{
          padding: '0.6rem 1.1rem', fontSize: '0.95rem', fontWeight: 600,
          cursor: refreshing ? 'not-allowed' : 'pointer',
          backgroundColor: colors.white, color: colors.text,
          border: `1px solid ${colors.borderMid}`, borderRadius: 6,
        }}
      >
        {refreshing ? 'Refreshing…' : '↻ Refresh'}
      </button>
      <span data-testid="pricing-counts" style={{ color: colors.textSecondary }}>
        {rows ? `${finished} finished / ${started} started / ${rows.length} on roster` : ''}
      </span>
      {scoreMsg && <span data-testid="pricing-score-msg" style={{ color: colors.text }}>{scoreMsg}</span>}
    </>
  )

  return (
    <InstructorChrome title={TITLE} actions={actions} navLinks={navLinks} onNavigate={navigate}>
      {header && <ModeHeader pmg={header.pmg} rule={header.rule} />}
      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}
      {rows && (
        <div data-testid="pricing-roster">
          <SortableTable<PricingReportParticipant, SortKey>
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
            finishing the game (spec §7). Total profit, knowledge-check scores and
            participation scores are on the <strong>Reports</strong> page.
          </p>
        </div>
      )}
    </InstructorChrome>
  )
}

/** The mode + competitor-rule banner (spec §10). Shared by the dashboard and the
 *  reports page so the two can never label the same instance differently. */
export function ModeHeader({ pmg, rule }: { pmg: boolean; rule: string }) {
  return (
    <div
      data-testid="pricing-mode-header"
      style={{
        border: `1px solid ${pmg ? colors.warnBannerBorder : colors.infoBannerBorder}`,
        background: pmg ? colors.warnBannerBg : colors.infoBannerBg,
        borderRadius: 8, padding: '0.7rem 1rem', marginBottom: '1rem', lineHeight: 1.55,
      }}
    >
      <strong data-testid="pricing-mode-name">
        {pmg ? 'PMG instance — price-matching guarantee in force' : 'Standard instance'}
      </strong>
      <div data-testid="pricing-rule-text" style={{ color: colors.text, marginTop: '0.2rem' }}>
        Their competitor was programmed to {rule}.
      </div>
    </div>
  )
}
