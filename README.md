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

## Shared packages (consumed, never modified)

`@mygames/game-engine`, `@mygames/game-server`, `@mygames/game-ui`. This family
adds nothing to them. A shared-package change is Elena's decision — stop and ask.
