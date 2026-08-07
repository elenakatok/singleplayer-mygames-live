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

## 6g. Checkpoint 4a — the open format's playable loop (2026-08-04)

§9 steps 1–5 only. Exit-price capture, the Tier-3 scatter, §5.2's round result, §5.3's
final results and every report are CP4b and are deliberately **not** built.

### The execution model, and what it cost

Open §4.6 (new, 2026-08-04) rejects precomputing the cascade at round open and animating
it client-side. **One bot bid = one server commit**, and `procurementAdvance` re-derives
the decision from stored state and checks `nextBotAtMs` itself.

⚠ **The CP3-era `openAuction.ts` was the rejected shape** and had to be rewritten, not
extended. Its `settle()` ran the whole cascade to quiescence inside `openAuction()` and
`playerBid()` — a client consuming it would necessarily have animated a result the server
already held, which is the a60cf51 blocker in a new costume. The pure module now exposes
`advanceOne` (one commit, timing-gated), and `settle` is reduced to "mark, schedule or
terminate" with no loop. The ONE place a cascade still runs to quiescence in a single call
is `playerDropOut`, because §4.4's table says so in those words — and it is safe there for
a reason rather than by exception: the player is out, so nobody can bid against a price
they cannot see.

### ⚠⚠ The RNG key is `(participant, round, DECISION INDEX)` — and the first control missed it

Bot response ordering is a new RNG consumer, and it is re-entered from storage on every
callable invocation. A stream keyed only by (participant, round) is recreated at position
0 on every decision, so **every decision in a round draws the same value** — under a seed
the same bot wins every ordering race and the cascade reads exactly as mechanical as §4.3
exists to avoid. `OpenState.decisions` is durable so the key can include it.

⚠ **My first negative control for this passed under the mutation** — BUILD_NOTES §3's
specimen collection gains a fifth entry, and it is the sharpest one yet. The control
asserted "more than one distinct bidder appears in the cascade". Under the mutation the
draw is constant, so `pick` selects a constant *index* of the willing list — but the
willing list's membership still changes as the holder changes, **so the bidder still
alternates and the test still passed**. It asserted a property of the stream using a
measurement that cannot see the stream.

The replacement is two controls, both verified to fail against the mutation:

- **(a)** an `rngAt` spy asserting the requested indices are `0,1,2,…` — precise,
  deterministic, and it also pins the positional convention (one draw per decision).
- **(b)** the behavioural one: over a long cascade with four always-willing bots, every bot
  gets a turn. Under a constant draw the choice cycles between exactly TWO bidders forever
  and the other two never bid — which is what a player would actually see.

### Storage — three recorded facts, no recipes

| What | Where | Why there |
|---|---|---|
| player's cost | `participants/{pid}.open_round` | as CP3b (BUILD_NOTES §6e) |
| **bot costs** | `truth/bots_{pid}.r{n}` | **rules-denied**; §4's own escape clause |
| auction state | `participants/{pid}.open_auction` | rules-denied; carries `stopped` |

**Bot costs must exist from round open, which the sealed format never required** — every
bot decision, from the first, is a function of its cost. §4 anticipates it: "if drawn
earlier for any reason, they live in the rules-denied `truth` subcollection". The doc id is
`bots_{pid}` rather than the bare participant id so a participant called `main` cannot
overwrite the seed doc. Three rules tests assert the path by NAME rather than trusting the
`{doc}` wildcard, because the id is derived from the one string a student definitely knows.

⚠ **The auction state is opened LAZILY, on arrival — the costs are not.** The transaction
that resolves round *t* draws round *t+1*'s player cost and bot costs (facts, and drawing
them a commit early is what makes the round advance atomic), but NOT its auction state:
`nextBotAtMs` is a wall-clock fact, and a round opened while the student was still reading
the previous result would have its first bot bid already overdue and fire the instant they
arrived — the opposite of §3's pacing.

### The leak boundary is `stopped`, not a cost

`OpenState` contains no cost at all. The dangerous field is `stopped`: a list of bot ids
derived from their costs, so "bot3 stopped at a standing of 48" says its cost is above 46.
Shipped every step it gives each rival's cost away to within one step. `openView.ts` is a
field-by-field whitelist; what crosses is the **count** §4.3 requires.

⚠ **A value scan would be unsound here and is not used** — a bot cost is a small integer
that frequently coincides with a legitimate bid on the same screen, so "no field equals 47"
would pass by luck or fail on a correct payload. The control is a recursive key-set pin,
mutation-verified by replacing the whitelist with a spread (both leak checks fail).

⚠ **The classroom-shaped harness case here is NOT the sealed one.** §13's is "no seed, NO
`truth/main`". The open format ALWAYS has truth. §15's control is **no seed, truth PRESENT,
payload asserted cost-free**, and it cross-checks the active-bidder count against the bot
costs read with owner credentials — a second source, not the server's arithmetic played
back.

### `botDelayMs` is gone

Open §3 replaced the scalar pair with `delaySchedule`, read through the **same band lookup**
as `decrementSchedule` (`bandAt` in `auction/schedule.ts`). Both schedules plus
`delayJitterMs` are editable in Settings, because open §2/§10 name three levers for tuning
the first live run — shorter delays, a coarser top band, a lower reserve — and require all
three between rounds. A deploy is not a lever.

⚠ The Settings editor refuses a malformed schedule locally AND the server rejects it by
name. `parseDecrementSchedule` is a *defensive reader* for half-written docs: it substitutes
the shipped default, which is right on the read path and wrong on a save, where an
instructor who mistyped one band would be told "saved" and get the shipped schedule.

### Where the refusals were, and what happens now

| Was | Now |
|---|---|
| `submitBid.ts` threw `failed-precondition` "This instance runs the open-bid format, which does not use sealed submissions" | **Routes.** An open instance goes to `openSubmitBid`, which commits one bid into the live auction. A player's bid is a player's bid under either mechanism. |
| `Play.tsx` rendered a "This instance uses the open-bid format / has not been built yet" notice | **Renders the real loop.** `params.format` selects the screen pair. |
| `resolveRound.ts` — a declared, throwing stub reserved for the open format | **Deleted.** The format needed TWO callables (`procurementAdvance`, `procurementDropOut`) plus the shared bid path, so one "resolve" verb never fitted. ⚠ The old function stays DEPLOYED and harmless until somebody deletes it; nothing calls it. |

