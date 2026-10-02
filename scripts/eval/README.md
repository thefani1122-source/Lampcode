# Eval harness

Twenty fixed prompts, run through the real API, scored the same way every time.

## Why it exists

Every prompt change, harness change and model switch in this repo so far was judged
on one build somebody happened to watch. That is why the unstyled-page bug survived
three months — no gate existed for "the page renders unstyled" — and why `check_page`
could be structurally incapable of running for three weeks while the agent's failures
were blamed on the model.

One build is not evidence. This is the thing that makes a change provable.

## What it measures

Two sources, combined per task:

**The build's own record** — `build_sessions.build_outcome`, written at the end of
every successful build (`src/server/routes/build.ts`). Rounds used, whether the turn
cap was hit, which tools the model called and how often, what its own `check_page`
and `check_types` last reported, cost, duration. Before this existed a finished build
left no evidence beyond `status = success`.

**The generated files** — read back through `/api/build/:sessionId/files` and checked
against per-task expectations: strings or regexes any correct implementation must
contain, a minimum file count (the agent's standing habit is one 2000-line
`App.tsx`), a per-file line cap, and never writing a template-owned file.

Three gate states stay distinct and are never collapsed into "fail":

| | meaning |
|---|---|
| `pass` / `fail` | the gate ran and said so |
| `unavailable` | the gate could not run — a sandbox problem, not a model problem |
| `never` | the model never called it |

## Running it

It spends real money. Every task is a real build: model tokens plus an E2B sandbox.
Four smoke tasks is a pulse check; the full set is twenty builds.

```bash
EVAL_TOKEN=<supabase access token> \
EVAL_BASE_URL=https://<the deployed api> \
  npm run eval -- --tier smoke --label "baseline"

npm run eval:report                     # the newest run
npm run eval:report -- --diff eval-results/<old>.json eval-results/<new>.json
```

`EVAL_TOKEN` is a Supabase access token for an account that is allowed to build —
an **admin** account while `WAITLIST_MODE` is on, since `/api/build/fast` rejects
everyone else. Sign in to the app and copy the token out of the Supabase session in
browser storage. A 403 from `/fast` almost always means a non-admin token.

Nothing here reads the database, so it can be pointed at production or at a local
`npm run dev` without a code change. Results land in `eval-results/`, which is
gitignored — they are local to whoever ran them.

`--dry-run` lists what would run and spends nothing. `--only counter,todo` runs
exactly those. `--keep-projects` leaves the created projects unarchived.

## Reading a result

- **pass** — built, and every check held.
- **soft-fail** — built, but a check failed. The interesting column: the build
  looked successful and wasn't.
- **fail** — the build itself failed or ran past the timeout.
- **error** — the harness couldn't run the task (auth, a 409, a network fault).
  This is the only verdict that makes the runner exit non-zero.

A build on the **pipeline** path (`AGENTIC_BUILD_ENABLED` unset) has no agent gates
to call, so its `check_page` / `check_types` read `never` and its `rounds` is 1. That
is not a finding; the report says how many tasks recorded no outcome at all.

## Changing the task set

Never edit an existing `prompt`. A changed prompt makes every stored run
incomparable with the new one, which defeats the entire purpose. Add a new task and
mark the old one `retired: true`, so old results stay readable.

Keep checks to things any correct implementation has to satisfy. A check a good
build can fail is worse than no check — it trains you to ignore the harness.

`npm run eval:test` exercises the scoring rules without spending anything, and runs
as part of neither `npm test` (there isn't one) nor the typecheck gate, so run it
after touching `score.ts`.
