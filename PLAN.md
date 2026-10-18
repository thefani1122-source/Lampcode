# Lampcode — the complete remaining list, and who does it

Reconciled against the repo on **2026-10-17**; first written 2026-10-15. `RESEARCH.md` holds what was verified,
`DESIGN.md` holds how each item is built, `HISTORY.md` holds what we measured ourselves, and
`CLAUDE.md` holds what is true now. **This file holds only what has not happened yet.**

Delete a row when it is done, its gate passed, and the evidence is in `HISTORY.md`.

## What "production level" means here — the definition of done

The owner's standing complaint is the loop: finished once, declared done, and ten things fall
out on first real verification. It has a single cause — **verifying at the unit level and
declaring victory at the system level.** Cases passing is not the same as a thing working where
the user meets it.

So every task below is done only when ALL of these hold:

1. `npm run typecheck`, `npm test`, `npm run build` pass on Linux.
2. Cases exist that pin the BEHAVIOUR, including the failure modes, not only the happy path.
3. It has been **observed working at the layer the user experiences** — a real build for a tool,
   a rendered page for UI, a queried row for a write. Not inferred.
4. An explicit written list of what was **not** verified. "It should work" is not a result.
5. Anything that cannot go stale, does not: if a fact is recorded, something re-measures it.

Evidence proved this is not theory: the label map was correct and never reached the screen; the
thinking fix made the panel worse; `hollow-tests` and `interactions` passed every case and had no
caller for days; `build_plan` is written to a column that does not exist. Every one of those
passed step 1 and 2 and failed step 3.

## How the work is split

The owner's Claude budget is the binding constraint — 38% of the week used. If it runs out the
work stops, so Claude must not be the one typing everything.

- **Codex implements** — self-contained modules with a clear interface and a strong test guard,
  that can be proven without Railway, E2B or money.
- **Claude specs, reviews and verifies** — writes the task prompt, reviews the diff on Linux,
  runs the real build, fixes what the gates find.
- **Claude keeps outright** — database migrations, prompt text, the dispatcher/agent loop,
  security decisions, and anything whose proof needs a real build. Each of those has already
  cost us once when treated casually.

**Push after every task to `claude/magical-fermat-zr857z`.** Not in a batch — Claude can only
review what is pushed, and one task's diff is reviewable where a batch is not.

Codex runs on Windows; Railway runs Linux. An esbuild parent-directory denial and the
username-lookup workaround are Windows environment problems — report them and push; Claude
re-runs all three gates on Linux.

---

## Status, re-derived from the repo on 2026-10-17 — not from this file

This file had gone stale in the way it warns about: it still listed a Vercel token that is
connected, and four section-B rows that are written and merged. Everything below was checked
against the working tree, the tool registry, the live database and git — never against the
previous version of this file.

**Branch `claude/magical-fermat-zr857z` is at `5861e36`; `main` is at `706d10f`.** The branch is
14 ahead and "6 behind", but that 6 is not divergence: every one of `main`'s commits is a
cherry-pick of a commit already on the branch. The only real difference is `package.json`'s test
chain, which on `main` deliberately omits Codex's case files because `main` does not carry
Codex's modules. **At merge time that one file is the only thing to reconcile.**

### Done AND proven on a real build

| | Evidence |
|---|---|
| Automatic page check after writes (was B1) | Production log, a build that never called `check_page` itself |
| Controls operated on every route, in-build (was B6+B7) | Production: `interactions ... routes=4 ran=true`, and the sweep diff 1788 → 83 chars |
| Page-sweep report-by-exception and by diff | Same build, `trigger=asked` showing both paths coexist |
| MCP write tools reachable behind approval | Root cause found and fixed; **the proof is still a build that pushes** |

### Written, gates green, NOT yet seen working — step 3 of the definition above

These are not "done". Each has cases and compiles on Linux; none has run where a user meets it.

| | What is unproven |
|---|---|
| `search_code` (was B2) | No build has used it |
| `delete_file` (was B3) | Guards are cased; sandbox + storage deletion unproven |
| `checkpoint` / `revert` (was B4) | Restore unproven against real E2B state |
| `diff_since` (was B5) | **Has a measured defect — see P0 below** |
| `data-layer.ts` | Reports correctly on 185 hand-written files; has never fired in a build |
| The connect-your-database gate | Backend and frontend both compile; **the two halves have never met** |

### Owner actions

| | State |
|---|---|
| **A2 — Vercel token** | ✅ **Connected 2026-10-16.** `user_mcp_connections` carries a `vercel` row. The deploy path is no longer blocked on the owner; it is blocked on a successful deploy nobody has seen. |
| **A1 — Anthropic key + `LLM_PROVIDER_MODE=auto`** | ❌ Still open. The largest quality lever and a prerequisite for F2. Not urgent while nothing is launched. |

