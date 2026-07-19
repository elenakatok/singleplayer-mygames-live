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

export function JarScreen({
  jarImage,
  questions,
  onDone,
}: {
  jarImage: string
  questions: JarQuestion[]
  onDone: () => void
}) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [lightbox, setLightbox] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const estimateQ = questions.find(q => q.field === 'estimate')
  const bidQ = questions.find(q => q.field === 'bid')

  const validMoney = (raw: string | undefined): number | null => {
    if (raw == null || raw.trim() === '') return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return null
    return Math.round(n * 100) / 100
  }

  const estimate = validMoney(values.estimate)
  const bid = validMoney(values.bid)
  const canSubmit = estimate !== null && bid !== null && !submitting

  const handleSubmit = async () => {
    if (estimate === null || bid === null || submitting) return
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

  const renderField = (q: JarQuestion) => (
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
      </div>
      <p style={{ margin: '0.4rem 0 0', fontSize: '0.85rem', color: colors.textSecondary, lineHeight: 1.4 }}>
        {q.helper}
      </p>
    </section>
  )

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

      {/* 2 — Instruction banner. */}
      <div
        style={{
          ...card,
          background: '#f6f8fa',
          fontWeight: 500,
          color: colors.text,
        }}
      >
        You are bidding in the auction for the above-pictured jar of pennies.
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
        {submitting ? 'Submitting…' : 'Submit'}
      </button>

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
