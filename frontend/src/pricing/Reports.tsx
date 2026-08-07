import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReportBoard, SortableTable, colors, type ReportTileConfig, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pricingGetReport, pricingInstructorSession, CLASSROOM_URL,
  type PricingReportData, type PricingReportParticipant,
} from './api'
import { PriceChartSVG } from './PriceChartSVG'
import { ProfitChartSVG } from './ProfitChartSVG'
import { ModeHeader } from './Dashboard'
import { formatPrice, formatProfitM } from './format'
import { compareByLastName } from '../shared/sortName'

// ═══════════════════════════════════════════════════════════════════════════════
// Pricing reports (spec §10), through the shared ReportBoard + a modal per tile —
// the same shape poll and PD use. Three tiles, one per tier:
//
//   Tier 1  Outcomes roster           — every student, finished or not
//   Tier 2  Debrief paragraphs        — exportable, for the AI-summary pass
//   Tier 3  Average posted price by round — THE slide-19 chart — and its sibling,
//           average profit by round, on the same tile. The pair is the lesson: what
//           the class charged, and what that earned them.
//
// INSTRUCTOR-ONLY, all of it. Every tile is labelled with the instance's mode and its
// competitor rule (spec §10) because two instances of this game run in the same course
// in the same week and differ only in a config flag — an unlabelled chart pasted into
// a lecture deck would be genuinely ambiguous a fortnight later.
//
// ⚠ MID-WEEK IS THE NORMAL CASE. Elena opens this while the class is still playing, so
// every tile has to read correctly on partial data: the roster shows in-progress
// students, the chart's denominators thin toward the tail and say so, and the summary
// stats are null-safe rather than dividing by an empty class.
//
// The Modal and the show-names toggle are this game's OWN copies of poll's pattern,
// not imports: both are private to poll/Reports.tsx, and lifting them into game-ui is
// a shared-package change (Elena's call), not something this slice should force.
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
const price = (v: number | null) => (v == null ? '—' : formatPrice(v))
const profit = (v: number | null) => (v == null ? '—' : formatProfitM(v))

// ── Tier 1: the outcomes roster ────────────────────────────────────────────────

type RosterKey = 'name' | 'status' | 'rounds' | 'avgPrice' | 'avgProfit' | 'total' | 'kc' | 'participation'


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

function OutcomesTable({ rows }: { rows: PricingReportParticipant[] }) {
  const columns: readonly SortableColumn<PricingReportParticipant, RosterKey>[] = [
    { key: 'name', label: 'Name', render: r => r.name ?? '—', compare: (a, b) => compareByLastName(a.name ?? '', b.name ?? '') },
    {
      key: 'status', label: 'Status',
      render: r => (r.completed ? 'Finished' : r.launched ? 'In progress' : 'Not started'),
      compare: (a, b) => (a.completed ? 2 : a.launched ? 1 : 0) - (b.completed ? 2 : b.launched ? 1 : 0) || tie(a, b),
    },
    { key: 'rounds', label: 'Rounds', render: r => <span style={tnum}>{r.rounds_played}</span>, compare: (a, b) => a.rounds_played - b.rounds_played || tie(a, b) },
    { key: 'avgPrice', label: 'Avg posted price', render: r => <span style={tnum}>{price(r.average_price)}</span>, nullsLast: true, isNull: r => r.average_price == null, compare: (a, b) => (a.average_price ?? 0) - (b.average_price ?? 0) || tie(a, b) },
    { key: 'avgProfit', label: 'Avg profit / round', render: r => <span style={tnum}>{profit(r.average_profit)}</span>, nullsLast: true, isNull: r => r.average_profit == null, compare: (a, b) => (a.average_profit ?? 0) - (b.average_profit ?? 0) || tie(a, b) },
    { key: 'total', label: 'Total profit', render: r => <span style={tnum}>{r.rounds_played === 0 ? '—' : formatProfitM(r.total_profit)}</span>, nullsLast: true, isNull: r => r.rounds_played === 0, compare: (a, b) => a.total_profit - b.total_profit || tie(a, b) },
    { key: 'kc', label: 'KC', render: r => <span style={tnum}>{r.knowledge_check_score == null ? '—' : `${Math.round(r.knowledge_check_score * 100)}%`}</span>, nullsLast: true, isNull: r => r.knowledge_check_score == null, compare: (a, b) => (a.knowledge_check_score ?? 0) - (b.knowledge_check_score ?? 0) || tie(a, b) },
    { key: 'participation', label: 'Participation', render: r => <span style={tnum}>{r.participation_score == null ? '—' : r.participation_score}</span>, nullsLast: true, isNull: r => r.participation_score == null, compare: (a, b) => (a.participation_score ?? 0) - (b.participation_score ?? 0) || tie(a, b) },
  ]
  return (
    <div data-testid="pricing-report-outcomes">
      <SortableTable<PricingReportParticipant, RosterKey>
        rows={rows} columns={columns} getRowKey={r => r.participant_id}
        initialSortKey="status" initialSortDir="desc" emptyMessage="No students yet." wrapHeaders
      />
      <p style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.5rem' }}>
        A student who has not started shows “—” rather than a zero: they have no average
        price, not an average price of nothing. The profit columns are outcomes, never
        grades (spec §7).
      </p>
    </div>
  )
}

