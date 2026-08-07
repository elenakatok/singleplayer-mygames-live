# Metalcraft Supplier Scorecard — build notes

Decisions and findings made during the build that are **not** in the spec, kept beside the
code because each one is a thing a later reader would otherwise re-derive or undo.

Spec is the authority: `Scorecard_Game_Specification_v3_FINAL.md`. Where this file and the
spec disagree, the spec wins unless a section below explicitly records a departure Elena
approved.

---

## 1. The spec's numbers were independently reproduced before any code was written

Every figure in spec §6.2 and §6.3 was re-derived from the stated rule alone, in a
throwaway script that had not seen the repo. **All of them matched**, which is why the
fixtures are trusted as a regression target rather than treated as approximate:

- Both slide-6 panels, **80/80 cells each**
- All eight §6.3 benchmark rows, in both conditions
- Both Δ values §6.2 quotes (8.80 at period 7/score 6; 2.72 at period 4/score 0)
- The §6.3 effort profile, all ten periods of all three rows
- `P(Binom(10,0.7) ≥ 7) = 0.6496` and `P(Binom(10,0.4) ≥ 7) = 0.0548`
- The 27.8% dead-state share

Two figures needed a definition pinned down before they reconciled. Both are recorded
below because in both cases the **obvious** reading is the wrong one and produces a
plausible number.

### 1a. ⚠ "Written off" is NOT "mathematically dead"

Spec §6.3's effort-profile table has three rows — P(high), P(coasting), P(written off) —
and they **partition to 1.00 in every period**. That fixes the definition:

```
P(written off) = 1 − P(high) − P(coasting)
```

It is the mass where **the DP has stopped paying and is not coasting**, which *includes
states that are still mathematically alive*. Spec §6.2 says so directly: it calls
(period 4, score 0) a write-off at Δ = 2.72, even though score 0 with seven periods left
can still reach seven.

Reading it as the strict "score + periodsRemaining < target" instead gives
`0 0 0 0 .02 .06 .09 .14 .21 .28` against the spec's `— — — .03 .08 .06 .21 .14 .21 .28`
— the last three periods agree, so a careless check passes.

⚠⚠ **BOTH SENSES ARE NEEDED AND THEY ARE TWO SEPARATELY NAMED FUNCTIONS** (Elena, 08-07).
Do not unify them, and do not let a caller pick "whichever is handy":

| | `isWrittenOff` (dp.ts) | `isDead` (resolve.ts) |
|---|---|---|
| Sense | loose | strict |
| Test | optimal policy stops paying, target unmet | `score + periodsRemaining < targetScore` |
| Depends on | the whole DP | arithmetic only |
| Feeds | §6.3's effort-profile row | §4.1's silence, Tier 1's "periods paid after dead" |

**What conflating them would silently do.** Tier 1's column claims a student paid for a
contract that was **already impossible** — a fact they could have derived themselves from
the periods-remaining counter (spec §4.1). Serving the loose predicate there would change
the claim to "paid for a contract the DP would have abandoned", counting give-ups that were
never impossible. The effort-gap ranking built on that column would then order the class by
**divergence from optimal play** rather than by **waste** — a different claim, and one spec
§11 does not make.

Measured on a concrete transcript (ten high-effort periods, no acceptable deliveries):
strict counts **6**, loose counts **7**. One extra period charged to every such student.

They disagree in exactly **three** states at the shipped defaults — `(p4,s0)`, `(p5,s1)`,
`(p7,s6)` — the same three cells §4 below is about. Dead always implies written off; the
reverse never holds. Both directions are asserted, and the count of strictly-looser states
is pinned at 3 so the distinction cannot quietly disappear.

### 1b. ⚠ The 27.8% dead-state share double-counts unless dead mass is removed

`deadStateShare()` removes dead mass from the live distribution as it counts it. The
tempting alternative — "dead now, and alive one period ago" — **double-counts**, because a
contract that scores a point *while already dead* re-satisfies the test: at `s + r < S`,
scoring gives `(s+1) + (r−1) = s + r`, still dead, still "newly" dead by that test.

