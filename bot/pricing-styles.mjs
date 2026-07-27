// ═══════════════════════════════════════════════════════════════════════════════
// Pricing robot PLAY STYLES (spec §11) — how the simulated STUDENT prices.
//
// Its own module because TWO consumers need exactly the same list: the robot driver
// beside it, and pricing-playwright.mjs, which runs a small cohort as a test. A second
// copy in the harness would let the tested styles drift from the shipped ones, which
// is the one thing a style test exists to prevent.
//
// ⚠ THE ROBOT'S STYLE IS NOT THE COMPETITOR'S RULE. These describe the simulated
// student. The competitor is chosen server-side by the instance's mode.
// ═══════════════════════════════════════════════════════════════════════════════

// A deliberate spread of recognizable human behaviours, so the class chart shows real
// contrast instead of a flat band of noise. Each takes the market it is playing in and
// the competitor's prices so far, and returns this round's price.
//
// The styles are MODE-SPECIFIC: undercutting is the whole story in Standard and a
// non-event under PMG, so a PMG cohort running Standard styles would produce a
// chart that says nothing. assignStyles() picks the list from the instance's mode,
// which the robot reads off its own screen.

/** Clamp to the instance's legal band, and to whole dollars. */
export const legal = (p, m) => Math.max(m.minPrice, Math.min(m.maxPrice, Math.round(p)))

/**
 * The interior Nash equilibrium of the Standard model (spec §2), computed HERE from
 * the market the robot read off its own price-entry screen — not imported from the
 * server, and not hardcoded, so an edited market moves the robots with it.
 */
export const nashStudentPrice = (m) =>
  (2 * (m.studentBaseShare * m.slope + m.studentUnitCost)
    + (m.competitorBaseShare * m.slope + m.competitorUnitCost)) / 3

export const STANDARD_STYLES = [
  {
    key: 'nash-player',
    label: 'prices at the equilibrium',
    decide: (m) => legal(nashStudentPrice(m), m),
    debrief: [
      'I worked out roughly where the two of us would end up if we both kept best-responding, and just priced there from the start instead of chasing it down.',
      'I picked a price near the middle that seemed stable and held it. Undercutting looked like it would only start a spiral that made us both worse off.',
    ],
  },
  {
    key: 'high-pricer',
    label: 'prices near the ceiling',
    decide: (m) => legal(m.maxPrice - 100, m),
    debrief: [
      'I kept my price high the whole way through. My margin per container was great but I watched my competitor undercut me round after round and my share kept shrinking.',
      'I decided to protect the margin rather than the volume. It felt right at first, and then I spent most of the game losing customers to a cheaper competitor.',
    ],
  },
  {
    key: 'undercutter',
    // Round 1 opens at the equilibrium, then always $100 under whatever the
    // competitor last posted — the behaviour the whole Standard lesson is about.
    decide: (m, theirs) =>
      legal(theirs.length === 0 ? nashStudentPrice(m) : theirs[theirs.length - 1] - 100, m),
    label: 'always undercuts by $100',
    debrief: [
      'Every round I looked at what they had just charged and went a hundred dollars under it. I won a lot of share doing that, but by the end the price was so low the volume was not worth much.',
      'My plan was simply to be cheaper than them, every single round. It worked in the sense that I got the customers, and it did not work in the sense that I was barely making anything on them.',
    ],
  },
  {
    key: 'cost-skimmer',
    label: 'prices just above cost',
    decide: (m) => legal(m.studentUnitCost + 50, m),
    debrief: [
      'I priced barely above my own cost to grab as much of the market as I could. I ended up with most of the customers and almost no profit, which was not what I expected.',
      'I went low deliberately to win volume. Looking at the totals afterwards, fifty dollars of contribution on a lot of containers is still not very much money.',
    ],
  },
  {
    key: 'random-in-bounds',
    label: 'prices at random',
    decide: (m) => legal(m.minPrice + Math.random() * (m.maxPrice - m.minPrice), m),
    debrief: [
      'I could not work out what my competitor was doing so I tried prices all over the range to see what happened. I never really found the pattern.',
      'I experimented rather than following a plan — high one round, low the next — mostly to see how the share moved.',
    ],
  },
]

export const PMG_STYLES = [
  {
    key: 'ceiling-poster',
    label: 'posts the ceiling every round',
    decide: (m) => legal(m.maxPrice, m),
    debrief: [
      'Once I understood that we both charge whatever the lower price is, there was no reason to go low at all. I posted the maximum every round and so did they.',
      'Undercutting buys you nothing under price matching — your share does not move — so I just posted the highest price allowed and left it there.',
    ],
  },
  {
    key: 'gradual-raiser',
    // Starts near the Standard equilibrium and walks up $100 a round: the discovery
    // curve the PMG lesson is about, made visible on the class chart.
    label: 'starts mid and walks the price up',
    decide: (m, theirs, mine) => legal(nashStudentPrice(m) + mine.length * 100, m),
    debrief: [
      'I started around where I would have priced in the normal game and then pushed the price up a bit each round to see if I lost any customers. I never did, so I kept going.',
      'I raised my price steadily because my share was not moving no matter what I did. It took a few rounds to trust that undercutting really was pointless here.',
    ],
  },
  {
    key: 'random-in-bounds',
    label: 'prices at random',
    decide: (m) => legal(m.minPrice + Math.random() * (m.maxPrice - m.minPrice), m),
    debrief: [
      'I tried prices all over the place to work out how the matching rule actually changed things. My share never budged, which was the surprise.',
      'I moved my price around a lot at first. Once I saw the share was stuck at the same number every round I stopped worrying about being undercut.',
    ],
  },
]

/** Assign styles ROUND-ROBIN over a shuffled list, not independently at random: with
 *  6 robots, independent draws can easily produce five undercutters and a flat,
 *  useless chart. Round-robin guarantees the spread the reports exist to show. */
export function assignStyles(n, pmg) {
  const pool = pmg ? PMG_STYLES : STANDARD_STYLES
  const shuffled = [...pool].sort(() => Math.random() - 0.5)
  return Array.from({ length: n }, (_, i) => shuffled[i % shuffled.length])
}

