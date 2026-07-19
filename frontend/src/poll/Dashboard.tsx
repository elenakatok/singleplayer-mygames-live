import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SortableTable, colors, type SortableColumn } from '@mygames/game-ui'
import { InstructorChrome } from '../shared/InstructorChrome'
import { useInstructorSession } from '../shared/useInstructorSession'
import { pollGetReport, pollSyncRoster, pollInstructorSession, CLASSROOM_URL, type ResponseRow } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// Poll instructor dashboard — the RESPONSE-STATUS view (spec §7.3): who has and hasn't
// responded. NO Score & Record button (the poll is entirely ungraded, spec §6), so the
// action bar carries only a refresh + a count. Roster sync runs on load so
// non-responders are visible — but it writes/pushes NO grade. Reuses the shared,
// presentational InstructorChrome unchanged.
// ═══════════════════════════════════════════════════════════════════════════════

type SortKey = 'name' | 'responses' | 'status'

const statusRank = (r: ResponseRow) => (r.completed ? 2 : r.answered > 0 ? 1 : 0)
const statusLabel = (r: ResponseRow) => (r.completed ? 'Completed' : r.answered > 0 ? 'In progress' : 'No response')

const columns: readonly SortableColumn<ResponseRow, SortKey>[] = [
  { key: 'name', label: 'Name', render: r => r.name ?? '—', compare: (a, b) => (a.name ?? '').localeCompare(b.name ?? '') },
  {
    key: 'responses', label: 'Responses',
    render: r => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{r.answered} / {r.total}</span>,
    compare: (a, b) => a.answered - b.answered,
  },
  { key: 'status', label: 'Status', render: statusLabel, compare: (a, b) => statusRank(a) - statusRank(b) },
]

const TITLE = 'Poll — Dashboard'

export default function Dashboard() {
  const session = useInstructorSession(pollInstructorSession)
  const navigate = useNavigate()
  const [rows, setRows] = useState<ResponseRow[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(() => {
    pollGetReport()
      .then(res => setRows(res.responseStatus))
      .catch(err => setLoadError(err instanceof Error ? err.message : 'Failed to load responses.'))
  }, [])

  useEffect(() => {
    if (session.kind !== 'ready') return
    // Sync the roster (so non-responders show) then load. NO grade is written or pushed.
    pollSyncRoster().catch(() => {}).finally(load)
  }, [session.kind, load])

  const handleRefresh = async () => {
    setRefreshing(true)
    try { await pollSyncRoster().catch(() => {}); load() } finally { setRefreshing(false) }
  }

  const navLinks = [
    { label: 'Settings →', href: `/settings${window.location.search}` },
    { label: 'Reports →', href: `/reports${window.location.search}` },
  ]

  if (session.kind === 'loading') return <InstructorChrome title={TITLE}><p>Loading…</p></InstructorChrome>
  if (session.kind === 'no-token') return <InstructorChrome title={TITLE}><p>Open the dashboard from the classroom.</p></InstructorChrome>
  if (session.kind === 'error') {
    return (
      <InstructorChrome title={TITLE}>
        <p style={{ color: '#c00' }}>{session.message}</p>
        <p><a href={CLASSROOM_URL}>← Return to classroom</a></p>
      </InstructorChrome>
    )
  }

  const responded = rows?.filter(r => r.answered > 0).length ?? 0

  const actions = (
    <>
      <button
        onClick={() => void handleRefresh()}
        disabled={refreshing}
        style={{
          padding: '0.6rem 1.5rem', fontSize: '1rem', fontWeight: 600,
          cursor: refreshing ? 'not-allowed' : 'pointer',
          backgroundColor: refreshing ? '#999' : colors.text, color: colors.white,
          border: 'none', borderRadius: 6,
        }}
      >
        {refreshing ? 'Refreshing…' : 'Refresh'}
      </button>
      <span style={{ color: colors.textSecondary }}>
        {rows ? `${responded} responded / ${rows.length} on roster` : ''}
      </span>
    </>
  )

  return (
    <InstructorChrome title={TITLE} actions={actions} navLinks={navLinks} onNavigate={navigate}>
      {loadError && <p style={{ color: '#c00' }}>{loadError}</p>}
      {rows && (
        <SortableTable<ResponseRow, SortKey>
          rows={rows}
          columns={columns}
          getRowKey={r => r.participant_id}
          initialSortKey="status"
          initialSortDir="desc"
          emptyMessage="No students on the roster yet — open the dashboard from the classroom to sync it."
        />
      )}
    </InstructorChrome>
  )
}
