# Procurement Auction — build notes

Decisions and findings made during the build that are **not** in the specs, kept beside the
code because each one is a thing a later reader would otherwise re-derive or undo.

Specs are the authority: `Procurement_Auction_Specification_v3_sealed_FINAL.md` (parent),
`..._v2_open_FINAL.md` (Part 2), `Procurement_Auction_KC_Questions_v3_FINAL.md`.

---

## 1. The tie rule — spec text vs decision (2026-08-02, confirmed 08-03)

⚠ **The v3 document's §7 step 4 is STALE.** It says ties are broken uniformly at random
"with no special case for the player". Elena decided **player-vs-bot ties go to the player;
bot-vs-bot ties stay seeded random** on 08-02, and §7 was never edited to match.

**Take the decision as authoritative over the v3 text.** If you are reading the spec and
the code disagrees here, the code is right.

**How it is implemented, and why it is not a player flag.** `ResolveSettings
.tieBreakPreference?: bidderId` — a tie including that id goes to it, every other tie is
random. The callable nominates the player. The resolver still cannot distinguish a bot from
a human; it knows only that one id was nominated, which is a real procurement convention
(incumbent preference on equal bids) and stays coherent in the all-human auction, where the
field is omitted and every tie is random. §5.3 / §13.2 hold unchanged.

Do **not** "simplify" this into an `isBot` field, a player flag, or a bidder-index
convention. Three tests guard it, including one that nominates a *bot* to prove the
mechanism is generic, and one that omits the field entirely — the all-human path, which is
the one nothing else would notice rotting.

---

## 2. ⚠ The halt price in the open format is order-dependent — measured

Bot response order is seeded-random (open §4.3). It changes the price the cascade halts at.

At a standing bid of 50 the ceiling is 48 and two bots have merit — bot1 (cost 47) and bot3
(cost 21). If bot3 takes 48, bot1 cannot answer (46 < 47) and it halts at **48**. If bot1
takes 48, bot3 *can* answer 46 and it halts at **46**.

**Measured 2026-08-03**, exhaustively over all orderings (memoised search over the ordering
tree, cross-validated against the real cascade over 9,000 seeded runs — zero halt prices
outside the enumerated set).

**Halt price spread**, 5,000 random rival-cost draws:

| spread | 0 | 1 | 2 | 5 | 10 |
|---|---|---|---|---|---|
| share | 4.7% | 18.6% | 33.7% | 35.8% | 7.2% |

15.7% exceed one step of the schedule at the halt price. The cause is **band-crossing** —
the halt lands either side of a boundary (50 or 80) where the step size itself changes.

**Player exit price spread** (the Tier-3 y-axis), under a bid-down-to-cost policy, 3,000
draws:

| spread | 0 | 1 | 2 | 5 | 10 |
|---|---|---|---|---|---|
| share | 4.1% | 34.8% | 43.3% | 16.9% | 0.9% |
| cumulative | 4.1% | 38.9% | **82.3%** | **99.1%** | 100% |

### The consequence for the Tier-3 chart (Elena, 08-03) — implement at CP4

- **Tolerance band: ±5 ECU, ABOVE THE 45° LINE ONLY.** 99.1% coverage at half the width of
  a ±10 band. The 0.9% carrying 10 ECU are a **measured, disclosed limitation** — put the
  figure in the report's methods note — not a reason to double the band.
- ⚠ **Above the line only, never symmetric.** The noise is one-directional: bidding order
  can only push an exit price *up*, toward "quit early". A symmetric band would imply a
  point *below* the 45° line might be an artifact, and it never is — bidding below your own
  cost is always a decision.
- **Caption, or wording to this effect:** *"Points within this band may reflect bidding
  order rather than choice. Points above it are quit-early behaviour."* Not
  "indistinguishable from bidding order" — that overstates it; even inside the band 83% of
  the spread is ≤2 ECU, so most of the distance is genuinely the student's.
- ⚠ **Do NOT make ordering deterministic to remove this.** Lowest-cost-willing-always-bids
  would make the two cheapest bots visibly alternate every step.

---

## 3. ⚠ A control can appear to fail correctly and still be worthless

The sharper form of "a test never seen to fail is not known to work", learned here on
2026-08-03 and worth carrying to every future build.

Mutation-testing the RNG stream invariant (§4 below), **two plausible-looking tests both
survived the mutation, for reasons unrelated to what they claimed to test**:

1. **The first had no ties in it at all.** It compared two runs whose later rounds were
   tie-free, so under the mutation *no draw was taken in either run* and the outputs matched
   anyway. The test asserted a property of tie handling using a scenario containing no ties.
2. **The second used a single seed.** With two tied bidders a desynced stream still picks
   the same winner **half the time by chance**. It passed under the mutation on a coin flip.

Only the third version — a bot-vs-bot tie in the later round, asserted across 60 seeds —
actually fails when the invariant is broken.

**The lesson:** running the mutation is not optional, and "my test looks like it would catch
this" is not evidence. Both bad versions would have shipped looking correct. When a control
guards a probabilistic property, it needs *many* trials; when it guards a conditional
behaviour, the scenario must actually *contain* the condition.

---

## 4. RNG convention — draws are positional, never conditional