The one-mechanism-per-instance guarantee did not weaken — it moved. `procurementAdvance`
and `procurementDropOut` refuse a sealed instance, which harness §9 now asserts in place of
the check it used to make.

### Departures from the FINAL spec — none

Everything below is scope, not divergence, but is recorded because a reader will look for it:

- **No exit-price capture on the round record.** §9 step 6 is CP4b. `playerExit()` exists
  and is unit-tested; nothing calls it. `open_history` IS stored, so CP4b can derive an exit
  price for any round played before then. ⚠ `parseStoredRounds` round-trips `open_history`
  even though nothing reads it — `rounds` is rewritten as a whole array on every submit, so
  a dropped field would be deleted from every earlier round.
- **`eq_bid`/`eq_won`/`eq_profit` are null/false/0 on every open round**, and that is the
  shape rather than a stub: β is the *sealed* first-price equilibrium and there is no
  closed form for this mechanism. §7's exit-price scatter is the open format's benchmark.
  Consequence: `totalEquilibriumProfit` is 0 for an open instance, and the report's
  benchmark column will read 0 until CP4b replaces it.
- **The round-end and end-of-loop screens are deliberately spare** and are NOT §5.2/§5.3.
  The gap message, the counterfactual and the replay are CP4b. `EndScreen` is explicitly
  NOT reused: its scatter draws β, which is the wrong benchmark for this mechanism, and
  drawing it would assert a line these rounds were never played against.

## 6h. ⚠⚠ The active-bidder count is GONE — screen, payload and derivation (Elena, 2026-08-04)

**Decided before the CP4a deploy, and it supersedes spec text.** Open §5.1's mock line
("3 of 5 still bidding"), §4.3's "the active-bidder count must reflect this from the
opening", and §10 item 3 ("active bidder count stays visible") are all superseded; the
spec is being updated to match.

**The reason, in Elena's words:** *a competitor's departure is not announced in a live
auction. The player infers it from silence, and silence is ambiguous between "priced out"
and "waiting." An explicit count destroys that ambiguity* — **and it was the last
client-side field derived from bot cost state.**

That last clause is why this is a category being closed rather than a field being hidden.
Everything else a student receives is either their own (`yourCost`, `yourLastBid`), public
config (`reserve`, `step`, `totalBidders`), or an action somebody publicly took (the
history). The count was the one number computed *from what the bots' costs imply*.

### What was removed, and where

| | |
|---|---|
| `activeBidderCount()` in `auction/openAuction.ts` | **DELETED**, not unexported. A helper sitting there is an invitation to put it back on a screen. |
| `activeBidders` on `ClientAuction` | gone; the key-set pins in `procurementOpenState.test.ts` and harness §15 now assert its **absence** |
| "Still bidding — 3 of 5" row | gone; replaced by **"Bidders — 5 in this auction, including you"**, the opening total |
| "Nobody else will go lower. It is your move" | **"It is your move — bid, or drop out. There is no clock."** The old wording announced in prose exactly what the count was removed to withhold. |

### The opening total stays, and it is a different kind of thing

"There are 5 bidders in this auction" is stated up front in the deck, the player needs `n`
to reason at all, and it **never moves** — a parameter, not a running commentary. A test
asserts it is identical at the opening, at the halt, and after a drop-out.

### The invariant that lets the bid history stay fully public

**A bot never emits anything but a bid.** There is no "bot 3 has stopped" event and no bot
drop-out event, and no code path that could produce one: `markStopped` records a departure
in `state.stopped` and appends *nothing*, and the only `dropOut` event in the system is
written by `playerDropOut` with the player's id. Stated on `OpenEvent`, and pinned three
ways — a unit test sweeping five reserves (including ones that strand bots mid-cascade), a
callable-level check in harness §15 at the halt, and a browser check that no
`Bot N — dropped out` row can appear.

So: **a bid is an announcement; a departure is silence.** Showing every announcement in
full is consistent with never reporting the silences.

`toClientAuction` now derives a drop-out row's `isYou` from the bidder id rather than
hardcoding `true` — always true today, but written so that if that ever changes the row
does not silently attribute a bot's exit to the student.

### "Auction opened at 110" is the oldest history row

§4.1: the auction opens with the incumbent's price **standing and unowned** — a real
standing bid for the decrement rule, and the thing the first bid must undercut. Without it
the history started mid-story, and on a round nobody had bid in it was empty, which reads
as a page that failed to load.

⚠ **Rendered client-side from `params.reserve`, NOT as a synthetic server event.** A
fabricated event would land in `open_history` and reappear in §5.2's replay as a bid that
nobody made. A test moves the reserve to 90 and checks the row follows.

### ⚠ The residual, stated rather than left to be discovered

`status` (and equivalently `nextBotAtMs === null`) still carries **one** boundary fact:
*all* remaining bots have stopped. The client cannot do without it — it is precisely the
signal to stop asking, and the alternative is polling a halted round forever, against a
format that already makes ~16 calls a round.

It is strictly weaker than the count: it distinguishes "everyone is out" from "someone is
still in", and says nothing about *how many* or *which*. Two auctions differing only in how
many bots are priced out are byte-identical on the wire — there is a test that constructs
exactly that pair and compares the serialised payloads. The screen no longer names the
boundary either, which is why the waiting line was reworded.

**Removing it entirely would mean unbounded polling.** Not proposed; recorded so nobody
re-derives the trade-off.

### What §8's conformance cases asserted about the count

**Nothing.** All twelve of §8.3's cases are about the mechanism — the trace, the bot rule,
legality, collisions, timing, the paused tab — and not one mentions the bidder count. The
count assertions that existed were mine, written to cover §4.3's *separate* requirement,
and they lived in three places: two in `procurementOpenAuction.test.ts` (case 7's field of
priced-out bots, and the lowered-reserve block) and the cross-check in harness §15.

What those tests were really guarding is untouched and is still asserted, at the level
where it was always observable: **a bot the reserve prices out is ABSENT from the
auction** — it is in `state.stopped` from the opening, and it never appears in the trace.
Case 7 now asserts `stopped.length === 4` (server-side truth) plus an unchanged
`totalBidderCount` of 5, instead of `activeBidderCount === 1`.

