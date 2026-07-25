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
// TWO SCREEN SHAPES:
//   • BASIC   — one view, one submit, then advance. (Pennies, Poll.)
//   • LOOP    — repeats an ASK → DISPLAY pair until the SERVER says the loop is
//               over. (Repeated PD, spec §4; Newsvendor and Pricing next.)
//
// The LOOP shape is the family primitive the architecture doc deferred (§7). It
// is added here as a new screen shape plus its own branch below — the BASIC path
// is byte-for-byte the behavior it always had, so Pennies and Poll are untouched.
//
// WHY THE SERVER ENDS THE LOOP, NOT A COUNT: PD's round count is server-side truth
// that must never reach the client (spec §3). A `count` prop would put it in the
// bundle. So the loop is UNBOUNDED here and each ASK reports back a `done` flag
// that the server derived — the client never learns how many iterations remain,
// only that this one was the last. Any future fixed-count consumer expresses that
// as "the server said done on iteration N", not as a client-side length.
// ═══════════════════════════════════════════════════════════════════════════════

/** One BASIC screen. `render` draws it and calls `onDone` when its submission has
 *  been ACCEPTED by the server (the per-screen one-shot lock lives in the screen's
 *  own callable, not here). */
export interface BasicScreen {
  id: string
  kind?: 'basic'
  render: (ctx: { onDone: () => void }) => ReactNode
}

/**
 * One LOOP screen: an ASK phase and a DISPLAY phase, repeated.
 *
 *   ask → (server accepts, returns a result + `done`) → display → next iteration
 *                                                              └→ done ⇒ leave the loop
 *
 * `result` is whatever the ask phase's callable returned; the runner only carries
 * it across to the display phase, never inspects it. The runner owns exactly two
 * pieces of state — which iteration, and which phase — because those are the only
 * things a consumer would otherwise have to reimplement per game.
 */
export interface LoopScreen {
  id: string
  kind: 'loop'
  /** First iteration NOT yet completed (0-based). Resume: for PD this is the number
   *  of rounds already stored on the participant doc — the loop's analogue of the
   *  findIndex in Poll's `startIndex`. */
  startIteration?: number
  /** ASK — the student's input for this iteration. Calls `onResult` once the server
   *  has ACCEPTED the submission, passing what it returned and whether the loop is
   *  now over. */
  ask: (ctx: { iteration: number; onResult: (result: unknown, done: boolean) => void }) => ReactNode
  /** DISPLAY — shows what the server returned for this iteration. Calls `onContinue`
   *  to move on (to the next iteration, or out of the loop if `done`). */
  display: (ctx: { iteration: number; result: unknown; done: boolean; onContinue: () => void }) => ReactNode
}

export type SequenceScreen = BasicScreen | LoopScreen

/**
 * Typed constructor for a LOOP screen. The runner carries the ask phase's result as
 * `unknown` (a generic on the screen union would make LoopScreen<R> unassignable to
 * the union — the callback positions are contravariant), so the ONE cast the whole
 * pattern needs lives here instead of in every consumer.
 */
export function loopScreen<R>(spec: {
  id: string
  startIteration?: number
  ask: (ctx: { iteration: number; onResult: (result: R, done: boolean) => void }) => ReactNode
  display: (ctx: { iteration: number; result: R; done: boolean; onContinue: () => void }) => ReactNode
}): LoopScreen {
  return {
    id: spec.id,
    kind: 'loop',
    startIteration: spec.startIteration,
    ask: ({ iteration, onResult }) =>
      spec.ask({ iteration, onResult: (result: R, done: boolean) => onResult(result, done) }),
    display: ({ iteration, result, done, onContinue }) =>
      spec.display({ iteration, result: result as R, done, onContinue }),
  }
}

/** Runs ONE loop screen. Split out so its iteration/phase state is created fresh
 *  when the sequence reaches it and discarded when it leaves — the runner's own
 *  `index` state stays exactly what it was. */
function LoopRunner({ screen, onLoopDone }: { screen: LoopScreen; onLoopDone: () => void }) {
  const [iteration, setIteration] = useState(screen.startIteration ?? 0)
  const [phase, setPhase] = useState<
    { name: 'ask' } | { name: 'display'; result: unknown; done: boolean }
  >({ name: 'ask' })

  const onLoopDoneRef = useRef(onLoopDone)
  onLoopDoneRef.current = onLoopDone

  if (phase.name === 'ask') {
    return <>{screen.ask({
      iteration,
      onResult: (result, done) => setPhase({ name: 'display', result, done }),
    })}</>
  }

  return <>{screen.display({
    iteration,
    result: phase.result,
    done: phase.done,
    onContinue: () => {
      if (phase.done) onLoopDoneRef.current()
      else { setIteration(i => i + 1); setPhase({ name: 'ask' }) }
    },
  })}</>
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

  if (screen.kind === 'loop') {
    // `key` — a second loop screen later in the same sequence must not inherit the
    // first one's iteration/phase state.
    return <LoopRunner key={screen.id} screen={screen} onLoopDone={onDone} />
  }

  return <>{screen.render({ onDone })}</>
}
