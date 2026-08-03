import { describe, it, expect } from 'vitest'
import { resolve, type SubmittedBid } from '../src/procurement/auction/resolve'
import { REVERSE, FORWARD } from '../src/procurement/auction/direction'
import { makeRng } from '../src/procurement/auction/rng'
import { equilibriumBid } from '../src/procurement/auction/equilibrium'

// ═══════════════════════════════════════════════════════════════════════════════
// THE SEALED CONFORMANCE VECTOR — sealed spec §7.1, frozen before implementation.
//
// Platform discipline (Winemaster scoring, eBay Part 3): implement to the vector
// exactly. Every case below is transcribed from the spec table, including the ones whose
// expected value is "seeded random".
//
// Defaults throughout: k = 4, reserve = 110, β(c) = 0.8c + 22.
// Rival costs 47, 88, 21, 63 → bot bids 60, 92, 39, 72.
// The player's equilibrium bid at cost 34 is 49.
//
// ⚠ CASE 6 WAS REMOVED IN v3 — there is no "no bid" path in the sealed format (§6.3).
// The numbering below keeps the spec's, so case 6 is absent on purpose.
// ═══════════════════════════════════════════════════════════════════════════════

const RESERVE = 110
const RIVAL_COSTS = [47, 88, 21, 63]
const BOT_BIDS = [60, 92, 39, 72]

/** The four rivals, as the resolver sees them — indistinguishable from the player. */
const rivals = (bids: number[] = BOT_BIDS, costs: number[] = RIVAL_COSTS): SubmittedBid[] =>
  bids.map((amount, i) => ({ bidderId: `rival${i + 1}`, amount, cost: costs[i] }))

const player = (amount: number, cost = 34): SubmittedBid =>
  ({ bidderId: 'player', amount, cost })

/** In play the callable nominates the player, so player-vs-bot ties go to the player. */
const settings = (seed: string) =>
  ({ reserve: RESERVE, direction: REVERSE, rng: makeRng(seed, 'tie'), tieBreakPreference: 'player' })

/** The ALL-HUMAN path: no bidder is nominated, so every tie is seeded random. */
const settingsNoPreference = (seed: string) =>
  ({ reserve: RESERVE, direction: REVERSE, rng: makeRng(seed, 'tie') })

const outcomeFor = (r: ReturnType<typeof resolve>, id: string) =>
  r.perBidderOutcomes.find(o => o.bidderId === id)!

describe('the bot bids the vector is built on', () => {
  it('β reproduces 60, 92, 39, 72 from costs 47, 88, 21, 63', () => {
    const s = { rivalCostMax: 110, reserve: RESERVE, totalBidders: 5 }
    expect(RIVAL_COSTS.map(c => equilibriumBid(c, s))).toEqual(BOT_BIDS)
  })
})

