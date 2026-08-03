// ═══════════════════════════════════════════════════════════════════════════════
// Procurement Auction AUTO-DRIVE — walk one student from launch to the first bidding
// screen, server-side, using only the student callables.
//
// This is what the launcher's "Start at game" option runs before it opens a student tab:
// the tab then loads already past the knowledge check and the prep paragraph, so whoever
// is watching sees the auction rather than eleven comprehension questions they have seen
// before.
//
// ⚠ IT LIVES HERE, NOT IN THE LAUNCHER, for the reason pricing's and forecast's do: TWO
// consumers need the sequence — the launcher (against production, authenticating with
// the student's classroom JWT) and this game's own browser harness (against the emulator,
// with the dev `_test` ids). A copy in each would let the tested sequence drift from the
// shipped one, which is exactly how forecast's second start position came to be offered
// while doing nothing at all.
//
// ⚠⚠ THE PREP PARAGRAPH IS PART OF THE DRIVE, and skipping it would leave the tab sitting
// on it. This game's flow is KC → PREP → the round loop (§6, §10), so a drive that
// answered only the KC would land one screen short — and would look identical in the
// launcher's log to one that worked. It is reported separately in `summarize` for that
// reason, following newsvendor's entry.
//
// ⚠ THE DEBRIEF IS NOT DRIVEN, deliberately. It comes AFTER the final results, and the
// server refuses it until `finished_at` exists. "Start at game" means start at the game,
// not finish it.
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
export async function driveProcurementStudentPastKc(call, auth) {
  // 1. Launch. This is what the browser's bootstrap does on ?token=, and it is what
  //    creates the participant doc — so a driven student appears on the roster as
  //    "in progress" rather than "not started", exactly like a real one.
  await call('procurementBootstrap', { ...auth })

  // 2. What does this instance ask? The instructor may have the KC switched off
  //    entirely, or have hidden any subset of it, so the set is READ rather than
  //    assumed. There is no "11 questions" constant here and there must not be one.
  const questions = await call('procurementGetQuestions', { ...auth })
  const kc = questions?.kc ?? []
  const kcEnabled = questions?.kcEnabled !== false

  // 3. Answer every graded question — a random option.
  let answered = 0
  for (const q of kc) {
    const options = q.options ?? []
    const answer = options.length > 0
      ? options[Math.floor(Math.random() * options.length)].value
      : 'Launched from the test launcher.'
    try {
      await call('procurementSubmitKcAnswer', { ...auth, field: q.field, answer })
      answered++
    } catch (err) {
      // An already-answered question is a re-drive of the same student, which is fine
      // and common (Elena reopens a tab). Anything else is worth surfacing, but not
      // worth failing the whole launch over — the tab still opens, on the KC.
      if (!/already|locked/i.test(String(err?.message ?? ''))) throw err
    }
  }

  // 4. The prep paragraph (S8) — the screen between the KC and round 1.
  //
  //    ⚠ MARKED AS A LAUNCHER SEAT in the text itself. This answer lands in Elena's
  //    Tier-2 report beside real students' plans, and one that read like a genuine
  //    answer would quietly contaminate the before/after pair the report exists for.
  const prep = questions?.prep ?? []
  const prepEnabled = prep.length > 0
  let prepSubmitted = false
  for (const q of prep) {
    try {
      await call('procurementSubmitFreeText', {
        ...auth,
        field: q.field,
        answer: '(Launcher demo seat — not a student answer.)',
      })
      prepSubmitted = true
    } catch (err) {
      // Already answered, or a round has already been played (the server refuses prep
      // after round 1). Both mean a re-drive, and both leave the tab in the right place.
      if (!/already|locked|not.*prep|round/i.test(String(err?.message ?? ''))) throw err
      prepSubmitted = true
    }
  }

  return {
    kcEnabled,
    kcTotal: kc.length,
    questionsAnswered: answered,
    prepEnabled,
    prepSubmitted,
  }
}
