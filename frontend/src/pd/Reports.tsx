import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReportBoard, SortableTable, colors, type ReportTileConfig, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import {
  pdGetReport, pdInstructorSession, CLASSROOM_URL,
  type PdReportData, type PdReportParticipant, type PdStrategy,
} from './api'
import { CooperationChartSVG } from './CooperationChartSVG'
import { FirstMoveChartSVG } from './FirstMoveChartSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// PD reports (spec §9), through the shared ReportBoard + a modal per tile — the same
// shape poll uses. Four tiles:
//
//   Tier 1  Outcomes roster            — every student, completed or not
//   Tier 2  Debrief paragraphs         — GROUPED BY STRATEGY FACED
//   Tier 3a Cooperation rate by round  — the two-line debrief chart
//   Tier 3b Outcome by first decision  — grouped bars
//
// INSTRUCTOR-ONLY, all of it: every tile aggregates the assigned strategy, which is
// exactly what students may not see during play. pdGetReport is instructor-
// authenticated, and no student screen imports anything from this file.
//
// The Modal and the show-names toggle are PD's OWN copies of poll's pattern, not
// imports: both are private to poll/Reports.tsx, and lifting them into game-ui is a
// shared-package change (Elena's call), not something this slice should force.
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

const STRATEGY_LABEL: Record<PdStrategy, string> = { tft: 'Tit-for-tat', grim: 'GRIM' }
const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`)
const oneDp = (v: number | null) => (v == null ? '—' : v.toFixed(1))
const tnum = { fontVariantNumeric: 'tabular-nums' as const }

// ── Tier 1: the outcomes roster ────────────────────────────────────────────────

type RosterKey = 'name' | 'status' | 'rounds' | 'coop' | 'avgYears' | 'strategy' | 'kc'

function OutcomesTable({ rows, unit }: { rows: PdReportParticipant[]; unit: string }) {
  const columns: readonly SortableColumn<PdReportParticipant, RosterKey>[] = [
    { key: 'name', label: 'Name', render: r => r.name ?? '—', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
    {
      key: 'status', label: 'Status',
      render: r => (r.completed ? 'Completed' : r.launched ? 'In progress' : 'Not launched'),
      compare: (a, b) => (a.completed ? 2 : a.launched ? 1 : 0) - (b.completed ? 2 : b.launched ? 1 : 0),
    },
    { key: 'rounds', label: 'Rounds', render: r => <span style={tnum}>{r.rounds_played}</span>, compare: (a, b) => a.rounds_played - b.rounds_played },
    { key: 'coop', label: 'Cooperation', render: r => <span style={tnum}>{pct(r.cooperation_rate)}</span>, nullsLast: true, isNull: r => r.cooperation_rate == null, compare: (a, b) => (a.cooperation_rate ?? 0) - (b.cooperation_rate ?? 0) },
    { key: 'avgYears', label: `Avg ${unit} / round`, render: r => <span style={tnum}>{oneDp(r.avg_years)}</span>, nullsLast: true, isNull: r => r.avg_years == null, compare: (a, b) => (a.avg_years ?? 0) - (b.avg_years ?? 0) },
    { key: 'strategy', label: 'Opponent', render: r => (r.strategy ? STRATEGY_LABEL[r.strategy] : '—'), nullsLast: true, isNull: r => r.strategy == null, compare: (a, b) => (a.strategy ?? '').localeCompare(b.strategy ?? '') },
    { key: 'kc', label: 'KC', render: r => <span style={tnum}>{r.knowledge_check_score == null ? '—' : `${Math.round(r.knowledge_check_score * 100)}%`}</span>, nullsLast: true, isNull: r => r.knowledge_check_score == null, compare: (a, b) => (a.knowledge_check_score ?? 0) - (b.knowledge_check_score ?? 0) },
  ]
  return (
    <div data-testid="pd-report-outcomes">
      <SortableTable<PdReportParticipant, RosterKey>
        rows={rows} columns={columns} getRowKey={r => r.participant_id}
        initialSortKey="status" initialSortDir="desc" emptyMessage="No students yet." wrapHeaders
      />
      <p style={{ fontSize: '0.78rem', color: colors.textSecondary, marginTop: '0.5rem' }}>
        The {unit} column is an outcome, never a grade (spec §6).
      </p>
    </div>
  )
}

// ── Tier 2: debrief paragraphs, GROUPED BY STRATEGY FACED ──────────────────────

function DebriefAnswers({ rows }: { rows: PdReportParticipant[] }) {
  const [showNames, setShowNames] = useState(true)

  // Grouped so the contrast is READABLE, which is the whole point: students who faced
  // a forgiving opponent and students who faced an unforgiving one played two
  // different games, and the AI-summary pass wants them separated, not interleaved.
  const groups: { key: PdStrategy | 'none'; title: string; rows: PdReportParticipant[] }[] = [
    { key: 'tft', title: 'Faced tit-for-tat (forgiving)', rows: rows.filter(r => r.strategy === 'tft' && r.debrief) },
    { key: 'grim', title: 'Faced GRIM (never forgives)', rows: rows.filter(r => r.strategy === 'grim' && r.debrief) },
    { key: 'none', title: 'No opponent assigned', rows: rows.filter(r => r.strategy == null && r.debrief) },
  ]

  return (
    <div data-testid="pd-report-debrief">
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', fontSize: '0.9rem', cursor: 'pointer' }}>
        <input type="checkbox" data-testid="pd-debrief-shownames" checked={showNames} onChange={e => setShowNames(e.target.checked)} />
        Show names
      </label>

      {groups.every(g => g.rows.length === 0) && (
        <p style={{ color: colors.textSecondary }}>No paragraphs submitted yet.</p>
      )}

      {groups.map(g => g.rows.length === 0 ? null : (
        <section key={g.key} data-testid={`pd-debrief-group-${g.key}`} style={{ marginBottom: '1.5rem' }}>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.95rem', color: colors.text }}>
            {g.title} <span style={{ fontWeight: 400, color: colors.textSecondary }}>({g.rows.length})</span>
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {g.rows.map((r, i) => (
              <div key={r.participant_id} style={{ border: `1px solid ${colors.borderMid}`, borderRadius: 6, padding: '0.6rem 0.8rem' }}>
                <div style={{ fontSize: '0.8rem', color: colors.textSecondary, marginBottom: '0.25rem' }}>
                  {showNames ? (r.name ?? '—') : `Respondent ${i + 1}`}
                  {' · '}{r.rounds_played} rounds · {pct(r.cooperation_rate)} cooperation
                </div>
                <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.55, color: colors.text }}>{r.debrief}</div>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  )
}

const TITLE = 'Repeated Prisoner’s Dilemma — Reports'

export default function Reports() {
  const session = useInstructorSession(pdInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<PdReportData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null)

  useEffect(() => {
    if (session.kind !== 'ready') return
    pdGetReport().then(setData).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load reports.'))
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
  const completed = data.participants.filter(p => p.completed)

  const tiles: ReportTileConfig[] = [
    {
      id: 'outcomes',
      title: 'Outcomes — all students',
      preview: <span>{completed.length} completed / {data.participants.length} on roster</span>,
      onOpen: () => setActive('outcomes'),
    },
    {
      id: 'debrief',
      title: 'Debrief paragraphs (by opponent)',
      disabled: debriefs.length === 0,
      preview: debriefs.length === 0
        ? <span style={{ color: '#94a3b8' }}>No paragraphs yet.</span>
        : <span>{debriefs.length} paragraph(s) — grouped by strategy faced</span>,
      onOpen: () => setActive('debrief'),
    },
    {
      id: 'cooperation',
      title: 'Cooperation rate by round',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={{ color: '#94a3b8' }}>No rounds played yet.</span>
        : <span>{data.roundCount} rounds — tit-for-tat vs GRIM</span>,
      onOpen: () => setActive('cooperation'),
    },
    {
      id: 'firstmove',
      title: 'Outcome by first decision',
      disabled: played.length === 0,
      preview: played.length === 0
        ? <span style={{ color: '#94a3b8' }}>No rounds played yet.</span>
        : <span>Avg {data.unit} / round — opened {data.labels.C} vs {data.labels.D}</span>,
      onOpen: () => setActive('firstmove'),
    },
  ]

  return chrome(
    <>
      <ReportBoard tiles={tiles} />

      {active === 'outcomes' && (
        <Modal title="Outcomes — all students" onClose={() => setActive(null)}>
          <OutcomesTable rows={data.participants} unit={data.unit} />
        </Modal>
      )}
      {active === 'debrief' && (
        <Modal title={data.debriefPrompt} onClose={() => setActive(null)}>
          <DebriefAnswers rows={data.participants} />
        </Modal>
      )}
      {active === 'cooperation' && (
        <Modal title="Cooperation rate by round — tit-for-tat vs GRIM" onClose={() => setActive(null)}>
          <CooperationChartSVG points={data.charts.cooperation} />
        </Modal>
      )}
      {active === 'firstmove' && (
        <Modal title="Outcome by first decision" onClose={() => setActive(null)}>
          <FirstMoveChartSVG outcomes={data.charts.firstMove} labels={data.labels} unit={data.unit} />
        </Modal>
      )}
    </>,
  )
}
