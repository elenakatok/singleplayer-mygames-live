// ═══════════════════════════════════════════════════════════════════════════════
// Pricing AUTO-DRIVE — walk one student from launch to the first price-entry screen,
// server-side, using only the student callables.
//
// This is what the launcher's "Start at game" option runs before it opens a student
// tab: the tab then loads already past the knowledge check, so whoever is watching
// sees the game rather than four comprehension questions they have seen before.
//
// ⚠ IT LIVES HERE, NOT IN THE LAUNCHER, because TWO consumers need it: the launcher
// (against production, authenticating with the student's classroom JWT) and
// pricing-playwright.mjs (against the emulator, authenticating with the dev _test
// ids). A copy in each would let the tested sequence drift from the shipped one. The
// caller and the auth payload are therefore INJECTED — this module knows the
// sequence and nothing about how to reach a server.
//
// ⚠ WHAT IT DOES NOT DO, and why there is nothing to do:
//   • The PMG RULES SCREEN needs no driving. It is a client-only screen with no
//     server fact behind it (deliberately — see PmgRulesScreen.tsx), and the resume
//     rule sends a student whose KC is complete straight to the round loop. Finishing
//     the KC is what puts them past it.
//   • There is no prep, no attendance code, no matching and no "start game" in this
//     family, so the negotiation-family drive has no analogue here beyond the KC.
//
// ⚠ ANSWERS ARE RANDOM, exactly as the robot driver's are. This exists to skip the
// KC, not to pass it: a launcher-opened student is a demo seat, and a column of 100%
// KC scores would misrepresent the class in the reports.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param call  async (fnName, data) => result — the caller's own transport. It must
 *              THROW on a callable error; a swallowed failure here would produce a
 *              tab that silently still shows the knowledge check.
 * @param auth  the object merged into every call that identifies the student:
 *              `{ token }` in production, `{ _test: { participant_id, game_instance_id } }`
 *              against the emulator.
 * @returns what was actually done, so the caller can log or assert on it.
 */
export async function drivePricingStudentPastKc(call, auth) {
  // 1. Launch. This is what the browser's bootstrap would do on ?token=, and it is
  //    what creates the participant doc — so a driven student appears on the roster
  //    as "in progress" rather than "not started", exactly like a real one.
  await call('pricingBootstrap', { ...auth })

  // 2. What does this instance ask? The mode picks the set, and the instance may have
  //    the KC switched off entirely, in which case there is nothing to answer.
  const questions = await call('pricingGetQuestions', { ...auth })
  const kc = [...(questions?.kc?.derived ?? []), ...(questions?.kc?.added ?? [])]

  // 3. Answer every question — a random option, or a short line for free text.
  let answered = 0
  for (const q of kc) {
    const options = q.options ?? []
    const answer = options.length > 0
      ? options[Math.floor(Math.random() * options.length)].value
      : 'Launched from the test launcher.'
    try {
      await call('pricingSubmitKcAnswer', { ...auth, field: q.field, answer })
      answered++
    } catch (err) {
      // An already-answered question is a re-drive of the same student, which is fine
      // and common (Elena reopens a tab). Anything else is worth surfacing, but not
      // worth failing the whole launch over — the tab still opens, on the KC.
      if (!/already|locked/i.test(String(err?.message ?? ''))) throw err
    }
  }

  return { pmg: questions?.pmg === true, questionsAnswered: answered, kcEnabled: questions?.kcEnabled !== false }
}