// ── Tier 2: the debrief paragraphs ─────────────────────────────────────────────

/**
 * The paragraphs, plain and copyable.
 *
 * ⚠ THE WORKFLOW IS COPY-AND-PASTE INTO AN AI SUMMARIZER (spec §9), and that is what
 * this tile is shaped around: one block of plain text, each paragraph prefixed with
 * who wrote it and headed by the mode and the competitor rule, so a pasted block
 * carries its own context. Nothing here is a download or an export format — Elena
 * selects it and pastes it, exactly as PD's tile works.
 */
function DebriefAnswers({
  rows, prompt, pmg, rule,
}: { rows: PricingReportParticipant[]; prompt: string; pmg: boolean; rule: string }) {
  const [showNames, setShowNames] = useState(true)
  const written = rows.filter(r => r.debrief)

  return (
    <div data-testid="pricing-report-debrief">
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', fontSize: '0.9rem', cursor: 'pointer' }}>
        <input type="checkbox" data-testid="pricing-debrief-shownames" checked={showNames} onChange={e => setShowNames(e.target.checked)} />
        Show names
      </label>

      <p data-testid="pricing-debrief-context" style={{ fontSize: '0.85rem', color: colors.textSecondary, margin: '0 0 0.75rem', lineHeight: 1.55 }}>
        {pmg ? 'PMG instance' : 'Standard instance'} · their competitor was programmed to {rule} ·
        prompt: “{prompt}”
      </p>

      {written.length === 0 && <p style={{ color: colors.textSecondary }}>No paragraphs submitted yet.</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
        {written.map((r, i) => (
          <div key={r.participant_id} data-testid="pricing-debrief-answer" style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.6rem 0.8rem' }}>
            <div style={{ fontSize: '0.8rem', color: colors.textSecondary, marginBottom: '0.25rem' }}>
              {showNames ? (r.name ?? '—') : `Respondent ${i + 1}`}
              {' · '}{r.rounds_played} rounds · avg {price(r.average_price)} · {profit(r.average_profit)}/round
            </div>
            <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, color: colors.text }}>{r.debrief}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Tier 3: the chart + its summary stats ──────────────────────────────────────

const stat = (label: string, value: string, testId: string) => (
  <div style={{ minWidth: '9rem' }}>
    <div style={{ fontSize: '0.78rem', color: colors.textSecondary }}>{label}</div>
    <div data-testid={testId} style={{ fontSize: '1.15rem', fontWeight: 700, color: colors.text, ...tnum }}>{value}</div>
  </div>
)

const summaryBox: React.CSSProperties = {
  flex: '0 1 13rem', border: `1px solid ${colors.borderMid}`, borderRadius: 8,
  padding: '0.9rem 1rem', display: 'flex', flexDirection: 'column', gap: '0.85rem',
}
const chartRow: React.CSSProperties = {
  display: 'flex', flexWrap: 'wrap', gap: '1.5rem', alignItems: 'flex-start',
}

/**
 * The Tier-3 tile: the price chart, then its profit sibling underneath, each with its
 * own summary box.
 *
 * ⚠ THE TWO ARE ONE ARGUMENT, which is why they share a tile rather than sitting in
 * two. "The class priced down toward equilibrium" and "the class earned less doing
 * it" are the same finding stated twice, and splitting them across tiles would let a
 * reader see either half alone.
 */
function PriceReport({ data }: { data: PricingReportData }) {
  const s = data.summary

  return (
    <div data-testid="pricing-report-prices">
      {/* ── Average posted price by round ─────────────────────────────────── */}
      <div style={chartRow}>
        <div style={{ flex: '1 1 20rem', minWidth: '18rem' }}>
          <PriceChartSVG
            points={data.charts.prices}
            equilibrium={data.summary.equilibrium}
            market={data.market}
            labels={data.labels}
          />
        </div>

        {/* The summary-stat box beside the chart — spec §10 mirrors slide 19's table. */}
        <div data-testid="pricing-summary-box" style={summaryBox}>
          {stat('Average posted price', price(s.averagePostedPrice), 'pricing-summary-avg-price')}
          {data.pmg && stat('Average price paid', price(s.averageEffectivePrice), 'pricing-summary-avg-effective')}
          {stat(
            data.pmg ? 'PMG equilibrium' : `${data.labels.student} equilibrium`,
            formatPrice(s.equilibrium.student),
            'pricing-summary-equilibrium',
          )}
          {!data.pmg && stat(
            `${data.labels.competitor} equilibrium`,
            formatPrice(s.equilibrium.competitor),
            'pricing-summary-equilibrium-competitor',
          )}
          <p style={{ fontSize: '0.72rem', color: colors.textSecondary, margin: 0, lineHeight: 1.45 }}>
            {s.equilibrium.label} — derived from this instance’s market, so it moves if the
            market is edited.
          </p>
        </div>
      </div>

      {/* ── …and what those prices EARNED ─────────────────────────────────── */}
      <h3 style={{ margin: '1.75rem 0 0.5rem', fontSize: '1rem', color: colors.text }}>
        Average profit by round
      </h3>
      <div style={chartRow}>
        <div style={{ flex: '1 1 20rem', minWidth: '18rem' }}>
          <ProfitChartSVG
            points={data.charts.profits}
            equilibrium={data.summary.profitEquilibrium}
            labels={data.labels}
          />
        </div>

        <div data-testid="pricing-profit-summary-box" style={summaryBox}>
          {stat(`${data.labels.student} avg profit / round`, profit(s.averageProfit), 'pricing-summary-avg-profit')}
          {stat(`${data.labels.competitor} avg profit / round`, profit(s.averageCompetitorProfit), 'pricing-summary-avg-competitor-profit')}
          {stat(`${data.labels.student} at equilibrium`, formatProfitM(s.profitEquilibrium.student), 'pricing-summary-eq-profit')}
          {stat(`${data.labels.competitor} at equilibrium`, formatProfitM(s.profitEquilibrium.competitor), 'pricing-summary-eq-profit-competitor')}
          <p style={{ fontSize: '0.72rem', color: colors.textSecondary, margin: 0, lineHeight: 1.45 }}>
            {s.profitEquilibrium.label} — computed through the same market model that
            scored every round, so it moves if the market is edited.
          </p>
        </div>
      </div>
    </div>
  )
}

const TITLE = 'Cheyenne Shipping — Reports'

export default function Reports() {
  const session = useInstructorSession(pricingInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<PricingReportData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    pricingGetReport().then(setData).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load reports.'))
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
  const debriefs = data.participants.filter(p => p.debrief)
  const finished = data.participants.filter(p => p.completed)
  const modeName = data.pmg ? 'PMG' : 'Standard'

  const tiles: ReportTileConfig[] = [
    {
      id: 'outcomes',
      title: 'Outcomes — all students',
      preview: <span>{finished.length} finished / {data.participants.length} on roster</span>,
      onOpen: () => setActive('outcomes'),
    },
    {
      id: 'debrief',
      title: 'Debrief paragraphs',
      disabled: debriefs.length === 0,
      preview: debriefs.length === 0
        ? <span style={{ color: '#94a3b8' }}>No paragraphs yet.</span>
        : <span>{debriefs.length} paragraph(s) — {modeName} instance</span>,
      onOpen: () => setActive('debrief'),
    },
    {
      id: 'prices',
      title: 'Average price and profit by round',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={{ color: '#94a3b8' }}>No rounds played yet.</span>
        : <span>{data.maxRoundsPlayed} rounds — {modeName}, against the equilibrium</span>,
      onOpen: () => setActive('prices'),
    },
  ]

  return chrome(
    <>
      <ModeHeader pmg={data.pmg} rule={data.competitorRule.description} />
      <ReportBoard tiles={tiles} />

      {active === 'outcomes' && (
        <Modal title={`Outcomes — all students (${modeName})`} onClose={() => setActive(null)}>
          <OutcomesTable rows={data.participants} />
        </Modal>
      )}
      {active === 'debrief' && (
        <Modal title={`Debrief paragraphs (${modeName})`} onClose={() => setActive(null)}>
          <DebriefAnswers
            rows={data.participants}
            prompt={data.debriefPrompt}
            pmg={data.pmg}
            rule={data.competitorRule.description}
          />
        </Modal>
      )}
      {active === 'prices' && (
        <Modal title={`Average price and profit by round (${modeName})`} onClose={() => setActive(null)}>
          <PriceReport data={data} />
        </Modal>
      )}
    </>,
  )
}
