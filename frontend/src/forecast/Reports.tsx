import { Fragment, useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors, typography } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  forecastGetReport, forecastInstructorSession,
  instructorErrorMessage,
  type ForecastReportData, type ForecastReportParticipant,
} from './api'
import { ClassChartSVG, MseHistogramSVG } from './ClassChartSVG'
import { formatBig, formatMetric, formatMoney, formatPercent, formatSigned } from './format'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — the reports page (Reports Contract v1, spec §10).
//
//   TIER 1  outcomes roster: every enrolled student, with MAE / MSE / Standard Error /
//           MAPE / Accuracy / bonus / bias / Y6-vs-Y7 / participation. Each row drills
//           through to that student's own month-by-month table.
//   TIER 2  the debrief paragraphs, every one, exportable — Elena reads these to write
//           the debrief slides, so scattered answers findable only student-by-student
//           would be unusable.
//   TIER 3  (a) the class chart: average actual vs average forecast vs the TRUE
//               systematic component, with per-month denominators;
//           (b) the MSE histogram with the §2.3 benchmarks as reference lines.
//
// ⚠ THE TIER-3 SUMMARY BOX *IS* THE DEBRIEF SLIDE (spec §10). It puts the class's own
// mean MAE / MSE / Standard Error / bias beside the benchmark MSEs, which is slide 10's
// comparison table rebuilt from the class's own play. That is why the benchmark column
// sits inside the same box rather than in a panel of its own.
//
// ⚠ ACCURACY IS NEVER GRADED (spec §6). Every outcome column here is an OUTCOME;
// `participation_score` is the only graded number, and it comes from finishing.
// ═══════════════════════════════════════════════════════════════════════════════

const card = {
  background: colors.white,
  border: `1px solid ${colors.borderMid}`,
  borderRadius: 8,
  padding: '1rem 1.1rem',
  marginBottom: '1.5rem',
} as const

const tnum = { fontVariantNumeric: 'tabular-nums' as const }

const th = {
  padding: '0.35rem 0.5rem', fontSize: '0.72rem', fontWeight: 600,
  color: colors.textSecondary, borderBottom: `1px solid ${colors.borderMid}`,
  textAlign: 'right' as const, whiteSpace: 'nowrap' as const,
}
const td = {
  padding: '0.32rem 0.5rem', fontSize: '0.8rem', textAlign: 'right' as const,
  ...tnum, borderBottom: `1px solid ${colors.borderLight ?? '#eee'}`, whiteSpace: 'nowrap' as const,
}

const dash = (v: number | null, f: (n: number) => string) => (v === null ? '—' : f(v))

const statusText = (r: ForecastReportParticipant) =>
  r.finalized ? 'Finalized'
    : r.completed ? 'Finished'
      : r.launched ? `In progress (${r.months_played})`
        : 'Not started'