The naive version reports **35.6%** for the high condition (plausible, wrong) and **136%**
under an always-low policy (impossible, which is what exposed it). The corrected figure is
**27.8%**, matching spec §6.3 exactly.

There is a cross-check in the test suite: `deadStateShare(…, minPeriodsLeft = 0)` must equal
`1 − P(bonus)`, since every contract finishing below target was dead at some point.

---

## 2. ⚠ The threshold rule is implemented on the cost DIFFERENCE

Spec §6.1 writes the marginal rule as `c / (reliability − p_low)`. That is correct at every
shipped default because `lowEffortCost` is **0** — but `lowEffortCost` is a setting (spec
§3), so the implemented rule is

```
(highEffortCost − lowEffortCost) / (reliability − p_low)
```

which reduces to the spec's expression exactly whenever `lowEffortCost = 0`.

**Not a departure** — the same rule, stated for the configuration space the settings screen
actually permits. It is pinned by a test: raising *both* costs by the same amount must leave
the policy identical and move earnings by the level shift only.

`marginalThreshold()` returns `Infinity` when `reliability ≤ p_low` rather than dividing by
zero — no point is ever worth enough, which is the honest answer, and the settings panel
renders it rather than crashing.

---

## 3. ⚠ A mutant the slide-6 fixtures do NOT kill — recorded, not hidden

