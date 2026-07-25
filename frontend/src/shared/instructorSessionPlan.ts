// ═══════════════════════════════════════════════════════════════════════════════
// WHAT TO DO ON AN INSTRUCTOR PAGE MOUNT — the decision, extracted from the effect
// that performs it so it can be unit-tested without jsdom or a Firebase stub.
//
// ⚠ THE BUG THIS EXISTS TO PREVENT. The instructor arrives with a classroom JWT that
// lives FIFTEEN MINUTES. The old hook re-sent that JWT to the game's session callable
// on EVERY mount — and every Dashboard → Settings → Reports navigation is a mount,
// because the nav links carry the same ?token= forward. So fifteen minutes into a
// working session, clicking "Settings →" threw `jwt expired` and locked the
// instructor out of a dashboard whose Firebase session was still perfectly valid and
// still auto-refreshing.
//
// THE FIX, mirroring game-ui's InstructorDashboard (which the multiplayer family has
// always had): the JWT is a ONE-TIME exchange credential. Once it has been swapped for
// a Firebase session, that session — not the JWT — is the credential. If a Firebase
// user is already signed in as THIS instance's instructor, resume and never look at
// the token again. Its expiry stops mattering the moment the session exists.
//
// `instructor_${gameInstanceId}` is the uid minted by makeSinglePlayerInstructorSession,
// and game_instance_id is on the URL from BOTH the classroom and the local launcher,
// so the expected uid needs no token decode — which matters, because decoding a token
// to decide whether we may ignore the token would be circular.
// ═══════════════════════════════════════════════════════════════════════════════

/** The argument shape the game's instructor-session callable accepts. */
export type InstructorSessionArgs =
  | { token: string }
  | { _dev: { game_instance_id: string } }

export type InstructorSessionPlan =
  /** A Firebase session for this instance already exists — use it, touch no token. */
  | { action: 'resume' }
  /** No usable session: exchange the token. `signOutFirst` when some OTHER user is
   *  signed in (a student tab in the same browser, or a different instance). */
  | { action: 'exchange'; args: InstructorSessionArgs; signOutFirst: boolean }
  /** Nothing to go on. */
  | { action: 'no-token' }

/**
 * @param token              the ?token= classroom JWT, or null
 * @param devGameInstanceId  DEV-only ?_gid= emulator bypass, or null
 * @param urlGameInstanceId  ?game_instance_id=, appended by classroom AND launcher
 * @param currentUid         auth.currentUser?.uid after authStateReady(), or null
 */
export function planInstructorSession({
  token,
  devGameInstanceId,
  urlGameInstanceId,
  currentUid,
}: {
  token: string | null
  devGameInstanceId: string | null
  urlGameInstanceId: string | null
  currentUid: string | null
}): InstructorSessionPlan {
  const instanceId = devGameInstanceId ?? urlGameInstanceId
  const expectedUid = instanceId ? `instructor_${instanceId}` : null

  // ── Resume: a session for THIS instance's instructor already exists ──────────
  // Checked BEFORE the token is even inspected — that is the whole point. An expired
  // token is irrelevant here, and so is a missing one.
  if (currentUid !== null && expectedUid !== null && currentUid === expectedUid) {
    return { action: 'resume' }
  }

  // ── Otherwise the token has to be exchanged ─────────────────────────────────
  const args: InstructorSessionArgs | null = devGameInstanceId
    ? { _dev: { game_instance_id: devGameInstanceId } }
    : token ? { token }
    : null
  if (args === null) return { action: 'no-token' }

  // Somebody else is signed in (a student in the same browser, or another instance's
  // instructor) — sign them out first so the new session cannot inherit their claims.
  return { action: 'exchange', args, signOutFirst: currentUid !== null }
}
