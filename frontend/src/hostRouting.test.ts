import { describe, it, expect } from 'vitest'
import { gameForHost, HOST_PREFIXES } from './hostRouting'

// ═══════════════════════════════════════════════════════════════════════════════
// ONE BUNDLE, SEVEN HOSTING SITES — the routing table, pinned.
//
// ⚠ WHY THIS TEST EXISTS. `HOST_PREFIXES` is matched by `startsWith`, first match wins.
// That makes adding a game a change to EVERY OTHER GAME'S routing: a new prefix that
// shadows an existing one silently sends that game's students to the wrong screens. The
// page renders, the header looks right, and it is simply the wrong game — which is
// exactly the class of failure that put another game's name in infoshare's browser tab.
//
// The list below is the LIVE hosting set, written out longhand rather than derived from
// HOST_PREFIXES, because a test that derives its expectations from the thing under test
// proves nothing. Both the custom domain and the Firebase default domain are asserted:
// the two differ (`procurement.mygames.live` vs `procurement-mygames.web.app`) and the
// default domains are what carry the suffixes the prefix rule exists to tolerate.
//
// ⚠ THE SUFFIXES ARE NOT UNIFORM AND NEVER WILL BE. `pennies`, `poll-mygames`,
// `pd-mygames-live`, `pricing-mygames-live`, `newsvendor-mygames-live`,
// `forecast-mygames`, `procurement-mygames` — three different conventions, because each
// name was whatever was still globally free on the day. That is precisely why matching
// is by prefix and not by exact label.
// ═══════════════════════════════════════════════════════════════════════════════

const LIVE_HOSTS: ReadonlyArray<readonly [string, string]> = [
  ['pennies.mygames.live', 'pennies'],
  ['pennies.web.app', 'pennies'],
  ['poll.mygames.live', 'poll'],
  ['poll-mygames.web.app', 'poll'],
  ['pd.mygames.live', 'pd'],
  ['pd-mygames-live.web.app', 'pd'],
  ['pricing.mygames.live', 'pricing'],
  ['pricing-mygames-live.web.app', 'pricing'],
  ['newsvendor.mygames.live', 'newsvendor'],
  ['newsvendor-mygames-live.web.app', 'newsvendor'],
  ['forecast.mygames.live', 'forecast'],
  ['forecast-mygames.web.app', 'forecast'],
  // ⚠ Plain `procurement` was globally taken (08-03), hence the `-mygames` site id.
  ['procurement.mygames.live', 'procurement'],
  ['procurement-mygames.web.app', 'procurement'],
]

describe('hostname → game', () => {
  it.each(LIVE_HOSTS)('%s resolves to %s', (host, game) => {
    expect(gameForHost(host)).toBe(game)
  })

  it('an unknown host matches nothing (the caller falls back)', () => {
    expect(gameForHost('example.com')).toBeNull()
    expect(gameForHost('localhost')).toBeNull()
  })

  it('every prefix in the table is reachable — none is shadowed by an earlier one', () => {
    // The real invariant: feeding a prefix to the router must return ITS OWN game. If a
    // later entry is shadowed by an earlier one this fails naming both, which is the
    // diagnostic a bare "wrong game" bug report never gives you.
    for (const [prefix, game] of HOST_PREFIXES) {
      expect(gameForHost(prefix), `'${prefix}' is shadowed by an earlier prefix`).toBe(game)
    }
  })

  it('covers every game in the routing table', () => {
    // Stops a game being added to HOST_PREFIXES without being added here — the whole
    // point is that the live host list is maintained by hand.
    const routed = new Set(HOST_PREFIXES.map(([, g]) => g))
    const tested = new Set(LIVE_HOSTS.map(([, g]) => g))
    expect([...routed].sort()).toEqual([...tested].sort())
  })
})