Following procurement BUILD_NOTES §3 ("a control can appear to fail correctly and still be
worthless"), the solver was mutation-tested against the fixtures. Four of five mutants die:

| Mutation | Killed by the fixtures? |
|---|---|
| low effort resolves at `reliability` (the condition collapse) | ✅ |
| the effort cost dropped from the comparison | ✅ |
| the "work until you hit the target" shortcut | ✅ |
| the bonus threshold off by one | ✅ |
| **`>=` for `>` — ties go to high effort** | ❌ **SURVIVES** |

**Why it survives:** at the shipped parameters no state is ever an exact tie, so strictness
is unobservable. A test asserting "the fixtures guard the comparison operator" would have
been decorative — exactly the failure mode procurement's §3 is about.

**The fix is a scenario that actually contains the condition**, not a weaker assertion. The
tie is *constructed*: at the last period, Δ is exactly `bonus` at score S*−1 and 0
elsewhere, so the comparison reduces to `(reliability − p_low) · bonus  vs  c`. Choosing
binary-exact values — reliability `0.5`, p_low `0.25`, bonus `120`, c `30` — makes both
sides exactly `30`, with no float slack. The test asserts the tie is genuine (`high === low`)
*before* asserting which way it breaks, so it cannot silently decay into a near-tie that
proves nothing.

### ⚠ Ties go to LOW effort — and it is `E[#high]`, not earnings, that this protects

Per spec §6.1's "must be worth **more** than the threshold". The convention is pinned
deliberately (Elena, 08-07), and the reason is not the obvious one:

> A tie leaves **E[earnings] unchanged by definition** — both actions are worth exactly the
> same, which is what "tie" means. It does **not** leave **E[#high]** unchanged. Breaking
> ties toward high effort inflates the expected high-effort count, and `E[#high]` is
> precisely the quantity the **§3.1 separation warning** compares between conditions.

So an instructor whose parameters happen to produce ties would, under a `>=` solver, see a
separation figure computed under a **different convention than the one spec §6.3's
benchmarks were computed with** — a warning silently calibrated against the wrong number,
on a screen whose entire job is to tell them whether the lesson survives their edits.

Asserted directly: at the constructed tie configuration, earnings are identical under both
conventions while the ties-to-high policy's `E[#high]` is strictly larger.

⚠ There is **no epsilon** anywhere in the comparison. The (period 7, score 6) cell sits
0.48 from flipping and spec §6.2 records that it "flips under small parameter edits" —
that is a *design fact about the parameters*, which the settings panel exists to surface,
not float noise to be smoothed away.

---

## 4. ⚠ There are TWO "work until the target" shortcuts and only one of them is subtle

The build prompt warns that a second policy implementation is the likeliest way to break
this game. Measured, under high reliability:

| Rule | Cells where it disagrees with the DP | Cost per contract |
|---|---|---|
| **Optimal (DP)** | — | — |
| "work until target" (naive) | **24** | **2.96 ECU** |
| "work until target, stop when mathematically dead" | **3** | **0.163 ECU** |
| optimal except forced high at (p7, s6) | 1 | 0.057 ECU |

**The spec/prompt's "0.17 ECU" is the dead-aware rule's 0.163**, not the naive one's 2.96 and
not the single cell's 0.057. This matters: the naive rule is *obviously* wrong (it keeps
paying for contracts already written off, 24 cells' worth), so nobody would ship it. The
**dead-aware** rule is the one a careful builder would actually write, and it is wrong in
only three cells: `(p4, s0)`, `(p5, s1)`, `(p7, s6)`. **Two of the three are exactly the
cells spec §6.2 names** as the ones that make the DP non-optional.

### ⚠⚠ The argument for one-solver is that the error is RARE, not that it is small

This is the framing to keep, because the obvious reading of "0.163 ECU" is *"negligible —
ship the shortcut"*, and that reading is wrong (Elena, 08-07):

| | |
|---|---|
| Cost **per visit** to (p7, s6) | **0.48 ECU** |
| P(reaching that state) under optimal play | **11.8%** |
| Cost **unconditionally** | 0.48 × 0.118 ≈ **0.057 ECU** |

The dead-aware shortcut is not a policy that is *slightly* wrong everywhere. It is a policy
that is **substantially wrong in a state students rarely reach** — and rarity is what makes
it survive review, not smallness. Nobody watching a screen will see 0.163 ECU per contract.
Anyone landing on (p7, s6) is being told to spend 4 ECU on a point worth 8.80 against a
threshold of 10, which is a real and legible mistake about the thing the lecture teaches.

⚠ **Never quote the unconditional 0.057 (or the 0.163) as "the size of the mistake".** It is
the size of the mistake *averaged over the times it does not occur*. A future reader who
reconstructs the naive rule, measures 0.163, and concludes the shortcut is fine will have
made exactly the inference this section exists to prevent.

The three shortcut cells are also the three where `isWrittenOff` and `isDead` diverge (§1a)
— the same states, reached from two different directions, which is a good sign that this is
a real structural feature of the game rather than an artefact of the parameters.

---

## 5. The config/truth split runs along a different seam than any other game

Full reasoning is in the header of `config.ts`; the short version, because it is the thing a
reviewer is most likely to get wrong:

Almost every number in this game is **printed on the student's screen and must be**
(spec §8). What is withheld is not the economics but the **experimental design** — that
reliability alternates, that there are exactly two conditions, that the roster is
counterbalanced.

So `reliabilityHigh` **and** `reliabilityLow` both live in `truth/main` even though one of
them is on screen at all times: holding the **pair** is what reveals the design. Same for
`labelHigh` / `labelLow` — the label *text* names the other condition, so shipping both
strings would leak in prose what the numbers were carefully withholding (S4 applied to
copy). The server sends the current contract's reliability and its rendered label, one
contract at a time.

`pAcceptableLow` is in `config/main` and that is **correct**: it is displayed, it is
identical in both conditions, and it discloses nothing about the treatment.

`showRemainingPeriods` appears in **neither** half — spec §3 marks it "true, NOT editable"
and §4.1 explains why. There is no setting because there is no choice.

---

## 6. `{pct}` is a token, never a typed-in percentage

`labelHigh` / `labelLow` store `"High Reliability ({pct})"`. `renderLabel()` is the only
place a probability becomes a percentage a student reads, and it rounds (R8).

The failure this prevents: an instructor edits `reliabilityLow` to 0.5, leaves a hardcoded
`"(40%)"`, and ships a screen that contradicts the game it is describing. Tested, including
a label carrying no token at all (legitimate) and one carrying the token twice.

---

## 7. Deliberate design points that look like bugs

Carried from spec §5 / the build prompt so nobody "fixes" them:

- **Low effort is 30% in both conditions.** The mechanism, not a copy-paste error. Only the
  high-effort probability moves.
- **Under low reliability, always-high (16.57) is three times WORSE than always-low
  (51.27).** The columns invert. Asserted in the test suite precisely because it is the most
  counter-intuitive number in the game.
- **Optimal high-effort periods under low reliability is 0.13** — not ~1 and not ~5. The work
  region is a sliver reachable only by getting lucky on free draws first.
- **Rows 5, 6 and 7+ of the two slide-6 panels are identical.** Correct: in the squeeze
  region Δ approaches the full bonus, clearing both the 10 and the 40 threshold. The
  conditions differ only where Δ is modest.
- **The game announces a reached target but never an unreachable one.** Deliberate asymmetry
  (spec §16, decided 08-07).
- **Earnings are never graded** — a correctness requirement here, not a preference: correct
  play under low reliability *earns less*.

---

## 8. Checkpoint log

**CP1 (pure core)** — `dp.ts`, `fixtures.ts`, `schedule.ts`, `resolve.ts`, `validate.ts`,
`config.ts`. 97 unit tests. Both slide-6 panels reproduced 80/80; all eight §6.3 benchmark
rows exact; five mutants run, four killed, the survivor documented in §3 above and killed by
a constructed tie.

---

## 9. ⚠ The contract boundary — a gated READ, not a write

Spec §13 forbids "next-contract reliability before that contract starts", and spec §4's
flow puts a contract-result screen between contracts. Those two together decide the design,
and it is not the obvious one.

**Contract-start is NOT a separate server screen.** Spec §4 describes it as "Contract k of
10 · Period 1 of 10 · the reliability label · score 0 · balance = endowment" — which is
period 1's effort-choice screen with a heading. It ships as `effort-choice` carrying
`isContractStart`. That is why the build prompt names exactly **three** resume boundaries
(mid-contract, contract-result, session-summary), not four.

**Advancing is `scorecardGetState({ advance: true })` — a read that writes nothing.** The
next contract's condition is derived from the stored `startsWith` on the spot, so it does
not exist in the database until its first period is submitted. The omission is in the data
model, not in a filter (S8).

⚠ **It is GATED, and the gate is the whole point.** `advance` is honoured only when the
student is genuinely at contract-result. Without that, any student could call it
mid-contract and read the next contract's reliability — the exact leak the design is
avoiding. A mid-contract caller is refused and learns nothing.

### ⚠ The bug this design caused, and the fix

Because `advance` writes nothing, `positionOf` still reports `contract-result` after the
student has advanced — so `scorecardSubmitPeriod`'s ordering check rejected the first
period of the next contract with *"That is not the period you are on"*. Every session died
at contract 2, period 1. **The CP2 harness caught it on its first clean run.**

The fix is that **two positions are legal sources for a submit**, not one:

| Position | Legal submit |
|---|---|
| `effort-choice(k, p)` | `(k, p)` — the ordinary case |
| `contract-result(k)` | `(k+1, 1)` — **the contract boundary** |

A future reader who tries to "simplify" that check back to a single case will reintroduce
the same total failure. It is commented at the call site for that reason.

---

## 10. ⚠ `(4 − 0) / (0.4 − 0.3)` is 39.999999999999986

Not 40. `0.4 − 0.3` is not exactly `0.1` in IEEE 754, and the low condition's marginal
threshold runs straight into it — so the knowledge check's Q2 would have printed
**"39.999999999999986 ECU"** as an answer option.

`questions.ts` rounds before rendering (`ecu()`), so students read "40 ECU". The harness
now rounds too, and additionally asserts that **no KC option matches `/\d\.\d{4,}/`** —
a general guard rather than a fix for this one number, since any edited probability can
land in the same place.

⚠ This is R8 ("round percentages before display") arriving somewhere R8 did not obviously
apply. The rule is really *round anything derived before it reaches a screen*.

---

## 11. Checkpoint log

**CP2 (student flow)** — `scorecardGetState`, `scorecardSubmitPeriod`,
`scorecardGetQuestions`, `scorecardSubmitKcAnswer`, `scorecardSubmitDebrief`; `state.ts`
(the bespoke nested loop), `clientState.ts` (the whitelist), `instance.ts` (the join
counter), `rng.ts`, `questions.ts`, `reveal.ts`; the frontend Play flow with
`key={screen.id}` isolation at both boundaries; Firestore rules. 133 unit tests plus a
162-check emulator harness, both arms played end to end.

⚠ **Dashboard, Settings and Reports ship as declared stubs** (`frontend/src/scorecard/
Placeholders.tsx`) — App.tsx's per-game map requires the quartet, and scorecard needs a
routing entry before Play is reachable. Each stub says on screen that it is not built.
CP3 replaces all three.

---

## 12. ⚠⚠ The effort gap has a STRUCTURAL FLOOR — deadness, not reliability

Found by the robot cohort, 08-07, and it matters because the effort gap is the Tier-1
headline.

A persona that ignores reliability entirely but **stops working on dead contracts**
measured a gap of **+0.318**. Not because it responded to the treatment — it could not
see it — but because **low-reliability contracts die more often**, so a deadness-aware
student simply has more periods in which they have already given up on the low side.

```
grinder      always high, never checks deadness        gap  0.000
learner v1   "ignores reliability" but stops when dead gap  0.318   ← the floor
responder    genuinely responds                        gap  0.800
```

⚠ **So a positive effort gap is not by itself evidence that a student reasoned about
reliability.** Part of it is the mechanical consequence of abandoning contracts that were
already lost — which is a *different* (and also desirable) piece of reasoning.

This is not a bug and nothing is filtered: the column measures what it measures, and
abandoning dead contracts IS a real behavioural difference between the conditions. But
when reading Tier 1, roughly the first third of a gap can come from deadness alone. The
"periods paid for after the contract was already dead" column is the companion figure —
a student with a large gap AND a high wasted count is responding to deadness, not to
reliability.

The robot persona was changed so its "ignoring reliability" phase ignores deadness too;
otherwise it could not test what it claimed (`bot/scorecard-styles.mjs`).

---

## 13. Tier 1 excludes bots; Tier 3 does not

Spec §11 states the bot rule under **Tier 1**, and Tier 1 is a grading roster — a
simulated student on it is a row that could be graded by mistake.

Tier 3 is a picture of behaviour, and excluding bots there makes the robot launcher
useless: the first cohort run produced **four empty charts**, with `byPeriod` all-null and
the two class lines reading `NaN vs NaN`. The launcher exists precisely so the charts can
be looked at with real spread before a class runs.

| | bots included? |
|---|---|
| Tier 1 roster | ❌ excluded (and humans get a ◆ marker) |
| Tier 3 charts 1 & 2 (class averages) | ✅ included |
| Tier 3 chart 3 (gap distribution) | ❌ **excluded** |
| Tier 3 chart 4 (policy grid) | n/a — no student data |

⚠ **Chart 3 is the exception among the Tier-3 charts** because it plots **one point per
student**: a bot in it is a fake body in a bucket, and "a mass at zero is the finding"
must be a mass of real students. Charts 1 and 2 are aggregates where a bot moves a mean.

`botCount` travels with the payload and every Tier-3 caption states it — the R6 posture
applied to *inclusion* rather than exclusion.

---

## 14. Checkpoint log

**CP3 (reports, final screens, robots)** — `stats.ts` (the shared analysis layer),
`report.ts`, `scoring.ts`, `scoreAndRecord.ts`, `syncRoster.ts`, `instructorConfig.ts`;
frontend `Reports.tsx`, `Settings.tsx`, `Dashboard.tsx`, `PolicyGridSVG.tsx`,
`ClassChartsSVG.tsx`; `bot/scorecard-styles.mjs` + `scorecard-robot-dryrun.mjs` (42
checks) + `scorecard-shots.mjs`.

Spec changes applied: `contracts` 10 → 20; the DP removed from every student surface;
two-button effort control with its three guards; Tier-3 chart 4.

⚠ The CP2 placeholder pages are **deleted** — `Placeholders.tsx` no longer exists, so the
CP4 gate ("stubs must not be live at deploy") is satisfied by construction rather than by
remembering to check.
