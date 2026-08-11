// ═══════════════════════════════════════════════════════════════════════════════
// THE PAGE-LEVEL "STUDENTS HAVE ALREADY STARTED" BANNER — one component, one string,
// all six single-player games (KC convergence spec §10's last open item; Elena, 08-10).
//
// ⚠⚠ ONE STRING, SHARED, AND THAT IS THE ENTIRE POINT. Six hand-placed copies would drift
// into six wordings, and an instructor who runs two of these games in a term would be told
// the same thing two different ways. The wording below is SCORECARD'S, verbatim — it
// shipped first and is the reference; nothing here is a rewrite of it.
//
// ⚠ D2 — WARN, NEVER BLOCK. Nothing on any settings page consults this. It is a standing
// statement of fact about the instance, not a gate and not a confirmation step.
//
// ⚠⚠ IT IS A STANDING BANNER, NOT A CHANGE DETECTOR. It says "students have started", not
// "you have changed something that matters". That is deliberate and it is why scorecard's
// KC-specific save-time trigger was DELETED when this landed: a change detector needs a
// baseline, a comparison, and a definition of what counts as a change — three things to get
// wrong, per game — and it can only ever fire after the instructor has already made the
// edit. This fires before they touch anything.
//
// ⚠ IT DOES NOT REPLACE THE SECTION-SCOPED NOTICES, and those are deliberately left alone.
// They say something this cannot: what editing THAT PARTICULAR section will do — pd's and
// pricing's about round ranges, pricing's about the market, forecast's about redrawing the
// demand history, procurement's about the format lock, newsvendor's about prices and costs.
// This banner is the general fact; those are the specific consequences.
//
// ⚠⚠ WHAT "STARTED" MEANS IS THE CALLER'S DECISION, AND IT IS NOT THE SAME MOMENT IN EVERY
// GAME. Each page passes a boolean; this component does not derive one and must never try.
// The rule the six follow is **the earliest moment at which two students' games become
// incomparable**, which is what the copy actually warns about:
//
//   scorecard   a participant has `starts_with`      — the high/low reliability assignment,
//                                                      made at FIRST LOAD (getState.ts)
//   pd          a per-student horizon has been drawn — also at FIRST LOAD (init.ts, via
//                                                      getState)
//   pricing     a per-student horizon has been drawn — as pd
//   newsvendor  someone has played a period          — nothing is drawn before that
//   forecast    someone has played a month           — as newsvendor
//   procurement someone has submitted a bid          — as newsvendor
//
// The first three fire when a student merely OPENS the game, and that is correct rather
// than over-eager: opening it draws something irreversible and private to that student, so
// an instructor editing afterwards has already produced the split cohort the banner
// describes. The last three draw nothing at load, so opening changes nothing and the
// meaningful moment is the first move.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ⚠ SCORECARD'S ORIGINAL WORDING, MOVED HERE UNCHANGED. Exported so a test can assert all
 * six render the identical sentence without restating it — a test that hard-coded the text
 * would pass while five pages drifted.
 */
export const STARTED_BANNER_TEXT =
  '⚠ Students have already started. Editing the rules now means different students '
  + 'played different games — the reports cannot separate them.'

/**
 * Renders nothing when `started` is false — the fresh-instance case, where the page must be
 * quiet.
 *
 * @param started  ⚠ The GAME'S OWN predicate. See the header: this is not one definition.
 * @param testIdPrefix  So each game's harness can address its own banner (`sc`, `pd`, …).
 */
export function StartedBanner({ started, testIdPrefix }: {
  started: boolean
  testIdPrefix: string
}) {
  if (!started) return null
  return (
    <p
      data-testid={`${testIdPrefix}-started-banner`}
      style={{
        background: '#fff8e6', border: '1px solid #e6d3a3', borderRadius: 6,
        padding: '0.6rem 0.9rem', fontSize: '0.85rem',
      }}
    >
      {STARTED_BANNER_TEXT}
    </p>
  )
}
