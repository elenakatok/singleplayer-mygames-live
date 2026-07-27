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

> `pricing` is at **Slice 1 (server-side round loop)**: the market model in both
> modes, the competitor strategy library, the per-student hidden horizon, and the two
> student callables (`pricingGetState`, `pricingSubmitPrice`). No screens, no KC, no
> debrief, no scoring, no reports yet — and **nothing deployed**. It is **one game,
> two course instances** — Standard and PMG are the same `game_id` switched by a
> per-instance config flag, never a second prefix or a second hosting site.
>
> ⚠ **Pricing's two invariants, in code:** the student's round count and the
> competitor's rule are server-side truth (`truth/…`, rules-denied) and appear in
> **no** callable response — both callables return hand-built whitelists, and
> `pricing-playthrough.mjs` §10 audits every response tree for stray keys, forbidden
> words, and any number that could be the horizon, then §10b greps the source that
> builds those responses. Unlike PD the horizon is drawn **per student**, so the
> first student to finish cannot tell the class how long the game is. Rounds also
> **submit-and-lock**: a resubmit for a played round returns the stored round and
> writes nothing.

> `pd` is **FEATURE-COMPLETE** (Slice 4): knowledge check → round loop → debrief,
> participation scoring + gradebook push, and the instructor dashboard + all three
> report tiers.
>
> ⚠ **PD's two invariants, in code:** the instance's round count and the student's
> bot strategy are server-side truth (`truth/…`, rules-denied) and appear in **no**
> callable response — both callables return hand-built whitelists, and
> `pd-playthrough.mjs` §10 audits every response tree for stray keys, forbidden
> words, and any number that could be the round count. Rounds also
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
npm run harness:pd          # HTTP  — server contract
npm run harness:pd:browser  # BROWSER — the whole game, clicked through
npm run harness:pennies
npm run harness:poll
npm run harness:pricing   # HTTP — Slice 0 scaffold contract
```

The browser harness boots the Vite **dev** server itself (dev mode is what enables the
`?_pid/_gid` test identity and the emulator wiring in `frontend/src/firebase.ts`) and
shuts it down afterwards. Its plumbing is deliberately game-agnostic — copy it for the
next game and change only the selectors.

## Shared packages (consumed, never modified)

`@mygames/game-engine`, `@mygames/game-server`, `@mygames/game-ui`. This family
adds nothing to them. A shared-package change is Elena's decision — stop and ask.
