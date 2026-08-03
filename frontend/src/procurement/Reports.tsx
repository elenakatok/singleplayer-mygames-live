import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { colors, typography } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  procurementGetReport, procurementInstructorSession, instructorErrorMessage,
  FORMAT_LABEL, type ProcurementReport,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — instructor reports.
//
// ⚠ TIER 1 + TIER 2 AT SPAWN (Reports Contract v2):
//   • Tier 1a — the roster view: every student, completed or not.
//   • Tier 1b — per-student decision detail: that student's rounds in full.
//   • Tier 2  — THE FREE-TEXT TIER, one report per text question. This game has exactly
//               one (the debrief), and it is wired FROM THE FIRST COMMIT. A game that
//               ships without it is a game whose paragraphs nobody reads — the standing
//               rule Elena has restated on every spawn, and the thing Slice 0 found
//               missing across the fleet.
//
// ⚠ TODO(build): TIER 3 IS CHECKPOINT 2. The scatter of every student's bid against the
// equilibrium markup line `c + (reserve − c)/n` (Part 1 §12) needs the bot rule
// conditioned on the reserve (Part 1 §5.1). Drawing that line before the game computes
// it would put a confident, wrong reference on the instructor's screen — the same class
// of mistake forecast's benchmark table made twice.
//
// ⚠ THE FORMAT IS NAMED IN THE HEADER. Two instances run side by side under one
// game_id and their results are not comparable; a report that did not say which
// mechanism produced it would invite exactly that comparison.
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

export default function Reports() {
  const session = useInstructorSession(procurementInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ProcurementReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await procurementGetReport()); setError(null) } catch (err) {
      setError(instructorErrorMessage(err))
    }
  }, [])

  useEffect(() => { if (session.kind === 'ready') void load() }, [session.kind, load])

  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]

  if (session.kind !== 'ready') {
    return (
      <InstructorChrome title="Procurement Auction — reports">
        <p>{session.kind === 'loading' ? 'Loading…'
          : session.kind === 'no-token' ? 'Open this page from the classroom so the link carries your instructor session.'
            : session.message}</p>
      </InstructorChrome>
    )
  }

  const rows = data?.rows ?? []
  const textQuestions = data?.textQuestions ?? []

  return (
    <InstructorChrome
      title="Procurement Auction — reports"
      navLinks={navLinks}
      onNavigate={navigate}
    >
      {error && <p style={{ color: '#b00' }}>{error}</p>}

      {data && (
        <p style={{ fontSize: '0.85rem', color: colors.textSecondary, marginBottom: '1.5rem' }}>
          <strong>{FORMAT_LABEL[data.format]}</strong> · {data.rounds} rounds ·
          {' '}reserve {data.reserve} {data.currencyLabel}
          {data.gradedTotal > 0 && <> · knowledge check out of {data.gradedTotal}</>}
        </p>
      )}

      {/* ── Tier 1a: the roster ───────────────────────────────────────────── */}
      <h2 style={{ fontSize: '0.95rem' }}>Every student</h2>
      <div style={{ overflowX: 'auto', marginBottom: '2.5rem' }}>
        <table data-testid="proc-rep-roster" style={{ borderCollapse: 'collapse', width: '100%', fontFamily: typography.fontFamily }}>
          <thead>
            <tr>
              <th style={{ ...th, textAlign: 'left' }}>Name</th>
              <th style={th}>Rounds</th>
              <th style={th}>Won</th>
              <th style={th}>Profit</th>
              <th style={th}>KC</th>
              <th style={{ ...th, textAlign: 'left' }} />
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.participantId}>
                <td style={{ ...td, textAlign: 'left' }}>{r.name ?? r.participantId}</td>
                <td style={td}>{r.roundsPlayed}</td>
                <td style={td}>{r.roundsWon}</td>
                <td style={td}>{r.profitTotal}</td>
                <td style={td}>
                  {r.knowledgeCheckScore === null ? '—'
                    : data && data.gradedTotal > 0
                      ? `${Math.round(r.knowledgeCheckScore * data.gradedTotal)}/${data.gradedTotal}`
                      : `${Math.round(r.knowledgeCheckScore * 100)}%`}
                </td>
                <td style={{ ...td, textAlign: 'left' }}>
                  {r.roundsPlayed > 0 && (
                    <button
                      style={{ fontSize: '0.75rem' }}
                      onClick={() => setOpen(open === r.participantId ? null : r.participantId)}
                    >{open === r.participantId ? 'Hide' : 'Rounds'}</button>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td style={{ ...td, textAlign: 'left' }} colSpan={6}>No students yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* ── Tier 1b: one student's rounds ─────────────────────────────────── */}
      {open && (() => {
        const r = rows.find(x => x.participantId === open)
        if (!r) return null
        return (
          <div style={{ marginBottom: '2.5rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>{r.name ?? r.participantId} — every round</h2>
            <div style={{ overflowX: 'auto' }}>
              <table data-testid="proc-rep-detail" style={{ borderCollapse: 'collapse', fontFamily: typography.fontFamily }}>
                <thead>
                  <tr>
                    <th style={th}>Round</th>
                    <th style={th}>Cost</th>
                    <th style={th}>Bid</th>
                    <th style={{ ...th, textAlign: 'left' }}>Won</th>
                    <th style={th}>Price</th>
                    <th style={th}>Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rounds.map(x => (
                    <tr key={x.round}>
                      <td style={td}>{x.round}</td>
                      <td style={td}>{x.yourCost}</td>
                      <td style={td}>{x.yourBid ?? '—'}</td>
                      <td style={{ ...td, textAlign: 'left' }}>{x.won ? 'Yes' : 'No'}</td>
                      <td style={td}>{x.price ?? '—'}</td>
                      <td style={td}>{x.profit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      })()}

      {/* ── Tier 2: one report PER FREE-TEXT QUESTION — the spawn gate ───────── */}
      {/* ⚠ FOUR ACROSS THE TWO FORMATS (S8/S9 sealed, O9/O10 open). Rendered from the
          server's `textQuestions` list rather than hardcoded, so a question switched on
          in Settings gets its tile with no code change — and one switched off does not
          leave an empty heading behind. */}
      {textQuestions.map(q => {
        const answered = rows.filter(r => typeof r.freeText?.[q.field] === 'string')
        return (
          <section key={q.field} style={{ marginBottom: '2.5rem' }}>
            <h2 style={{ fontSize: '0.95rem' }}>
              {q.stage === 'prep' ? 'Before play' : 'After the results'} — {q.field}
            </h2>
            <p style={{ fontSize: '0.8rem', color: colors.textSecondary, fontStyle: 'italic' }}>
              {q.prompt}
            </p>
            <div data-testid={`proc-rep-text-${q.field}`}>
              {answered.length === 0 && (
                <p style={{ fontSize: '0.85rem', color: colors.textSecondary }}>
                  No answers yet.
                </p>
              )}
              {answered.map(r => (
                <div key={r.participantId} style={{
                  marginBottom: '1rem', padding: '0.6rem 0.8rem',
                  border: `1px solid ${colors.borderMid}`, borderRadius: 6,
                }}>
                  <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.textSecondary }}>
                    {r.name ?? r.participantId}
                  </div>
                  <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{r.freeText[q.field]}</div>
                </div>
              ))}
            </div>
          </section>
        )
      })}
    </InstructorChrome>
  )
}
