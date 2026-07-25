import { describe, it, expect } from 'vitest'
import { planInstructorSession } from './instructorSessionPlan'

// ⚠ THIS FILE PINS A SHIPPED BUG. The instructor's classroom JWT lives 15 minutes, and
// the hook used to re-send it on EVERY mount — every Dashboard → Settings → Reports
// navigation included, since the nav links carry ?token= forward. Fifteen minutes into
// a working session the next click threw `jwt expired`, locking the instructor out of
// a dashboard whose Firebase session was still valid and still auto-refreshing.
//
// The whole fix is: when a session for this instance's instructor already exists, the
// token is not consulted at all. These tests assert that — including the aged-token
// case, which is the actual reported failure.

const INSTANCE = 'inst-123'
const UID = `instructor_${INSTANCE}`

/** A token string is deliberately opaque here: the plan must never parse it. */
const FRESH = 'header.fresh-payload.sig'
const AGED = 'header.expired-payload.sig'

describe('planInstructorSession — the aged-token bug (regression)', () => {
  it('⚠ RESUMES on a re-mount with an EXPIRED token when the session exists', () => {
    // This is the bug. Before the fix this returned an exchange, the server called
    // verifyClassroomToken, and jwt.verify threw "jwt expired".
    const plan = planInstructorSession({
      token: AGED,
      devGameInstanceId: null,
      urlGameInstanceId: INSTANCE,
      currentUid: UID,
    })
    expect(plan).toEqual({ action: 'resume' })
  })

  it('resumes with NO token at all, if the session exists', () => {
    // A stale link whose ?token= was stripped is still fine — the session is the
    // credential once it exists.
    expect(planInstructorSession({
      token: null, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: UID,
    })).toEqual({ action: 'resume' })
  })

  it('resumes identically however old the token is — the token is never read', () => {
    // Same session, two different token strings ⇒ identical plan. The plan cannot be
    // token-dependent, because deciding whether to trust the token by reading the
    // token would be circular.
    const withFresh = planInstructorSession({
      token: FRESH, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: UID,
    })
    const withAged = planInstructorSession({
      token: AGED, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: UID,
    })
    expect(withFresh).toEqual(withAged)
  })

  it('resumes across all three instructor pages — the navigation that broke', () => {
    // Dashboard → Settings → Reports each re-mount the hook with the same URL. Every
    // mount after the first must resume.
    for (const _page of ['dashboard', 'settings', 'reports']) {
      void _page
      expect(planInstructorSession({
        token: AGED, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: UID,
      }).action).toBe('resume')
    }
  })
})

describe('planInstructorSession — the FIRST load must still exchange', () => {
  it('exchanges when nobody is signed in', () => {
    expect(planInstructorSession({
      token: FRESH, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: null,
    })).toEqual({ action: 'exchange', args: { token: FRESH }, signOutFirst: false })
  })

  it('exchanges when the URL carries no game_instance_id (guard cannot apply)', () => {
    // Degrades to the pre-fix behaviour rather than guessing: without the instance id
    // there is no expected uid to compare against.
    expect(planInstructorSession({
      token: FRESH, devGameInstanceId: null, urlGameInstanceId: null, currentUid: UID,
    })).toMatchObject({ action: 'exchange', args: { token: FRESH } })
  })

  it('uses the DEV _gid bypass in the emulator', () => {
    expect(planInstructorSession({
      token: null, devGameInstanceId: INSTANCE, urlGameInstanceId: null, currentUid: null,
    })).toEqual({ action: 'exchange', args: { _dev: { game_instance_id: INSTANCE } }, signOutFirst: false })
  })

  it('resumes on the DEV path too, once signed in', () => {
    expect(planInstructorSession({
      token: null, devGameInstanceId: INSTANCE, urlGameInstanceId: null, currentUid: UID,
    })).toEqual({ action: 'resume' })
  })

  it('reports no-token when there is nothing to exchange and no session', () => {
    expect(planInstructorSession({
      token: null, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: null,
    })).toEqual({ action: 'no-token' })
    expect(planInstructorSession({
      token: null, devGameInstanceId: null, urlGameInstanceId: null, currentUid: null,
    })).toEqual({ action: 'no-token' })
  })
})

describe('planInstructorSession — never inherits somebody else’s session', () => {
  it('signs out a STUDENT signed in on the same browser, then exchanges', () => {
    // The launcher opens N students and the dashboard in one browser. Resuming onto a
    // student's uid would hand the dashboard a session with no instructor claim.
    const plan = planInstructorSession({
      token: FRESH, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: 'student-abc',
    })
    expect(plan).toEqual({ action: 'exchange', args: { token: FRESH }, signOutFirst: true })
  })

  it('signs out the instructor of a DIFFERENT instance, then exchanges', () => {
    const plan = planInstructorSession({
      token: FRESH, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: 'instructor_other-instance',
    })
    expect(plan).toEqual({ action: 'exchange', args: { token: FRESH }, signOutFirst: true })
  })

  it('does not resume on a uid that merely starts the same', () => {
    // `instructor_inst-1234` must not satisfy the guard for `inst-123`.
    expect(planInstructorSession({
      token: FRESH, devGameInstanceId: null, urlGameInstanceId: INSTANCE, currentUid: `${UID}4`,
    }).action).toBe('exchange')
  })

  it('prefers the DEV instance id over the URL one when both are present', () => {
    // Mirrors the multiplayer hook: the dev bypass wins, so an emulator run cannot
    // accidentally resume onto a production-shaped uid.
    expect(planInstructorSession({
      token: null, devGameInstanceId: 'dev-1', urlGameInstanceId: 'prod-1', currentUid: 'instructor_dev-1',
    })).toEqual({ action: 'resume' })
    expect(planInstructorSession({
      token: null, devGameInstanceId: 'dev-1', urlGameInstanceId: 'prod-1', currentUid: 'instructor_prod-1',
    }).action).toBe('exchange')
  })
})
