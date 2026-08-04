import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReportBoard, colors, typography, type ReportTileConfig } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { ClassScatterSVG, classScatterPoints, classRivalPoints } from './ClassScatterSVG'
import {
  procurementGetReport, procurementInstructorSession, instructorErrorMessage,
  FORMAT_LABEL, type ProcurementReport, type ProcurementReportRow,
} from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction — instructor reports, as a TILE GRID with a MODAL PER REPORT.
// The same shape poll, PD, pricing, newsvendor and forecast use (`ReportBoard` +
// `Modal`), adopted 08-03 so this game stops being the one that scrolls.
//
//   Tier 1a  Every student            roster totals
//   Tier 1b  One student's rounds     the drill-through, from a row's "See rounds ↗"
//   Tier 3   The class chart          ← THE LECTURE SLIDE
//   Tier 2   Before play — S8         one tile per free-text question…
//   Tier 2   After the results — S9   …built from the server's list, not hardcoded
//
// ⚠ THE ROSTER HAS NO KC COLUMN (Elena, 08-03). The knowledge check is scored on its own
// path and pushed to the gradebook separately; a percentage beside auction profit invited
// reading one as a component of the other, which it never is (§11). The denominator still
// appears in the header, where it describes the instance rather than a student.
//
// ⚠ TIER 2 IS THE SPAWN GATE and it is rendered FROM `data.textQuestions`, so a question
// switched on in Settings gets its own tile with no code change here — and one switched
// off leaves no empty heading behind.
//
// ⚠ THE FORMAT IS NAMED IN THE HEADER. Two instances run side by side under one game_id
// and their results are not comparable; a report that did not say which mechanism
// produced it would invite exactly that comparison.
// ═══════════════════════════════════════════════════════════════════════════════

/** The modal every report opens into. Copied from forecast/Reports.tsx deliberately — it
 *  is a dozen lines of layout and the fleet already has five copies; promoting it into
 *  game-ui is a real question and Elena's, not one to settle quietly here. */
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex',
        alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem',
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: colors.white, borderRadius: 10, padding: '1.25rem 1.5rem',
          maxWidth: 1100, width: '100%', maxHeight: '90vh', overflow: 'auto',
          fontFamily: typography.fontFamily,
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
          gap: '1rem', marginBottom: '1rem',
        }}>
          <h2 style={{ margin: 0, fontSize: '1.2rem', lineHeight: 1.35 }}>{title}</h2>
          <button
            data-testid="proc-rep-modal-close"
            onClick={onClose}
            style={{
              border: `1px solid ${colors.border}`, background: 'none', borderRadius: 4,
              padding: '0.3rem 0.7rem', cursor: 'pointer', flexShrink: 0,
            }}
          >Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

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

/** A big number for a tile's preview — what the grid shows before anything is opened. */
function Stat({ value, label, testId }: { value: string; label: string; testId?: string }) {
  return (
    <div style={{ textAlign: 'center' }}>
      <div data-testid={testId} style={{ fontSize: '1.6rem', fontWeight: 700, ...tnum }}>{value}</div>
      <div style={{ fontSize: '0.78rem', color: colors.textSecondary }}>{label}</div>
    </div>
  )
}

// ── Tier 1a ────────────────────────────────────────────────────────────────────

function RosterTable({ rows, onOpenStudent }: {
  rows: ProcurementReportRow[]
  onOpenStudent: (id: string) => void
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table data-testid="proc-rep-roster" style={{ borderCollapse: 'collapse', width: '100%' }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: 'left' }}>Name</th>
            <th style={{ ...th, textAlign: 'left' }}>Status</th>
            <th style={th}>Rounds</th>
            <th style={th}>Won</th>
            <th style={th}>Profit</th>
            {/* ⚠ NO KC COLUMN — see the file header. */}
            <th style={{ ...th, textAlign: 'left' }} />
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.participantId}>
              <td style={{ ...td, textAlign: 'left' }}>{r.name ?? r.participantId}</td>
              <td style={{ ...td, textAlign: 'left' }}>
                {r.finished ? 'Finished' : r.roundsPlayed > 0 ? 'In progress' : 'Not started'}
              </td>
              <td style={td}>{r.roundsPlayed}</td>
              <td style={td}>{r.roundsWon}</td>
              <td style={td}>{r.profitTotal}</td>
              <td style={{ ...td, textAlign: 'left' }}>
                {r.roundsPlayed > 0 && (
                  <button
                    data-testid={`proc-rep-open-${r.participantId}`}
                    onClick={() => onOpenStudent(r.participantId)}
                    style={{
                      fontSize: '0.75rem', border: `1px solid ${colors.border}`,
                      background: 'none', borderRadius: 4, padding: '0.2rem 0.55rem',
                      cursor: 'pointer', whiteSpace: 'nowrap',
                    }}
                  >See rounds ↗</button>
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
  )
}

// ── Tier 1b ────────────────────────────────────────────────────────────────────

