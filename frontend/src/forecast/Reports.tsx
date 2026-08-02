import { PageShell } from '../shared/PageShell'
import { typography, colors } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — instructor Reports. PLACEHOLDER (Slice 3).
//
// ⚠ See Dashboard.tsx for why this is an honest placeholder rather than a shell that
// looks functional. The route exists because App.tsx maps all four per-game screens.
// ═══════════════════════════════════════════════════════════════════════════════

export default function Reports() {
  return (
    <PageShell>
      <h1 style={{ fontFamily: typography.fontFamily, fontSize: '1.35rem', marginTop: 0 }}>
        Forecasting Game — reports
      </h1>
      <p style={{ fontFamily: typography.fontFamily, color: colors.textSecondary }}>
        Arrives in Slice&nbsp;3.
      </p>
    </PageShell>
  )
}