Stated in full at the top of `auction/rng.ts`. In short: a call site takes its draw whether
or not it uses the value, so **the stream position after an operation never depends on the
data**. Break it and two seeded runs differing only in whether a round tied diverge in every
later draw — "the harness passes but production differs".

This is the invariant §3 above was mutation-testing.

---

## 5. An edge the specs do not cover — drop out while holding

If the player held the standing bid and dropped out with no bot able to undercut: **no
award**. Implemented as a defensive branch and commented as such in `openAuction.ts`. It is
unreachable through the public API — a settle in which the player holds and no bot is
willing resolves as a player win before any further action is possible — so it is a guard,
not a rule. Elena approved keeping it (08-03).

---

## 6a. Checkpoint 3a decisions (2026-08-03)

Three choices in `submitBid`/`rounds.ts` that a later reader would otherwise undo.

**The next round's cost ships WITH the round result** (`nextCost` on the submit response).
It looks like it hands a student a draw early; it does not. It is the player's own cost, off
the player's own separately-keyed stream, for the round they are about to be shown — the
same number `getState` would return one call later. What §4 forbids is the RIVALS' costs
existing before the bid, and those are still drawn inside the transaction that accepts it.
Guarded: `nextCost` is null once the game is over, so a finished student is never handed a
ninth draw, and the harness asserts that.

**A malformed reveal field degrades the round; a malformed core field truncates the
history.** `parseStoredRounds` breaks contiguity on `round`/`cost`/`won`/`profit` only. The
reveal detail (`rival_bids`, `tie`, `eq_*`) is presentation layered on the outcome, so a bad
one costs that round its bid table rather than costing the student every round after it.
Same defensive posture as before, applied at the right granularity.

**`rival_costs` parses all-or-nothing, never filtered.** `rival_costs[i]` pairs with
`rival_bids[i]` in the reports. A filter would drop the bad element and silently re-pair
every cost after it onto the wrong rival — wrong numbers, no error, corrupt docs only.

**The two client reshapers are key-set pinned in two places**, `procurementRoundRecord
.test.ts` and the harness's §4. Both pins were mutation-verified on 08-03 by replacing the
field-by-field build with `{ ...r }`: both fail, and they fail because `rival_costs` appears.

---

## 6b. Two more worthless-looking-control specimens, for §3's collection

Written and then deleted during CP3a. Both would have shipped looking correct.

1. **"Two students under one seed draw different costs."** The player cost is one integer
   out of 51. Two students collide about 2% of the time — so the check reads as an
   independence test and is really a 98%-pass coin flip, and it says nothing at all about
   whether the streams are keyed per student. Replaced with six students' RIVAL VECTORS
   (four integers out of 101 each) asserted pairwise distinct, plus a negative control that
   requires an instance-wide draw to fail it.
2. **A `|| true` left in a conditional check** — "rivals priced out by the reserve appear as
   no bid *when they occur*". It never fails, and it inflated the pass count by one while
   testing nothing. If a condition might not occur in the scenario, construct a scenario
   where it does, or do not count it.

---

## 6c. Checkpoint 3b, Steps 1–3 (2026-08-03)

**The §9 reveal is the one place a rival cost leaves the server, and it is gated on
`finished_at`.** `getState.revealRivalPoints` is null for the entire live game, including
for a student sitting on the round-8 bidding screen. Gated on the STAMP, not on
`stored.length >= config.rounds`: the stamp is a fact the server wrote, and a config change
mid-assignment cannot make a count-based gate open early. It exists because the scatter's
argument — the bots sit *on* the optimal line — needs their costs on the x-axis. Guarded by
8 per-round harness checks plus a key-set pin; mutation-verified by forcing the gate open,
which fails exactly those 8.

**The flow's ORDER is enforced by the server, not just by `Play.tsx`.** `submitFreeText`
refuses a prep answer once `rounds_played > 0` and refuses a debrief answer until
`finished_at` exists. So KC → prep → loop → results → debrief is a server contract; a
rearranged client fails against it rather than merely looking wrong. Both directions are
asserted in the harness §11.

**The results screen has no stored completion fact, deliberately.** It writes nothing, so
there is nothing to record. Resume expresses "past the results" as "the debrief has been
answered" — a fact — rather than as a flag nothing would maintain. A student who reads the
results and reloads sees them again, which is right for a screen whose job is to be read.

**The optimal line is computed from config on BOTH sides.** The lecture slide's
`b = 0.8c + 22` is β for θmax = 110, n = 5 *only*. `ScatterSVG.optimalBid` takes both from
`params`, and three render tests move the rival range, the bidder count and the reserve to
prove the line moves with them.

### A harness trap worth not re-learning

**A Firestore REST `PATCH` with no `updateMask` REPLACES the document.** Seeding an
instance and then "adding" the KC keys in a second call silently deleted `rounds` and
`reserve`, and the instance fell back to shipped defaults — the harness then measured the
defaults while appearing to test a 1-round instance. `makeInstance` now writes every field
in one call. This is the "a harness that inherits its config re-tunes itself" failure
arriving through a different door.

---

## 6. `allowDropOut` does not exist

It appears in an early prompt's config list but in **neither** FINAL spec. Drop Out is
determined by `format` (open only — sealed §6.3, open §4.5), not by a separate key. Adding
one would create a second way to express something `format` already decides, and a
configurable-but-incoherent state (sealed + `allowDropOut: true`). Raised at spawn, left
out.
