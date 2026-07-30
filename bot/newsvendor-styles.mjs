// ═══════════════════════════════════════════════════════════════════════════════
// NEWSVENDOR ROBOT PLAY STYLES — how a simulated student decides how much to order.
//
// The point of a spread is the REPORTS. Eight robots that all order the mean produce
// an order-vs-demand chart with one flat line and an optimality gap that says nothing;
// the styles below are chosen so a cohort reproduces the behaviours the newsvendor
// literature actually finds in a classroom — pull-to-centre, demand chasing, and the
// occasional student who works out the critical ratio — and so Elena can point at the
// chart and name what she is looking at.
//
// ⚠ EVERY STYLE DECIDES FROM WHAT IS ON THE STUDENT'S OWN SCREEN. `params` is parsed
// off the place-order screen by the driver (P, c, v, g, h, the demand distribution and
// the order bounds — spec §7a prints all of them), and `history` is what the robot has
// already played. Nothing here reads the server's benchmark, because no student
// response carries it (spec §9.2).
//
// ⚠ THE `optimizer` STYLE IS NOT A LEAK. It computes the critical ratio from P, c, v,
// g and h — numbers printed on the screen it is looking at — which is precisely the
// calculation the knowledge check asks students to perform. A strong student can do
// this; the robot doing it is the cohort's upper end, not privileged information.
// ═══════════════════════════════════════════════════════════════════════════════

/** Clamp to the order box's own bounds and round to a whole unit (spec §3). The server
 *  enforces the same range, so a style that drifts outside it would simply be refused. */
export const legal = (q, p) =>
  Math.max(p.orderMin, Math.min(p.orderMax, Math.round(q)))

/** Mean demand as the screen states it — the Normal's mean, or the Uniform's midpoint. */
export const centre = (p) => (p.isNormal ? p.mean : (p.minD + p.maxD) / 2)

/** A rough spread measure, so styles can step in units that suit the distribution
 *  rather than in hardcoded tens. */
export const spread = (p) =>
  p.isNormal ? p.sd : Math.max(1, (p.maxD - p.minD) / 4)

/** Φ⁻¹ by bisection on a compact erf — good to ~1e-6, which is far more than an
 *  integer order needs. Deliberately NOT imported from functions/: a robot that shared
 *  the server's implementation could not disagree with it, and disagreeing is the only
 *  way this cohort would ever reveal a server-side arithmetic bug. */
