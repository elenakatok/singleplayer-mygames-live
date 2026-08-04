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

## 6d. Checkpoint 3b, Steps 4–6 (2026-08-03)

**Tier 3 needed config it was not being sent.** `procurementGetReport` now carries
`rivalCostMin/Max`, `playerCostMin/Max`, `rivalCount` and `totalBidders`. β needs θmax and
n, not just the reserve, so without them the class chart would have had to assume the
shipped numbers and two instances with different rival ranges would have shared one line —
in the chart Elena presents in lecture. `ClassScatterSVG` imports the student chart's own
`optimalBid`: one derivation, so the two charts cannot disagree in front of a room.

⚠ **Reports.tsx's own header note had the formula wrong** and it is worth recording rather
than quietly fixing. It said the Tier-3 line was `c + (reserve − c)/n`. That is β only at
the DEFAULT reserve, where reserve = rivalCostMax. At the shipped numbers the two agree
exactly, so the error would have survived every default-reserve check and drawn a
confident, wrong reference the first time anyone lowered the reserve. Third instance of
BUILD_NOTES §7's trap.

**Tier 3 carries no rival cost, and the question of gating it per-student does not
arise.** §12's class scatter is every student's bid against their OWN cost; the bots are
the LINE, not points. `rows[].rounds` uses the same `toClientHistory` whitelist the student
path uses, so there is no rival figure on a report row to gate. A mid-game student
contributes their resolved rounds and nothing else, and the harness asserts that opening
the report does NOT open that student's own `revealRivalPoints`.

### Two more worthless-control specimens, and one new trap

3. **A roster assertion that matched on the participant id.** The roster renders
   `name ?? id`, so a bootstrap that supplied a name would have failed a correct page.
   Replaced with the FIGURES — rounds, wins, profit — checked against what the round
   screens actually showed.
4. **A test that called `resolveRound` twice and compared.** It claimed to prove the
   counterfactual runs on its own tie stream; `resolveRound` is deterministic, so it would
   have passed whichever stream the counterfactual used. Deleted. The separate keying is
   real but is not observable from one call site, and no honest unit test here can assert
   it — said so in the file rather than leaving a green check implying otherwise.

⚠ **`startVite` accepted a server it did not start.** The obvious loop — spawn, then poll
until `fetch(APP)` succeeds — accepts ANY server on that port. After a killed run left a
stale Vite behind, the freshly spawned child died of EADDRINUSE, the poll succeeded against
the OLD server, and `vite.kill()` at the end killed nothing. Cost a 25-minute apparent
hang. Both browser harnesses now REFUSE to run when the port is already serving. Same shape
as the `updateMask` trap: the harness believed it controlled something it did not, and every
result after that point was about a different system than the one it named.

### The launcher entry

`bot/procurement-autodrive.mjs` + one `SINGLE_PLAYER_DRIVES.procurement` entry in the
launcher's `server.mjs`, which owns the wording AND the driver — the arrangement that
exists because forecast's second start position lived in two places and silently did
nothing. The drive answers the KC **and submits the prep paragraph**; without the prep the
tab lands one screen short while looking identical in the log. `[LAUNCHER]` in the
Playwright harness imports that exact module rather than reproducing its steps.

---

## 6e. ⚠⚠ THE PRODUCTION BLOCKER — a derived value is not a recorded one (2026-08-03)

**Found in production, on the first real playthrough.** A student was shown one cost and
the round resolved against another: shown 33, resolved 58; shown 20, resolved 57. They
could win a contract at a loss no visible number predicted.

**Cause.** `makeRng(null, key)` returns `Math.random` and **ignores the key**. A
classroom-created instance has no `truth/main`, so `loadProcurementSeed` returns null. CP3a
computed the player's cost on demand from `(seed, participantId, round)` and described it as
"once-only by construction" — true only when a seed is set. Unseeded, every read redrew it.

**Fix (Elena, 08-03): stop deriving, start recording.** The cost is drawn once when the
round opens, written (`open_round: { round, cost, opened_at }`), and read everywhere after —
bidding screen, resolution, round result, history, reports. `openRound.ts` owns it, and it
is transactional so two tabs cannot each draw.

⚠ **The rejected fix is worth recording too.** My first instinct was a persisted per-instance
seed. Correct instinct, **wrong layer** — it makes the recipe reliable again when the problem
is that a fact was being recomputed instead of recorded. (A `gameInstanceId` fallback would
also have been a §4 leak: `hash32` is in the repo and a student knows their own ids.)

