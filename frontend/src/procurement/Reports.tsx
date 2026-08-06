import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ReportBoard, SortableTable, colors, typography,
  type ReportTileConfig, type SortableColumn,
} from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { ClassScatterSVG, classScatterPoints, classRivalPoints } from './ClassScatterSVG'
import { OpenClassScatterSVG, openClassExitPoints, openClassBotExits } from './OpenClassScatterSVG'
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

/**
 * ⚠⚠ TIER 1a USES THE SHARED `SortableTable`, as pennies/poll/pd/pricing/newsvendor and
 * forecast's own report already do. This table shipped as a plain `<table>` and therefore
 * never had column sorting — see BUILD_NOTES §6k. An ADOPTION, not a restoration.
 *
 * ⚠ THE COLUMN SET IS FORMAT-NEUTRAL. Name, status, rounds, won and profit are roster
 * facts both mechanisms produce, so the sorting is not wired to a sealed-only or
 * open-only column. The format-specific detail lives one level down, in the per-student
 * rounds modal, which is where the gate already is.
 *
 * ⚠ "See rounds" IS AN ACTION, NOT DATA, and is deliberately NOT a sortable column — it
 * is rendered inside the Name cell instead of occupying a column of its own. Sorting by
 * a button would mean nothing, and `SortableTable` makes every column's header clickable.
 */
type RosterKey = 'name' | 'status' | 'rounds' | 'won' | 'profit'

export const rosterColumns = (
  onOpenStudent: (id: string) => void,
): readonly SortableColumn<ProcurementReportRow, RosterKey>[] => [
  {
    key: 'name',
    label: 'Name',
    render: r => (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.5rem' }}>
        {r.name ?? r.participantId}
        {r.roundsPlayed > 0 && (
          <button
            data-testid={`proc-rep-open-${r.participantId}`}
            onClick={() => onOpenStudent(r.participantId)}
            style={{
              fontSize: '0.7rem', border: `1px solid ${colors.border}`,
              background: 'none', borderRadius: 4, padding: '0.1rem 0.45rem',
              cursor: 'pointer', whiteSpace: 'nowrap',
            }}
          >See rounds ↗</button>
        )}
      </span>
    ),
    // ⚠ CASE-INSENSITIVE via localeCompare's collation, not a lowercased copy.
    compare: (a, b) => (a.name ?? a.participantId).localeCompare(
      b.name ?? b.participantId, undefined, { sensitivity: 'base' }),
  },
  {
    key: 'status',
    label: 'Status',
    render: r => r.finished ? 'Finished' : r.roundsPlayed > 0 ? 'In progress' : 'Not started',
    // ⚠ RANKED, NOT ALPHABETICAL — alphabetically "Finished" precedes "Not started",
    // which orders the class by nothing anybody cares about.
    compare: (a, b) => rosterRank(a) - rosterRank(b),
  },
  // ⚠ THE CELL IS THE BARE COUNT, unchanged from the plain table this replaced. Adding
  // "of 8" would be a presentation change riding along on a sorting change, and the
  // browser harness reads this cell by value.
  { key: 'rounds', label: 'Rounds', render: r => r.roundsPlayed, compare: (a, b) => a.roundsPlayed - b.roundsPlayed },
  { key: 'won', label: 'Won', render: r => r.roundsWon, compare: (a, b) => a.roundsWon - b.roundsWon },
  { key: 'profit', label: 'Profit', render: r => r.profitTotal, compare: (a, b) => a.profitTotal - b.profitTotal },
]

/** Not started < in progress < finished. ⚠ The report has no `finalized` state of its
 *  own — that is the dashboard's, which reads `normalizedScore`. */
export const rosterRank = (r: ProcurementReportRow) =>
  r.finished ? 2 : r.roundsPlayed > 0 ? 1 : 0

function RosterTable({ rows, onOpenStudent }: {
  rows: ProcurementReportRow[]
  onOpenStudent: (id: string) => void
}) {
  return (
    <SortableTable<ProcurementReportRow, RosterKey>
      rows={rows}
      columns={rosterColumns(onOpenStudent)}
      getRowKey={r => r.participantId}
      initialSortKey="name"
      tableTestId="proc-rep-roster"
      emptyMessage="No students yet."
    />
  )
}

// ── Tier 1b ────────────────────────────────────────────────────────────────────

