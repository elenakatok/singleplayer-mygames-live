import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReportBoard, SortableTable, colors, type ReportTileConfig, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  RoundSeriesChartSVG, fitDomainIncludingZero, type ReferenceLine,
} from '../shared/RoundSeriesChartSVG'
import {
  newsvendorGetReport, newsvendorInstructorSession, CLASSROOM_URL,
  type NewsvendorReportData, type NewsvendorReportParticipant,
} from './api'
import { InstanceHeader } from './Dashboard'
import { formatAverageUnits, formatMoney, formatPercent, formatUnits } from './format'
import { ExpectedProfitChartSVG } from './ExpectedProfitChartSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor reports, through the shared ReportBoard + a modal per tile — the same
// shape poll, PD and pricing use. FIVE tiles:
//
//   Tier 1  Outcomes roster    — every student, finished or not, WITH the benchmark
//                                and the optimality gap
//   Tier 2a Prep paragraphs    — "do you plan to order the optimal amount?", before play
//   Tier 2b Debrief paragraphs — "how did you actually decide?", after play
//   Tier 3a Order by period    — class average order vs the demand that turned up,
//                                with the dashed optimal-order line
//   Tier 3b Profit by period   — what those orders earned vs the benchmark
//   Tier 3c Expected profit by order quantity — ANALYTICAL, no student data: both
//                                modes' profit curves with their optima marked
//
// ⚠ THE TWO CHARTS ARE SEPARATE TILES, and they used to be one. Split because they
// answer different questions and get projected separately: the order chart is the one
// that shows pull-to-centre against Q*, and stacking the profit chart under it meant
// scrolling past the finding to reach the money. They still average over EXACTLY the
// same students period for period — both arrays come from one newsvendorGetReport call
// built by one server-side helper — and the browser harness asserts that rather than
// trusting it.
//
// ⚠ TWO TIER-2 TILES, NOT ONE (spec §8, last line: "every free-text question needs its
// own Tier-2 report"). The prep and the debrief are different questions asked at
// opposite ends of the game, and the teaching value is in reading a student's stated
// intention against what they actually did.
//
// ⚠ THIS IS WHERE THE BENCHMARK LIVES (spec §9.2). Q*, the critical ratio, the
// benchmark profit and the signed optimality gap are all here, and nowhere a student
// can reach. This whole page is behind an instructor session.
//
// ⚠ MID-WEEK IS THE NORMAL CASE. Elena opens this while the class is still playing, so
// every tile reads correctly on partial data: the roster shows in-progress students,
// the charts' denominators thin toward the tail and say so, and the summary stats are
// null-safe rather than dividing by an empty class.
//
// The Modal and the show-names toggle are this game's OWN copies of the pattern poll
// and pricing use; lifting them into game-ui is a shared-package change (Elena's call),
// not something this slice should force.
// ═══════════════════════════════════════════════════════════════════════════════

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem', maxWidth: 900, width: '100%', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '1rem', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.2rem', lineHeight: 1.35 }}>{title}</h2>
          <button onClick={onClose} style={{ border: '1px solid #ccc', background: 'none', borderRadius: 4, padding: '0.3rem 0.7rem', cursor: 'pointer', flexShrink: 0 }}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

const tnum = { fontVariantNumeric: 'tabular-nums' as const }
const units = (v: number | null) => (v == null ? '—' : formatAverageUnits(v))
const money = (v: number | null) => (v == null ? '—' : formatMoney(v))
/**
 * The roster's three dollar columns, in ONE place so the format is a single decision.
 *
 * ⚠ FULL PRECISION, and that is a MEASURED choice rather than a preference. Dropping
 * the KC column and moving from period TOTALS to per-period averages together shortened
 * these values by roughly a digit, and the browser harness measures the rendered
 * table's scrollWidth against its box: it fits, so the exact figures are shown. The
 * harness asserts the fit, so if a future column reintroduces overflow it fails there
 * rather than being discovered on a projector.
 */
const rosterMoney = (v: number | null) => (v == null ? '—' : formatMoney(v))
const pct = (v: number | null) => (v == null ? '—' : formatPercent(v))

// ── Tier 1: the outcomes roster ────────────────────────────────────────────────

type RosterKey =
  | 'name' | 'status' | 'periods' | 'avgOrder' | 'avgDemand' | 'inStock'
  | 'avgProfit' | 'benchmark' | 'gap'

