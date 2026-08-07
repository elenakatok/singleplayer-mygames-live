import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ReportBoard, SortableTable, colors, type ReportTileConfig, type SortableColumn,
} from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  forecastGetReport, forecastInstructorSession, instructorErrorMessage,
  type ForecastReportData, type ForecastReportParticipant,
} from './api'
import { ClassChartSVG, MseHistogramSVG } from './ClassChartSVG'
import { DemandChartSVG } from './DemandChartSVG'
import { formatBig, formatMetric, formatMoney, formatPercent, formatSigned } from './format'
import { compareByLastName } from '../shared/sortName'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting reports, through the shared ReportBoard + a modal per tile — the same
// shape poll, PD, pricing and newsvendor use. FIVE tiles:
//
//   Tier 1  Outcomes — all students        every student, finished or not
//   Tier 2  Debrief paragraphs             how they actually forecast, in their words
//   Tier 3a Forecast vs actual vs the true process, by month
//   Tier 3b Class result against the benchmark rules   ← THIS IS THE DEBRIEF SLIDE
//   Tier 3c Spread of student MSE          the histogram, with the benchmarks marked
//
// ⚠ ONE TIER-2 TILE, NOT TWO. Newsvendor has a prep paragraph AND a debrief; spec §9
// gives this game exactly ONE free-text question, asked after the final screen. The
// contract is "one report per free-text question", so one is correct here.
//
// ⚠ THE THREE TIER-3 TILES ARE SEPARATE, and they used to be one long scrolling page.
// Split because they answer different questions and get projected separately: the chart
// shows whether the class tracked the season, the comparison box is the slide that names
// what good looked like, and the histogram locates the tail. Stacked, you scrolled past
// the finding to reach the point.
//
// ⚠ THIS IS WHERE THE MODEL LIVES (spec §10). The true systematic component is the
// chart's dashed reference and the banner's headline, auto-derived from the instance
// rather than hand-entered. It is instructor-only: this whole page is behind an
// instructor session, and the one STUDENT path that carries the model is gated behind a
// finished debrief (functions forecast/reveal.ts).
//
// ⚠ MID-WEEK IS THE NORMAL CASE. Elena opens this while the class is still playing, so
// every tile reads correctly on partial data: the roster shows in-progress students, the
// chart's denominators thin toward the tail and say so, and the summary stats are
// null-safe rather than dividing by an empty class.
// ═══════════════════════════════════════════════════════════════════════════════

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}>
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem', maxWidth: 1100, width: '100%', maxHeight: '90vh', overflow: 'auto' }}>
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
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const big = (v: number | null) => (v == null ? '—' : formatBig(v))
const met = (v: number | null) => (v == null ? '—' : formatMetric(v))
const num = (v: number | null) => v ?? 0

/** The instance's true process — the instructor's reference banner (spec §10). */
function ProcessHeader({ data }: { data: ForecastReportData }) {
  const p = data.process
  const season = p.highSeasonMonths.map(m => MONTHS[m - 1]).join(' and ')
  return (
    <div
      data-testid="fc-process-banner"
      style={{
        background: '#eff6ff', border: '1px solid #bfdbfe', borderRadius: 8,
        padding: '0.8rem 1rem', marginBottom: '1.25rem',
      }}
    >
      <div style={{ fontWeight: 700, fontSize: '0.95rem', marginBottom: '0.2rem', ...tnum }}>
        demand = {p.intercept} + {p.trend} × month + {p.highSeasonLift} in {season} + noise (sd {p.sigma})
      </div>
      <div style={{ fontSize: '0.8rem', color: colors.textSecondary }}>
        {data.numHistory} months of history · {data.params.rounds} months played ·
        {' '}floor σ² = <span style={tnum}>{formatBig(p.floorMse)}</span> — no forecast can beat it.
        {' '}<strong>Instructor reference; students see none of this until the debrief.</strong>
      </div>
    </div>
  )
}