---

### Two things raised for Elena at this checkpoint

1. ~~**"Still bidding" is read as "could make a FURTHER bid"**~~ — **CLOSED by §6h.**
   BUILD_NOTES §2 promised to raise the definitional question at CP4; it was raised, and
   the answer was that there should be no count at all. The reading no longer exists to be
   chosen.
2. **`§8.3` case 1 ends by Drop Out in the harness.** §4.4's second row is a WAIT, not a
   resolution, so a round in which the player stops bidding never resolves on its own. That
   is the spec, and it is right, but it means a student who simply stops has an unfinished
   round rather than a played one — the same status a sealed abandoner has (Part 1 §6.3).
   Worth confirming that is intended before CP4b writes it into participation.

---

## 6i. Checkpoint 4b — exit capture, open reports, open end screen, open robots (2026-08-04)

### ⚠⚠ The live bug it opened with: a missing FORMAT GATE

`Reports.tsx` read `data.format` in **exactly one place** — to print a label — and rendered
`ClassScatterSVG` unconditionally. On an open instance that drew CASCADE BIDS against cost,
put β through them as "the optimal line", and captioned itself *"the rivals bid the optimal
markup for their own cost every time"* over rival dots at (cost 65, bid 100) that plainly
did not. **The chart contradicted its own caption in front of a room.**

The student side had refused correctly ("results are still being built"); the instructor
side had no such refusal. The lesson is that a format gate is not one `if` — it is an
inventory. Every format-dependent surface, enumerated before building:

| Surface | Was | Now |
|---|---|---|
| Tier 3 modal | sealed scatter, β, false caption | `OpenClassScatterSVG` — exit price vs cost, 45° line |
| Tier 3 tile | "N student bids · M rival bids" | "N student exits · M supplier exits" |
| Tier 1b modal | cost/bid/**Optimal**/price | cost/**exit price**/final price/won/profit |
| Tier 1b caption | explains β | rewritten, explains censoring |
| Tier 1a roster | name/status/rounds/won/profit | **unchanged — already format-neutral** |
| Student §5.3 | `OpenAllRoundsDone` placeholder | `OpenEndScreen` |
| Student §5.2 | spare CP4a panel | gap sentence + both counterfactual forms + replay |
| Report header, Dashboard | already printed `FORMAT_LABEL` | unchanged |

⚠ **The chart is a different COMPONENT, not a prop.** The y axis is a different quantity
and the benchmark is a different line; a `variant` prop would have invited exactly the
half-converted chart that caused the bug.

### The field names (Item 1 asked me to report them)

| Field | Meaning |
|---|---|
| `exit_price` | where the player stopped (§7) |
| `exit_censored` | true iff they WON |
| `eq_profit` | **reused** — what perfect play earns from these draws |
| `eq_won` | **reused** — would perfect play have won |
| `eq_bid` | **stays null on open rounds** |

⚠ **`eq_*` is reused rather than given a `perfect_*` twin, deliberately.** The concept is
the same sentence in both formats — "what a player following the optimal strategy would
have earned from your draws" — and in the open format that strategy *is* the equilibrium
(§1 calls it the dominant strategy), so the prefix is accurate rather than borrowed.
Reusing it also means `totalEquilibriumProfit()` and the student's "a perfect player would
have earned X" line work unchanged instead of forking on `format` in three more places.
`eq_bid` does not carry over: there is no single benchmark bid in a descending auction, and
the column that showed it is format-gated away rather than shown as a row of dashes.

⚠ **`exit_censored` is STORED, not inferred from `won` downstream.** They coincide today.
They are different *facts*: one is an outcome, the other is a statement about what the
datum means. A chart that inferred one from the other would start lying the first time a
round could end another way — and §7's entire point is that a winner's exit is not a
revealed stopping point.

### The benchmark is a CLOSED FORM (Elena, 2026-08-04) — superseding a sampled replay

    profit = (second-lowest cost among all bidders, including the player) − player cost,
             when the player's cost is the lowest;  0 otherwise

CP4b first computed this by **replaying** the whole auction with the player exiting at
their own cost. That inherited the seeded-random bot ORDERING, which BUILD_NOTES §2
measured moving the halt price by up to 10 ECU, so the number wobbled. **Elena's
correction, and it is right: the ordering noise is a LARGE-INCREMENT phenomenon.** The
increments that settle this auction are 2 and 1; ordering changes the path, not the
destination. It is also the standard result she teaches, so the student's screen and the
lecture slide now assert the same number rather than two that nearly agree.

Removed with it: `replayPerfectPlay` and `benchmarkSettingsFor` — **and its separately
keyed RNG stream**, which existed only so a hypothetical replay could not disturb the real
auction's draws. Nothing else used either. The test that asserted ordering variation
*exists* went too: it was guarding the sampled implementation, not a property of the game.

⚠ **The ceiling cap is part of the closed form, not a fudge.** The auction opens AT the
reserve, so nobody is ever paid more than `reserve − step(reserve)`. Without it an empty
field would report `reserve − cost` and overstate what was winnable by a whole top step
(§8.3 case 7: unopposed at 100, not 110). It also absorbs §4.1's known artifact — a
supplier costing between the ceiling and the reserve can never bid — for free.

### ⚠⚠ A PLAYER CAN BEAT THE BENCHMARK — measured, and RESOLVED AS WORDING (Elena, 08-04)

The closed form prices the contract at *exactly* the second-lowest cost. The mechanism
cannot: the runner-up stops when `standing − step(standing) < its cost`, so the winner
holds at up to `secondLowest + step(P) − 1`. **Measured** (300 unseeded rounds, player
following the dominant strategy): about **a quarter of winning rounds beat the closed form,
worst excess 4 ECU against a band bound of exactly 4**. The emulator harness hit one live:
player 28, perfect 25.

**Elena's decision (08-04): OPTION 1 — keep the closed form, keep the ceiling cap, change
the WORDING.** Options 2 (`secondLowest + step − 1`) and 3 (clamp to realized profit) are
declined.

