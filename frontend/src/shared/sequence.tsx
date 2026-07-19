import { useRef, useState } from 'react'
import type { ReactNode } from 'react'

// ═══════════════════════════════════════════════════════════════════════════════
// SEQUENCE RUNNER — the single-player family's core: a game is an ordered list of
// screens, rendered in order, one at a time. Each screen owns its own view and its
// own submit; the runner only sequences and resumes.
//
// RESUME: the caller passes `startIndex` — the first screen the student has not yet
// completed. For a per-question game (Poll, Part 3) that index is computed exactly
// like the KC pattern: read the persisted per-question answers map, findIndex the
// first question with no entry (see Poll spec §5.3). For Jar of Pennies (one screen)
// it is always 0, and a returning student who already submitted never mounts the
// runner at all — Play shows the confirmation instead.
//
// DELIBERATELY NOT BUILT (architecture §7 — no consumer yet; Newsvendor introduces
// them): the fixed-count LOOP wrapper, the DISPLAY screen, and the COMPUTE step.
// Adding them is a new SequenceScreen shape + handling here, not a rewrite.
// ═══════════════════════════════════════════════════════════════════════════════

/** One screen in the sequence. `render` draws it and calls `onDone` when its
 *  submission has been ACCEPTED by the server (the per-screen one-shot lock lives
 *  in the screen's own callable, not here). */
export interface SequenceScreen {
  id: string
  render: (ctx: { onDone: () => void }) => ReactNode
}

export function SequenceRunner({
  screens,
  startIndex = 0,
  onAllComplete,
}: {
  screens: SequenceScreen[]
  startIndex?: number
  onAllComplete: () => void
}) {
  const [index, setIndex] = useState(startIndex)
  const onAllCompleteRef = useRef(onAllComplete)
  onAllCompleteRef.current = onAllComplete

  const screen = screens[index]
  if (!screen) return null

  const onDone = () => {
    if (index >= screens.length - 1) onAllCompleteRef.current()
    else setIndex(i => i + 1)
  }

  return <>{screen.render({ onDone })}</>
}
