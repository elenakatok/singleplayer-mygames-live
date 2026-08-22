import { useState } from 'react'
import type { CSSProperties } from 'react'
import { colors } from '@mygames/game-ui'
import { penniesSubmit, type JarQuestion } from '../api'

// ═══════════════════════════════════════════════════════════════════════════════
// The jar screen (spec §3.1). ONE screen, two numeric inputs, one submit.
//
// House pattern (from eBay): shared header (in PageShell), centered main, bordered
// card sections, label-above / helper-below. DELIBERATE DEPARTURES (Part-2 spec):
//   • The image IS the task, not decoration. It sits ABOVE the form in its own card,
//     ~280px, objectFit:CONTAIN (full image, the 4" scale arrow never cropped) —
//     NOT eBay's 220px cover-cropped square.
//   • Click the image to enlarge to a lightbox at native resolution (source 691×766;
//     not upscaled). Dismiss by clicking anywhere.
//   • Styled submit button (eBay's is browser-native).
//   • Responsive: inputs go full-width and the image scales on narrow viewports.
// ═══════════════════════════════════════════════════════════════════════════════

const card: CSSProperties = {
  border: '1px solid #d0d7de',
  borderRadius: 8,
  padding: '1rem 1.25rem',
  marginBottom: '1rem',
}

/** Whole-dollar formatter for the reverse-mode conversions and confirmation. */
const usd = (n: number) =>
  '$' + n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })

