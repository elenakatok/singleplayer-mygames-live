# Single-Player Games — `singleplayer-mygames-live`

The **fourth game family**: games a student walks alone. No groups, no matching,
no presence/RTDB, no attendance code, no roles, no live state.

> **Defining constraint (holds in code and in rules):** a single-player game
> never waits for another student, and never reads another student's data during
> play.

See `Single_Player_Game_Architecture_v1.md` (design authority) and each game's
spec (e.g. `Jar_of_Pennies_Game_Specification_v1.md`).

## Games in this repo

| game_id | Title | Subdomain | Hosting site |
|---|---|---|---|
| `pennies` | Jar of Pennies | `pennies.mygames.live` | `pennies` |
| `poll` | Poll | `poll.mygames.live` | `poll-mygames` |
| `pd` | Repeated Prisoner's Dilemma | `pd.mygames.live` | `pd-mygames-live` |
| `pricing` | Pricing Game (Cheyenne Shipping) | `pricing.mygames.live` | `pricing-mygames-live` |
| `newsvendor` | Newsvendor | `newsvendor.mygames.live` | `newsvendor-mygames-live` |
| `forecast` | The Forecasting Game | `forecast.mygames.live` | `forecast-mygames` |

> `forecast` is **FEATURE-COMPLETE**: knowledge check → the month loop → final results
> → debrief → the process reveal, participation scoring + the gradebook push, the
> instructor dashboard, settings, all three report tiers, and a seven-style robot
> cohort. **Nothing is deployed yet.**
>
> ⚠ **The hosting site is `forecast-mygames`, NOT `forecast-mygames-live`** — plain
> `forecast` is globally taken, and this follows the `poll-mygames` precedent rather
> than the `<game>-mygames-live` one. The deploy target is still `--only hosting:forecast`.
>
> ⚠ **Forecast's config/truth split is the INVERSE of newsvendor's, and it is the
> whole point of the data model.** Newsvendor keeps its economics in student-readable
> `config/main` because the student is shown all of it. Here the model IS the answer —
> explaining the systematic component is the exercise — so `a`, `b`, `H`, `σ`,
> `highSeasonMonths`, the seasonality flags AND the seed all live in the rules-denied
> `truth/main`. `config/main` carries only what a student may read off the SDK.
>
> ⚠ **Forecast's three invariants, in code:**
> 1. **The model reaches no student before the debrief.** Every student callable has its
>    full response shape pinned recursively in `forecast-playthrough.mjs`, and the
>    browser harness partitions responses to assert the model appears in EXACTLY the two
>    gated endpoints (`forecastSubmitDebrief`, `forecastGetReveal`) and nowhere else.
> 2. **The reveal is gated by ONE function** (`forecast/reveal.ts`), called by both the
>    submit path and the read path: the game must be over AND the debrief behind them.
>    The paragraph is stored BEFORE the reveal is built, so nobody can read the process
>    and then describe a method they did not use.
> 3. **Neither CSV carries a pre-coded high-season indicator** (spec §4, amended 08-02).
>    Coding the indicator is the analyst's job — slide 11. Neither builder takes a
>    `ForecastModel` at all, so the export path cannot leak the model.
>
> The five-year history is a **fixed array** (spec §2.1's published table, hardcoded):
> its fitted coefficients and the whole §2.3 benchmark table are quoted against those
> exact sixty numbers. Futures are drawn **per student**, server-side, after the forecast
> is committed.

> `newsvendor` is **PART 1 COMPLETE — the REGULAR (single-source) game**: prep → the
> period loop → final results → a ten-question graded knowledge check → debrief,
> participation scoring + the gradebook push, the instructor dashboard, four report
> tiles, and instructor settings. **Nothing is deployed**, there is no hosting site, no
> secret and no classroom registry entry yet.
>
> ⚠ **Dual sourcing is PART 2 and is NOT built.** It is a per-instance `dual` config
> flag on this same game — never a second `game_id`, never a second set of callables —
> and `newsvendorUpdateConfig` **refuses** to set it until the branch exists.
>
> ⚠ **Newsvendor's two invariants, in code:**
> 1. **The benchmark never reaches a student.** Every period stores `q_opt` and
>    `profit_opt` (the optimal order, and what it would have earned against that
>    student's *own* demand draw) for the instructor's reports; spec §9.2 keeps both off
>    every student screen, during play and on the final screen. The student responses are
>    hand-built whitelists (`rounds.ts`, `clientState.ts`), participant docs are
>    rules-denied, and `newsvendor-playthrough.mjs` §2 audits every response tree for
>    benchmark keys *and* for the numeric value of Q*.
> 2. **The seed lives in `truth/`, not `config/`** — unlike pricing's. It derives every
>    future demand draw, and `config/main` is student-readable by rules, so a seed stored
>    there could be read with the plain SDK to compute period 12's demand before ordering
>    in period 11.
>
> Demand is drawn **per student, per period, server-side, after the order is committed**,
> inside the same transaction — and a resubmit for a played period returns the stored
> period, so a retry cannot buy a second draw.

> `pricing` is **FEATURE-COMPLETE** (Slice 5): (PMG rules →) knowledge check → round
> loop → debrief, participation scoring + the gradebook push, classroom registration,
> the instructor dashboard + all three report tiers, instructor settings, and a robot
> cohort driver. **Nothing is deployed.** It is **one game,
> two course instances** — Standard and PMG are the same `game_id` switched by a
> per-instance config flag, never a second prefix or a second hosting site.
>
> ⚠ **Pricing's two invariants, in code:** the student's round count and the
> competitor's rule are server-side truth (`truth/…`, rules-denied) and appear in
> **no** callable response — both callables return hand-built whitelists, and
> `pricing-playthrough.mjs` §10 audits every response tree for stray keys, forbidden
> words, and any number that could be the horizon, then §10b greps the source that
> builds those responses. The horizon is drawn **per student** (as PD's now is), so
> the first student to finish cannot tell the class how long the game is. Rounds also
> **submit-and-lock**: a resubmit for a played round returns the stored round and
> writes nothing.

> `pd` is **FEATURE-COMPLETE** (Slice 4): knowledge check → round loop → debrief,
> participation scoring + gradebook push, and the instructor dashboard + all three
> report tiers.
>
> ⚠ **PD's two invariants, in code:** the student's round count and their bot
> strategy are server-side truth (`truth/participant_*`, rules-denied) and appear in
> **no** callable response — both callables return hand-built whitelists, and
> `pd-playthrough.mjs` §10 audits every response tree for stray keys, forbidden
> words, and any number that could be the round count. **Both are drawn per
> student**, so a classmate who finishes first cannot hand the class a known
> horizon; PD writes no instance-level truth doc at all. Rounds also
> **submit-and-lock**: a resubmit for a played round returns the stored round and
> writes nothing.

Each game is separated from the others by **collection prefix** (`pennies_…`) and
its **own hosting site**, all inside the one Firebase project with the one
`(default)` Firestore database. There is **no RTDB**.

## Layout

```
firebase.json          multi-site hosting targets; NO database block
.firebaserc            project + hosting target map
firestore.rules        all games, prefix-scoped
firestore.indexes.json
functions/
  src/
    index.ts           exports every game's callables (per-game names)
    shared/            family machinery (session bootstrap, submit, finalize)
    pennies/           this game
frontend/
  src/
    shared/            shell, sequence runner, session wiring
    pennies/           this game
```

## ⚠️ Deploy discipline — NEVER blanket-deploy functions

Several games share **one** Firebase project, so a blanket `--only functions`
deploy would mint new revisions for **every** game at once and risk the Cloud Run
CPU-quota pileup. Every function is therefore named **per game**
(`penniesBootstrap`, `penniesSubmit`, `penniesScoreAndRecord`, …) and every deploy
is scoped by name:

```sh
# ✅ correct — scoped to one game, by name
firebase deploy --only functions:penniesBootstrap,functions:penniesSubmit \
  --project singleplayer-mygames-live

# ❌ NEVER do this in this project
firebase deploy --only functions
```

Hosting is likewise per-site, via the `target` key in `firebase.json`:

```sh
firebase deploy --only hosting:pennies --project singleplayer-mygames-live
```

Adding a game adds a second hosting array entry and a second CNAME — it must never
become possible to deploy all games with one command by accident.

## Harnesses

Every game has an emulator harness driving its callables over HTTP, and PD adds the
family's first **real-browser** harness (Playwright + Chromium). The browser harness is
ADDITIONAL coverage — the HTTP harnesses still own the server contract.

```sh
npm install && npx playwright install chromium   # once, for the browser harness
npm run harness:pd               # HTTP    — server contract
npm run harness:pd:browser       # BROWSER — the whole game, clicked through
npm run harness:pennies
npm run harness:poll
npm run harness:pricing          # HTTP    — the whole server contract
npm run harness:pricing:browser  # BROWSER — both modes, clicked through
npm run harness:newsvendor          # HTTP    — the server contract + the negative controls
npm run harness:newsvendor:browser  # BROWSER — the whole game, clicked through
npm run harness:forecast            # HTTP    — shape pins, the reveal gate, both CSVs
npm run harness:forecast:browser    # BROWSER — KC → loop → debrief → reveal
npm run robots:forecast:dryrun      # ROBOTS  — 7 styles, and the §2.3 spread they must reproduce
HEADED=1 npm run harness:pricing:browser   # …and watch it play

# Robot cohorts (spec §11) — N independent students, each playing their own full game.
node bot/pricing-robot-driver.mjs --instance <id> --students 8      # LIVE, via the launcher
node bot/pricing-robot-driver.mjs --instance demo-1 --emulator --headless   # dry run

# Newsvendor's cohort walks the whole flow: prep → every period → KC → debrief.
node bot/newsvendor-robot-driver.mjs --instance <id> --students 8   # LIVE, via the launcher
node bot/newsvendor-robot-driver.mjs --instance demo-1 --emulator --headless --exit-when-done  # dry run

# Forecast's seven styles ARE the seven §2.3 benchmark rules, so a cohort reproduces
# the debrief slide rather than merely filling the roster. 7 students = one per rule.
node bot/forecast-robot-driver.mjs --instance <id> --students 7     # LIVE, via the launcher
node bot/forecast-robot-driver.mjs --instance demo-1 --emulator --headless --exit-when-done  # dry run
```

The browser harness boots the Vite **dev** server itself (dev mode is what enables the
`?_pid/_gid` test identity and the emulator wiring in `frontend/src/firebase.ts`) and
shuts it down afterwards. Its plumbing is deliberately game-agnostic — copy it for the
next game and change only the selectors.

## Shared packages (consumed, never modified)

`@mygames/game-engine`, `@mygames/game-server`, `@mygames/game-ui`. This family
adds nothing to them. A shared-package change is Elena's decision — stop and ask.
