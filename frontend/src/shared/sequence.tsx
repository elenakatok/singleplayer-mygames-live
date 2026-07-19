import { useState } from 'react'
import type { PrepTextQuestion } from '@mygames/game-ui'
import { colors, spacing, typography } from '@mygames/game-ui'

// ═══════════════════════════════════════════════════════════════════════════════
// SEQUENCE RUNNER — the single-player family's core: a game is an ordered list of
// screens (as DATA), rendered in order. This is the minimal runner a one-screen
// game needs (Jar of Pennies). It walks the list and, for a non-terminal screen,
// offers a "Continue".
//
// DELIBERATELY NOT BUILT (architecture §7 — no consumer yet; Newsvendor introduces
// them): the fixed-count LOOP wrapper, the DISPLAY screen, and the COMPUTE step.
// The Screen union and the runner are left open enough to add those without a
// rewrite (add a union member + a case in renderScreen), but no speculative code
// for them exists here.
// ═══════════════════════════════════════════════════════════════════════════════

/** A screen that collects inputs from the student. Questions are DATA OBJECTS
 *  (the shared PrepTextQuestion model), never hardcoded inline JSX — the standing
 *  platform constraint that keeps a future admin-defaults screen small. */
export interface QuestionScreen {
  kind:      'question'
  id:        string
  title:     string
  questions: PrepTextQuestion[]
}

/** The screen union. Open by design — 'display' (and a loop wrapper over a span of
 *  screens) join here when Newsvendor needs them. Today there is exactly one kind. */
export type Screen = QuestionScreen

// ── Runner ──────────────────────────────────────────────────────────────────────

export function SequenceRunner({ screens }: { screens: Screen[] }) {
  const [index, setIndex] = useState(0)
  const screen = screens[index]
  if (!screen) return null

  const isLast  = index === screens.length - 1
  const advance = () => { if (!isLast) setIndex(i => i + 1) }

  return renderScreen(screen, isLast, advance)
}

function renderScreen(screen: Screen, isLast: boolean, onAdvance: () => void) {
  switch (screen.kind) {
    case 'question':
      return <QuestionScreenView screen={screen} isLast={isLast} onAdvance={onAdvance} />
  }
}

// ── Question screen (PLACEHOLDER — Part 2 replaces the body with the real numeric
//    form + one-shot submit; the shell, title, and sequencing are proven now) ─────

function QuestionScreenView({
  screen,
  isLast,
  onAdvance,
}: {
  screen: QuestionScreen
  isLast: boolean
  onAdvance: () => void
}) {
  return (
    <section>
      <h1 style={{ marginTop: 0, fontSize: '1.6rem', color: colors.text }}>{screen.title}</h1>
      <p style={{ color: colors.textSecondary, lineHeight: 1.6, fontFamily: typography.fontFamily }}>
        Screen content lands in Part 2.
      </p>
      {!isLast && (
        <button onClick={onAdvance} style={{ marginTop: spacing.gapMd }}>
          Continue
        </button>
      )}
    </section>
  )
}