**Measured and worth knowing: `user_integrations` has ZERO rows.** Nobody has connected a
Supabase — the owner included. Every one of the 416 projects was built without a database.

---

## P0 — before anything new

| # | Task | Owner | Done means |
|---|---|---|---|
| **P0.1** | **`build_messages` RLS.** 3253 rows of user prompts and model output, RLS disabled, on a table reachable by the public anon key that ships in the frontend bundle. Verified still open on 2026-10-17. `ALTER TABLE "public"."build_messages" ENABLE ROW LEVEL SECURITY;` with no policies — checked: the only reader/writer goes through Drizzle over `DATABASE_URL`, the backend's Supabase client uses the service key, and the frontend never queries it | **owner runs it** | `list_tables` reports `rls_enabled: true` and a build still records messages |
| **P0.2** | **`diff_since` erases real edits.** Reproduced 2026-10-17: four 11,000-line created files plus a one-line edit → `filesChanged=0, added=0, removed=0` and the edit absent. One large file is fine. Cause: a pure create or delete still runs Myers, spending budget on a diff that needs no search, and starving every file after it. The reporting is honest that counts are incomplete, so this is not a silent lie — but the model cannot see its own change. Fix: when one side is absent, emit all-add or all-remove without calling Myers | **Codex** (its module) | The probe above returns the small edit; a case pins it |
| **P0.4** | **G6 — finish the database flow.** The gate is built: a full-stack build stops and asks, the option opens `/mcp?connect=supabase`, the workspace polls and answers. Decision settled — the data lives in the USER's Supabase. What remains is proof and the paid alternative | **Claude** | One real full-stack build connects a Supabase and persists a row |
| **P0.5** | **Prove B2–B5 on one real build.** Four tools merged without a single build between them. One build exercising search, delete, checkpoint/revert and diff closes all four | **Claude** | Each tool appears in a real build's log having done its job |

---

## P1 — the differentiator: understand the code, then prove the app

Nothing here exists yet. These are what separate Lampcode from a coding agent with a sandbox.

| # | Task | Owner | Done means |
|---|---|---|---|
| **E1** | Circular imports. **Cheaper than it looks: `src/verify/import-graph.ts` already builds the graph** (`buildImportGraph`, `resolveSpecifier`, `importSpecifiers`). Only the cycle walk is missing | **Codex** | Cases for self, two-cycle, long cycle, no cycle |
| **E2** | Layer rule: `src/components/**` must not import `src/db/**` or `src/server/**` | **Codex** | Cases both directions |
| **E3** | Duplicate business logic — normalised function bodies compared | **Codex** | Cases for exact, whitespace-different, genuinely different |
| **E4** | File-size ceiling | **Codex** | Cases for the boundary |
| **E5** | One architecture gate over all eight rules, reported like `wiring` — **and every message carries its remediation**, not just the violation | **Claude** (prompt-adjacent) | A real build reports a finding whose message names the fix |
| **D3** | Journeys derived from the criteria the completion audit already extracts: run before and after a fix, store the pair as proof | **Claude** | `unverified` becomes "we drove it and it did not happen" on a real build |
| **B6+** | Scripted `browser_interact` — arbitrary click/type/wait/assert. Today's probe operates buttons, links and forms on every route, which is **not** the same thing | **Claude** | A real build drives a multi-step flow, including typing and signing in |
| **G2** | Threat-model extraction: task-specific security checks derived from the user's prompt, by a pass that cannot write code | **Claude** | Different prompts produce genuinely different checks |
| **G3** | **Adversarial half only — the static half shipped 2026-10-18.** `checkRlsScoping` reads the policies and catches `USING (true)` and owner tables whose policies never mention `auth.uid()`. What remains is driving it: sign in as B, request A\'s row, on a real build | **Claude** | A seeded authorization hole is caught on a real build |
| **G4** | Retire the pattern checks, **keeping** `checkPackages` (slopsquatting) and `checkSecrets`. No longer blocked — G1 is decided | **Codex** | Cases prove the kept two still fire; the removed ones are gone, not disabled |

---

## P2 — durable state, richer observation, external systems