describe('§7.1 conformance vector', () => {
  it('case 1 — player bids 45, Rival 3 wins at 39, player profit 0', () => {
    const r = resolve([player(45), ...rivals()], settings('s1'))
    expect(r.winnerId).toBe('rival3')
    expect(r.price).toBe(39)
    expect(r.tie).toBe(false)
    expect(outcomeFor(r, 'player').profit).toBe(0)
  })

  it('case 2 — player bids 37 and wins at 37, profit 3', () => {
    const r = resolve([player(37), ...rivals()], settings('s1'))
    expect(r.winnerId).toBe('player')
    expect(r.price).toBe(37)
    expect(outcomeFor(r, 'player').profit).toBe(3)
  })

  it('case 3 — player bids 39, ties Rival 3, and WINS — under EVERY seed', () => {
    // ⚠ THE TIE RULE AS DECIDED (Elena, 08-02). A player-vs-bot tie goes to the player.
    // This supersedes the v3 document text, which said "seeded random" throughout and was
    // never edited to match the decision.
    //
    // Asserted across many seeds rather than one, deliberately: a fixed seed would pass
    // by luck roughly half the time under a purely random rule, so it would not
    // distinguish "the player wins" from "the player got lucky here".
    for (let i = 0; i < 200; i++) {
      const r = resolve([player(39), ...rivals()], settings(`seed-${i}`))
      expect(r.price, `seed ${i}`).toBe(39)
      expect(r.tie, `seed ${i}`).toBe(true)
      expect(r.winnerId, `seed ${i}`).toBe('player')
      expect(outcomeFor(r, 'player').profit, `seed ${i}`).toBe(5)
    }
  })

  it('case 3 — ⚠ WITHOUT a nominated bidder it reverts to seeded random', () => {
    // ⚠ THE ALL-HUMAN PATH, AND THE ONE NOTHING ELSE WOULD NOTICE ROTTING. Omit
    // `tieBreakPreference` and every tie is random again — which is what an auction with
    // no incumbent must do. If a future edit hardcodes the preference, or reads a player
    // id from somewhere, only this test fails.
    const winners = new Set<string | null>()
    for (let i = 0; i < 200; i++) {
      winners.add(resolve([player(39), ...rivals()], settingsNoPreference(`seed-${i}`)).winnerId)
    }
    expect(winners).toEqual(new Set(['player', 'rival3']))
  })

  it('case 3 — the nominated bidder wins even when it is a rival, not the player', () => {
    // The resolver has no notion of "player". Nominate a bot and the bot wins the tie —
    // which is the proof that the mechanism is a generic incumbent preference rather than
    // a player flag wearing a different name.
    const r = resolve(
      [player(39), ...rivals()],
      { reserve: RESERVE, direction: REVERSE, rng: makeRng('x', 'tie'), tieBreakPreference: 'rival3' },
    )
    expect(r.winnerId).toBe('rival3')
    expect(outcomeFor(r, 'player').profit).toBe(0)
  })

  it('a nominated bidder who is NOT in the tie does not win it', () => {
    // Preference applies only when the nominee is actually tied for best. Rival 1 bid 60
    // and is nowhere near the winning 39.
    const r = resolve(
      [player(39), ...rivals()],
      { reserve: RESERVE, direction: REVERSE, rng: makeRng('y', 'tie'), tieBreakPreference: 'rival1' },
    )
    expect(['player', 'rival3']).toContain(r.winnerId)
    expect(r.price).toBe(39)
  })

  it('case 4 — player bids 30, wins, and LOSES MONEY (profit −4)', () => {
    // Below own cost is legal and never blocked (§6.2). Losing money is part of the
    // lesson; the lecture's own scatter shows students doing it.
    const r = resolve([player(30), ...rivals()], settings('s1'))
    expect(r.winnerId).toBe('player')
    expect(r.price).toBe(30)
    expect(outcomeFor(r, 'player').profit).toBe(-4)
  })

  it('case 5 — a bid of 112 is above the reserve and is refused', () => {
    // The spec expects this REJECTED AT SUBMIT, so the resolver never sees it in play.
    // Both halves are pinned: the gate predicate that the callable will use, and the
    // resolver's own step-2 discard as the backstop.
    expect(REVERSE.admissible(112, RESERVE)).toBe(false)

    const r = resolve([player(112), ...rivals()], settings('s1'))
    expect(outcomeFor(r, 'player').admissible).toBe(false)
    expect(outcomeFor(r, 'player').won).toBe(false)
    expect(outcomeFor(r, 'player').profit).toBe(0)
    expect(r.winnerId).toBe('rival3')
  })

  it('case 7 — four rivals all bid 30: a BOT-vs-BOT tie, SEEDED RANDOM, fixed seed', () => {
    // ⚠ BOT-vs-BOT TIES STAY RANDOM (Elena, 08-02). The player is nominated here exactly
    // as in play, and it changes nothing — the player bid 66 and is not in the tie, so
    // the preference never applies. Asserted against a FIXED SEED, per the spec's
    // instruction for this case: the same seed must always give the same winner.
    const first = resolve([player(66, 55), ...rivals([30, 30, 30, 30])], settings('bot-tie'))
    expect(first.price).toBe(30)
    expect(first.tie).toBe(true)
    expect(['rival1', 'rival2', 'rival3', 'rival4']).toContain(first.winnerId)
    expect(outcomeFor(first, 'player').profit).toBe(0)

    for (let i = 0; i < 25; i++) {
      const again = resolve([player(66, 55), ...rivals([30, 30, 30, 30])], settings('bot-tie'))
      expect(again.winnerId, `repeat ${i}`).toBe(first.winnerId)
    }
  })

  it('case 7 — all four rivals can win it across seeds', () => {
    const winners = new Set<string | null>()
    for (let i = 0; i < 300; i++) {
      winners.add(resolve(
        [player(66, 55), ...rivals([30, 30, 30, 30])],
        settings(`bt-${i}`),
      ).winnerId)
    }
    expect(winners).toEqual(new Set(['rival1', 'rival2', 'rival3', 'rival4']))
  })

  it('case 8 — the EQUILIBRIUM bid of 49 still loses to a low-cost rival', () => {
    // This is why the §8 counterfactual exists: playing perfectly and losing is a
    // normal, informative round rather than evidence of a mistake.
    const r = resolve([player(49), ...rivals()], settings('s1'))
    expect(r.winnerId).toBe('rival3')
    expect(r.price).toBe(39)
    expect(outcomeFor(r, 'player').profit).toBe(0)
  })
})