/**
 * The Tier-3 exclusion note (spec §5b, §6) — ⚠ PRINTED AT ALL TIMES, INCLUDING ZERO.
 *
 * ⚠⚠ THIS USED TO RENDER ONLY WHEN SOMETHING WAS FLAGGED, which quietly made the two
 * cases indistinguishable: a chart with nobody excluded and a chart whose exclusion note
 * had been forgotten looked exactly alike (Elena, 08-03). A FILTERED CHART MUST NEVER BE
 * MISTAKABLE FOR AN UNFILTERED ONE — and "no note" is not evidence of "nobody dropped",
 * it is evidence of nothing at all. Saying "0 excluded" is what tells the reader the
 * check ran, which is the same reason the reports index says "none of 16 flagged".
 *
 * Styled quietly at zero and loudly above it: it is reassurance in the common case and a
 * warning in the rare one, and those should not look the same either.
 */
function ExclusionNote({ n }: { n: number }) {
  const some = n > 0
  return (
    <strong
      data-testid="fc-exclusion-note"
      style={{
        display: 'block',
        marginTop: '0.4rem',
        color: some ? '#92400e' : colors.textSecondary,
        fontWeight: some ? 600 : 400,
      }}
    >
      {some
        ? `⚠ ${n} student${n === 1 ? '' : 's'} excluded as below the theoretical error `
          + `floor, so ${n === 1 ? 'one of them' : 'they'} cannot distort this chart. `
          + 'They are still listed on the outcomes roster.'
        : '0 students excluded as below the theoretical error floor — every student who '
          + 'played is in this chart.'}
    </strong>
  )
}

/**
 * The below-floor badge (spec §5b) — INFORMATION FOR ELENA, nothing more.
 *
 * ⚠ DELIBERATELY NOT AN ACCUSATION. It says what is measurably true — this MSE is below
 * what the noise alone permits — and stops there. Nothing is blocked, nothing is
 * penalised, no score moves, and the student is never told. Scoring is
 * participation-only and forecast accuracy is never graded (spec §6), so a badge that
 * read like a verdict would be claiming an authority this game does not have.
 *
 * The tooltip carries the arithmetic, because a flag Elena cannot check is a flag she
 * has to either trust blindly or ignore.
 */
function BelowFloorBadge({ r }: { r: ForecastReportParticipant }) {
  const f = r.below_floor
  if (!f?.flagged) return null
  const odds = f.pValue > 0 ? Math.round(1 / f.pValue).toLocaleString() : '∞'
  return (
    <span
      data-testid={`fc-below-floor-${r.participant_id}`}
      title={
        `MSE ${formatBig(r.mse ?? 0)} over ${f.months} months. A perfect forecaster — one who `
        + `knew the true process exactly — would still carry the noise, and would score `
        + `below ${formatBig(f.thresholdMse)} only about 1 time in ${odds}. `
        + `Informational only: no score is affected.`
      }
      style={{
        marginLeft: '0.4rem', padding: '0.05rem 0.35rem', borderRadius: 4,
        fontSize: '0.68rem', fontWeight: 600, whiteSpace: 'nowrap',
        background: '#fef3c7', color: '#92400e', border: '1px solid #fde68a',
        cursor: 'help',
      }}
    >
      below floor
    </span>
  )
}

// ── Tier 1: the outcomes roster ────────────────────────────────────────────────

type RosterKey =
  | 'name' | 'status' | 'months' | 'y6' | 'y7' | 'mse' | 'se' | 'mae' | 'bias'
  | 'mape' | 'accuracy' | 'bonus'

/**
 * The roster (spec §10).
 *
 * ⚠ COLUMN ORDER IS Y6 · Y7 · MSE, deliberately (Elena, 08-02). For a FINISHED student
 * the overall MSE is EXACTLY the mean of the two year MSEs — both years hold twelve
 * months, so (1/24)Σall = ½[(1/12)ΣY6 + (1/12)ΣY7] — and putting the parts before the
 * whole lets that be read straight off the row. (For a student partway through Year 7
 * it is a WEIGHTED mean rather than a simple one, which is the other reason the parts
 * are worth showing beside the total rather than instead of it.)
 *
 * ⚠ NO KC OR PARTICIPATION COLUMN (Elena, 08-02). Both are GRADED fields and this is an
 * OUTCOMES report; sitting them beside MSE invites reading the outcome columns as a
 * grade, which spec §6 is explicit they are not. The KC score still travels to the
 * gradebook on its own field and participation is still written by Score & Record —
 * they are simply not shown next to a forecast accuracy they have nothing to do with.
 */