function StudentRounds({ row, currency, isOpen }: {
  row: ProcurementReportRow
  currency: string
  /** ⚠ THE GATE. The two formats record different quantities, not the same quantity
   *  under different names — see the note above the columns. */
  isOpen: boolean
}) {
  return (
    <div style={{ overflowX: 'auto' }}>
      {/* ⚠⚠ THE CAPTION IS REWRITTEN, NOT ADAPTED (Elena, CP4b). The sealed one explains
          β — "the bid that maximises expected profit at that cost" — which is a true
          sentence about a sealed auction and a false one about this. */}
      <p style={{ margin: '0 0 0.6rem', fontSize: '0.8rem', color: colors.textSecondary }}>
        {isOpen
          ? 'What this student drew, where they stopped bidding, and what the contract '
            + 'finally went for. ↑ marks a round they WON: the auction ended before anyone '
            + 'pushed them lower, so that exit price is an upper bound on where they would '
            + 'have stopped, not the stopping point itself.'
          : 'What this student drew, what they bid, and what the round paid. \u201cOptimal\u201d is the '
            + 'bid that maximises expected profit at that cost \u2014 the same number the student saw '
            + 'on their own results screen.'}
      </p>
      <table data-testid="proc-rep-detail" style={{ borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>Round</th>
            <th style={th}>Cost</th>
            {/* ⚠ THE OPEN COLUMNS ARE cost / exit price / final price / won / profit.
                There is no "Bid" — a round contains many — and no "Optimal", because the
                sealed optimal bid has no meaning in a descending auction. */}
            {isOpen
              ? <th style={th}>Exit price</th>
              : <><th style={th}>Bid</th><th style={th}>Optimal</th></>}
            <th style={th}>{isOpen ? 'Final price' : 'Price'}</th>
            <th style={{ ...th, textAlign: 'left' }}>Won</th>
            <th style={th}>Profit</th>
          </tr>
        </thead>
        <tbody>
          {row.rounds.map(x => (
            <tr key={x.round}>
              <td style={td}>{x.round}</td>
              <td style={td}>{x.yourCost}</td>
              {isOpen
                ? (
                  <td style={td} data-testid={`proc-rep-exit-${x.round}`}>
                    {x.exitPrice ?? '\u2014'}
                    {/* The censoring marker travels with the number wherever it is shown. */}
                    {x.exitCensored && <span title="won — nobody pushed them lower"> ↑</span>}
                  </td>
                )
                : (
                  <>
                    <td style={td}>{x.yourBid ?? '\u2014'}</td>
                    <td style={td}>{x.yourEquilibriumBid ?? '\u2014'}</td>
                  </>
                )}
              <td style={td}>{x.price ?? '\u2014'}</td>
              <td style={{ ...td, textAlign: 'left' }}>{x.won ? 'Yes' : 'No'}</td>
              <td style={td}>{x.profit}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td style={{ ...td, fontWeight: 600, textAlign: 'left' }} colSpan={isOpen ? 5 : 6}>
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
  // ⚠ DEFAULT OFF (§7): the reader sees the class cloud first and reveals the benchmark.
  const [showBots, setShowBots] = useState(false)

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
  // ⚠⚠ THE FORMAT GATE, read once and threaded to every surface that depends on it.
  // Before CP4b this page read `data.format` only to print a label, and the class chart
  // rendered the SEALED scatter for open instances — β drawn through cascade bids, under
  // a caption its own data contradicted. Every format-dependent surface is gated here:
  // the chart, the per-student rounds modal, the tile counts, and every caption.
  const isOpen = data?.format === 'open_descending'
  const studentBids = data ? (isOpen ? openClassExitPoints(data).length : classScatterPoints(data).length) : 0
  const rivalBids = data ? (isOpen ? openClassBotExits(data).length : classRivalPoints(data).length) : 0
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
      // ⚠ THE TILE NAMES THE RIGHT QUANTITY. In an open instance the chart is not "every
      // bid" — a single round contains a dozen of them and none is the decision.
      title: isOpen ? 'Where the class stopped' : 'Every bid in the class',
      preview: (
        <Stat
          value={String(studentBids)}
          label={isOpen
            ? `student exits · ${rivalBids} supplier exits`
            : `student bids · ${rivalBids} rival bids`}
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
          <StudentRounds row={openRow} currency={data?.currencyLabel ?? 'ECU'} isOpen={isOpen} />
        </Modal>
      )}

      {active === 'chart' && data && (
        <Modal
          title={isOpen
            ? 'Where every student stopped, against their own cost'
            : 'Every bid in the class, against the bidder\u2019s own cost'}
          onClose={() => setActive(null)}
        >
          {/* ⚠⚠ THE GATE THAT WAS MISSING. `ClassScatterSVG` plots bid-vs-cost with \u03b2 as the
              benchmark, which is the right chart for a sealed auction and a wrong one for a
              descending auction \u2014 it judges rounds against a line they were never played
              against. The open chart is a different quantity on the y axis and a different
              benchmark, so it is a different component, not a prop. */}
          {isOpen
            ? <OpenClassScatterSVG report={data} showBots={showBots} />
            : <ClassScatterSVG report={data} />}
          {isOpen && (
            <label style={{ display: 'block', fontSize: '0.8rem', marginTop: '0.6rem' }}>
              <input
                type="checkbox"
                data-testid="proc-rep-show-bots"
                checked={showBots}
                onChange={e => setShowBots(e.target.checked)}
              />
              {' '}Show the simulated suppliers (they stop exactly at cost, so they sit on the line)
            </label>
          )}
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