function StudentRounds({ row, currency }: { row: ProcurementReportRow; currency: string }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <p style={{ margin: '0 0 0.6rem', fontSize: '0.8rem', color: colors.textSecondary }}>
        What this student drew, what they bid, and what the round paid. “Optimal” is the
        bid that maximises expected profit at that cost — the same number the student saw
        on their own results screen.
      </p>
      <table data-testid="proc-rep-detail" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Round</th>
            <th style={th}>Cost</th>
            <th style={th}>Bid</th>
            <th style={th}>Optimal</th>
            <th style={th}>Price</th>
            <th style={{ ...th, textAlign: 'left' }}>Won</th>
            <th style={th}>Profit</th>
          </tr>
        </thead>
        <tbody>
          {row.rounds.map(x => (
            <tr key={x.round}>
              <td style={td}>{x.round}</td>
              <td style={td}>{x.yourCost}</td>
              <td style={td}>{x.yourBid ?? '—'}</td>
              <td style={td}>{x.yourEquilibriumBid ?? '—'}</td>
              <td style={td}>{x.price ?? '—'}</td>
              <td style={{ ...td, textAlign: 'left' }}>{x.won ? 'Yes' : 'No'}</td>
              <td style={td}>{x.profit}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, fontWeight: 600, textAlign: 'left' }} colSpan={6}>
              Total ({currency})
            </td>
            <td style={{ ...td, fontWeight: 600 }}>{row.profitTotal}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  )
}

// ── Tier 2 ─────────────────────────────────────────────────────────────────────

function FreeTextReport({ rows, field, prompt }: {
  rows: ProcurementReportRow[]; field: string; prompt: string
}) {
  const answered = rows.filter(r => typeof r.freeText?.[field] === 'string')
  return (
    <div data-testid={`proc-rep-text-${field}`}>
      <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: colors.textSecondary, fontStyle: 'italic' }}>
        {prompt}
      </p>
      {answered.length === 0 && (
        <p style={{ fontSize: '0.85rem', color: colors.textSecondary }}>No answers yet.</p>
      )}
      {answered.map(r => (
        <div key={r.participantId} style={{
          marginBottom: '0.75rem', padding: '0.6rem 0.8rem',
          border: `1px solid ${colors.borderMid}`, borderRadius: 6,
        }}>
          <div style={{ fontSize: '0.75rem', fontWeight: 600, color: colors.textSecondary }}>
            {r.name ?? r.participantId}
          </div>
          <div style={{ fontSize: '0.85rem', whiteSpace: 'pre-wrap' }}>{r.freeText[field]}</div>
        </div>
      ))}
    </div>
  )
}

// ═══════════════════════════════════════════════════════════════════════════════

export default function Reports() {
  const session = useInstructorSession(procurementInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<ProcurementReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** Which report is open: a tile id, or `student:<participantId>` for the drill-through. */
  const [active, setActive] = useState<string | null>(null)

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
  const played = rows.filter(r => r.roundsPlayed > 0)
  const finished = rows.filter(r => r.finished).length
  const studentBids = data ? classScatterPoints(data).length : 0
  const rivalBids = data ? classRivalPoints(data).length : 0
  const openStudent = active?.startsWith('student:') ? active.slice('student:'.length) : null
  const openRow = openStudent ? rows.find(r => r.participantId === openStudent) ?? null : null

  const tiles: ReportTileConfig[] = [
    {
      id: 'roster',
      title: 'Every student',
      preview: <Stat value={String(rows.length)} label={`${finished} finished`} testId="proc-tile-roster" />,
      onOpen: () => setActive('roster'),
    },
    {
      id: 'chart',
      title: 'Every bid in the class',
      preview: (
        <Stat
          value={String(studentBids)}
          label={`student bids · ${rivalBids} rival bids`}
          testId="proc-tile-chart"
        />
      ),
      onOpen: () => setActive('chart'),
      disabled: studentBids === 0,
    },
    ...textQuestions.map(q => ({
      id: `text:${q.field}`,
      title: `${q.stage === 'prep' ? 'Before play' : 'After the results'} — ${q.field}`,
      preview: (
        <Stat
          value={String(rows.filter(r => typeof r.freeText?.[q.field] === 'string').length)}
          label="answers"
          testId={`proc-tile-${q.field}`}
        />
      ),
      onOpen: () => setActive(`text:${q.field}`),
    })),
  ]

  const activeText = active?.startsWith('text:')
    ? textQuestions.find(q => q.field === active.slice('text:'.length)) ?? null
    : null

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

      <ReportBoard tiles={tiles} />

      {active === 'roster' && (
        <Modal title="Every student" onClose={() => setActive(null)}>
          <RosterTable rows={rows} onOpenStudent={id => setActive(`student:${id}`)} />
        </Modal>
      )}

      {/* ⚠ Closes BACK TO the roster, not to the board — the drill-through was opened
          from a roster row, so that is where "done looking at this student" returns to. */}
      {openRow && (
        <Modal
          title={`${openRow.name ?? openRow.participantId} — every round`}
          onClose={() => setActive('roster')}
        >
          <StudentRounds row={openRow} currency={data?.currencyLabel ?? 'ECU'} />
        </Modal>
      )}

      {active === 'chart' && data && (
        <Modal title="Every bid in the class, against the bidder’s own cost" onClose={() => setActive(null)}>
          <ClassScatterSVG report={data} />
        </Modal>
      )}

      {activeText && (
        <Modal
          title={`${activeText.stage === 'prep' ? 'Before play' : 'After the results'} — ${activeText.field}`}
          onClose={() => setActive(null)}
        >
          <FreeTextReport rows={played} field={activeText.field} prompt={activeText.prompt} />
        </Modal>
      )}
    </InstructorChrome>
  )
}