| # | Task | Owner | Done means |
|---|---|---|---|
| **C1** | `build_events` table + migration, applied **and verified against production**. Confirmed absent from `schema.ts` on 2026-10-17 | **Claude** (migrations are applied by hand; this is how `build_plan` was lost) | An `information_schema` query confirms the columns on production |
| **C2** | Write the stream: `turn/start`, `plan/ready`, `tool/call`, `tool/result`, `files/written`, `verification/result`, `repair/applied`, `turn/end`, `build/failed` | **Claude** | A real build produces a readable, ordered stream |
| **C3** | `build_outcome` becomes a projection folded from events instead of a write | **Codex** (pure function) | Cases prove it equals today's shape; a real build proves it no longer goes stale |
| **C4** | Resume a build from the event log instead of "nothing was saved" | **Claude** | A deploy mid-build is resumed, not lost |
| **F1** | Pruned DOM snapshot alongside `innerText` | **Claude** | A real build returns it within the token budget |
| **F2** | Screenshot as a vision input. **Verify the model accepts images first** — depends on A1 | **Claude** | A real build reports something only visible in the image |
| **F3** | `localStorage` / `sessionStorage` / IndexedDB capture. Confirmed absent | **Codex** (script) + Claude (wiring) | Cases on the parse; a real build shows state after a journey |
| **F4** | Dynamic routes — seed an id from the app's own data, then visit. Depends on D3 | **Claude** | A real build opens `/item/:id` with a real id |
| **H2** | MCP capability mapper. `src/mcp/providers/` is a REST provider registry (make, n8n, shopify, wordpress, zapier), **not** this | **Codex** | Cases for seeded, unknown-then-cached, unmapped-still-usable |
| **H3** | Four permission tiers over the existing approval gate | **Codex** | Cases for each tier |
| **H4** | Deploy operations. `vercel.ts` exports `deployToVercel` and helpers only — **no status, build logs, runtime logs, redeploy, rollback or env listing** | **Claude** | A real deployment is driven and verified end to end |
| **H5** | Build-failure vs runtime-failure triage before any code is edited | **Claude** | A seeded build failure and a seeded runtime failure are classified differently |
| **I2** | `shell`, after G1: denylist, output redaction, timeout, approval tiers | **Claude** (security) | A refused command, an approved command and a redacted output all proven |
| **I3** | `web_search` | **Codex** | Cases on parsing and capping |

### H1 — answered 2026-10-17, no code needed

The installed SDK is **1.32.1** under a `^1.29.0` pin. The client offers **2025-11-25** and
accepts down to 2024-10-07; statelessness needs nothing from us, because the session header is
only sent when a server supplies one. Four cases pin the version set so a floating upgrade fails
on the machine that runs it rather than on a user's build.

---

## The tool surface, measured

```
search_code        implemented, unproven      code_intel         absent
delete_file        implemented, unproven      impact_analysis    absent
checkpoint/revert  implemented, unproven      shell              absent
diff_since         implemented, DEFECT        web_search         absent
browser_interact   partial — no scripted journeys
```

Registered today: `ask_user`, `check_page`, `check_types`, `checkpoint`, `delete_file`,
`deploy_app`, `diff_since`, `edit_file`, `fetch_reference`, `find_dead_code`,
`find_wiring_gaps`, `list_files`, `load_skill`, `read_file`, `read_logs`, `read_project_file`,
`request_write_action`, `revert`, `review_code`, `run_tests`, `search_code`, `write_files`.

**The foundation is built; the intelligence is not.** Writing, deleting, snapshotting, diffing
and observing all exist. Understanding — what a symbol is, what depends on it, whether the
architecture is rotting — does not. That is P1, and it is the whole differentiator.

## Deliberately NOT doing, and why

| Not doing | Why |
|---|---|
| Cordis / plugin system / profiles / bundles | A framework, in developer preview, breaking changes expected in capitals. Our failures are not in the loop's structure. |
| Metrics + traces stack (Victoria/Prometheus per worktree) | Right for a complex internal service, wrong for a small generated app a non-coder will use. |
| Multi-agent / swarms | Our failure is not coordination. One agent not calling `write_files` is not fixed by adding a second. |
| Trajectory learning / learned routing | ~50 builds total. Cursor trained on hundreds of thousands of turns. Needs users first — and users need the product to work. |
| Minimal blocking merge gates | Right for OpenAI with engineers watching. Here a bad result **is** the product, seen by a stranger on their first build. Our gates get stronger, not weaker. |
| `git` in the template | B5 (`diff_since`) gives the model what it wants from `git diff` with no template rebuild and no new failure mode. |

---

## The ordering question that belongs to the owner

This list is ordered for the **long-project target** — the stated goal that nobody needs an
MVP-builder.

The 23 October deadline pulls the other way. If it holds, only **A1, A2 and section B** fit, and
C through I are next quarter's work. That is a product decision, not an engineering one.