⚠ **The rationale is the part worth keeping, because it reframes the whole thing.** The
same phenomenon *already ships in the sealed format*: β maximises EXPECTED profit, so a
realized draw can beat it ex post, and a live sealed instance shows "+40 earned, +38
perfect" and has been fine. **So the issue was never that a student may beat the benchmark.
It is that the old wording invited reading that as an error.** The gap IS the lesson —
discrete increments hand the winner a small surplus, which is why increment size is an
auction-design decision.

The benchmark is therefore presented as **the frictionless outcome**, not an unbeatable
ceiling: what the auction would pay with no increments at all. Every string reads in both
directions and none implies a mistake. **The arithmetic is untouched.**

### ⚠ The excess bound is BAND-DERIVED, not a constant

`step(winningPrice) − 1` — 1 in the step-2 band, 4 in the step-5 band. It was originally
hardcoded to `10`, the schedule's largest step. Not to the 3 ECU first measured, but still
a constant, and a **useless** one: under a mutation that understated the benchmark by 3,
the constant let **150 of 162 winning rounds** "beat" the benchmark with a worst excess of
6 and still passed. The band-derived bound fails the same mutation immediately —
`round 0: settled at 11 (step 1), excess 3 must not exceed 0`.

Both call sites are fixed: the unit sweep, and the emulator harness (which implements its
own step lookup rather than importing the server's, same discipline as its independent
recomputation of the closed form).

### §5.2's gap sentence is UNCHANGED

It never referenced the benchmark: *"You stopped at 38. Your cost was 34, so you had 4 ECU
of room left."* is their last bid against their own cost. The line that did change wording
is the separate per-round benchmark line, and only in what computes it — *"Playing it
perfectly — stopping exactly at your cost — would have earned X this round"* and *"Even
played perfectly, this round was not winnable at your cost"* both still read correctly
under the closed form, because `eq_won` is now exactly "somebody else was cheaper".

### Item 2 — the personas, and why the sealed six do not port

The sealed six vary by **markup relative to β**, and open has no markup. `cost-bidder` and
`equilibrium` **collapse into one behaviour** (undercutting to your cost IS the dominant
strategy), and `under-marker` has no analogue short of loss-making. So the open cohort is
defined by **exit threshold**, which is the quantity §7's chart actually plots. The labels
that appear in Elena's reports: **exits at cost · exits early · exits below cost · random
exit.**

⚠⚠ **The trigger is `minimum next bid < threshold`, never `price < threshold`.** At a
standing of 48 with a cost of 47 the price is still above cost while the next legal bid is
46 — already a loss. A robot waiting on the price sits forever, the round never resolves,
and Item 3 has nothing to chart. That was the shipped behaviour before CP4b.

Every seat is dealt BOTH a sealed and an open persona, because the format is not knowable
until a page has rendered — a live driver holds a launch URL and nothing else.

### Three bugs the harnesses found, all in code I had just written

1. **The open loop never re-fetched the bot series after the last round.** `finished_at` is
   stamped by the final round's commit, so the page's original `getState` was correctly
   refused the rival costs; the sealed loop has re-fetched since CP3b and the open one did
   not. The §5.3 toggle would never have appeared. Found by the browser harness.
2. **The robot driver assumed a debrief question exists.** The results screen carries a
   Continue whether or not one follows, so in a KC-disabled instance the driver clicked it
   and waited 30s for a free-text box that was never coming. Now waits for either outcome.
3. **A spawn check that swallowed the child's stdout.** The whole point of spawning rather
   than importing (§6f) is to see what the launcher sees; the failure printed only an exit
   code. It now dumps the tail of the child's output on failure.

### ⚠ And one of my own vacuous controls, for §3's collection

**"Winners and losers are separate series"** asserted only that both selectors existed. The
cohort it ran against contained no wins — so zero winner dots was *correct behaviour* and a
failed assertion, and had the cohort gone the other way it would have passed while proving
nothing about the split. Replaced with **exact counts derived from the report API** (a
different source from the DOM under test) plus an assertion that the cohort contains both
outcomes at all, and the instance seeded so that is a fact rather than a coin flip.

⚠ Seeding it does not re-introduce §6e's trap. The unseeded classroom shape is exercised
end to end by the emulator harness's §15; what is under test here is the chart, and its
input needs to be known.

### ⚠⚠ `npx tsc --noEmit` IN `frontend/` TYPECHECKS NOTHING — a fifth harness-trap entry

`frontend/tsconfig.json` is `{ "files": [], "references": [...] }`. A bare `tsc --noEmit`
against it therefore compiles **zero files and exits 0**. Every "TS OK" it printed during
this build was vacuous, and it stayed vacuous through several rounds of real edits.

What caught the resulting bug was `npm run build` (`tsc -b && vite build`): the client read
`turn.totalEquilibriumProfit` off a response that did not carry it, so §5.3's
"perfect play would have earned" would have rendered **NaN** in front of a class.

⚠ **Typecheck the frontend with `npm run build` or `npx tsc -b`, never `npx tsc --noEmit`.**
This is the same family as §6e's table — `emulators:exec` serving a stale `lib`, the
maskless REST `PATCH`, every instance carrying a seed, `startVite` accepting a server it did
not start — *a tool believed to be checking something it was not touching.*

### A §7 reading recorded rather than left to be rediscovered

**The bot series plots each bot's COST, not the standing price it actually stopped at.**
§7 asks for exactly this — *"sitting exactly on the 45° line, since bots stop precisely at
cost"* — and it is the bot's *limit*. Its observed stopping standing would sit slightly
ABOVE the line (it declines a bid one step below where it stands), and the series would
stop being the clean benchmark the chart exists to show.

---

## 6j. ⚠⚠ NO BID BELOW COST, and the exit-price defect (2026-08-04)

### The defect: `exit_price === price` in 100% of rounds, by construction

`playerExit` returned `state.standing` of the **resolved** state. For a loser that is the
FINAL PRICE — the bots they left behind have already driven it down — and `terminate()`
sets `price` from the same field. For a winner, their last bid *is* the winning price. So
the column agreed with `price` in every round of both outcomes and carried **no
information at all**. The Tier-3 chart was plotting the clearing price against cost: the
45° benchmark meaningless for losers, the winner/loser split meaningless as a censoring
distinction.

