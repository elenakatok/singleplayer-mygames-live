import { useState } from 'react'
import { colors, typography } from '@mygames/game-ui'
import { forecastGetExport } from './api'

// ═══════════════════════════════════════════════════════════════════════════════
// THE DATA EXPORT (spec §4, §5) — "load-bearing", in the spec's own word.
//
// ⚠ THE TAUGHT METHOD IS AN EXCEL METHOD. Students cannot run a regression on numbers
// they can only read off a chart, so if this button does not work the lecture's method
// is unusable and the assignment fails. That is why there are TWO ways to get the data
// out — a file download and copy-to-clipboard — rather than one: a managed laptop that
// blocks downloads is a real thing in a real classroom, and the clipboard route works
// there.
//
// ⚠ THE FILE IS FETCHED, NOT BUILT (spec §12). This component asks the server for
// finished CSV text and writes it to a Blob. It never assembles a file from data the
// client is holding — the client is not holding any series it could assemble one from,
// and that is the property the whole no-leak design rests on.
// ═══════════════════════════════════════════════════════════════════════════════

const button = (enabled: boolean) => ({
  padding: '0.45rem 0.9rem',
  fontSize: '0.85rem',
  fontWeight: 600,
  cursor: enabled ? 'pointer' : 'not-allowed',
  background: colors.white,
  color: enabled ? colors.text : colors.textSecondary,
  border: `1px solid ${colors.borderMid}`,
  borderRadius: 6,
})

export function DataExport({
  kind,
  label,
  testIdPrefix = 'fc-export',
}: {
  kind: 'history' | 'full'
  /** The button's own wording — spec §4 requires the in-play file be LABELLED as the
   *  five-year history, so the caller passes the label rather than this guessing. */
  label: string
  testIdPrefix?: string
}) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const fetchCsv = async () => {
    const res = await forecastGetExport(kind)
    return res
  }

  const onDownload = async () => {
    if (busy) return
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetchCsv()
      // A Blob + object URL, rather than a data: URI — data URIs are size-capped in
      // some browsers and an 84-row file is small but the cap is not worth learning
      // about in a classroom.
      const blob = new Blob([res.csv], { type: 'text/csv;charset=utf-8;' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = res.filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      setNote(`Downloaded ${res.filename}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download failed. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  const onCopy = async () => {
    if (busy) return
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetchCsv()
      // Tab-separated for the clipboard: pasting TSV into Excel or Sheets lands in
      // columns without an import dialog, where CSV usually does not.
      const tsv = res.csv.split('\r\n').map(line => line.split(',').join('\t')).join('\n')
      await navigator.clipboard.writeText(tsv)
      setNote('Copied — paste straight into Excel or Google Sheets.')
    } catch {
      setError('Could not copy. Use the download button instead.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ fontFamily: typography.fontFamily }}>
      <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
        <button
          data-testid={`${testIdPrefix}-download`}
          onClick={() => void onDownload()}
          disabled={busy}
          style={button(!busy)}
        >
          {busy ? 'Preparing…' : label}
        </button>
        <button
          data-testid={`${testIdPrefix}-copy`}
          onClick={() => void onCopy()}
          disabled={busy}
          style={button(!busy)}
        >
          Copy to clipboard
        </button>
      </div>
      {note && (
        <p data-testid={`${testIdPrefix}-note`} style={{ margin: '0.4rem 0 0', fontSize: '0.78rem', color: colors.textSecondary }}>
          {note}
        </p>
      )}
      {error && (
        <p role="alert" style={{ margin: '0.4rem 0 0', fontSize: '0.78rem', color: colors.errorAction }}>
          {error}
        </p>
      )}
    </div>
  )
}
