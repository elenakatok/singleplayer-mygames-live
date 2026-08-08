import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import {
  ReportBoard, SortableTable, colors,
  type ReportTileConfig, type SortableColumn,
} from '@mygames/game-ui'
import { useInstructorSession } from '../shared/useInstructorSession'
import { InstructorChrome } from '../shared/InstructorChrome'
import { compareByLastName } from '../shared/sortName'
import {
  scorecardGetReport, scorecardInstructorSession, instructorErrorMessage,
  type ScorecardReport, type ScorecardReportParticipant,
} from './api'
import { PolicyGridSVG, PolicyGridLegend } from './PolicyGridSVG'
import { EffortByRoundChart, EffortByPeriodChart, GapDistributionChart } from './ClassChartsSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Metalcraft Supplier Scorecard — the three report tiers (spec §11).
//
// ⚠⚠ R4 — THE NAME TIEBREAK IS INSIDE `compare`, ON EVERY COLUMN. `SortableTable`'s own
// `tiebreak` field fires ONLY when both rows are null, so it does not cover a numeric tie
// between two present values. Without `|| tie(a, b)` on each column the roster RESHUFFLES
// BETWEEN REFRESHES under the instructor. This was 85 columns across 14 files on 08-07 —
// do not rediscover it.
//
// ⚠ R2/R3 — surname sort via `compareByLastName`, which takes STRINGS. The caller owns
// the unnamed-row fallback, and this game's is `''` (sorts first) with an explicit label
// in the cell (R9) rather than a blank.
//
// ⚠ R5 — `nullsLast` on every numeric metric column, and `effort_gap` needs it most: a
// null gap means "played only one condition", which must not sort as if it were zero.
//
// ⚠⚠ NO BENCHMARK-RATIO COLUMNS (removed 08-07). The comparison that matters is a student
// against THEMSELVES across conditions, not against a dynamic program they were never
// asked to solve. The DP appears in exactly two places on this page — chart 4's policy
// grid, and chart 2's optional dashed overlay, which is DEFAULT OFF.
// ═══════════════════════════════════════════════════════════════════════════════

/** ⚠ Local, matching forecast's and procurement's — `Modal` is not a game-ui export. */
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

