// ═══════════════════════════════════════════════════════════════════════════════
// Forecast AUTO-DRIVE — walk one student from launch to the first forecast-entry
// screen, server-side, using only the student callables.
//
// This is what the launcher's second start-position option runs before it opens a
// student tab: the tab then loads already past the knowledge check, so whoever is
// watching sees the game rather than nine comprehension questions they have seen before.
//
// ⚠ IT LIVES HERE, NOT IN THE LAUNCHER, for the reason pricing-autodrive.mjs does: TWO
// consumers need the sequence — the launcher (against production, authenticating with
// the student's classroom JWT) and the game's own harness (against the emulator, with
// the dev `_test` ids). A copy in each would let the tested sequence drift from the
// shipped one. The caller and the auth payload are INJECTED; this module knows the
// sequence and nothing about how to reach a server.
//
// ⚠ ANSWERING THE KC IS THE WHOLE DRIVE, and that is a fact about this game's flow
// rather than a shortcut. forecastResumeIndex puts a student whose answers are all
// stored at the month loop: there is no prep question (spec §9 gives this game exactly
// ONE free-text question, the debrief, asked at the END), no attendance code, no
// matching and no "start game". The opening history screen is part of the loop's first
// screen, not a gate in front of it.
//
// ⚠ ANSWERS ARE RANDOM, exactly as the robot driver's are. This exists to skip the KC,
// not to pass it: a launcher-opened student is a demo seat, and a column of 100% KC
// scores would misrepresent the class in the reports.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * @param call  async (fnName, data) => result — the caller's own transport. It must
 *              THROW on a callable error; a swallowed failure here would produce a tab
 *              that silently still shows the knowledge check.
 * @param auth  the object merged into every call that identifies the student:
 *              `{ token }` in production, `{ _test: { participant_id, game_instance_id } }`
 *              against the emulator.
 * @returns what was actually done, so the caller can log or assert on it.
 */
export async function driveForecastStudentPastKc(call, auth) {
  // 1. Launch. This is what the browser's bootstrap does on ?token=, and it is what
  //    creates the participant doc — so a driven student appears on the dashboard as
  //    "in progress" rather than "not started", exactly like a real one.
  await call('forecastBootstrap', { ...auth })

  // 2. What does this instance ask? The instance may have the KC switched off entirely,
  //    in which case there is nothing to answer and the student is already at the loop.
  //
  //    ⚠ `kc: { authored, added }` — NOT `{ derived, added }`. Pricing's key is
  //    `derived` because its stems are computed from the live instance config; this
  //    game's nine are AUTHORED and carry their own numbers on purpose, precisely so a
  //    KC that runs BEFORE play cannot print a model parameter. Reading the wrong key
  //    here would answer nothing and fail silently.
  const questions = await call('forecastGetQuestions', { ...auth })
  const kc = [...(questions?.kc?.authored ?? []), ...(questions?.kc?.added ?? [])]

  // 3. Answer every question — a random option, or a short line for free text (an
  //    instructor's added question may be ungraded text).
  let answered = 0
  for (const q of kc) {
    const options = q.options ?? []
    const answer = options.length > 0
      ? options[Math.floor(Math.random() * options.length)].value
      : 'Launched from the test launcher.'
    try {
      await call('forecastSubmitKcAnswer', { ...auth, field: q.field, answer })
      answered++
    } catch (err) {
      // An already-answered question is a re-drive of the same student, which is fine
      // and common (Elena reopens a tab). The server discards the second answer and
      // keeps the first, so this is genuinely a no-op rather than a swallowed problem.
      // Anything else is worth surfacing, but not worth failing the whole launch over —
      // the tab still opens, on the KC.
      if (!/already|locked/i.test(String(err?.message ?? ''))) throw err
    }
  }

  return {
    questionsAnswered: answered,
    kcEnabled: questions?.kcEnabled !== false,
    kcTotal: kc.length,
  }
}