describe('the seeded stream advances identically whatever the tie looked like', () => {
  it('one draw per resolve — tie or no tie, preference applied or not', () => {
    // ⚠ WHY THIS MATTERS. The tie draw is consumed BEFORE the preference is applied, so
    // the stream position after a round never depends on the tie's composition. If it
    // were consumed lazily, two seeded runs that differed only in whether the player
    // happened to tie would diverge in every LATER draw of the game — a reproducibility
    // bug that would surface as "the harness passes but production differs".
    const run = (bidsList: number[][], seed: string) => {
      const rng = makeRng(seed, 'shared')
      const out: (string | null)[] = []
      for (const bids of bidsList) {
        out.push(resolve(
          [player(bids[0]), ...rivals(bids.slice(1))],
          { reserve: RESERVE, direction: REVERSE, rng, tieBreakPreference: 'player' },
        ).winnerId)
      }
      return out
    }

    // ⚠ THE LATER ROUND MUST ITSELF BE A STREAM-DEPENDENT TIE, or this test proves
    // nothing. My first version made rounds 2–3 tie-free, so under lazy consumption NO
    // draw was taken in either run and the outputs matched anyway — the mutation escaped.
    // Round 2 here is a BOT-vs-BOT tie (rivals 1 and 2 both bid 30, the player is at 66
    // and nowhere near it), so the preference cannot decide it and its winner is a pure
    // function of where the stream stands.
    const BOT_TIE_ROUND = [66, 30, 30, 39, 72]

    // ⚠ AND IT MUST RUN OVER MANY SEEDS. With two tied bidders a desynced stream still
    // picks the same winner half the time by chance, so a single seed lets the bug
    // through 50% of the time — which is exactly what happened: the mutation escaped
    // twice before this loop was added. Across 60 seeds, coincidence is not available.
    for (let i = 0; i < 60; i++) {
      const seed = `stream-${i}`
      // Round 1 differs ONLY in whether the player ties. Eager consumption takes exactly
      // one draw either way, so round 2 must land on the same winner in both runs.
      const withTie = run([[39, 60, 92, 39, 72], BOT_TIE_ROUND], seed)
      const noTie = run([[45, 60, 92, 39, 72], BOT_TIE_ROUND], seed)

      expect(withTie[0], seed).toBe('player')   // the tie, taken by preference
      expect(noTie[0], seed).toBe('rival3')     // no tie
      expect(['rival1', 'rival2']).toContain(withTie[1])
      expect(withTie[1], seed).toBe(noTie[1])   // ⚠ the assertion that catches a desync
    }
  })
})

describe('§7 step 5 — a loser NEVER earns a negative number', () => {
  it('a losing below-cost bid still earns exactly 0', () => {
    // A losing supplier incurs no cost. The below-cost bid is only ever costly when it
    // WINS (case 4) — a resolver that computed payoff for everyone would report −25 here.
    const r = resolve([player(20, 45), ...rivals([10, 92, 39, 72])], settings('s1'))
    expect(r.winnerId).toBe('rival1')
    expect(outcomeFor(r, 'player').profit).toBe(0)
  })
})

describe('§7 step 6 — no admissible bid means no award', () => {
  it('every bid above a lowered reserve → nobody wins, everyone earns 0', () => {
    const r = resolve(
      [player(80), ...rivals([85, 92, 88, 90])],
      { reserve: 70, direction: REVERSE, rng: makeRng('x', 'tie') },
    )
    expect(r.winnerId).toBeNull()
    expect(r.price).toBeNull()
    expect(r.perBidderOutcomes.every(o => o.profit === 0)).toBe(true)
    expect(r.perBidderOutcomes.every(o => !o.admissible)).toBe(true)
  })
})

describe('§5.3 — bots are outside the resolver', () => {
  it('the resolver has no way to tell a bot from the player', () => {
    // The structural claim, made testable: relabel every bidder and the outcome is the
    // same shape with the same numbers. If any branch treated 'player' specially, the
    // relabelled run would differ.
    const named = resolve([player(37), ...rivals()], settings('rel'))
    const relabelled = resolve(
      [
        { bidderId: 'A', amount: 37, cost: 34 },
        ...BOT_BIDS.map((amount, i) => ({ bidderId: `B${i}`, amount, cost: RIVAL_COSTS[i] })),
      ],
      settings('rel'),
    )
    expect(relabelled.price).toBe(named.price)
    expect(relabelled.winnerId).toBe('A')
    expect(
      relabelled.perBidderOutcomes.find(o => o.bidderId === 'A')!.profit,
    ).toBe(outcomeFor(named, 'player').profit)
  })
})

describe('§7 — direction-neutral internals', () => {
  it('the same resolver run FORWARD picks the highest bid and inverts the payoff', () => {
    // Nothing about "lowest" is written into the loop: swapping the injected direction
    // is the entire change. This is what the `direction` config key exists to make
    // possible, and running the abstraction proves the claim rather than asserting it.
    const bids: SubmittedBid[] = [
      { bidderId: 'a', amount: 30, cost: 10 },
      { bidderId: 'b', amount: 80, cost: 10 },
      { bidderId: 'c', amount: 55, cost: 10 },
    ]
    const rev = resolve(bids, { reserve: 110, direction: REVERSE, rng: makeRng('d', 'k') })
    expect(rev.winnerId).toBe('a')
    expect(rev.price).toBe(30)
    expect(outcomeFor(rev, 'a').profit).toBe(20) // price − cost

    const fwd = resolve(bids, { reserve: 0, direction: FORWARD, rng: makeRng('d', 'k') })
    expect(fwd.winnerId).toBe('b')
    expect(fwd.price).toBe(80)
    expect(outcomeFor(fwd, 'b').profit).toBe(-70) // cost − price
  })
})