⚠ **Why two checkpoints of tests missed it.** Every test used the reference field
47/88/21/63, where after the player leaves the **cheapest bot already holds and cannot
undercut itself** — the settle is a no-op, the price does not move, and exit legitimately
equals final. BUILD_NOTES §3, a sixth time: the scenario never contained the condition.
The live case had **two** cheap bots left, which duel each other down to 17.

**The pin** now uses that fixture deliberately — bots 12/14/88/63, student at 46 — and
asserts `exit_price !== price` on a losing round where the settle moved. It is the
assertion nothing made.

### The mechanism change: one rule for every bidder

§4.3 already forbade a BOT from bidding below its own cost. **The player was the only
bidder in the auction permitted to do what none of the others could.** Now nobody may:

- **Sealed** — `validateBid` refuses it at submit. The check runs INSIDE the transaction,
  because it needs the recorded cost, and still draws nothing: throwing aborts the
  transaction before `resolveRound` opens the rival stream.
- **Open** — `playerBid` refuses it; the screen closes Bid and says why with both numbers;
  and a bot bid landing below the cost **auto-drops** the player.

⚠ It also makes the closed-form benchmark **exact rather than approximate**: the
lowest-cost bidder always wins, and the price always lands within one step above the
second-lowest cost.

### ⚠⚠ Auto-drop can never steal a won round — structurally

It runs only on a **bot** bid, so the holder is that bot; and a player who holds is
standing at their own bid, which cannot be below their own cost. A player holding at
exactly their cost with every bot stopped is the normal winning path. The `holder` test is
written explicitly anyway, and two tests assert it — one targeted, one a 150-round sweep —
because "cannot happen" is what every stolen round is made of.

### Exit price: three cases, complete, never clamped

| | |
|---|---|
| **won** | their winning bid (censored) |
| **dropped out** | their last bid — `null` if they never bid |
| **auto-dropped** | their **cost** |

Recorded **at the moment of leaving**, on `OpenState.playerExitPrice`, and read back from
there. Never re-derived from the settled state.

⚠ **No `min()`/`max()` anywhere near it.** An early quitter at 50 with a cost of 34 records
50; clamping would plot them as perfect. And the auto-drop case is why last-bid alone is
wrong: a passive player who bid 40 and watched the bots walk to 33 would read as "quit
early, left 6 unclaimed", when what happened is the auction went below what they were
allowed to pay. Their cost is exactly that boundary.

⚠ **`null` is omitted from charts and counted separately**, never silently dropped: they
committed to nothing, so there is no revealed stopping point to record.

### Consequences

**Two personas deleted, not left dead** — sealed `loss-maker` (6→5) and open
`exits below cost` (4→3). Both existed to populate the region under the 45° line, which is
now **unreachable by construction**. Surviving sets:
*sealed* — equilibrium · cost-bidder · over-marker · under-marker · random-in-band;
*open* — exits at cost · exits early · random exit.

**Both captions rewritten.** §7's "below the line = willing to supply below cost" is dead
text in both formats; each chart now says the region is unreachable by construction rather
than empty by luck.

**`autoDrop` is its own event kind**, not a `dropOut`. A history that told a student they
quit when the auction left them behind would be a lie in the record. It is still the
player's — the invariant that a bot emits nothing but a bid is intact.

### The robot budget: wall clock, not iterations

The open loop read `guard < 400` with a 150 ms wait — roughly **60–80 seconds**, a number
nobody chose. At shipped pacing (800/1200/2500/3000) a long endgame exceeded it, fell out
of the loop, and then timed out waiting for a Continue that was never coming. **Two of
eight stuck in a launcher run.**

⚠ An iteration count is the wrong *unit*: it measures how often we looked, not how long
the auction has had. Halving the poll interval would have halved the budget silently.
Now **5 minutes of wall clock per round**, with the loop's exit reason logged and the
longest round reported so the margin is visible rather than assumed.

⚠ **The browser cohort now runs at the SHIPPED schedule.** It previously ran at
`delayMs: 0` — zeroing the pacing exactly where the bug lived, which is why the harness was
green throughout. **Measured after the fix: longest round 41–42 s against a 300 s budget,
86% headroom, headless AND headed.**

### ⚠⚠ Occluded-window throttling was my hypothesis and it was WRONG

I predicted timer throttling would dominate the headed case and that wall-clock budgeting
alone might not fix it. It did fix it. The headed run went red twice, and **neither cause
was throttling**:

1. **A flake I had just introduced.** The `[OPEN]` section drew a student cost from the
   full 10–60 range, so once auto-drop existed the round often resolved mid-cascade and
   never reached `waiting`. Headless passed only because the draw was low. Both harnesses
   now PIN the cost range per section — cheap student for the manual path, dear student for
   the auto-drop path — so each section tests the ending it names rather than whichever the
   RNG produced.
2. ⚠⚠ **A genuine product defect: a player's click was silently swallowed.** `call()`
   returned early whenever anything was in flight, and at a fast delay schedule the advance
   tick is in flight most of the time — so a student pressing **Drop Out or Bid mid-cascade
   got nothing. No action, no error, no reason.** §5.1 requires both controls live while the
   bots bid, and "live" has to mean the press does something.

   Player actions now **queue** behind an in-flight call; ticks still skip, because another
   tick is already scheduled and queueing them would stack redundant advances. The
   asymmetry is the point: there is no second Drop Out coming, and the student is watching
   for it.

**Only the headed run found (2).** It is the case where the harness clicks land against a
live tick often enough to matter — which is also the case a real student is in.

---

## 6k. Table sorting — an ADOPTION, not a restoration; and the four missing points

### ⚠⚠ Procurement never had column sorting. It was not lost.

Reported as a regression ("that ability is gone"). It is not one. `git log` over **every
commit that has ever touched** `procurement/Dashboard.tsx` and `procurement/Reports.tsx`
finds `SortableTable` in **none** of them: procurement shipped a plain `<table>` at CP1
(4262ed2) and has rendered one ever since. Nothing removed it, and the format-gate work
did not bypass it.

### The family audit (Item 3, read-only)

