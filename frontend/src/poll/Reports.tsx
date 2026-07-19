import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { ReportBoard, SortableTable, colors, type ReportTileConfig, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { pollGetReport, pollInstructorSession, CLASSROOM_URL, type PollReportData, type QuestionReport, type TextReport, type ResponseRow } from './api'
import { PieChartSVG } from './PieChartSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll reports (spec §7) — TYPE-DERIVED. One tile per VISIBLE question, in order; the
// tile's report is chosen by the question's TYPE (text → answers table; mc → pie),
// so an instructor-authored question is automatically reportable with no extra code.
// Plus a response-status tile. Rendered through the shared ReportBoard, unchanged.
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

// ── text report → answers table with a show/hide-names toggle (instructor-side) ──
function TextAnswers({ report }: { report: TextReport }) {
  const [showNames, setShowNames] = useState(true)
  type Row = { participant_id: string; name: string; value: string }
  const rows: Row[] = report.answers.map((a, i) => ({
    participant_id: a.participant_id,
    name: showNames ? (a.name ?? '—') : `Respondent ${i + 1}`,
    value: a.value,
  }))
  const columns: readonly SortableColumn<Row, 'name' | 'answer'>[] = [
    { key: 'name', label: 'Participant', render: r => r.name, compare: (a, b) => a.name.localeCompare(b.name), headerStyle: { width: '30%' } },
    { key: 'answer', label: 'Answer', render: r => <span style={{ whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{r.value}</span>, compare: () => 0 },
  ]
  return (
    <>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: '0.4rem', marginBottom: '0.75rem', fontSize: '0.9rem', cursor: 'pointer' }}>
        <input type="checkbox" checked={showNames} onChange={e => setShowNames(e.target.checked)} />
        Show names
      </label>
      <SortableTable<Row, 'name' | 'answer'> rows={rows} columns={columns} getRowKey={r => r.participant_id} initialSortKey="name" emptyMessage="No answers yet." wrapHeaders />
    </>
  )
}

function StatusTable({ status }: { status: ResponseRow[] }) {
  const rank = (r: ResponseRow) => (r.completed ? 2 : r.answered > 0 ? 1 : 0)
  const columns: readonly SortableColumn<ResponseRow, 'name' | 'status'>[] = [
    { key: 'name', label: 'Name', render: r => r.name ?? '—', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
    { key: 'status', label: 'Responses', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.answered} / {r.total}{r.completed ? ' ✓' : ''}</span>, compare: (a, b) => rank(a) - rank(b) },
  ]
  return <SortableTable<ResponseRow, 'name' | 'status'> rows={status} columns={columns} getRowKey={r => r.participant_id} initialSortKey="status" initialSortDir="desc" emptyMessage="No students yet." />
}

const TITLE = 'Poll — Reports'

export default function Reports() {
  const session = useInstructorSession(pollInstructorSession)
  const navigate = useNavigate()
  const [data, setData] = useState<PollReportData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<string | null>(null) // report id, or 'status'

  useEffect(() => {
    if (session.kind !== 'ready') return
    pollGetReport().then(setData).catch(e => setErr(e instanceof Error ? e.message : 'Failed to load reports.'))
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

  const count = (r: QuestionReport) => (r.type === 'mc' ? r.total : r.answers.length)

  const tiles: ReportTileConfig[] = [
    ...data.reports.map<ReportTileConfig>(r => ({
      id: r.id,
      title: r.prompt,
      disabled: count(r) === 0,
      preview: count(r) === 0
        ? <span style={{ color: '#94a3b8' }}>No responses yet.</span>
        : <span>{r.type === 'mc' ? `${r.total} vote(s) — pie chart` : `${r.answers.length} answer(s) — table`}</span>,
      onOpen: () => setActive(r.id),
    })),
    {
      id: 'status',
      title: 'Response status',
      preview: <span>{data.responseStatus.filter(s => s.answered > 0).length} of {data.totalParticipants} responded</span>,
      onOpen: () => setActive('status'),
    },
  ]

  const activeReport = data.reports.find(r => r.id === active)

  return chrome(
    <>
      {data.reports.length === 0 && (
        <p style={{ color: colors.textSecondary }}>
          No visible questions yet. Turn questions on in <strong>Settings</strong> — each visible question gets its own report here automatically.
        </p>
      )}
      <ReportBoard tiles={tiles} />

      {active === 'status' && (
        <Modal title="Response status" onClose={() => setActive(null)}>
          <StatusTable status={data.responseStatus} />
        </Modal>
      )}
      {activeReport && (
        <Modal title={activeReport.prompt} onClose={() => setActive(null)}>
          {activeReport.type === 'mc'
            ? <PieChartSVG slices={activeReport.slices} />
            : <TextAnswers report={activeReport} />}
        </Modal>
      )}
    </>,
  )
}
