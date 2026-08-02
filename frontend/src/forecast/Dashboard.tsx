import { PageShell } from '../shared/PageShell'
import { typography, colors } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// Forecasting — instructor dashboard. PLACEHOLDER (Slice 3).
//
// ⚠ DELIBERATELY NOT A WORKING-LOOKING SHELL. The route has to exist because App.tsx
// maps all four per-game screens, but an empty roster table with a Score & Record
// button that did nothing would be worse than an honest placeholder: Elena opens these
// pages to check state, and a page that looks functional and reports nothing is
// indistinguishable from a page reporting that nobody has played.
// ═══════════════════════════════════════════════════════════════════════════════

export default function Dashboard() {
  return (
    <PageShell>
      <h1 style={{ fontFamily: typography.fontFamily, fontSize: '1.35rem', marginTop: 0 }}>
        Forecasting Game — dashboard
      </h1>
      <p style={{ fontFamily: typography.fontFamily, color: colors.textSecondary }}>
        The roster, Score&nbsp;&amp;&nbsp;Record and the report tiles arrive in Slice&nbsp;3.
        The student game (the month loop and the final results screen) is complete and playable.
      </p>
    </PageShell>
  )
}