| game | dashboard | class report |
|---|---|---|
| pennies | **SortableTable** — name, status, bid | **SortableTable** — name, bid, estimate, truth, status, profit |
| poll | **SortableTable** — responses | **SortableTable** — name, answer, status |
| pd | **SortableTable** — name, status, rounds, coop, avgYears, strategy, kc, participation | **SortableTable** — name, status, rounds, coop, avgYears, strategy, kc (+3 tiles) |
| pricing | **SortableTable** — name, status, rounds, avgPrice, avgProfit | **SortableTable** — name, status, rounds, avgPrice, avgProfit, total, kc, participation |
| newsvendor | **SortableTable** — name, status, periods, avgOrder, avgProfit | **SortableTable** — name, status, periods, avgOrder, avgDemand, inStock, avgProfit, benchmark, gap, qopt |
| forecast | **plain `<table>` — never had it** | **SortableTable** — name, status, months, mse, se, mae, bias, mape, accuracy, bonus |
| procurement | **plain — never had it** → now adopted | **plain — never had it** → now adopted |

**Sorting has always been SHARED**, not per-game: `SortableTable` + `SortableColumn` in
`@mygames/game-ui` (`src/dashboard/SortableTable.tsx`). Games supply columns and
comparators; the widget owns click-to-sort, reverse, the active-column arrow, `nullsLast`
and role filtering.

⚠ **Two gaps remain and BOTH are pre-existing, neither is procurement's:** forecast's
DASHBOARD has never used it (its report does). Not touched — Elena's call, and it is
another game's hosting target.

**Nothing shared was modified.** Procurement now consumes the widget the same way the
other five do, so this stays a one-target deploy.

### The columns, and why the comparators are what they are

Dashboard — name · status · rounds · won · profit · KC. Report — name · status · rounds ·
won · profit.

- **Numeric columns compare numbers, never rendered strings.** Pennies' own header records
  the string-sort bug shipping *twice*; `"10" < "9"` is the whole of it.
- **Name uses `localeCompare(…, { sensitivity: 'base' })`**, not a lowercased copy, so
  "de Souza" and "De Souza" sit together.
- **Status ranks by PROGRESS**, not alphabetically — alphabetically "Finished" precedes
  "Not started", the exact reverse of useful. The dashboard has a fourth rank
  (`finalized`, from `normalizedScore`); the report has three.
- **KC is `nullsLast`.** A student who has not sat it is absent, not a zero, and sorting
  them among the zeroes would read as "scored nothing".
- ⚠ **"See rounds" is an action and is NOT a column.** It renders inside the Name cell,
  because `SortableTable` makes every header clickable and a column of buttons would
  advertise a sort that means nothing.
- **Both column sets are format-neutral** — every one is a roster fact both mechanisms
  produce. The format-specific detail is one level down, in the per-student rounds modal,
  where the gate already is.

### ⚠⚠ The four missing chart points — identified, not assumed

The open class scatter showed 90 + 34 = 124 points against 128 resolved rounds.

**Reproduced in the emulator before anything was written.** A 16-robot open cohort
produced **4 null exits in 76 rounds** — the same signature and roughly the same rate:

| pid | round | cost | exit_price | player bids | end event | well-formed |
|---|---|---|---|---|---|---|
| robot-16-… | 2 | 54 | ABSENT | 0 | dropOut | yes |
| robot-2-… | 2 | 60 | ABSENT | 0 | dropOut | yes |
| robot-3-… | 7 | 60 | ABSENT | 0 | dropOut | yes |
| robot-6-… | 5 | 58 | ABSENT | 0 | dropOut | yes |

**(d) They genuinely carry a null exit — the chart's filter is correct.** Not a rendering
bug, and not a mechanism gap either: `null` is the SPECIFIED value for "dropped out having
never bid", and it is the *only* case that produces one — a winner always has a bid, and an
auto-drop records the student's cost. The three cases remain exhaustive.

**How a robot produces one**, which the prompt doubted: its threshold is `cost + 0..20`, and
if the cascade drives the price below that threshold *before its first poll*, it drops out
without ever bidding. Every one of the four had a dear cost (54–60), so the price passed
their threshold early while still above their cost — which is why auto-drop did not fire
instead.

⚠ `exit_price` reads **ABSENT** rather than `null` because `parseStoredRounds` round-trips
it conditionally, so the first whole-array rewrite drops a null key. Same to every consumer;
recorded so nobody reads "absent" as a different failure.

**The fix is the legend, not the filter.** Both charts now count unplotted rounds **from the
data** and say so — *"4 rounds are not plotted: the auction was left without a single bid …
128 rounds in total"* — and show **nothing at all** when the count is zero.

⚠ **A cosmetic finding, not fixed here:** robot participant ids embed the SEALED persona
name (`robot-16-equilibrium`) even in an open instance, because the label is built from the
sealed style before the format is known. The robot plays its OPEN persona correctly; only
the id misleads. Flagged, not changed — it is outside this prompt.

---

## 6l. Sorting people by LAST name (Elena, 2026-08-07)

§6k adopted `SortableTable` but sorted the **display string**, which is a **first-name**
sort. Elena: *"the sort has to be by last name … find that algorithm that parses the name
before sorting so that everything is consistent."*

### The algorithm already existed, and it is not in a place a single-player game can reach

`@mygames/game-ui`'s `RosterTable.tsx` has sorted by surname since it shipped:

```ts
function getLastName(name: string): string {
  const tokens = name.trim().split(/\s+/)
  return tokens[tokens.length - 1]
}
```

⚠⚠ **But `getLastName` is module-private, and `RosterTable` is a MULTIPLAYER component**
(`SharedParticipant`, `group_id`, "Negotiating"). No single-player game renders it. Exporting
it would edit a package **every game consumes** — a seven-target deploy at minimum, and
Elena's call, not a side effect of a procurement sort. So the rule is **copied verbatim**
into `frontend/src/procurement/sortName.ts`, which says exactly that in its header, and
`sortName.test.ts` pins it against an independent restatement of the shared source so the
two cannot drift silently.

⚠ **Behaviour is identical; only the code is duplicated.** That is the trade recorded: one
duplicated three-line function against a cross-family package bump.

### ⚠⚠ The wider finding: NO single-player game sorts by last name

Checked, not assumed — all seven sort the whole display string:

| family | surname sort? |
|---|---|
| multiplayer roster (`game-ui` `RosterTable`) | ✅ always has |
| pennies · poll · pd · pricing · newsvendor · forecast | ❌ first-name, all six |
| procurement | ❌ → ✅ **fixed here** |