⚠ **§4 is untouched.** Rival costs are still drawn at RESOLUTION, inside the transaction
that accepts the bid. All 8 §4 checks pass unchanged, and §4 now additionally pins that the
cost on screen IS the cost in the record — on the seeded path too, so the property is
defended everywhere rather than only where it broke.

### Is `makeRng`-on-null still reachable, and does it matter?

**Yes, at all four sites** (player cost, rival costs, tie break, counterfactual) whenever an
instance has no seed — the normal case. **It no longer matters, because every one of those
draws now has its OUTCOME written by the transaction that made it**: `rival_costs`,
`rival_bids`, the winner, the profit and the `eq_*` fields are all recorded on the round.
Nothing is read twice. An unseeded instance is simply *genuinely random*, which is what an
unseeded instance is supposed to be.

One residual sharp edge, named so nobody re-derives it: **under a null seed the
"separately keyed streams" property is vacuous** — player, rivals, tie and counterfactual all
share one `Math.random`. Nothing depends on it today (each result is recorded), but the
positional-draw convention in `rng.ts` guarantees nothing at all without a seed. Any future
value that is *derived rather than recorded* will break exactly the way this one did.

### The harness gap — the real lesson, and the third of this shape

Every instance the harness created set a seed. **396 checks were green about a configuration
production never uses.** Third finding of this form this session:

| # | Trap | The harness believed |
|---|---|---|
| 1 | `emulators:exec` serves `functions/lib` | it was testing the source it had just edited |
| 2 | REST `PATCH` with no `updateMask` REPLACES the doc | it had seeded a 1-round instance |
| 3 | **every instance set a seed** | **it was testing the classroom's instance shape** |

(And a fourth, same family: `startVite` accepting a server it did not start.)

**Standing case added: §13, a classroom-shaped instance — no seed, no `truth/main`.** It
asserts one cost across repeated reads, and resolution matching what was shown.
**Verified to FAIL before the fix (8 failures) and pass after** — the mutation discipline
applied to the fix itself.

---

## 6f. ⚠⚠ THE ROBOT DRIVER SHIPPED AS A LIBRARY (2026-08-03)

**Elena hit it, no harness did.** Launching robots printed:

```
[robots ixfRxgo7] spawned robot-driver — 16 seats, pace watch
[robots ixfRxgo7] driver exited (code 0)
```

**Cause.** `bot/procurement-robot-driver.mjs` exported `runCohort`/`playOneRobot` and had
**no `main()`, no argv handling**. The launcher spawns a driver as a child process
(`node <driver> --instance … --seats … --pace … --launcher …`); node loaded the module,
defined the exports, and exited 0. Exit 0 reads as success in the launcher's log.

⚠ **The launcher's own guard could not catch this.** `robotLoadErrors` checks the driver
FILE EXISTS. It cannot tell "exists" from "does anything" — and I registered procurement in
`ROBOT_GAMES` in the same commit that added the (working) auto-drive entry, so the file was
there and robot mode advertised itself.

⚠ **And my own harnesses could not catch it either, because both IMPORTED the module.**
The dry run called `runCohort` directly; Playwright's `[LAUNCHER]` section imported the
*auto-drive*, a different module. Both were green. **Importing tests a function; only
spawning tests an entry point.** Both harnesses now spawn the driver exactly as the
launcher does and assert it announces itself and that every robot finished. Mutation-
verified by putting the CLI back behind `if (false && …)`.

**Fourth instance of the same shape this session** — after `emulators:exec` serving stale
`lib`, the maskless REST `PATCH`, and every instance carrying a seed. The pattern: *the
harness exercised something adjacent to the thing that actually runs.*

### Two more of my own vacuous checks, deleted

On the first run after the CLI was added, 0/6 robots finished — and these still read green:

```
✓ and each played all 6 rounds
✓ and each wrote a debrief paragraph
✓ every bid was inside the legal band
```

**`[].every(...)` is `true`.** With the cohort empty every `.every()` passed. All are now
guarded by a length check. A file whose purpose is catching vacuous passes must not
contain three of its own.

### The driver reads its parameters off the screen

`readAuctionParams` scrapes the reserve, rival range and bidder count from the bidding
panel rather than fetching config — which is what lets the same driver run against
production, where it has no config access. ⚠ It deliberately does NOT read a player cost
range: §4 keeps that off the screen, and the styles need only the realized cost.

---

## 6. `allowDropOut` does not exist

It appears in an early prompt's config list but in **neither** FINAL spec. Drop Out is
determined by `format` (open only — sealed §6.3, open §4.5), not by a separate key. Adding
one would create a second way to express something `format` already decides, and a
configurable-but-incoherent state (sealed + `allowDropOut: true`). Raised at spawn, left
out.