/** Tier 1 — the outcomes roster, with a drill-down row per student (spec §10). */
function Tier1({ participants }: { participants: ForecastReportParticipant[] }) {
  const [open, setOpen] = useState<string | null>(null)

  return (
    <section style={card}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Tier 1 — outcomes roster</h2>
      <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: colors.textSecondary }}>
        Every enrolled student. Click a row for their month-by-month table.
        {' '}<strong>Forecast accuracy is never graded</strong> — participation is scored on finishing.
      </p>
      <div style={{ overflowX: 'auto' }}>
        <table data-testid="fc-tier1" style={{ borderCollapse: 'collapse', width: '100%', minWidth: '900px', fontFamily: typography.fontFamily }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Name</th>
              <th style={{ ...th, textAlign: 'left' }}>Status</th>
              <th style={th}>Months</th>
              <th style={th}>MSE</th>
              <th style={th}>Std Error</th>
              <th style={th}>MAE</th>
              <th style={th}>Bias</th>
              <th style={th}>MAPE</th>
              <th style={th}>Accuracy</th>
              <th style={th}>Bonus</th>
              <th style={th}>Y6 MSE</th>
              <th style={th}>Y7 MSE</th>
              <th style={th}>KC</th>
              <th style={th}>Participation</th>
            </tr>
          </thead>
          <tbody>
            {participants.map(p => (
              <Fragment key={p.participant_id}>
                <tr
                  data-testid={`fc-tier1-row-${p.participant_id}`}
                  onClick={() => setOpen(open === p.participant_id ? null : p.participant_id)}
                  style={{ cursor: p.months_played > 0 ? 'pointer' : 'default' }}
                >
                  <td style={{ ...td, textAlign: 'left' }}>{p.name ?? p.participant_id}</td>
                  <td style={{ ...td, textAlign: 'left', color: p.completed ? colors.text : colors.textSecondary }}>
                    {statusText(p)}
                  </td>
                  <td style={td}>{p.months_played}</td>
                  <td style={{ ...td, fontWeight: 600 }} data-testid={`fc-tier1-mse-${p.participant_id}`}>
                    {dash(p.mse, formatBig)}
                  </td>
                  <td style={td}>{dash(p.standard_error, v => formatMetric(v))}</td>
                  <td style={td}>{dash(p.mae, v => formatMetric(v))}</td>
                  <td style={td}>{dash(p.mean_error, v => formatSigned(v, 1))}</td>
                  <td style={td}>{formatPercent(p.mape)}</td>
                  <td style={td}>{formatPercent(p.accuracy)}</td>
                  <td style={td}>{formatMoney(p.bonus)}</td>
                  <td style={td}>{dash(p.first_year_mse, formatBig)}</td>
                  <td style={td}>{dash(p.second_year_mse, formatBig)}</td>
                  <td style={td}>{p.knowledge_check_score === null ? '—' : formatPercent(p.knowledge_check_score, 0)}</td>
                  <td style={td}>{p.participation_score === null ? '—' : p.participation_score}</td>
                </tr>
                {open === p.participant_id && p.months.length > 0 && (
                  <tr>
                    <td colSpan={14} style={{ padding: '0.5rem 1rem 1rem', background: '#f8fafc' }}>
                      <table data-testid={`fc-drill-${p.participant_id}`} style={{ borderCollapse: 'collapse', fontFamily: typography.fontFamily }}>
                        <thead>
                          <tr>
                            <th style={th}>Period</th>
                            <th style={th}>Forecast</th>
                            <th style={th}>Actual</th>
                            <th style={th}>Error</th>
                            <th style={th}>Abs error</th>
                            <th style={th}>Squared error</th>
                            <th style={th}>Abs % error</th>
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
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  )
}

/** Tier 2 — every debrief paragraph, exportable (Reports Contract v1). */
function Tier2({ participants, prompt }: { participants: ForecastReportParticipant[]; prompt: string }) {
  const written = participants.filter(p => p.debrief !== null)

  const copyAll = async () => {
    const text = written.map(p => `${p.name ?? p.participant_id}\n${p.debrief}\n`).join('\n---\n\n')
    try { await navigator.clipboard.writeText(text) } catch { /* clipboard unavailable */ }
  }

  return (
    <section style={card}>
      <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Tier 2 — how they made their forecasts</h2>
      <p style={{ margin: '0 0 0.5rem', fontSize: '0.8rem', color: colors.textSecondary, fontStyle: 'italic' }}>
        &ldquo;{prompt}&rdquo;
      </p>
      <button
        data-testid="fc-tier2-copy"
        onClick={() => void copyAll()}
        style={{
          padding: '0.4rem 0.8rem', fontSize: '0.8rem', marginBottom: '0.75rem',
          background: colors.white, border: `1px solid ${colors.borderMid}`, borderRadius: 6, cursor: 'pointer',
        }}
      >
        Copy all {written.length} answers
      </button>
      {written.length === 0 ? (
        <p style={{ fontSize: '0.85rem', color: colors.textSecondary }}>No answers yet.</p>
      ) : (
        <div data-testid="fc-tier2">
          {written.map(p => (
            <div key={p.participant_id} style={{ marginBottom: '0.9rem', paddingBottom: '0.9rem', borderBottom: `1px solid ${colors.borderLight ?? '#eee'}` }}>
              <div style={{ fontSize: '0.8rem', fontWeight: 600, marginBottom: '0.2rem' }}>
                {p.name ?? p.participant_id}
                <span style={{ fontWeight: 400, color: colors.textSecondary }}>
                  {' '}— MSE {dash(p.mse, formatBig)}
                </span>
              </div>
              <div style={{ fontSize: '0.85rem', lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{p.debrief}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

export default function Reports() {
  const session = useInstructorSession(forecastInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ForecastReportData | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await forecastGetReport()) } catch (err) {
      setError(instructorErrorMessage(err))
    }
  }, [])

  useEffect(() => { if (session.kind === 'ready') void load() }, [session, load])

  if (session.kind !== 'ready' || (!data && !error)) {
    return <InstructorChrome title="Forecasting Game — reports"><p>Loading…</p></InstructorChrome>
  }
  if (error || !data) {
    return (
      <InstructorChrome title="Forecasting Game — reports">
        <p style={{ color: '#c00' }}>{error}</p>
      </InstructorChrome>
    )
  }

  const s = data.summary

  // ⚠ THE QUERY STRING IS CARRIED FORWARD — `?token=`/`?_gid=` is how the instructor
  // session identifies the instance across pages.
  const navLinks = [
    { label: 'Dashboard →', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]

  return (
    <InstructorChrome title="Forecasting Game — reports" navLinks={navLinks} onNavigate={navigate}>
      <Tier1 participants={data.participants} />
      <Tier2 participants={data.participants} prompt={data.debriefPrompt} />

      {/* ── Tier 3 (a): the class chart ─────────────────────────────────────── */}
      <section style={card}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Tier 3 — the class chart</h2>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: colors.textSecondary }}>
          Class average actual demand and class average forecast, against the true
          systematic component. Later months average fewer students — that is composition,
          not behaviour, which is why every month carries its own n.
        </p>
        <ClassChartSVG points={data.classChart} />
      </section>

      {/* ── The summary box: "this box IS the debrief slide" (spec §10) ─────── */}
      <section style={card}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>The comparison — this is the debrief slide</h2>
        <div style={{ display: 'flex', gap: '2rem', flexWrap: 'wrap' }}>
          <div style={{ minWidth: '15rem' }}>
            <h3 style={{ fontSize: '0.85rem', margin: '0 0 0.4rem' }}>
              This class ({s.students} {s.students === 1 ? 'student' : 'students'})
            </h3>
            <table data-testid="fc-summary" style={{ borderCollapse: 'collapse', fontFamily: typography.fontFamily }}>
              <tbody>
                <tr><td style={{ ...td, textAlign: 'left' }}>Mean MSE</td><td style={{ ...td, fontWeight: 700 }} data-testid="fc-summary-mse">{dash(s.meanMse, formatBig)}</td></tr>
                <tr><td style={{ ...td, textAlign: 'left' }}>Standard Error</td><td style={td}>{dash(s.standardError, v => formatMetric(v))}</td></tr>
                <tr><td style={{ ...td, textAlign: 'left' }}>Mean MAE</td><td style={td}>{dash(s.meanMae, v => formatMetric(v))}</td></tr>
                <tr><td style={{ ...td, textAlign: 'left' }}>Mean bias</td><td style={td}>{dash(s.meanBias, v => formatSigned(v, 1))}</td></tr>
                <tr><td style={{ ...td, textAlign: 'left' }}>Mean MAPE</td><td style={td}>{formatPercent(s.meanMape)}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ flex: 1, minWidth: '20rem' }}>
            <h3 style={{ fontSize: '0.85rem', margin: '0 0 0.4rem' }}>The benchmark rules</h3>
            {data.benchmarks === null ? (
              <p style={{ fontSize: '0.82rem', color: colors.textSecondary }}>
                This instance&rsquo;s demand model has been edited away from the published one,
                so the design&rsquo;s benchmark table does not describe it. Students see
                benchmarks recomputed against their own months instead.
              </p>
            ) : (
              <table data-testid="fc-benchmarks" style={{ borderCollapse: 'collapse', width: '100%', fontFamily: typography.fontFamily }}>
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
      </section>

      {/* ── Tier 3 (b): the MSE histogram (spec §10, "BUILD IN v1") ─────────── */}
      <section style={card}>
        <h2 style={{ fontSize: '1rem', marginTop: 0 }}>Tier 3 — the spread of student MSE</h2>
        <p style={{ margin: '0 0 0.75rem', fontSize: '0.8rem', color: colors.textSecondary }}>
          Where the class landed, with the benchmark rules marked. The tail on the right
          is the chased-the-noise group. The axis is logarithmic — MSE spans a 40× range,
          and on a linear axis everything competent would pile up at the left edge.
        </p>
        {data.histogram === null ? (
          <p style={{ fontSize: '0.85rem', color: colors.textSecondary }}>Nobody has played yet.</p>
        ) : (
          <MseHistogramSVG histogram={data.histogram} benchmarks={data.benchmarks ?? []} />
        )}
      </section>
    </InstructorChrome>
  )
}