/**
 * ⚠ THE LAST-NAME TIEBREAK EVERY COLUMN FALLS BACK TO (Elena, 08-07) — see the note in
 * this game's Dashboard. This game's own `?? ''` fallback is UNCHANGED; only the ORDERING
 * rule is shared. Procurement BUILD_NOTES §6m.
 */
const tie = (a: ForecastReportParticipant, b: ForecastReportParticipant) =>
  compareByLastName(a.name ?? '', b.name ?? '')

function OutcomesTable({
  rows,
  onOpenStudent,
}: {
  rows: ForecastReportParticipant[]
  onOpenStudent: (id: string) => void
}) {
  const flagged = rows.filter(r => r.below_floor?.flagged).length
  const columns: readonly SortableColumn<ForecastReportParticipant, RosterKey>[] = [
    {
      key: 'name', label: 'Name',
      render: r => r.name ?? '—',
      compare: (a, b) => compareByLastName(a.name ?? '', b.name ?? ''),
      sticky: 'left',
    },
    {
      key: 'status', label: 'Status',
      render: r => (
        <>
          {r.completed ? 'Finished' : r.launched ? `In progress (${r.months_played})` : 'Not started'}
          {r.below_floor?.flagged && <BelowFloorBadge r={r} />}
        </>
      ),
      compare: (a, b) => (a.completed ? 2 : a.launched ? 1 : 0) - (b.completed ? 2 : b.launched ? 1 : 0) || tie(a, b),
    },
    { key: 'months', label: 'Months', render: r => <span style={tnum}>{r.months_played}</span>, compare: (a, b) => a.months_played - b.months_played || tie(a, b) },

    // ── the parts, then the whole ────────────────────────────────────────────
    { key: 'y6', label: 'Y6 MSE', render: r => <span style={tnum}>{big(r.first_year_mse)}</span>, nullsLast: true, isNull: r => r.first_year_mse == null, compare: (a, b) => num(a.first_year_mse) - num(b.first_year_mse) || tie(a, b) },
    { key: 'y7', label: 'Y7 MSE', render: r => <span style={tnum}>{big(r.second_year_mse)}</span>, nullsLast: true, isNull: r => r.second_year_mse == null, compare: (a, b) => num(a.second_year_mse) - num(b.second_year_mse) || tie(a, b) },
    {
      key: 'mse', label: 'MSE',
      render: r => <strong data-testid={`fc-mse-${r.participant_id}`} style={tnum}>{big(r.mse)}</strong>,
      nullsLast: true, isNull: r => r.mse == null,
      compare: (a, b) => num(a.mse) - num(b.mse) || tie(a, b),
    },
    { key: 'se', label: 'Std Error', render: r => <span style={tnum}>{met(r.standard_error)}</span>, nullsLast: true, isNull: r => r.standard_error == null, compare: (a, b) => num(a.standard_error) - num(b.standard_error) || tie(a, b) },
    { key: 'mae', label: 'MAE', render: r => <span style={tnum}>{met(r.mae)}</span>, nullsLast: true, isNull: r => r.mae == null, compare: (a, b) => num(a.mae) - num(b.mae) || tie(a, b) },
    {
      key: 'bias', label: 'Bias',
      // Signed, on purpose: an over-forecast is not a worse error than an under-forecast
      // of the same size, it is the OTHER kind, and a run of one sign is what bias is.
      render: r => <span style={tnum}>{r.mean_error == null ? '—' : formatSigned(r.mean_error, 1)}</span>,
      nullsLast: true, isNull: r => r.mean_error == null,
      compare: (a, b) => num(a.mean_error) - num(b.mean_error) || tie(a, b),
    },
    { key: 'mape', label: 'MAPE', render: r => <span style={tnum}>{formatPercent(r.mape)}</span>, nullsLast: true, isNull: r => r.mape == null, compare: (a, b) => num(a.mape) - num(b.mape) || tie(a, b) },
    { key: 'accuracy', label: 'Accuracy', render: r => <span style={tnum}>{formatPercent(r.accuracy)}</span>, nullsLast: true, isNull: r => r.accuracy == null, compare: (a, b) => num(a.accuracy) - num(b.accuracy) || tie(a, b) },
    { key: 'bonus', label: 'Bonus', render: r => <span style={tnum}>{formatMoney(r.bonus)}</span>, nullsLast: true, isNull: r => r.bonus == null, compare: (a, b) => num(a.bonus) - num(b.bonus) || tie(a, b) },
  ]

  return (
    <>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: colors.textSecondary }}>
        Every enrolled student. <strong>Forecast accuracy is never graded</strong> —
        participation is scored on finishing. Click a student for their month-by-month
        table. For a finished student, MSE is the average of the two year MSEs beside it.
      </p>
      <p data-testid="fc-roster-flag-summary" style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: colors.textSecondary }}>
        <strong>Below-floor check:</strong>{' '}
        {flagged === 0
          ? `no student's error is smaller than the noise alone allows. `
          : `${flagged} student${flagged === 1 ? '' : 's'} carry a badge in the Status column — `
            + `their error is smaller than the noise alone allows. `}
        Every student who has played at least six months is tested against their own
        month count and this instance&rsquo;s noise level. It is informational: no score
        is affected, and nothing is shown to the student.
      </p>
      <SortableTable
        rows={rows}
        columns={columns}
        getRowKey={r => r.participant_id}
        initialSortKey="mse"
        initialSortDir="asc"
        tableTestId="fc-tier1"
        emptyMessage="Nobody on the roster yet."
        getRowProps={r => (r.months_played > 0
          ? { onClick: () => onOpenStudent(r.participant_id), style: { cursor: 'pointer' } }
          : {})}
      />
    </>
  )
}

