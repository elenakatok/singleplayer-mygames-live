// ═══════════════════════════════════════════════════════════════════════════════
// Newsvendor AUTO-DRIVE — walk one student from launch to the first order-entry
// screen, server-side, using only the student callables.
//
// This is what the launcher's second start-position option runs before it opens a
// student tab: the tab then loads already past the knowledge check and the prep
// paragraph, so whoever is watching sees the game rather than ten comprehension
// questions and a paragraph they have written before.
//
// ⚠ IT LIVES HERE, NOT IN THE LAUNCHER, for the reason the other two do: TWO consumers
// need the sequence — the launcher (against production, authenticating with the
// student's classroom JWT) and the game's own browser harness (against the emulator,
// with the dev `_test` ids). A copy in each would let the tested sequence drift from
// the shipped one. The caller and the auth payload are INJECTED; this module knows the
// sequence and nothing about how to reach a server.
//
// ⚠⚠ THIS IS NOT A COPY OF THE FORECAST DRIVE, AND THE DIFFERENCE IS THE POINT.
// Forecast's flow is KC → loop, so answering the KC is the whole drive. Newsvendor's is
// KC → PREP → loop (newsvendorResumeIndex), so a drive that stopped at the KC would
// leave every student staring at the prep paragraph — the same silent half-failure the
// launcher registry was rebuilt to prevent, one screen further along.
//
// ⚠ AND THE ORDER IS LOAD-BEARING, not incidental. The prep asks whether the student
// intends to ORDER the optimal quantity they have just computed; its wording is written
// against the KC coming first (resume.ts says so explicitly). Submitting the prep before
// the KC would store an answer to a question the student was never walked up to.
//
// ⚠ ANSWERS ARE RANDOM, and the prep paragraph is a placeholder line — exactly as the
// robot driver's are. This exists to skip what is in front of the game, not to pass it:
// a launcher-opened student is a demo seat, and a column of 100% KC scores or a Tier-2
// report full of real-looking prep answers would misrepresent the class.
// ═══════════════════════════════════════════════════════════════════════════════

/** What the driven student writes for the prep paragraph. Deliberately obvious in a
 *  Tier-2 report: an instructor reading the prep answers should be able to see at a
 *  glance which rows are demo seats rather than students. */
const PREP_PLACEHOLDER = 'Launched from the test launcher — this is not a student answer.'

/**
 * @param call  async (fnName, data) => result — the caller's own transport. It must
 *              THROW on a callable error; a swallowed failure here would produce a tab
 *              that silently still shows the knowledge check or the prep.
 * @param auth  the object merged into every call that identifies the student:
 *              `{ token }` in production, `{ _test: { participant_id, game_instance_id } }`
 *              against the emulator.
 * @returns what was actually done, so the caller can log or assert on it.
 */
export async function driveNewsvendorStudentPastKc(call, auth) {
  // 1. Launch. This is what the browser's bootstrap does on ?token=, and it is what
  //    creates the participant doc — so a driven student appears on the dashboard as
  //    "in progress" rather than "not started", exactly like a real one.
  await call('newsvendorBootstrap', { ...auth })

  // 2. What does this instance ask? Either block can be switched off, and each has its
  //    own switch — an instructor who drops the prep still gets the KC, and vice versa.
  //
  //    ⚠ `kc: { authored, added }`, as forecast's is — NOT pricing's `derived`.
  const questions = await call('newsvendorGetQuestions', { ...auth })
  const kc = [...(questions?.kc?.authored ?? []), ...(questions?.kc?.added ?? [])]

  // 3. Answer every knowledge-check question — a random option, or a short line for
  //    free text (an instructor's added question may be ungraded text).
  let answered = 0
  for (const q of kc) {
    const options = q.options ?? []
    const answer = options.length > 0
      ? options[Math.floor(Math.random() * options.length)].value
      : PREP_PLACEHOLDER
    try {
      await call('newsvendorSubmitKcAnswer', { ...auth, field: q.field, answer })
      answered++
    } catch (err) {
      // An already-answered question is a re-drive of the same student, which is fine
      // and common (Elena reopens a tab). The server returns the stored result rather
      // than overwriting, so this is genuinely a no-op. Anything else is worth
      // surfacing, but not worth failing the whole launch over — the tab still opens.
      if (!/already|locked/i.test(String(err?.message ?? ''))) throw err
    }
  }

  // 4. THE PREP PARAGRAPH — the screen forecast does not have.
  //
  //    ⚠ GATED ON prepEnabled, not attempted-and-caught: newsvendorSubmitFreeText
  //    throws failed-precondition for a question this instance has switched off, and
  //    swallowing that would hide a real misconfiguration behind a drive that "worked".
  //    The field comes from the server's own answer, never a hardcoded string, so a
  //    question that is renamed cannot leave this silently submitting to nothing.
  let prepSubmitted = false
  if (questions?.prepEnabled && questions?.prep?.field) {
    try {
      await call('newsvendorSubmitFreeText', {
        ...auth, field: questions.prep.field, answer: PREP_PLACEHOLDER,
      })
      prepSubmitted = true
    } catch (err) {
      if (!/already|locked/i.test(String(err?.message ?? ''))) throw err
    }
  }

  return {
    questionsAnswered: answered,
    kcTotal: kc.length,
    kcEnabled: questions?.kcEnabled !== false,
    prepEnabled: questions?.prepEnabled === true,
    prepSubmitted,
    dual: questions?.dual === true,
  }
}