const tnum: React.CSSProperties = { fontVariantNumeric: 'tabular-nums' }
const pct = (v: number | null) => (v === null ? '—' : `${Math.round(v * 100)}%`)
// ⚠ NO UNIT ON EVERY CELL. 13 columns × 16 rows of "125 ECU" is 200 repetitions of a
// constant, and it is what pushed the table off the screen. The unit goes in the HEADER.
const money = (v: number | null) => (v === null ? '—' : String(Math.round(v)))
// ⚠ The SUMMARY keeps its unit — it is four figures read in prose, not 200 cells in a
// grid, and there the unit carries its weight instead of costing horizontal space.
const moneyUnit = (v: number | null, c: string) => (v === null ? '—' : `${Math.round(v)} ${c}`)
const signedPct = (v: number | null) =>
  v === null ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 100)}%`

/** ⚠ R3 — the caller owns the unnamed-row fallback. Empty string sorts first. */
const nameOf = (p: ScorecardReportParticipant) => p.name ?? ''

/** ⚠ R4 — appended to EVERY column's compare. */
const tie = (a: ScorecardReportParticipant, b: ScorecardReportParticipant) =>
  compareByLastName(nameOf(a), nameOf(b))

/** Numeric coercion for nullsLast columns: the value never decides order for nulls. */
const num = (v: number | null) => (v === null ? 0 : v)

// ⚠ `pre-line` is what turns the `\n` in a label into an actual second line — the label
// type is a plain string, so the break has to be honoured by CSS. Applied to EVERY column
// from one constant, so a column added later cannot forget it and silently render
// "Con-tracts" on one line.
const hdr: React.CSSProperties = { whiteSpace: 'pre-line', lineHeight: 1.25 }

type RosterKey =
  | 'name' | 'status' | 'contracts' | 'earnings'
  | 'rate_high' | 'rate_low' | 'gap' | 'raw_gap'
  | 'earn_high' | 'earn_low' | 'bonus_high' | 'bonus_low'
  | 'wasted'

export default function Reports() {
  const session = useInstructorSession(scorecardInstructorSession)
  const [report, setReport] = useState<ScorecardReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** ⚠ Spec §11: the DP overlay on chart 2 is DEFAULT OFF. */
  const [showOptimal, setShowOptimal] = useState(false)
  const [active, setActive] = useState<string | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    if (session.kind !== 'ready') return
    let cancelled = false
    scorecardGetReport()
      .then(r => { if (!cancelled) setReport(r) })
      .catch(e => { if (!cancelled) setError(instructorErrorMessage(e)) })
    return () => { cancelled = true }
  }, [session])

  if (session.kind === 'loading') return <InstructorChrome title="Reports"><p>Loading…</p></InstructorChrome>
  if (session.kind === 'error') {
    return <InstructorChrome title="Reports"><p style={{ color: '#c00' }}>{session.message}</p></InstructorChrome>
  }
  if (error) return <InstructorChrome title="Reports"><p style={{ color: '#c00' }}>{error}</p></InstructorChrome>
  if (!report) return <InstructorChrome title="Reports"><p>Loading…</p></InstructorChrome>

  const { params, treatment, participants, tier3, summary, botCount } = report
  const cur = params.currency

  // ⚠⚠ R7 — CAPTIONS FOLLOW CONFIG, NEVER HARDCODED PHRASING. Both
  // `reliabilitySchedule` AND `showReliabilityLabel` change what these charts MEAN, not
  // merely how they read:
  //   • under `blocked` or `betweenSubject` the counterbalancing that makes chart 1's two
  //     series comparable is absent, so the caption must not claim it;
  //   • with labels OFF the effort gap measures NOTICING; with them ON it measures
  //     RESPONSE GIVEN AWARENESS, and a zero gap becomes a STRONGER finding, not a weaker
  //     one (spec §2.3). Testing only the default branch would miss this.
  const scheduleCaption =
    treatment.reliabilitySchedule === 'alternating'
      ? 'Conditions alternate contract by contract, with half the class starting on each — '
        + 'so at every round the two series draw on comparable halves of the class, and the '
        + 'order effect is separated from the treatment.'
      : treatment.reliabilitySchedule === 'blocked'
        ? '⚠ This instance uses a BLOCKED schedule: one condition runs first and the other '
          + 'second, so a difference between the series is part treatment and part contract '
          + 'order. The two are not separable here.'
        : '⚠ This instance is BETWEEN-SUBJECT: each student sees only one condition, so these '
          + 'series compare different people rather than the same person twice.'

  const labelCaption = params.showReliabilityLabel
    ? 'Reliability was NAMED on screen, so a small gap means a student saw the number, was '
      + 'told what it meant, and worked anyway — a stronger finding than a small gap would be '
      + 'if they had had to notice it themselves.'
    : '⚠ Reliability was NOT named on screen in this instance, so the gap measures whether '
      + 'students NOTICED the change, not whether they acted on one they were shown.'

  const botCaption = botCount > 0
    ? `⚠ ${botCount} simulated student${botCount === 1 ? '' : 's'} are included in these class `
      + 'averages (they are excluded from the roster and from the gap distribution).'
    : ''

  const columns: readonly SortableColumn<ScorecardReportParticipant, RosterKey>[] = [
    {
      key: 'name',
      label: 'Student',
      // ⚠ Pinned: the table is wide, and a name column that scrolls away makes every
      // other column unreadable.
      sticky: 'left',
      headerStyle: hdr,
      // ⚠ R9 — an unnamed row gets an explicit label, never a blank cell.
      render: r => (r.name ?? <em style={{ color: colors.textSecondary }}>(no name on the roster)</em>),
      compare: (a, b) => compareByLastName(nameOf(a), nameOf(b)),
    },
    {
      key: 'status',
      label: 'Status',
      headerStyle: hdr,
      render: r => (
        <>
          {r.completed ? 'Finished' : r.launched ? 'In progress' : 'Not started'}
          {/* ⚠ Spec §11 — a human in a cohort that also contains bots is MARKED. */}
          {r.from_bot_cohort && (
            <span title="This instance also contains simulated students"
              style={{ marginLeft: 6, fontSize: '0.7rem', color: colors.textSecondary }}>◆</span>
          )}
        </>
      ),
      compare: (a, b) =>
        ((a.completed ? 2 : a.launched ? 1 : 0) - (b.completed ? 2 : b.launched ? 1 : 0)) || tie(a, b),
    },
    {
      key: 'contracts', label: 'Con-\ntracts',
      headerStyle: hdr,
      render: r => <span style={tnum}>{r.contracts_completed}</span>,
      compare: (a, b) => (a.contracts_completed - b.contracts_completed) || tie(a, b),
    },
    {
      key: 'earnings', label: `Total\n${cur}`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{Math.round(r.total_earnings)}</span>,
      compare: (a, b) => (a.total_earnings - b.total_earnings) || tie(a, b),
    },
    // ── The paired per-condition columns (spec §11) ─────────────────────────
    {
      key: 'rate_high', label: `Effort\n${Math.round(treatment.reliabilityHigh * 100)}%`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{pct(r.high_effort_rate_high)}</span>,
      nullsLast: true, isNull: r => r.high_effort_rate_high == null,
      compare: (a, b) => (num(a.high_effort_rate_high) - num(b.high_effort_rate_high)) || tie(a, b),
    },
    {
      key: 'rate_low', label: `Effort\n${Math.round(treatment.reliabilityLow * 100)}%`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{pct(r.high_effort_rate_low)}</span>,
      nullsLast: true, isNull: r => r.high_effort_rate_low == null,
      compare: (a, b) => (num(a.high_effort_rate_low) - num(b.high_effort_rate_low)) || tie(a, b),
    },
    {
      // ⚠⚠ THE HEADLINE COLUMN (spec §11) — CONTESTED PERIODS ONLY. Sorting on it ranks
      // the class by who acted on what they were shown.
      //
      // ⚠ It is NOT the raw all-period gap. Over all periods a student who never thought
      // about reliability but stops on dead contracts shows +0.275 by pure mechanics, and
      // would out-rank a genuine weak responder. The contested denominator zeroes that
      // exactly, by construction.
      //
      // `nullsLast` matters more here than anywhere: a null means the student faced no
      // contested periods in one condition, and must not sort as if it were zero.
      key: 'gap', label: 'Contested\ngap',
      headerStyle: hdr,
      render: r => (
        <strong style={{ ...tnum, color: r.contested_gap === null ? colors.textSecondary : undefined }}>
          {signedPct(r.contested_gap)}
        </strong>
      ),
      nullsLast: true, isNull: r => r.contested_gap == null,
      compare: (a, b) => (num(a.contested_gap) - num(b.contested_gap)) || tie(a, b),
    },
    {
      // ⚠ SECONDARY. Shown BESIDE the contested gap precisely so the mechanical component
      // is legible: a large raw gap next to a near-zero contested one IS the deadness
      // artifact, and the "paid after dead" column names it.
      key: 'raw_gap', label: 'Raw gap\n(all periods)',
      headerStyle: hdr,
      render: r => (
        <span style={{ ...tnum, color: colors.textSecondary }}>{signedPct(r.effort_gap)}</span>
      ),
      nullsLast: true, isNull: r => r.effort_gap == null,
      compare: (a, b) => (num(a.effort_gap) - num(b.effort_gap)) || tie(a, b),
    },
    {
      key: 'earn_high', label: `${cur}/contract\n${Math.round(treatment.reliabilityHigh * 100)}%`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{money(r.earnings_high)}</span>,
      nullsLast: true, isNull: r => r.earnings_high == null,
      compare: (a, b) => (num(a.earnings_high) - num(b.earnings_high)) || tie(a, b),
    },
    {
      key: 'earn_low', label: `${cur}/contract\n${Math.round(treatment.reliabilityLow * 100)}%`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{money(r.earnings_low)}</span>,
      nullsLast: true, isNull: r => r.earnings_low == null,
      compare: (a, b) => (num(a.earnings_low) - num(b.earnings_low)) || tie(a, b),
    },
    {
      key: 'bonus_high', label: `Bonuses\n${Math.round(treatment.reliabilityHigh * 100)}%`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{r.bonuses_high}</span>,
      compare: (a, b) => (a.bonuses_high - b.bonuses_high) || tie(a, b),
    },
    {
      key: 'bonus_low', label: `Bonuses\n${Math.round(treatment.reliabilityLow * 100)}%`,
      headerStyle: hdr,
      render: r => <span style={tnum}>{r.bonuses_low}</span>,
      compare: (a, b) => (a.bonuses_low - b.bonuses_low) || tie(a, b),
    },
    {
      // ⚠ Strict `isDead` server-side — periods paid for on a contract that was ALREADY
      // IMPOSSIBLE, not one the DP would have abandoned (BUILD_NOTES §1a).
      key: 'wasted', label: 'Wasted\nperiods',
      headerStyle: hdr,
      render: r => <span style={tnum}>{r.periods_paid_after_dead}</span>,
      compare: (a, b) => (a.periods_paid_after_dead - b.periods_paid_after_dead) || tie(a, b),
    },
  ]

  /**
   * ⚠ THE TIER-2 EXPORT CARRIES THE NUMBERS (spec §11). Elena grades the written answers
   * offline; a claim like "I eased off when the scorecard got unreliable" is unassessable
   * without the student's own figures beside it.
   */
  function copyExport(step: 'noticing' | 'linking') {
    const rows = participants
      .filter(p => (step === 'noticing' ? p.noticing : p.linking) !== null)
      .map(p => [
        `NAME: ${p.name ?? p.participant_id}`,
        `EFFORT @ ${Math.round(treatment.reliabilityHigh * 100)}%: ${pct(p.high_effort_rate_high)}`,
        `EFFORT @ ${Math.round(treatment.reliabilityLow * 100)}%: ${pct(p.high_effort_rate_low)}`,
        `CONTESTED GAP: ${signedPct(p.contested_gap)}`
          + ` (over ${p.contested_periods_high}/${p.contested_periods_low} contested periods)`,
        `RAW GAP (all periods): ${signedPct(p.effort_gap)}`,
        `CONTRACTS COMPLETED: ${p.contracts_completed}`,
        `BONUSES: ${p.bonuses_high} @ high, ${p.bonuses_low} @ low`,
        `PERIODS PAID AFTER DEAD: ${p.periods_paid_after_dead}`,
        '',
        (step === 'noticing' ? p.noticing : p.linking) ?? '',
      ].join('\n'))
      .join('\n\n' + '-'.repeat(60) + '\n\n')
    void navigator.clipboard?.writeText(rows).catch(() => { /* clipboard unavailable */ })
  }

  const sectionDefs = [
    {
      id: 'tier1',
      preview: <span>{participants.length} on the roster · {participants.filter(p => p.completed).length} finished</span>,
      title: 'Tier 1 — outcomes roster',
      body: (
        <>
          <div style={{ margin: '0 0 0.75rem', fontSize: '0.82rem', color: colors.textSecondary }}>
            <p style={{ margin: '0 0 0.5rem' }}>
              <strong>Contested gap is the headline.</strong> It is each student against
              themselves across the two conditions, counted only over periods where the bonus
              was <em>still winnable and not yet won</em> — sort on it to rank the class by who
              acted on what they were shown. {labelCaption}
              {botCount > 0 && <> Simulated students are excluded from this roster; a ◆ marks
                humans in a cohort that contains them.</>}
            </p>
            {/* ⚠ THE THREE COLUMNS THAT NEED A GLOSS. Without this the roster is a wall of
                numbers whose definitions live only in the spec. */}
            <p style={{ margin: 0 }}>
              <strong>Raw gap</strong> is the same comparison over <em>all</em> periods — shown
              beside the contested one because the difference between them is informative: a
              large raw gap with a near-zero contested gap means the student was reacting to
              contracts being <em>already lost</em>, not to reliability.{' '}
              <strong>Wasted periods</strong> counts periods where they paid for high effort on
              a contract that was <em>already mathematically impossible</em> — the bonus could
              no longer be reached no matter what they did. The game never tells them that;
              noticing it is part of what is being measured.
            </p>
          </div>
          <SortableTable
            rows={participants}
            columns={columns}
            getRowKey={r => r.participant_id}
            initialSortKey="gap"
            initialSortDir="desc"
            // ⚠ NOT "sc-tier1" — the MODAL WRAPPER already carries that id (`sc-${open.id}`),
            // so both resolved to it and any selector hit two elements. Second instance of
            // the SessionSummary bug: two different things, one identity.
            tableTestId="sc-tier1-table"
            emptyMessage="Nobody on the roster yet."
          />
        </>
      ),
    },
    {
      id: 'tier2',
      preview: <span>{participants.filter(p => p.linking !== null).length} written reflections · figures included in the export</span>,
      title: 'Tier 2 — written answers',
      body: (
        <>
          {report.freeTextQuestions.map(q => {
            const written = participants.filter(
              p => (q.step === 'noticing' ? p.noticing : p.linking) !== null)
            return (
              <div key={q.id} style={{ margin: '0 0 2rem' }}>
                <h4 style={{ margin: '0 0 0.3rem' }}>
                  {q.step === 'noticing' ? '1. Before seeing any results' : '3. After the reveal'}
                </h4>
                <p style={{ margin: '0 0 0.35rem', fontSize: '0.82rem', color: colors.textSecondary, fontStyle: 'italic' }}>
                  &ldquo;{q.prompt}&rdquo;
                </p>
                <p style={{ margin: '0 0 0.75rem', fontSize: '0.78rem', color: colors.textSecondary }}>
                  {q.gradedNote} · {written.length} of {participants.length} written.
                  {' '}
                  <button onClick={() => copyExport(q.step)} style={{ fontSize: '0.78rem' }}>
                    Copy all with figures
                  </button>
                </p>
                {written.map(p => (
                  <div key={p.participant_id} style={{
                    borderLeft: `3px solid ${colors.borderMid}`,
                    padding: '0.4rem 0 0.4rem 0.75rem', margin: '0 0 0.9rem',
                  }}>
                    {/* ⚠⚠ THE FIGURES SIT BESIDE THE TEXT (spec §11, Elena 08-07). Elena
                        grades this offline, and "I eased off when it got unreliable" cannot
                        be assessed without the numbers next to it — otherwise the grade
                        rewards plausible prose over actual insight. */}
                    <div style={{ fontSize: '0.78rem', color: colors.textSecondary }}>
                      <strong style={{ color: colors.text ?? '#222' }}>
                        {p.name ?? '(no name on the roster)'}
                      </strong>
                      {' · '}effort {pct(p.high_effort_rate_high)} @ {Math.round(treatment.reliabilityHigh * 100)}%
                      {' / '}{pct(p.high_effort_rate_low)} @ {Math.round(treatment.reliabilityLow * 100)}%
                      {' · '}<strong>contested gap {signedPct(p.contested_gap)}</strong>
                      {' · '}{p.contracts_completed} contracts
                      {' · '}bonuses {p.bonuses_high}/{p.bonuses_low}
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', marginTop: '0.3rem' }}>
                      {q.step === 'noticing' ? p.noticing : p.linking}
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </>
      ),
    },
    {
      // ════════════════════════════════════════════════════════════════════════
      // ⚠ ONE CHART PER TILE (Elena, 08-08). All four used to share a single "Tier 3"
      // tile, which put four charts in one modal and defeated the point of the grid: you
      // could not open one without the others, and none of them had room.
      //
      // ⚠ THE EXCEPTION IS CHART 4 — its two panels are ONE chart, not two. Low and high
      // are read AGAINST each other; the whole finding is that the work region collapses to
      // a sliver on the left, which is invisible unless they sit side by side. They stay
      // together in one tile, in slide order.
      // ════════════════════════════════════════════════════════════════════════
      id: 'chart1',
      preview: <span>Reproduces slide 7 — does effort drift across the session?</span>,
      title: 'Effort by contract round',
      body: (
        <EffortByRoundChart
          high={tier3.byRound.high} low={tier3.byRound.low}
          labelHigh={treatment.labelHigh} labelLow={treatment.labelLow}
          caption={`${scheduleCaption} ${botCaption}`}
        />
      ),
    },
    {
      id: 'chart2',
      preview: <span>Where in a contract the class works — and where it stops</span>,
      title: 'Effort by period within a contract',
      body: (
        <>
          <EffortByPeriodChart
            high={tier3.byPeriod.high} low={tier3.byPeriod.low}
            optimalHigh={tier3.byPeriod.optimalHigh} optimalLow={tier3.byPeriod.optimalLow}
            showOptimal={showOptimal}
            labelHigh={treatment.labelHigh} labelLow={treatment.labelLow}
            caption={botCaption}
          />
          {/* ⚠ DEFAULT OFF (spec §11), and it lives HERE because it overlays THIS chart.
              A rhetorical device for the room, not a standard students are held to — and
              never on a student screen. */}
          <label style={{ display: 'block', fontSize: '0.82rem', margin: '1.25rem 0 0' }}>
            <input type="checkbox" checked={showOptimal}
              onChange={e => setShowOptimal(e.target.checked)} />{' '}
            Overlay best-possible play{' '}
            <span style={{ color: colors.textSecondary }}>
              &mdash; for lecture. It shows how near zero the best response to an unreliable
              scorecard is. Students never see it.
            </span>
          </label>
        </>
      ),
    },
    {
      id: 'chart3',
      preview: (
        <span>
          How many students responded at all
          {tier3.gapDistribution.atZero > 0 && <> &middot; {tier3.gapDistribution.atZero} at exactly zero</>}
        </span>
      ),
      title: 'Per-student contested-period effort gap',
      body: <GapDistributionChart dist={tier3.gapDistribution} caption={labelCaption} />,
    },
    {
      id: 'chart4',
      preview: <span>Slide 6, from this instance&rsquo;s own settings &middot; no student data</span>,
      // ⚠ SHORT. The tile header puts "Open ↗" on the same line, and the longer form
      // ran straight into it. The full sentence lives in the tile body instead.
      title: 'Optimal policy grid',
      body: (
        <>
          <p style={{ fontSize: '0.85rem', color: colors.textSecondary, margin: '0 0 1rem' }}>
            Computed from this instance&rsquo;s own settings; no student data is in it. This is
            the slide-6 picture, and it is instructor-only &mdash; students are never shown the
            optimal policy. ⚠ The two panels are ONE chart: read them against each other,
            and note how the work region collapses to a sliver on the left.
          </p>
          <PolicyGridSVG panels={tier3.policyGrid} currency={cur} />
          <PolicyGridLegend />
        </>
      ),
    },
    {
      id: 'summary',
      preview: <span>Class effort and earnings per condition, against best possible</span>,
      title: 'Summary',
      body: (
        <table style={{ borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left', padding: '0.3rem 0.8rem 0.3rem 0' }} />
              <th style={{ textAlign: 'left', padding: '0.3rem 0.8rem' }}>{treatment.labelHigh}</th>
              <th style={{ textAlign: 'left', padding: '0.3rem 0.8rem' }}>{treatment.labelLow}</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style={{ padding: '0.3rem 0.8rem 0.3rem 0' }}>Class effort</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{pct(summary.classEffortHigh)}</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{pct(summary.classEffortLow)}</td>
            </tr>
            <tr>
              <td style={{ padding: '0.3rem 0.8rem 0.3rem 0' }}>Best possible</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{pct(summary.optimalEffortHigh)}</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{pct(summary.optimalEffortLow)}</td>
            </tr>
            <tr>
              <td style={{ padding: '0.3rem 0.8rem 0.3rem 0' }}>Mean earnings / contract</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{moneyUnit(summary.classEarningsHigh, cur)}</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{moneyUnit(summary.classEarningsLow, cur)}</td>
            </tr>
            <tr>
              <td style={{ padding: '0.3rem 0.8rem 0.3rem 0' }}>Best possible</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{moneyUnit(summary.optimalEarningsHigh, cur)}</td>
              <td style={{ padding: '0.3rem 0.8rem', ...tnum }}>{moneyUnit(summary.optimalEarningsLow, cur)}</td>
            </tr>
            <tr>
              <td colSpan={3} style={{ paddingTop: '0.8rem', color: colors.textSecondary, fontSize: '0.85rem' }}>
                Under the unreliable scorecard the class spent{' '}
                <strong>{Math.round(summary.lowConditionEffortSpend)} {cur}</strong> on effort
                across {summary.lowConditionContractsPlayed} contracts —{' '}
                <strong>
                  {summary.lowConditionContractsPlayed > 0
                    ? (summary.lowConditionEffortSpend / summary.lowConditionContractsPlayed).toFixed(2)
                    : '—'} {cur}
                </strong>{' '}
                per contract, against a best-possible{' '}
                <strong>{summary.lowConditionOptimalSpendPerContract.toFixed(2)} {cur}</strong>.
              </td>
            </tr>
          </tbody>
        </table>
      ),
    },
  ]

  // ═══════════════════════════════════════════════════════════════════════════
  // ⚠ THE STANDARD REPORT GRID — same shell as procurement, forecast and the rest
  // (spec §11, Elena 08-07). A CONSISTENCY REQUIREMENT, not a preference: an instructor
  // moving between games should not have to relearn the page.
  //
  // An earlier version rendered the tiers as one stacked page, on the reasoning that
  // Tier 3's four charts are read against each other. That reasoning was about ONE tier
  // and the fix belongs there — the Tier-3 modal shows all four charts together, so the
  // comparison survives while the page shape matches every other game.
  // ═══════════════════════════════════════════════════════════════════════════
  const tiles: ReportTileConfig[] = sectionDefs.map(sec => ({
    id: sec.id,
    title: sec.title,
    preview: sec.preview,
    onOpen: () => setActive(sec.id),
  }))
  const open = sectionDefs.find(sec => sec.id === active)

  // ⚠ THE WAY BACK. Reports had no nav at all, so an instructor who opened it was stranded
  // — the only exit was the browser's back button. The query string is carried forward
  // because `?token=`/`?_gid=` is how the instructor session identifies the instance across
  // pages; a link that dropped it lands somewhere with no session and no way to recover one.
  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]

  return (
    <InstructorChrome
      title="Supplier Scorecard — reports"
      navLinks={navLinks}
      onNavigate={navigate}
    >
      {report.isDemoCohort && (
        <p data-testid="sc-demo-banner" style={{
          background: '#fff3cd', border: '1px solid #e0c877', borderRadius: 6,
          padding: '0.6rem 0.9rem', margin: '0 0 1rem', fontWeight: 600,
        }}>
          ⚠ Demo cohort — robot data. There are no human students in this instance, so the
          charts below are drawn from {botCount} simulated players. Nothing here is a class.
        </p>
      )}
      <ReportBoard tiles={tiles} />
      {open && (
        <Modal title={open.title} onClose={() => setActive(null)}>
          <div data-testid={`sc-${open.id}`}>{open.body}</div>
        </Modal>
      )}
    </InstructorChrome>
  )
}