/** One student's month-by-month table — the Tier-1 drill-through (spec §10). */
function StudentDetail({ p }: { p: ForecastReportParticipant }) {
  const th = { padding: '0.35rem 0.5rem', fontSize: '0.72rem', fontWeight: 600, color: colors.textSecondary, borderBottom: `1px solid ${colors.borderMid}`, textAlign: 'right' as const }
  const td = { padding: '0.3rem 0.5rem', fontSize: '0.8rem', textAlign: 'right' as const, ...tnum, borderBottom: `1px solid ${colors.borderLight ?? '#eee'}` }
  return (
    <>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.85rem', color: colors.textSecondary }}>
        MSE <strong style={tnum}>{big(p.mse)}</strong> · Std Error <span style={tnum}>{met(p.standard_error)}</span>
        {' '}· Y6 <span style={tnum}>{big(p.first_year_mse)}</span> · Y7 <span style={tnum}>{big(p.second_year_mse)}</span>
        {p.improved !== null && (p.improved ? ' · improved in Year 7' : ' · did not improve in Year 7')}
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table data-testid={`fc-drill-${p.participant_id}`} style={{ borderCollapse: 'collapse', width: '100%' }}>
          <thead>
            <tr>
              {['Period', 'Forecast', 'Actual', 'Error', 'Abs error', 'Squared error', 'Abs % error']
                .map(h => <th key={h} style={th}>{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {p.months.map(m => (
              <tr key={m.period}>
                <td style={td}>{m.period}</td>
                <td style={td}>{m.forecast.toLocaleString()}</td>
                <td style={td}>{m.actual.toLocaleString()}</td>
                <td style={td}>{formatSigned(m.error)}</td>
                <td style={td}>{m.absoluteError.toLocaleString()}</td>
                <td style={td}>{formatBig(m.squaredError)}</td>
                <td style={td}>{formatPercent(m.absolutePercentageError)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}

/** Tier 2 — every debrief paragraph (Reports Contract v1). */
function DebriefAnswers({ rows, prompt }: { rows: ForecastReportParticipant[]; prompt: string }) {
  const written = rows.filter(p => p.debrief !== null)
  const copyAll = async () => {
    const text = written.map(p => `${p.name ?? p.participant_id} — MSE ${big(p.mse)}\n${p.debrief}\n`).join('\n---\n\n')
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard unavailable */ }
  }
  return (
    <>
      <p style={{ margin: '0 0 0.6rem', fontSize: '0.82rem', color: colors.textSecondary, fontStyle: 'italic' }}>
        &ldquo;{prompt}&rdquo;
      </p>
      <button
        data-testid="fc-tier2-copy"
        onClick={() => void copyAll()}
        style={{ padding: '0.4rem 0.8rem', fontSize: '0.8rem', marginBottom: '1rem', background: colors.white, border: `1px solid ${colors.borderMid}`, borderRadius: 6, cursor: 'pointer' }}
      >
        Copy all {written.length} answers
      </button>
      <div data-testid="fc-tier2">
        {written.map(p => (
          <div key={p.participant_id} style={{ marginBottom: '1rem', paddingBottom: '1rem', borderBottom: `1px solid ${colors.borderLight ?? '#eee'}` }}>
            <div style={{ fontSize: '0.82rem', fontWeight: 600, marginBottom: '0.25rem' }}>
              {p.name ?? p.participant_id}
              <span style={{ fontWeight: 400, color: colors.textSecondary }}> — MSE {big(p.mse)}</span>
            </div>
            <div style={{ fontSize: '0.88rem', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{p.debrief}</div>
          </div>
        ))}
      </div>
    </>
  )
}

/** Tier 3b — the class's own numbers beside the benchmark rules. THE DEBRIEF SLIDE. */
function BenchmarkComparison({ data }: { data: ForecastReportData }) {
  const s = data.summary
  const th = { padding: '0.35rem 0.5rem', fontSize: '0.72rem', fontWeight: 600, color: colors.textSecondary, borderBottom: `1px solid ${colors.borderMid}`, textAlign: 'right' as const }
  const td = { padding: '0.32rem 0.5rem', fontSize: '0.85rem', textAlign: 'right' as const, ...tnum, borderBottom: `1px solid ${colors.borderLight ?? '#eee'}` }
  return (
    <div style={{ display: 'flex', gap: '2.5rem', flexWrap: 'wrap' }}>
      <div style={{ minWidth: '15rem' }}>
        <h3 style={{ fontSize: '0.9rem', margin: '0 0 0.5rem' }}>
          This class ({s.students} {s.students === 1 ? 'student' : 'students'})
        </h3>
        <table data-testid="fc-summary" style={{ borderCollapse: 'collapse' }}>
          <tbody>
            <tr><td style={{ ...td, textAlign: 'left' }}>Mean MSE</td><td style={{ ...td, fontWeight: 700 }} data-testid="fc-summary-mse">{big(s.meanMse)}</td></tr>
            <tr><td style={{ ...td, textAlign: 'left' }}>Standard Error</td><td style={td}>{met(s.standardError)}</td></tr>
            <tr><td style={{ ...td, textAlign: 'left' }}>Mean MAE</td><td style={td}>{met(s.meanMae)}</td></tr>
            <tr><td style={{ ...td, textAlign: 'left' }}>Mean bias</td><td style={td}>{s.meanBias == null ? '—' : formatSigned(s.meanBias, 1)}</td></tr>
            <tr><td style={{ ...td, textAlign: 'left' }}>Mean MAPE</td><td style={td}>{formatPercent(s.meanMape)}</td></tr>
          </tbody>
        </table>
      </div>
      <div style={{ flex: 1, minWidth: '22rem' }}>
        <h3 style={{ fontSize: '0.9rem', margin: '0 0 0.5rem' }}>The benchmark rules</h3>
        {data.benchmarks === null ? (
          <p style={{ fontSize: '0.82rem', color: colors.textSecondary }}>
            This instance&rsquo;s demand model has been edited away from the published one, so
            the design&rsquo;s benchmark table does not describe it. Students see benchmarks
            recomputed against their own months instead.
          </p>
        ) : (
          <table data-testid="fc-benchmarks" style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: 'left' }}>Rule</th>
                <th style={th}>MSE</th>
                <th style={th}>Std Error</th>
              </tr>
            </thead>
            <tbody>
              {data.benchmarks.map(b => (
                <tr key={b.id} data-testid={`fc-bench-${b.id}`}>
                  <td style={{ ...td, textAlign: 'left', fontWeight: b.id === 'reg_holiday' ? 700 : 400 }}>{b.label}</td>
                  <td style={{ ...td, fontWeight: b.id === 'reg_holiday' ? 700 : 400 }}>{b.mse === null ? '—' : formatBig(b.mse)}</td>
                  <td style={td}>{b.standardError}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

// ── The page ───────────────────────────────────────────────────────────────────

type TileId = 'outcomes' | 'debrief' | 'history' | 'chart' | 'comparison' | 'histogram'

export default function Reports() {
  const session = useInstructorSession(forecastInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ForecastReportData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<TileId | null>(null)
  const [student, setStudent] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    forecastGetReport().then(setData).catch(e => setErr(instructorErrorMessage(e)))
  }, [session])

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]
  const chrome = (body: ReactNode) => (
    <InstructorChrome title="Forecasting Game — reports" navLinks={navLinks} onNavigate={navigate}>
      {body}
    </InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open the reports from the classroom.</p>)
  if (session.kind === 'error') return chrome(<p style={{ color: '#c00' }}>{session.message}</p>)
  if (err) return chrome(<p style={{ color: '#c00' }}>{err}</p>)
  if (!data) return chrome(<p>Loading reports…</p>)

  const played = data.participants.filter(p => p.months_played > 0)
  const finished = data.participants.filter(p => p.completed)
  const debriefs = data.participants.filter(p => p.debrief)
  const months = data.classChart.length
  const flaggedCount = data.participants.filter(p => p.below_floor?.flagged).length
  const detail = student ? data.participants.find(p => p.participant_id === student) ?? null : null

  const grey = { color: '#94a3b8' }

  const tiles: ReportTileConfig[] = [
    {
      id: 'outcomes',
      title: 'Outcomes — all students',
      // ⚠ THE FLAG COUNT IS SHOWN EVEN WHEN IT IS ZERO (Elena, 08-02). A badge that
      // only appears when triggered is invisible until it matters — which meant going
      // looking for it and finding nothing was indistinguishable from it not existing.
      // Saying "none flagged" is how an instructor knows the check ran at all.
      preview: (
        <>
          <span>{finished.length} finished / {data.participants.length} on roster</span>
          <span
            data-testid="fc-tile-flag-count"
            style={{
              display: 'block', marginTop: '0.3rem', fontSize: '0.8rem',
              color: flaggedCount > 0 ? '#92400e' : colors.textSecondary,
              fontWeight: flaggedCount > 0 ? 600 : 400,
            }}
          >
            {flaggedCount > 0
              ? `⚠ ${flaggedCount} flagged below the error floor`
              : played.length === 0
                ? 'Below-floor check: nobody has played yet'
                : `Below-floor check: none of ${played.length} flagged`}
          </span>
        </>
      ),
      onOpen: () => setActive('outcomes'),
    },
    {
      id: 'debrief',
      title: 'Debrief paragraphs — after play',
      disabled: debriefs.length === 0,
      preview: debriefs.length === 0
        ? <span style={grey}>No paragraphs yet.</span>
        : <span>{debriefs.length} paragraph(s) — how they actually forecast</span>,
      onOpen: () => setActive('debrief'),
    },
    {
      // ⚠ THE DATA STUDENTS WERE GIVEN (Elena, 08-02). Every other chart on this page
      // starts at the first PLAYED month, so until now the reports could show what the
      // class did but not what they were looking at when they did it. It is the same
      // sixty months every student saw, so it is ALWAYS available — no play required.
      id: 'history',
      title: 'The five years students were given',
      preview: <span>{data.history.length} months of demand — the common starting data</span>,
      onOpen: () => setActive('history'),
    },
    {
      // ⚠ NAMED FOR WHAT IT SHOWS, not for its tier (Elena, 08-02). "The class chart"
      // said nothing about WHICH class chart, and the three series are the whole point.
      id: 'chart',
      title: 'Forecast vs actual vs the true process, by month',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={grey}>No months played yet.</span>
        : <span>{months} months — did the class track the season?</span>,
      onOpen: () => setActive('chart'),
    },
    {
      id: 'comparison',
      title: 'Class result against the benchmark rules',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={grey}>No months played yet.</span>
        : <span>Class mean MSE {big(data.summary.meanMse)} — against all eight rules</span>,
      onOpen: () => setActive('comparison'),
    },
    {
      id: 'histogram',
      title: 'Spread of student MSE',
      disabled: data.histogram === null,
      preview: data.histogram === null
        ? <span style={grey}>No months played yet.</span>
        : <span>{played.length} student(s) — and where the tail sits</span>,
      onOpen: () => setActive('histogram'),
    },
  ]

  return chrome(
    <>
      <ProcessHeader data={data} />
      <ReportBoard tiles={tiles} />

      {active === 'outcomes' && (
        <Modal
          title={detail ? `${detail.name ?? detail.participant_id} — month by month` : 'Outcomes — all students'}
          onClose={() => (detail ? setStudent(null) : setActive(null))}
        >
          {detail
            ? <StudentDetail p={detail} />
            : <OutcomesTable rows={data.participants} onOpenStudent={setStudent} />}
        </Modal>
      )}

      {active === 'debrief' && (
        <Modal title="Debrief paragraphs — after play" onClose={() => setActive(null)}>
          <DebriefAnswers rows={data.participants} prompt={data.debriefPrompt} />
        </Modal>
      )}

      {active === 'history' && (
        <Modal title="The five years students were given" onClose={() => setActive(null)}>
          <p style={{ margin: '0 0 0.9rem', fontSize: '0.82rem', color: colors.textSecondary }}>
            The {data.history.length} months of demand every student opens on — identical
            for all of them. This is the data the exercise asks them to explain: a rising
            trend with a high season they have to spot for themselves.
            {' '}<strong>The student&rsquo;s own copy carries the demand line ALONE</strong> —
            the dashed reference below is yours, not theirs.
          </p>
          <DemandChartSVG
            history={data.history}
            totalPeriods={data.history.length}
            height={340}
            reference={data.historySystematic.map((value, i) => ({ period: i + 1, value }))}
          />
        </Modal>
      )}

      {active === 'chart' && (
        <Modal title="Forecast vs actual vs the true process, by month" onClose={() => setActive(null)}>
          <p style={{ margin: '0 0 0.9rem', fontSize: '0.82rem', color: colors.textSecondary }}>
            {data.demandDraw === 'common'
              ? <>
                  <strong>Actual demand</strong> — the identical series every student
                  faced — and the class&rsquo;s average forecast, against the true
                  systematic component with a shaded ±1σ band around it: the range demand
                  actually varied in. A forecast inside that band is as close as the
                  process allows.
                  {' '}<em>The n under each month is the FORECAST line&rsquo;s
                  denominator only.</em> Later months average fewer students because play
                  is spread across the week — that is composition, not behaviour. The
                  demand line is one realized series and does not move with who was
                  playing.
                </>
              : <>
                  <strong>Class average actual demand</strong> and the class&rsquo;s
                  average forecast, against the true systematic component with a shaded
                  ±1σ band around it: the range demand actually varied in. This instance
                  draws a DIFFERENT future for every student, so both lines are averages.
                  Later months average fewer students — that is composition, not
                  behaviour, which is why every month carries its own n.
                </>}
          <ExclusionNote n={data.excludedFromCharts} />
          </p>
          <ClassChartSVG
            points={data.classChart}
            sigma={data.process.sigma}
            demandDraw={data.demandDraw}
          />
        </Modal>
      )}

      {active === 'comparison' && (
        <Modal title="Class result against the benchmark rules" onClose={() => setActive(null)}>
          <p style={{ margin: '0 0 0.9rem', fontSize: '0.82rem', color: colors.textSecondary }}>
            The class&rsquo;s own numbers beside what each forecasting rule would have
            scored. This is the debrief slide.
          <ExclusionNote n={data.excludedFromCharts} />
          </p>
          <BenchmarkComparison data={data} />
        </Modal>
      )}

      {active === 'histogram' && data.histogram !== null && (
        <Modal title="Spread of student MSE" onClose={() => setActive(null)}>
          <p style={{ margin: '0 0 0.9rem', fontSize: '0.82rem', color: colors.textSecondary }}>
            Where the class landed, with the benchmark rules marked. The tail on the right
            is the chased-the-noise group. The axis is logarithmic — MSE spans a 40× range,
            and on a linear axis everything competent would pile up at the left edge.
          <ExclusionNote n={data.excludedFromCharts} />
          </p>
          <MseHistogramSVG histogram={data.histogram} benchmarks={data.benchmarks ?? []} />
        </Modal>
      )}
    </>,
  )
}