So procurement is now the ODD ONE OUT in its own family while matching the platform's
older, larger one. **The real fix is to export `getLastName` from `game-ui` and adopt it in
all six remaining single-player games** — one shared change, seven targets, Elena's
decision. Flagged, deliberately not taken.

### Every column tiebreaks on it

`SortableTable`'s own `tiebreak` fires **only when both rows are null** (`SortableTable.tsx:88`),
so a general tiebreak has to live inside `compare` — which is exactly what `RosterTable`
does (`… || a.lastName.localeCompare(b.lastName)`). Without it the twenty students who are
all "Not started" fall in **server order**, and the roster reshuffles under the instructor
between refreshes. This closes the RISK flagged at §6k.

⚠ A tiebreak folded into `compare` **reverses with the sort direction**. The shared roster
behaves the same way; consistency was preferred over a stable secondary key.

### Known limits, accepted deliberately

"Ana de la Cruz" keys on **Cruz**; "Kim Jr." keys on **Jr.**. A cleverer parser would be a
DIFFERENT algorithm from the rest of the platform's, and a roster that sorts one way in
Baxter and another way here is worse than one that is uniformly imperfect. Improving it is a
shared change, made once, for everybody.

⚠ One deliberate divergence from `RosterTable`: procurement passes `{ sensitivity: 'base' }`
so "de Souza" and "De Souza" sit together. It changes only which SPELLING of the same name
comes first, never which name comes first.

### Controls

Two mutations, both bite:

| mutation | result |
|---|---|
| `compareByLastName` → sort the display string (the pre-08-07 behaviour) | **6 of 25 fail** |
| drop the full-name tiebreak | **3 of 25 fail** |

⚠ And the browser harness now **clicks the real header**: it asserts the roster opens in
surname order, that clicking Name reverses it, and that clicking Profit sorts numerically
ascending. §6k listed "no test drives an actual header click" under NOT VERIFIED BY TEST;
that gap is closed. Names come from the rendered roster, never hardcoded.

---

## 6m. The rule went FAMILY-WIDE — all seven games (Elena, 2026-08-07)

§6l fixed procurement and flagged that it was then the odd one out. Elena: *"I would like
all other single player games to sort by last name. So that it is consistent with the other
games."* Done — **13 comparators across 7 games**.

### Where the rule lives, and why NOT in `game-ui`

`frontend/src/shared/sortName.ts`, **not** an export from `@mygames/game-ui`. Exporting
`getLastName` would edit a package **every family** consumes (Baxter, Winemaster, …) for a
change only the single-player family asked for. Living in `shared/` the blast radius is one
repo and one project's seven hosting targets. The duplication is a three-line function, and
`sortName.test.ts` pins it against an independent restatement of game-ui's rule so the two
cannot drift silently.

⚠ **This is now the SECOND copy, deliberately.** If a third appears, promote it to `game-ui`
instead.

### ⚠⚠ THE MODULE TAKES STRINGS, NOT ROWS — and that is the whole safety argument

The seven games disagree about what an **unnamed** row is called: six fall back to `''`,
procurement falls back to the participant id, and forecast's dashboard to `participant_id`.
That fallback decides whether unnamed students **clump at the top** or **scatter by id**.
Changing it would be a behaviour change riding along on a sorting change, so every caller
keeps its **own** fallback expression verbatim and this module changes only the ORDERING
RULE. `lastNameOf('')` is `''`, so empty names still clump exactly where they did.

### What was touched

| game | dashboard | report |
|---|---|---|
| pennies · pd · pricing · newsvendor | name column | name column |
| poll | name column | **two** — the answers table and the status table |
| forecast | ⚠ no columns — sorts rows in place, ordering changed | name column |
| procurement | name + every column's tiebreak (§6l) | name + tiebreaks |

⚠ **`forecast`'s dashboard STILL has no clickable column sorting.** It now *orders* by
surname, but it is the one roster in the family without `SortableTable`. Pre-existing, first
recorded at §6k, and deliberately still not fixed — Elena asked for last-name sorting, not
for the missing widget.

⚠ **Tiebreaks were NOT added to the other six games' non-name columns.** Procurement has
them (§6l); the rest still fall to server order within a tied column. Same latent defect,
but adding it would change orderings five browser harnesses assert on, for something nobody
asked for. Flagged, not taken.

### The test is a SOURCE SCAN, and the reason is worth recording

Almost none of these column arrays can be imported: most are module-private, and five are
declared **inside** their component body (`poll`, `pd`, `pricing`, `newsvendor`, `forecast`
Reports). Exporting eleven of them to satisfy a test would restructure six components for no
runtime benefit. So the conformance test **reads the source** and asserts every Name column
routes through `compareByLastName`.

⚠ **It is a WIRING check, not a behaviour check.** Behaviour is proved by
`compareByLastName`'s own tests; end-to-end wiring by the procurement browser harness, which
clicks a real header and reads the rendered order. Stated plainly so nobody mistakes the scan
for proof that a roster renders in order.

⚠ A fixed-width window was **not** enough, and the first version proved it: procurement's
report Name column renders a "See rounds" button, so its `compare:` sits ~500 characters
after its `key:` and a 400-char window reported a **false failure**. The window now ends at
the next `key:`.

### ⚠⚠ Another worthless-control specimen, for §3's collection

The first per-game control run reported **"NOTHING FAILED"** for all six games — and I had
`cd`'d into `src/`, so `npx vitest run src/shared/…` resolved to `src/src/shared/…`, matched
no test files, and the grep for "N failed" found nothing in output that said *"No test files
found"*. **A control that runs zero tests reports exactly like a control that bites.** Fixed
by asserting the baseline passes 30 first, then reading the full `Tests` line rather than
grepping for a failure count.

Redone properly, **13 of 13 controls bite**: reverting any single game's Dashboard or
Reports to the display-string comparator fails 2 of 30 (forecast's dashboard 1 of 30 — it
has no `key: 'name'` column, so only its dedicated assertion fires).

⚠ And `npm run build` was re-verified to actually typecheck by injecting a deliberate type
error (`error TS2322`, caught) — §6i records that `npx tsc --noEmit` in `frontend/` checks
nothing, and a 200ms incremental build looks identical to a build that skipped.

