import { colors, typography } from '@mygames/game-ui'
import type { PricingLabels, PricingMarket } from './api'
import { PmgRules } from './MarketPanel'

// ═══════════════════════════════════════════════════════════════════════════════
// The PMG rules screen (spec §6.2) — a STANDALONE screen, shown BEFORE the knowledge
// check, in PMG instances only.
//
// WHY IT IS ITS OWN SCREEN and not just the panel that already rides on the
// price-entry screen: this replaces an in-lecture announcement. In the in-person deck
// Elena stops the class and tells them the rules have changed; a student who meets
// the same sentence as one panel among five, on a screen that is mostly a price box,
// will price first and read second. So it gets a screen with nothing else on it, and
// a button that means "I have read this".
//
// The in-game panel (RoundScreen) stays as it is — a reference for someone who has
// already been told, which is a different job from being told.
//
// It carries NO knowledge check of its own and nothing is submitted here: the server
// has no "read the rules" fact to store, and inventing one would gate a student out
// of their own game if it ever failed to write.
// ═══════════════════════════════════════════════════════════════════════════════

export function PmgRulesScreen({
  market,
  labels,
  minRounds,
  maxRounds,
  onDone,
}: {
  market: PricingMarket
  labels: PricingLabels
  minRounds: number
  maxRounds: number
  onDone: () => void
}) {
  return (
    <div>
      <p style={{ color: colors.textSecondary, marginBottom: '0.3rem', fontSize: typography.sizeSm }}>
        Before you begin
      </p>
      <h1 data-testid="pricing-pmg-screen" style={{ marginTop: 0, marginBottom: '1.25rem', fontSize: '1.5rem', color: colors.text }}>
        The rules have changed
      </h1>

      <PmgRules market={market} labels={labels} />

      <p style={{ margin: '0 0 1.25rem', lineHeight: 1.6, color: colors.text }}>
        Everything else about the game is the same as before: you post a price each
        round, your competitor posts one at the same time, and you will play{' '}
        {/* the RANGE — the only schedule fact a student may ever be told (spec §3) */}
        <strong>between {minRounds} and {maxRounds} rounds</strong>, without being told
        which one is the last.
      </p>

      <button
        data-testid="pricing-pmg-continue"
        onClick={onDone}
        style={{
          padding: '0.7rem 1.75rem', fontSize: '1rem', fontWeight: 600, cursor: 'pointer',
          backgroundColor: colors.text, color: colors.white, border: 'none', borderRadius: 6,
        }}
      >
        I understand — continue
      </button>
    </div>
  )
}