function OutcomesTable({ rows }: { rows: NewsvendorReportParticipant[] }) {
  const columns: readonly SortableColumn<NewsvendorReportParticipant, RosterKey>[] = [
    { key: 'name', label: 'Name', render: r => r.name ?? '—', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
    {
      key: 'status', label: 'Status',
      render: r => (r.completed ? 'Finished' : r.launched ? 'In progress' : 'Not started'),
      compare: (a, b) => (a.completed ? 2 : a.launched ? 1 : 0) - (b.completed ? 2 : b.launched ? 1 : 0),
    },
    { key: 'periods', label: 'Periods', render: r => <span style={tnum}>{r.rounds_played}</span>, compare: (a, b) => a.rounds_played - b.rounds_played },
    { key: 'avgOrder', label: 'Avg order', render: r => <span style={tnum}>{units(r.average_order)}</span>, nullsLast: true, isNull: r => r.average_order == null, compare: (a, b) => (a.average_order ?? 0) - (b.average_order ?? 0) },
    { key: 'avgDemand', label: 'Avg demand', render: r => <span style={tnum}>{units(r.average_demand)}</span>, nullsLast: true, isNull: r => r.average_demand == null, compare: (a, b) => (a.average_demand ?? 0) - (b.average_demand ?? 0) },
    // ⚠ IN-STOCK %, NOT "avg demand met" — a different question, and the one that is
    // comparable to the critical ratio the instructor already has on screen.
    { key: 'inStock', label: 'In-stock %', render: r => <span data-testid={`nv-instock-${r.participant_id}`} style={tnum}>{pct(r.in_stock_rate)}</span>, nullsLast: true, isNull: r => r.in_stock_rate == null, compare: (a, b) => (a.in_stock_rate ?? 0) - (b.in_stock_rate ?? 0) },
    // ⚠ ALL THREE DOLLAR COLUMNS ARE PER PERIOD, not totals. A total scales with how
    // far through the game a student is, so a mid-week roster would rank by progress;
    // and the averages sit on the same scale as the expected-profit chart, so an
    // optimal orderer's Avg profit lands on that chart's peak.
    { key: 'avgProfit', label: 'Avg profit', render: r => <span data-testid={`nv-avgprofit-${r.participant_id}`} style={tnum}>{rosterMoney(r.average_profit)}</span>, nullsLast: true, isNull: r => r.average_profit == null, compare: (a, b) => (a.average_profit ?? 0) - (b.average_profit ?? 0) },
    { key: 'benchmark', label: 'Benchmark', render: r => <span data-testid={`nv-avgbench-${r.participant_id}`} style={tnum}>{rosterMoney(r.average_benchmark_profit)}</span>, nullsLast: true, isNull: r => r.average_benchmark_profit == null, compare: (a, b) => (a.average_benchmark_profit ?? 0) - (b.average_benchmark_profit ?? 0) },
    {
      key: 'gap', label: 'Gap',
      render: r => (
        <span
          data-testid={`nv-gap-${r.participant_id}`}
          style={{ ...tnum, color: (r.average_optimality_gap ?? 0) < 0 ? colors.kcCorrectText : colors.text }}
        >
          {rosterMoney(r.average_optimality_gap)}
        </span>
      ),
      nullsLast: true, isNull: r => r.average_optimality_gap == null,
      compare: (a, b) => (a.average_optimality_gap ?? 0) - (b.average_optimality_gap ?? 0),
    },
  ]
  return (
    // ⚠ `overflowX: hidden` IS THE ASSERTION, not a style preference. The table has to
    // FIT — dropping Participation and abbreviating the three dollar columns is what
    // buys the width, and pinning the overflow here means a future column that breaks
    // the budget clips visibly instead of quietly reintroducing the scrollbar.
    <div data-testid="nv-report-outcomes" style={{ overflowX: 'hidden', maxWidth: '100%' }}>
      <SortableTable<NewsvendorReportParticipant, RosterKey>
        rows={rows} columns={columns} getRowKey={r => r.participant_id}
        initialSortKey="status" initialSortDir="desc" emptyMessage="No students yet." wrapHeaders
      />
      <p style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.5rem', lineHeight: 1.55 }}>
        “Gap” is the benchmark&rsquo;s profit minus the student&rsquo;s, over the periods they
        played. It is <strong>signed</strong>: a negative gap (green) means the student
        beat the benchmark, which happens over a short game because the benchmark is
        optimal in expectation, not period by period. “In-stock %” is the share of
        PERIODS a student was fully stocked (Q ≥ D) — read it against the critical ratio,
        which an optimal orderer would match. The three dollar columns are PER PERIOD,
        so they sit on the same scale as the expected-profit chart — an optimal
        orderer&rsquo;s average profit lands on that chart&rsquo;s peak.
        A student who has not started
        shows “—” rather than a zero. Profit and the gap are OUTCOMES, never grades —
        participation is scored on finishing, and the knowledge check is the assessed
        component.
      </p>
    </div>
  )
}

// ── Tier 2: the free-text paragraphs (one tile per question) ───────────────────

/**
 * The paragraphs, plain and copyable.
 *
 * ⚠ THE WORKFLOW IS COPY-AND-PASTE INTO AN AI SUMMARIZER (spec §8), and that is what
 * this tile is shaped around: one block of plain text, each paragraph prefixed with
 * who wrote it and headed by the prompt, so a pasted block carries its own context.
 */
function TextAnswers({
  rows, prompt, pick, testId,
}: {
  rows: NewsvendorReportParticipant[]
  prompt: string
  /** Which of the two paragraphs this tile shows. */
  pick: (r: NewsvendorReportParticipant) => string | null
  testId: string
}) {
  const [showNames, setShowNames] = useState(true)
  const written = rows.filter(r => pick(r))

  return (
    <div data-testid={testId}>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', fontSize: '0.9rem', cursor: 'pointer' }}>
        <input type="checkbox" data-testid={`${testId}-shownames`} checked={showNames} onChange={e => setShowNames(e.target.checked)} />
        Show names
      </label>

      <p data-testid={`${testId}-context`} style={{ fontSize: '0.85rem', color: colors.textSecondary, margin: '0 0 0.75rem', lineHeight: 1.55 }}>
        prompt: “{prompt}”
      </p>

      {written.length === 0 && <p style={{ color: colors.textSecondary }}>No paragraphs submitted yet.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {written.map((r, i) => (
          <div key={r.participant_id} data-testid={`${testId}-answer`} style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.6rem 0.8rem' }}>
            <div style={{ fontSize: '0.8rem', color: colors.textSecondary, marginBottom: '0.25rem' }}>
              {showNames ? (r.name ?? '—') : `Respondent ${i + 1}`}
              {' · '}{r.rounds_played} periods · avg order {units(r.average_order)}
            </div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, color: colors.text }}>{pick(r)}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tier 3: the two charts + their summary stats ───────────────────────────────

const summaryBox = {
  border: `1px solid ${colors.borderMid}`, borderRadius: 8, padding: '0.8rem 1rem',
  display: 'flex', flexDirection: 'column' as const, gap: '0.7rem', minWidth: '13rem',
}

function Stat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div>
      <div style={{ fontSize: '0.78rem', color: colors.textSecondary }}>{label}</div>
      <div data-testid={testId} style={{ fontSize: '1.15rem', fontWeight: 700, color: colors.text, ...tnum }}>{value}</div>
    </div>
  )
}

/**
 * (a) ORDER BY PERIOD — what the class ordered against the demand that turned up, with
 * the dashed optimal-order line.
 *
 * ⚠ THE Q* LINE IS INSTRUCTOR-ONLY (spec §9.2), and it is safe here for a structural
 * reason rather than a careful one: `benchmark` arrives on the newsvendorGetReport
 * response, which is behind an instructor session, and NO STUDENT MODULE IMPORTS THIS
 * FILE. Splitting the tile in two did not change that — both halves still read from the
 * one instructor payload, and neither is reachable from Play.tsx.
 */
function OrderChartReport({ data }: { data: NewsvendorReportData }) {
  const { charts, summary, benchmark, params } = data

  // The y-domain starts from the ORDER BOX's bounds, so where the class sat between the
  // floor and the ceiling is legible — the same reasoning pricing's price chart uses.
  //
  // ⚠ …but it is WIDENED to cover the data, because unlike a posted price, DEMAND is
  // not bounded by the order box. A Normal draw beyond three sigma is rare but not rare
  // enough to ignore across a class-week of draws, and a pinned domain would render that
  // point outside the plot area rather than off the top of it — a silently truncated
  // chart, which is worse than a slightly taller one.
  const orderValues = charts.orders.flatMap(p => [p.student, p.competitor])
  const orderDomain: [number, number] = [
    Math.min(params.orderMin, ...orderValues, ...(benchmark ? [benchmark.Qopt] : [])),
    Math.max(params.orderMax, ...orderValues, ...(benchmark ? [benchmark.Qopt] : [])),
  ]
  const orderRefs: ReferenceLine[] = benchmark
    ? [{ key: 'qopt', value: benchmark.Qopt, label: `Optimal order ${formatUnits(benchmark.Qopt)}` }]
    : []

  return (
    <div data-testid="nv-report-order-chart" style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 24rem', minWidth: 0 }}>
        <RoundSeriesChartSVG
          points={charts.orders}
          refLines={orderRefs}
          yDomain={orderDomain}
          formatValue={v => formatUnits(v)}
          seriesLabels={{ student: 'Class average order', competitor: 'Demand that turned up' }}
          ids={{ root: 'nv-order-chart', line: 'nv-order-line', ref: 'nv-order-ref', count: 'nv-order-n' }}
          ariaLabel="Average order quantity and realized demand by period"
          xAxisLabel="Period (n = students who had played it)"
          caption={
            <>
              What the class <strong>ordered</strong> each period against the demand that
              actually turned up. The denominator is the students who had played that
              period — shown as n= under the axis — so later periods average over fewer
              students while the class is still mid-week. A wobble at the tail is usually
              who is left, not what they did.
              {benchmark && <> The dashed line is the optimal order for this instance&rsquo;s
                parameters; students never see it.</>}
            </>
          }
        />
      </div>
      <div style={summaryBox}>
        <Stat label="Class average order" value={units(summary.averageOrder)} testId="nv-summary-avg-order" />
        <Stat label="Average demand" value={units(summary.averageDemand)} testId="nv-summary-avg-demand" />
        {benchmark && (
          <>
            <Stat label="Optimal order Q*" value={formatUnits(benchmark.Qopt)} testId="nv-summary-qopt" />
            <Stat label="Critical ratio" value={benchmark.CR.toFixed(3)} testId="nv-summary-cr" />
          </>
        )}
        {params.showServiceLevel && (
          <Stat label="Average demand met" value={pct(summary.averageServiceLevel)} testId="nv-summary-avg-sl" />
        )}
        <p style={{ fontSize: '0.75rem', color: colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
          Q* and the critical ratio are derived from this instance&rsquo;s own parameters,
          so they move when the settings do. Instructor-only.
        </p>
      </div>
    </div>
  )
}

/**
 * (b) PROFIT BY PERIOD — what those orders earned, against what the optimal order would
 * have earned on the same demand draws.
 *
 * ⚠ IT STILL AVERAGES OVER EXACTLY THE SAME STUDENTS as the order chart, period for
 * period: both series come from the same newsvendorGetReport call, whose two chart
 * arrays are built by the same byPeriod() helper server-side (functions
 * newsvendor/reportStats.ts). Splitting the tile did NOT split the denominators — that
 * is asserted in the browser harness rather than assumed.
 */
function ProfitChartReport({ data }: { data: NewsvendorReportData }) {
  const { charts, summary } = data

  const profitValues = charts.profits.flatMap(p => [p.student, p.competitor])
  const profitDomain = fitDomainIncludingZero(profitValues)

  return (
    <div data-testid="nv-report-profit-chart" style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
      <div style={{ flex: '1 1 24rem', minWidth: 0 }}>
        <RoundSeriesChartSVG
          points={charts.profits}
          refLines={[]}
          yDomain={profitDomain}
          formatValue={v => formatMoney(v)}
          seriesLabels={{ student: 'Class average profit', competitor: 'Benchmark profit' }}
          ids={{ root: 'nv-profit-chart', line: 'nv-profit-line', ref: 'nv-profit-ref', count: 'nv-profit-n' }}
          ariaLabel="Average realized profit and benchmark profit by period"
          xAxisLabel="Period (n = students who had played it)"
          caption={
            <>
              What those orders <strong>earned</strong>, against what the optimal order
              would have earned <strong>against the same demand draws</strong> — so the
              distance between the two lines is the optimality gap, not luck. It averages
              over exactly the same students as the order chart, period for period. Below
              the zero line the class was losing money.
            </>
          }
        />
      </div>
      <div style={summaryBox}>
        <Stat label="Avg profit / period" value={money(summary.averageProfit)} testId="nv-summary-avg-profit" />
        <Stat label="Benchmark / period" value={money(summary.averageBenchmarkProfit)} testId="nv-summary-avg-benchmark" />
        <Stat
          label="Average gap / period"
          value={summary.averageProfit == null || summary.averageBenchmarkProfit == null
            ? '—'
            : formatMoney(summary.averageBenchmarkProfit - summary.averageProfit)}
          testId="nv-summary-avg-gap"
        />
        <p style={{ fontSize: '0.75rem', color: colors.textSecondary, margin: 0, lineHeight: 1.5 }}>
          The benchmark is evaluated against each student&rsquo;s own demand draws, so the
          gap is a decision difference rather than a difference in luck.
        </p>
      </div>
    </div>
  )
}

// ── The page ───────────────────────────────────────────────────────────────────

const TITLE = 'Newsvendor — Reports'

export default function Reports() {
  const session = useInstructorSession(newsvendorInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<NewsvendorReportData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    newsvendorGetReport().then(setData).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load reports.'))
  }, [session.kind])

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]
  const chrome = (body: ReactNode) => (
    <InstructorChrome title={TITLE} navLinks={navLinks} onNavigate={navigate}>{body}</InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open reports from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }
  if (err) return chrome(<p style={{ color: '#c00' }}>{err}</p>)
  if (!data) return chrome(<p>Loading reports…</p>)

  const played = data.participants.filter(p => p.rounds_played > 0)
  const preps = data.participants.filter(p => p.prep)
  const debriefs = data.participants.filter(p => p.debrief)
  const finished = data.participants.filter(p => p.completed)

  const tiles: ReportTileConfig[] = [
    {
      id: 'outcomes',
      title: 'Outcomes — all students',
      preview: <span>{finished.length} finished / {data.participants.length} on roster</span>,
      onOpen: () => setActive('outcomes'),
    },
    {
      id: 'prep',
      title: 'Prep paragraphs — before play',
      disabled: preps.length === 0,
      preview: preps.length === 0
        ? <span style={{ color: '#94a3b8' }}>No paragraphs yet.</span>
        : <span>{preps.length} paragraph(s) — how they planned to decide</span>,
      onOpen: () => setActive('prep'),
    },
    {
      id: 'debrief',
      title: 'Debrief paragraphs — after play',
      disabled: debriefs.length === 0,
      preview: debriefs.length === 0
        ? <span style={{ color: '#94a3b8' }}>No paragraphs yet.</span>
        : <span>{debriefs.length} paragraph(s) — how they actually decided</span>,
      onOpen: () => setActive('debrief'),
    },
    {
      // ⚠ ALWAYS ENABLED — it is analytical, so it renders from config alone with no
      // students and no periods played. That is the point: it is usable the moment the
      // instance is configured, and identical before and after the class.
      id: 'expected',
      title: 'Expected profit by order quantity',
      preview: <span>Single source vs dual — from the parameters, no student data</span>,
      onOpen: () => setActive('expected'),
    },
    {
      id: 'orders',
      title: 'Order by period',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={{ color: '#94a3b8' }}>No periods played yet.</span>
        : <span>{data.maxPeriodsPlayed} periods — against the optimal order</span>,
      onOpen: () => setActive('orders'),
    },
    {
      id: 'profit',
      title: 'Profit by period',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={{ color: '#94a3b8' }}>No periods played yet.</span>
        : <span>{data.maxPeriodsPlayed} periods — against the benchmark</span>,
      onOpen: () => setActive('profit'),
    },
  ]

  return chrome(
    <>
      <InstanceHeader params={data.params} benchmark={data.benchmark} configError={data.configError} />
      <ReportBoard tiles={tiles} />

      {active === 'outcomes' && (
        <Modal title="Outcomes — all students" onClose={() => setActive(null)}>
          <OutcomesTable rows={data.participants} />
        </Modal>
      )}
      {active === 'prep' && (
        <Modal title="Prep paragraphs — before play" onClose={() => setActive(null)}>
          <TextAnswers rows={data.participants} prompt={data.prepPrompt} pick={r => r.prep} testId="nv-report-prep" />
        </Modal>
      )}
      {active === 'debrief' && (
        <Modal title="Debrief paragraphs — after play" onClose={() => setActive(null)}>
          <TextAnswers rows={data.participants} prompt={data.debriefPrompt} pick={r => r.debrief} testId="nv-report-debrief" />
        </Modal>
      )}
      {active === 'expected' && (
        <Modal title="Expected profit by order quantity" onClose={() => setActive(null)}>
          <ExpectedProfitChartSVG
            params={{
              P: data.params.P, c: data.params.c, v: data.params.v,
              g: data.params.g, h: data.params.h,
              // ⚠ The instructor-only c_l, NOT data.params.cL — that one is zeroed on a
              // regular instance (clientState.ts), and the dual curve needs a real cost.
              cL: data.secondSourceCost,
              isNormal: data.params.isNormal,
              mean: data.params.mean, sd: data.params.sd,
              minD: data.params.minD, maxD: data.params.maxD,
            }}
          />
        </Modal>
      )}
      {active === 'orders' && (
        <Modal title="Order by period" onClose={() => setActive(null)}>
          <OrderChartReport data={data} />
        </Modal>
      )}
      {active === 'profit' && (
        <Modal title="Profit by period" onClose={() => setActive(null)}>
          <ProfitChartReport data={data} />
        </Modal>
      )}
    </>,
  )
}