export function JarScreen({
  jarImage,
  questions,
  reverse = false,
  pennyValue = 1000,
  onDone,
}: {
  jarImage: string
  questions: JarQuestion[]
  /** Reverse (supplier/cost) mode: supplier copy, the shorthand-entry rule, and a
   *  confirm-in-dollars step before submit. Forward mode is byte-for-byte unchanged. */
  reverse?: boolean
  /** Dollars per penny — the shorthand factor AND the "under this is shorthand" cutoff. */
  pennyValue?: number
  onDone: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lightbox, setLightbox] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reverse only: the interpreted dollar amounts awaiting the student's confirmation.
  const [confirm, setConfirm] = useState<{ estimate: number; bid: number } | null>(null)

  const estimateQ = questions.find(q => q.field === 'estimate')
  const bidQ = questions.find(q => q.field === 'bid')

  const validMoney = (raw: string | undefined): number | null => {
    if (raw == null || raw.trim() === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 100) / 100
  }

  /**
   * The dollar amount a typed number MEANS in reverse mode. A number below one penny's
   * value is obviously shorthand (nobody bids $3 on a six-figure contract), so it is read
   * as that many pennies and multiplied up; anything at or above is taken as literal
   * dollars. Forward mode never calls this — the number is already the dollar amount.
   * The confirmation step always shows the result, so this heuristic is a convenience,
   * never the last word.
   */
  const toDollars = (n: number): number => {
    const d = n < pennyValue ? n * pennyValue : n
    return Math.round(d * 100) / 100
  }

  const estimate = validMoney(values.estimate)
  const bid = validMoney(values.bid)
  const canSubmit = estimate !== null && bid !== null && !submitting

  // Forward: submit the entered dollars directly (unchanged). Reverse: interpret, then
  // ask the student to confirm the resulting dollars before anything is written.
  const handleSubmit = async () => {
    if (estimate === null || bid === null || submitting) return
    if (reverse) {
      setError(null)
      setConfirm({ estimate: toDollars(estimate), bid: toDollars(bid) })
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      await penniesSubmit(estimate, bid)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
    }
  }

  // Reverse: the student confirmed the dollar figures — commit them.
  const handleConfirm = async () => {
    if (!confirm || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      await penniesSubmit(confirm.estimate, confirm.bid)
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.')
      setSubmitting(false)
      setConfirm(null)
    }
  }

  const renderField = (q: JarQuestion) => {
    const raw = validMoney(values[q.field])
    const preview = reverse && raw !== null ? toDollars(raw) : null
    return (
      <section style={card} key={q.field}>
        <label
          htmlFor={`pennies-${q.field}`}
          style={{ display: 'block', fontWeight: 600, marginBottom: '0.4rem', color: colors.text }}
        >
          {q.prompt}
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
          <span style={{ color: colors.textSecondary, fontSize: '1.1rem' }}>$</span>
          <input
            id={`pennies-${q.field}`}
            data-testid={`pennies-${q.field}`}
            type="number"
            inputMode="decimal"
            min={q.min}
            step="0.01"
            placeholder="0.00"
            value={values[q.field] ?? ''}
            disabled={submitting}
            onChange={e => setValues(v => ({ ...v, [q.field]: e.target.value }))}
            style={{
              flex: 1,
              maxWidth: 220,
              fontSize: '1.1rem',
              padding: '0.4rem 0.55rem',
              borderRadius: 4,
              border: `1px solid ${colors.inputBorder ?? '#cbd5e1'}`,
            }}
          />
          {preview !== null && (
            <span data-testid={`pennies-${q.field}-preview`} style={{ color: colors.textSecondary, fontSize: '0.95rem' }}>
              = {usd(preview)}
            </span>
          )}
        </div>
        <p style={{ margin: '0.4rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
          {q.helper}
        </p>
      </section>
    )
  }

  return (
    <div>
      <h1 style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>Jar of Pennies</h1>

      {/* 1 — The jar image: its own card, contained (never cropped), click to enlarge. */}
      <section style={{ ...card, textAlign: 'center' }}>
        <img
          src={jarImage}
          alt="A jar of pennies with a 4-inch height reference"
          onClick={() => setLightbox(true)}
          data-testid="pennies-jar-image"
          style={{
            width: '100%',
            maxWidth: 280,
            height: 'auto',
            objectFit: 'contain',
            borderRadius: 6,
            cursor: 'zoom-in',
          }}
        />
        <p style={{ margin: '0.5rem 0 0', fontSize: '0.8rem', color: colors.textSecondary }}>
          Click the image to enlarge.
        </p>
      </section>

      {/* 2 — Instruction banner (mode-dependent). */}
      <div
        style={{
          ...card,
          background: '#f6f8fa',
          fontWeight: 500,
          color: colors.text,
          lineHeight: 1.5,
        }}
      >
        {reverse ? (
          <>
            You are a supplier bidding for a contract. <strong>Each penny in the jar represents {usd(pennyValue)} of cost.</strong>{' '}
            Study the jar, estimate your cost, and place your bid. The <strong>lowest bid wins</strong> the contract —
            you are paid your bid and earn <strong>your bid minus your actual cost</strong>, so bidding below cost loses money.
          </>
        ) : (
          <>You are bidding in the auction for the above-pictured jar of pennies.</>
        )}
      </div>

      {/* 3–4 — Estimate then bid. */}
      {estimateQ && renderField(estimateQ)}
      {bidQ && renderField(bidQ)}

      {error && (
        <p data-testid="pennies-error" role="alert" style={{ color: '#c5221f', fontSize: '0.9rem', marginBottom: '0.75rem' }}>
          {error}
        </p>
      )}

      {/* 5 — Styled submit. */}
      <button
        data-testid="pennies-submit"
        onClick={() => void handleSubmit()}
        disabled={!canSubmit}
        style={{
          padding: '0.7rem 1.75rem',
          fontSize: '1rem',
          fontWeight: 600,
          cursor: canSubmit ? 'pointer' : 'not-allowed',
          backgroundColor: canSubmit ? colors.text : colors.textMuted ?? '#999',
          color: colors.white,
          border: 'none',
          borderRadius: 6,
          transition: 'background-color 0.15s',
        }}
      >
        {submitting && !confirm ? 'Submitting…' : reverse ? 'Review bid →' : 'Submit'}
      </button>

      {/* Reverse-mode confirmation — the dollar figures the student is committing. */}
      {confirm && (
        <div
          data-testid="pennies-confirm"
          style={{
            position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 90, padding: '1rem',
          }}
        >
          <div style={{ background: '#fff', borderRadius: 10, padding: '1.5rem 1.75rem', maxWidth: 460, width: '100%' }}>
            <h2 style={{ marginTop: 0, fontSize: '1.25rem', color: colors.text }}>Confirm your entry</h2>
            <p style={{ color: colors.textSecondary, lineHeight: 1.5, marginTop: 0 }}>
              Each penny is {usd(pennyValue)}, so you are submitting:
            </p>
            <div style={{ margin: '0.75rem 0 1.25rem', fontSize: '1.05rem', color: colors.text, lineHeight: 1.8 }}>
              <div>Your estimated cost: <strong data-testid="pennies-confirm-estimate">{usd(confirm.estimate)}</strong></div>
              <div>Your bid: <strong data-testid="pennies-confirm-bid">{usd(confirm.bid)}</strong></div>
            </div>
            <p style={{ color: '#c5221f', fontSize: '0.85rem', marginTop: 0 }}>
              This is final — you cannot change it after you confirm.
            </p>
            <div style={{ display: 'flex', gap: '0.6rem', marginTop: '1rem' }}>
              <button
                data-testid="pennies-confirm-yes"
                onClick={() => void handleConfirm()}
                disabled={submitting}
                style={{
                  padding: '0.6rem 1.4rem', fontSize: '1rem', fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  backgroundColor: submitting ? '#999' : colors.text, color: colors.white,
                  border: 'none', borderRadius: 6,
                }}
              >
                {submitting ? 'Submitting…' : 'Confirm & submit'}
              </button>
              <button
                data-testid="pennies-confirm-back"
                onClick={() => setConfirm(null)}
                disabled={submitting}
                style={{
                  padding: '0.6rem 1.4rem', fontSize: '1rem', fontWeight: 600,
                  cursor: submitting ? 'not-allowed' : 'pointer',
                  backgroundColor: colors.white, color: colors.text,
                  border: '1px solid #cbd5e1', borderRadius: 6,
                }}
              >
                Go back
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Lightbox — native-resolution, dismiss on any click. */}
      {lightbox && (
        <div
          onClick={() => setLightbox(false)}
          data-testid="pennies-lightbox"
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 100,
            cursor: 'zoom-out',
            padding: '1rem',
          }}
        >
          <img
            src={jarImage}
            alt="A jar of pennies with a 4-inch height reference, enlarged"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
          />
        </div>
      )}
    </div>
  )
}