---

## 6n. All-column sorting, tiebreaks everywhere, and the robot id (Elena, 2026-08-07)

§6m took the last-name rule family-wide. Elena then asked for the rest of the consistency:
*"Sorting by all columns on dashboard and report, and when sorting by name, use last name,
should exist for all single player games."* Plus two items carried from §6k's report.

### Sorting on every column — one gap, and it was the one already known

Audited all seven games first. **Every roster already had every column sortable except
forecast's dashboard**, the last one in the family rendering a plain `<table>` (5 raw `<th>`).
It now uses `SortableTable`: name · status · months · MSE · std error, with `nullsLast` on
both metrics — ⚠ *a student with no MSE has not played; sorting them among the low scores
would read as the best forecaster in the class.*

⚠ **The remaining raw `<th>` tables are NOT rosters** — they are the per-student drill-down
round histories in forecast/Reports and procurement/Reports, which are **chronological by
design**. Sorting a round history by profit would destroy the only order it has. Left alone
deliberately, so nobody "finishes the job" later.

### The tiebreak went to all 85 columns

§6l gave procurement a last-name tiebreak on every column and §6m explicitly declined to
spread it, on the grounds that nobody had asked and it could disturb five browser harnesses.
Elena asked. **85 columns across 14 files** now fall back to last name.

⚠ Each game defines its own `const tie` carrying **its own null fallback**, and the shared
module still only supplies the ordering rule (§6m). A conformance test pins every `const tie`
to `compareByLastName`, because otherwise the Name-column scan would wave through a file that
defined `tie` as anything at all.

### ⚠⚠ The robot id named the wrong persona — and why the fix is NOT a probe

Ids embedded the **sealed** persona (`robot-16-equilibrium`) even on open instances, where the
personas are exits-at-cost / exits-early / random-exit. These ids are how the robot reports
get read, so the label was misleading about the only thing it exists to say.

**The constraint that shapes the fix:** gameplay reads the format **off the screen** (§6f — a
live robot has a launch URL and nothing else), but **the id must exist before the page
loads**. So the id cannot come from the screen, and a probe request would either pollute the
instance with a throwaway participant or reintroduce the config dependency the driver exists
without.

**Resolution: `--format` is passed in by the caller that CREATED the instance.** Gameplay
detection is untouched.

⚠ **It only ever mattered in emulator/dry-run runs.** In a live run `mintUrl` **ignores the
pid entirely** — a robot's name comes from the launcher. Worth recording, because it bounds
the bug: no live report ever carried a wrong persona name.

⚠ **With no `--format`, the seat is `robot-3` — unnamed rather than named wrongly.** A bare
seat number says "persona not known here", which is true; the old behaviour was a guess that
was wrong half the time.

⚠ **Slugged.** The sealed names were already id-safe (`cost-bidder`); the open ones carry
spaces (`exits at cost`), and a space in a participant id is a broken URL, not a cosmetic
problem. The browser harness now asserts on the **ids themselves** — no id may end in a
sealed persona name, every id must end in an open one — rather than on the summary line,
because the summary was always right; it was the id that lied.

### Controls (16 total, all bite)

| mutation | fails |
|---|---|
| revert any one of 13 files to the display-string sort | 2 of 32 each |
| strip a `\|\| tie(a, b)` from any column | 1 of 32 |
| define a local `tie()` without the shared rule | 2 of 32 |
| revert forecast's dashboard to a plain table | 1 of 32 |

---

## 7. Which hosting targets a frontend change needs — the standing rule

Read off `frontend/vite.config.ts` and `firebase.json`, not off convention.

**How the build is actually configured.** `vite.config.ts` sets no `rollupOptions`,
`manualChunks` or lazy boundaries, so it is a DEFAULT SINGLE-ENTRY build: one
`dist/assets/index-<hash>.js` containing ALL SEVEN games, because `App.tsx` imports every
game's Play/Dashboard/Settings/Reports statically. And in `firebase.json` all seven
hosting targets — pennies, poll, pd, pricing, newsvendor, forecast, procurement — declare
the SAME `"public": "frontend/dist"`.

So one `npm run build` produces one artifact that is the deployable for every target, and
`--only hosting:<target>` publishes that artifact to ONE site. The rest keep serving
whatever they were last given.

**Which targets NEED redeploying = the ones whose BEHAVIOUR changed.** Decide from the
changed paths:

| Changed | Redeploy |
|---|---|
| only `frontend/src/<game>/…` | that game's target |
| `frontend/src/shared/…`, `App.tsx`, `hostRouting.ts`, `firebase.ts`, `main.tsx`, `index.css` | **all seven** |
| a `@mygames/game-ui` bump | **all seven** |

⚠ **THE TRAP: cross-game imports make the path rule insufficient.** `git diff --name-only`
tells you which game's folder changed, not who imports it. Today the tree contains exactly
ONE cross-game import — `procurement/api.ts` imports `isAuthError`,
`instructorErrorMessage`, `CLASSROOM_URL` and `STUDENT_CLASSROOM_URL` from
`../forecast/api`. So a change to `forecast/api.ts` changes PROCUREMENT's behaviour too.
Before concluding "one target", grep for importers of the module you touched:

```
grep -rn "<ModuleName>" frontend/src | grep -v "^frontend/src/<game>/"
```

⚠ **Corollary — the sites drift, and that is expected.** Because there is one bundle, any
target you do not redeploy keeps an OLDER `index-<hash>.js`. That is harmless while its own
code paths are unchanged, but "all seven serve the same file" is only true immediately
after deploying all seven. Do not treat a hash mismatch between sites as a fault.

**Worked example (08-03).** The class-chart legend fix touched only
`frontend/src/procurement/ClassScatterSVG.tsx`, whose sole importer is
`procurement/Reports.tsx`. One target: `hosting:procurement`.

---

## 6. `allowDropOut` does not exist

It appears in an early prompt's config list but in **neither** FINAL spec. Drop Out is
determined by `format` (open only — sealed §6.3, open §4.5), not by a separate key. Adding
one would create a second way to express something `format` already decides, and a
configurable-but-incoherent state (sealed + `allowDropOut: true`). Raised at spawn, left
out.
