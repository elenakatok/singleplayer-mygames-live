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

### ⚠⚠ THE "≥ WHAT THE PLAYER EARNED" PROPERTY IS **NOT** GUARANTEED — measured, reported

Elena asked me to confirm it is now genuinely guaranteed rather than usually true, and to
report a defect rather than relax the assertion. **It is not guaranteed.**

The closed form prices the contract at *exactly* the second-lowest cost. The mechanism
cannot: a bot stops when `standing − step < its cost`, so a player holding the low bid wins
at up to `secondLowest + step − 1`. A real player therefore beats the benchmark by **less
than one step in force where the round settled**.

**Measured** (`procurementOpenExit.test.ts`, 300 unseeded rounds, player following the
dominant strategy): **31 of 166 winning rounds beat the closed form — about 19% of wins —
worst excess 3 ECU.** The emulator harness hit one live on its first run: player 28,
perfect 25.

So a student can see "you earned 28, perfect play would have earned 25". Options, none
taken unilaterally:

1. **Leave it.** The gap is ≤ 3 ECU and only on rounds they won; the benchmark stays the
   theoretical statement the lecture makes.
2. **Define the benchmark as `secondLowest + step(secondLowest) − 1`** — the best the
   mechanism can actually pay a perfect player. Exact, never beatable, but no longer the
   number on the slide.
3. **Clamp** `eq_profit` up to the realized profit. Cheapest, and dishonest — it would
   make the benchmark a function of the student's own play.

Tests assert the **bound** (excess < one step), not the property. The harness comment says
so in those words so nobody later reads a passing check as "perfect play is never beaten".

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
