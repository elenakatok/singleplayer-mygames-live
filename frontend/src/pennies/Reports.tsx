import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ReportBoard, SortableTable, colors,
  type ReportTileConfig, type SortableColumn,
} from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { penniesGetReport, penniesInstructorSession, CLASSROOM_URL, type ReportData, type ReportParticipant } from '../api'
import { JarHistogramSVG } from './JarHistogramSVG'

// ═══════════════════════════════════════════════════════════════════════════════
// Reports (spec §8.2). Two instructor-only reports through the shared ReportBoard
// (tiles → modal, unchanged). Report 1 = frequency histogram + stats + a hidden-
// until-clicked "Show true value" button (Gary's request). Report 2 = a sortable
// Class Bids table (numeric sorts, default bid-descending). Before Score & Record,
// a clear "not yet scored" state — never a broken chart or empty table.
// ═══════════════════════════════════════════════════════════════════════════════

const money = (n: number | null) =>
  n == null ? '—' : '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// ── Local modal (each ReportBoard consumer supplies its own — see eBay/SAA) ─────
function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div
      onClick={onClose}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '1rem' }}
    >
      <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 10, padding: '1.25rem 1.5rem', maxWidth: 900, width: '100%', maxHeight: '90vh', overflow: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
          <h2 style={{ margin: 0, fontSize: '1.3rem' }}>{title}</h2>
          <button onClick={onClose} style={{ border: '1px solid #ccc', background: 'none', borderRadius: 4, padding: '0.3rem 0.7rem', cursor: 'pointer' }}>Close</button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Report 2 columns ────────────────────────────────────────────────────────────
type BidSortKey = 'name' | 'bid' | 'estimate' | 'truth' | 'status' | 'profit'

function bidColumns(trueValue: number): readonly SortableColumn<ReportParticipant, BidSortKey>[] {
  return [
    { key: 'name', label: 'Name', render: r => r.name ?? '—', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
    { key: 'bid', label: 'Bid', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.bid)}</span>, nullsLast: true, isNull: r => r.bid == null, compare: (a, b) => (a.bid ?? 0) - (b.bid ?? 0) },
    { key: 'estimate', label: 'Estimate', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.estimate)}</span>, nullsLast: true, isNull: r => r.estimate == null, compare: (a, b) => (a.estimate ?? 0) - (b.estimate ?? 0) },
    { key: 'truth', label: 'True Value', render: () => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(trueValue)}</span>, compare: () => 0 },
    { key: 'status', label: 'Winning Status', render: r => (r.won ? 'Won' : 'Did not win'), compare: (a, b) => Number(a.won) - Number(b.won) },
    { key: 'profit', label: 'Profit', render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{money(r.profit ?? (r.submitted ? 0 : null))}</span>, nullsLast: true, isNull: r => r.profit == null && !r.submitted, compare: (a, b) => (a.profit ?? 0) - (b.profit ?? 0) },
  ]
}

export default function Reports() {
  const session = useInstructorSession(penniesInstructorSession)
  const [data, setData] = useState<ReportData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [active, setActive] = useState<'analysis' | 'bids' | null>(null)
  const [showTruth, setShowTruth] = useState(false)

  useEffect(() => {
    if (session.kind !== 'ready') return
    penniesGetReport()
      .then(setData)
      .catch(e => setErr(e instanceof Error ? e.message : 'Failed to load reports.'))
  }, [session.kind])

  const navigate = useNavigate()
  const navLinks = [
    { label: '← Dashboard', href: `/dashboard${window.location.search}` },
    { label: 'Settings →', href: `/settings${window.location.search}` },
  ]
  const chrome = (body: ReactNode) => (
    <InstructorChrome title="Jar of Pennies — Reports" navLinks={navLinks} onNavigate={navigate}>
      {body}
    </InstructorChrome>
  )

  if (session.kind === 'loading') return chrome(<p>Loading…</p>)
  if (session.kind === 'no-token') return chrome(<p>Open reports from the classroom.</p>)
  if (session.kind === 'error') {
    return chrome(<><p style={{ color: '#c00' }}>{session.message}</p><p><a href={CLASSROOM_URL}>← Return to classroom</a></p></>)
  }
  if (err) return chrome(<p style={{ color: '#c00' }}>{err}</p>)
  if (!data) return chrome(<p>Loading reports…</p>)

  const submitters = data.participants.filter(p => p.submitted && p.bid != null)
  const hasResponses = data.stats.responses > 0

  const tiles: ReportTileConfig[] = [
    {
      id: 'analysis',
      title: 'Class Analysis',
      disabled: !hasResponses,
      preview: hasResponses
        ? <span>{data.stats.responses} response(s) — histogram + statistics</span>
        : <span style={{ color: '#94a3b8' }}>No responses yet.</span>,
      onOpen: () => { setShowTruth(false); setActive('analysis') },
    },
    {
      id: 'bids',
      title: 'Class Bids',
      disabled: !data.scored,
      preview: data.scored
        ? <span>{submitters.length} bid(s) — sortable table</span>
        : <span style={{ color: '#94a3b8' }}>Run Score &amp; Record to see winners and profit.</span>,
      onOpen: () => setActive('bids'),
    },
  ]

  const statCell = (label: string, value: string) => (
    <div style={{ padding: '0.5rem 0.75rem', borderBottom: '1px solid #eee' }}>
      <div style={{ fontSize: '0.8rem', color: '#666' }}>{label}</div>
      <div style={{ fontSize: '1.2rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{value}</div>
    </div>
  )

  return chrome(
    <>
      {!data.scored && (
        <p style={{ color: colors.textSecondary }}>
          Not yet scored. The histogram is available once students respond; the Class Bids table (winners, profit)
          appears after you run <strong>Score &amp; Record</strong> on the dashboard.
        </p>
      )}
      <ReportBoard tiles={tiles} />

      {active === 'analysis' && (
        <Modal title="Class Analysis" onClose={() => setActive(null)}>
          <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <div style={{ flex: '2 1 380px', minWidth: 320 }}>
              <JarHistogramSVG bids={submitters.map(p => p.bid as number)} estimates={submitters.map(p => p.estimate ?? 0)} />
            </div>
            <div style={{ flex: '1 1 220px', minWidth: 200, border: '1px solid #e2e8f0', borderRadius: 8 }}>
              {statCell('Number of Responses', String(data.stats.responses))}
              {statCell('Average Estimate', money(data.stats.avgEstimate))}
              {statCell('Average Bid', money(data.stats.avgBid))}
              {statCell('Winning Bid', money(data.stats.winningBid))}
              <div style={{ padding: '0.75rem' }}>
                {showTruth ? (
                  <div data-testid="pennies-true-value-reveal" style={{ fontWeight: 700 }}>
                    True value: <span style={{ color: '#137333' }}>{money(data.true_value)}</span>
                  </div>
                ) : (
                  <button
                    onClick={() => setShowTruth(true)}
                    style={{ padding: '0.5rem 1rem', fontWeight: 600, cursor: 'pointer', background: colors.text, color: colors.white, border: 'none', borderRadius: 6 }}
                  >
                    Show true value
                  </button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}

      {active === 'bids' && (
        <Modal title="Class Bids" onClose={() => setActive(null)}>
          <SortableTable<ReportParticipant, BidSortKey>
            rows={submitters}
            columns={bidColumns(data.true_value)}
            getRowKey={r => r.participant_id}
            initialSortKey="bid"
            initialSortDir="desc"
            emptyMessage="No bids yet."
          />
        </Modal>
      )}
    </>,
  )
}