export function invNorm(target) {
  const cdf = (x) => {
    const sign = x < 0 ? -1 : 1
    const z = Math.abs(x) / Math.SQRT2
    const t = 1 / (1 + 0.3275911 * z)
    const erf = 1 - (((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t
      + 0.254829592) * t) * Math.exp(-z * z)
    return 0.5 * (1 + sign * erf)
  }
  let lo = -8, hi = 8
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (cdf(mid) < target) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

/** The order a student who worked out the critical ratio would place (spec §4), from
 *  the parameters printed on their own screen. */
export function criticalRatioOrder(p) {
  const CU = p.P - p.c + p.g
  const CO = p.c - (p.v - p.h)
  // A degenerate market has no interior answer; fall back to the centre rather than
  // dividing by zero. The game refuses to run such a config anyway.
  if (!(CU > 0) || !(CO > 0)) return centre(p)
  const CR = CU / (CU + CO)
  return p.isNormal
    ? p.mean + invNorm(CR) * p.sd
    : p.minD + CR * (p.maxD - p.minD)
}

/** The mean of what this robot has actually seen so far, or null before period 1. */
const seenMean = (history) =>
  history.length === 0 ? null : history.reduce((a, r) => a + r.demand, 0) / history.length

export const STYLES = [
  {
    key: 'mean-anchor',
    label: 'Orders average demand, every period',
    // The single most common classroom answer, and the one the game exists to correct:
    // with a critical ratio above 0.5 the mean is systematically too low.
    decide: (p) => legal(centre(p), p),
    prep: [
      'I am going to order about the average demand each time. It seems like the safest middle ground.',
      'My plan is to order roughly what I expect demand to be — no reason to guess higher or lower.',
    ],
    debrief: [
      'I ordered close to average demand almost every period. Looking back I ran out more often than I expected, so the average was probably too low a target.',
      'I stuck with the mean the whole way. It felt balanced, but I think I lost more on missed sales than I saved on leftovers.',
    ],
  },
  {
    key: 'demand-chaser',
    label: 'Orders whatever demand was last period',
    // Demand chasing — the best-documented newsvendor behaviour, and the one the
    // by-period chart makes visible as a lagging, oscillating line.
    decide: (p, history) =>
      legal(history.length === 0 ? centre(p) : history[history.length - 1].demand, p),
    prep: [
      'I will start at the average and then just order whatever sold last period. Demand seems like the best clue I have.',
      'I plan to follow demand — order what I needed last time.',
    ],
    debrief: [
      'I ordered whatever demand had been the period before. It felt responsive but I was always one step behind — high after a big period, low after a small one.',
      'I chased demand the whole game. In hindsight I was reacting to noise rather than to anything real.',
    ],
  },
  {
    key: 'cautious',
    label: 'Orders below the mean — fears leftovers',
    decide: (p) => legal(centre(p) - 0.6 * spread(p), p),
    prep: [
      'I would rather sell out than be stuck with stock I cannot shift, so I will order on the low side.',
      'Leftovers feel like wasted money, so I am going to order under the average.',
    ],
    debrief: [
      'I deliberately ordered below average because leftovers bothered me more than stockouts. I sold nearly everything every period, but I was leaving sales on the table the whole time.',
      'I kept my orders low to avoid waste. My demand-met percentage was poor and I think that cost me more than the leftovers would have.',
    ],
  },
  {
    key: 'stockout-averse',
    label: 'Orders well above the mean — fears running out',
    decide: (p) => legal(centre(p) + 1.1 * spread(p), p),
    prep: [
      'Running out means losing a customer, so I am going to order comfortably above average.',
      'I would rather have too much than turn people away — ordering high.',
    ],
    debrief: [
      'I ordered well above average because running out felt worse than having stock left. I almost always met demand, though I did carry leftovers most periods.',
      'I stocked up heavily every period. It kept my demand-met percentage high, and given how much a missed sale costs I think that was close to right.',
    ],
  },
  {
    key: 'adaptive',
    label: 'Adjusts up after a shortage, down after leftovers',
    // A plausible learner: it moves toward the demand it has actually seen and nudges
    // in the direction the last period's outcome suggests.
    decide: (p, history) => {
      const base = seenMean(history) ?? centre(p)
      if (history.length === 0) return legal(base, p)
      const last = history[history.length - 1]
      const nudge = last.unitsShort > 0 ? 0.35 * spread(p)
        : last.unitsOver > 0 ? -0.2 * spread(p)
          : 0
      return legal(base + nudge, p)
    },
    prep: [
      'I will start around the average and then adjust — up if I run short, down if I am left with stock.',
      'My plan is to learn as I go: raise the order after a sell-out, lower it after leftovers.',
    ],
    debrief: [
      'I started at the average and adjusted after each period — up when I ran short, down when I had stock left. It drifted upward over the game, which surprised me.',
      'I let the results push my order around. By the end I was ordering noticeably more than I started with, because running short kept happening.',
    ],
  },
  {
    key: 'optimizer',
    label: 'Works out the critical ratio from the posted costs',
    // The cohort's upper end. See the file header: the parameters it uses are printed
    // on the student's own screen, so this is a calculation, not a leak.
    decide: (p) => legal(criticalRatioOrder(p), p),
    prep: [
      'Missing a sale costs me the margin plus the goodwill penalty, and a leftover unit only costs me the difference between cost and salvage. Being short is much more expensive, so I will order above average.',
      'I worked out the shortage cost against the leftover cost. The shortage side is far bigger here, so my orders will sit well above mean demand.',
    ],
    debrief: [
      'I compared the cost of being one unit short against the cost of one unit left over. Being short was much more expensive, so I ordered above average from the start and kept it there.',
      'I set my order from the ratio of the two costs rather than from the mean. It felt uncomfortably high early on, but the periods where demand spiked paid for every leftover.',
    ],
  },
  {
    key: 'erratic',
    label: 'Orders anywhere in bounds — no discernible policy',
    // Every class has one, and the noise is useful: it keeps the class-average line
    // from looking cleaner than a real cohort's.
    decide: (p) => legal(p.orderMin + Math.random() * (p.orderMax - p.orderMin), p),
    prep: [
      'Not sure yet — I will get a feel for it once I see a few periods.',
      'I do not have a plan. I will try different amounts and see what happens.',
    ],
    debrief: [
      'I did not really settle on a method. I tried different amounts to see what happened and never spotted a pattern I trusted.',
      'I was guessing most of the game, honestly. Some periods worked out and some did not.',
    ],
  },
]

/**
 * N robots, assigned round-robin over a SHUFFLED pool.
 *
 * Shuffled so a four-student run is not always the first four styles in file order,
 * and round-robin so a sixteen-student run covers every style rather than picking
 * sixteen at random and leaving two behind. Both matter for the same reason: the
 * cohort exists to fill a chart, and a chart missing its extremes is not the test.
 */
export function assignStyles(n) {
  const shuffled = [...STYLES].sort(() => Math.random() - 0.5)
  return Array.from({ length: n }, (_, i) => shuffled[i % shuffled.length])
}
