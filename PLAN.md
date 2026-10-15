# Lampcode — the complete remaining list, and who does it

Rewritten 2026-10-15 after the six-report research pass. `RESEARCH.md` holds what was verified,
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

## A. Owner actions — these block whole sections and cost us nothing

| # | Action | What it unblocks |
|---|---|---|
| **A1** | **Anthropic API key** + `LLM_PROVIDER_MODE=auto` | The largest single quality lever. Every premium model 403s on the current AWS account. `dispatcher.ts` already supports it — two variables, not a build. Also a prerequisite for F2 (vision). |
| **A2** | **Connect a Vercel token** | The ENTIRE production/deploy section. `vercel.ts` is written, tested, and **has never executed once**. |

---

## B. Finish what is half-built — cheapest, and we have our own evidence

| # | Task | Owner | Done means |
|---|---|---|---|
| **B1** | Run the page check automatically after writes, injecting detail only when something is broken | **Claude** (touches the agent loop) | A real build shows the verdict appended to a `write_files` result; a clean app adds ~nothing to context |
| **B2** | `search_code` over the in-memory file map — regex + literal, path glob, ±2 lines context, capped | **Codex** | Cases for regex, literal, glob, cap, no-match; a real build shows the model using it |
| **B3** | A delete capability (`delete_file`), with the same guards `write_files` has: refuse template-owned paths out loud, record churn, persist, never remove the entry point | **Codex** | Cases for each guard; proven on a real build |
| **B4** | `checkpoint` / `revert` — a named snapshot of the file map and a restore that re-runs the gates | **Codex** | Cases for snapshot/restore/unknown-label; restore proven to bring back exact content |
| **B5** | `diff_since(checkpoint)` — unified diff computed in-process. **No git, no template rebuild** | **Codex** | Cases for added/removed/modified/renamed-as-pair; output readable by a model |
| **B6** | `browser_interact` — generalise `interactions.ts`: any route, scripted steps, returns text + console + network + storage + final URL. Runtime script, no template rebuild | **Claude** (sandbox-side, needs a real build) | A real build drives a multi-step flow on a non-home route |
| **B7** | Wire the interaction probe into the build loop so the model sees findings while it can still fix them (open task #10) | **Claude** | A real build shows the model receiving and acting on a finding |
| **B8** | Cut superseded code once the gates are green: checkpoint → remove provably unreachable → re-run gates → revert if broken (open task #12, needs B3 + B4) | **Claude** | A real build where a cut happens and the gates stay green; and one where a cut is reverted |

---

## C. Durable state — the thing five of six reports converge on

| # | Task | Owner | Done means |
|---|---|---|---|
| **C1** | `build_events` table + migration, applied **and verified against production** before any code depends on it | **Claude** (migrations are applied by hand here; this is exactly how `build_plan` was lost) | `information_schema` query confirms the column set on production |
| **C2** | Write the event stream: `turn/start`, `plan/ready`, `tool/call`, `tool/result`, `files/written`, `verification/result`, `repair/applied`, `turn/end`, `build/failed` | **Claude** (dispatcher + build.ts) | A real build produces a readable, ordered stream |
| **C3** | `build_outcome` becomes a **projection** folded from events instead of a write | **Codex** (pure function, strongly testable) | Cases prove the projection equals today's shape; a real build proves it no longer goes stale |
| **C4** | Resume a build from the event log instead of "nothing was saved" | **Claude** | A deploy mid-build is resumed, not lost |

---

## D. Code intelligence — the differentiator

| # | Task | Owner | Done means |
|---|---|---|---|
| **D1** | `code_intel` — TypeScript compiler API over the in-memory files: definition, references, symbols. Regex fallback when a file does not parse | **Codex** | Cases including unparseable files; proven against real generated output |
| **D2** | `impact_analysis(symbol)` — assembles callers, routes, endpoints, tests, auth-boundary crossing, and **which touched files have no test** | **Codex** | Cases on a fixture project; proven on a real build's files |
| **D3** | Journey runner: turn criteria the completion audit **already extracts** into browser journeys, run before and after a fix, and store the pair as proof | **Claude** (prompt + audit + sandbox) | `unverified` becomes "we drove it and it did not happen" on a real build |

---

## E. Architecture gate — the answer to AI code rotting

Four of its eight rules already exist in `dead-code.ts`, `wiring.ts` and `churn`.

| # | Task | Owner | Done means |
|---|---|---|---|
| **E1** | Circular-import detection from `parseImports` | **Codex** | Cases for self, two-cycle, long cycle, no cycle |
| **E2** | Layer rule: `src/components/**` must not import `src/db/**` or `src/server/**` | **Codex** | Cases both directions |
| **E3** | Duplicate business logic — normalised function bodies compared | **Codex** | Cases for exact, whitespace-different, genuinely different |
| **E4** | File-size ceiling | **Codex** | Trivial; cases for boundary |
| **E5** | Collect all eight rules into one gate, reported like `wiring` — **and every finding's message carries its remediation**, not just the violation | **Claude** (its output is prompt-adjacent; trap 4) | A real build reports a finding whose message names the fix |

---

## F. Observation — finishing what the V1 started

| # | Task | Owner | Done means |
|---|---|---|---|
| **F1** | DOM snapshot (pruned) in addition to `innerText`, so assertions can be precise | **Claude** (sandbox script) | A real build returns it within the token budget |
| **F2** | Screenshot as a **vision input to the model**, not the project thumbnail. **Verify the model accepts images first** — depends on A1 | **Claude** | A real build where the model reports something only visible in the image |
| **F3** | `localStorage` / `sessionStorage` / IndexedDB key capture | **Codex** (script) + Claude (wiring) | Cases on the parse; a real build shows state after a journey |
| **F4** | Dynamic routes — seed an id from the app's own data via a journey, then visit. Depends on D3 | **Claude** | A real build opens `/item/:id` with a real id |

---

## G. Security — replace the gate, do not extend it

`security.ts` is 520 lines of pattern matching — the kind the research says catches little, and
it was already caught **reporting a clean pass over zero files scanned** (Finding 18).

| # | Task | Owner | Done means |
|---|---|---|---|
| **G1** | **Decide the sandbox secret question**: does `PREVIEW_SUPABASE_SERVICE_KEY` belong in the sandbox at all? It bypasses RLS and the generated app needs only the anon key. **Blocks G4** | **Claude + owner** | Written decision in `HISTORY.md`, and the `.env` writer changed to match |
| **G2** | Threat-model extraction: derive task-specific security checks from the user's prompt, with a pass that cannot write code — the completion-audit shape | **Claude** (prompt text, trap 4) | Different prompts produce genuinely different checks; probe set like `audit-probe` |
| **G3** | Verify each check: statically where possible, by **driving the app** where not (sign in as B, request A's resource), plus an adversarial pass. Verdicts stay `proven`/`contradicted`/`unverified` | **Claude** | A seeded authorization hole is caught on a real build |
| **G4** | Retire the pattern checks, **keeping** `checkPackages` (slopsquatting) and `checkSecrets` | **Codex** | Cases prove the kept two still fire; the removed ones are gone, not disabled |

---

## H. External systems — blocked on A2

| # | Task | Owner | Done means |
|---|---|---|---|
| **H1** | **Resolve the MCP SDK protocol version.** Pinned `^1.29.0`; the spec went stateless on 2026-07-28. Do this BEFORE building on MCP | **Claude** | Written answer: which protocol the installed SDK negotiates |
| **H2** | Capability mapper — hand-seeded table for our 14 providers, one cached classification dispatch for unknown servers, unmapped tools stay raw | **Codex** | Cases for seeded, unknown-then-cached, and unmapped-still-usable |
| **H3** | Four permission tiers over the existing approval gate | **Codex** | Cases for each tier |
| **H4** | Deploy capabilities: status, build logs, runtime logs, redeploy, rollback, env NAMES only | **Claude** (needs A2 and a real deploy) | A real deployment is driven and verified end to end |
| **H5** | Build-failure vs runtime-failure triage before any code is edited | **Claude** | A seeded build failure and a seeded runtime failure are classified differently |

---

## I. Maintenance seam

| # | Task | Owner | Done means |
|---|---|---|---|
| **I1** | Tool registry: `Map<string, ToolHandler>`, one file per tool. `executeTool` becomes guards + lookup (currently 758 lines, 29 branches) | **Codex** | All existing tools pass unchanged; the file shrinks; a new tool costs one file |
| **I2** | `shell`, after G1: denylist, output redaction, timeout, approval tiers | **Claude** (security) | A refused command, an approved command, and a redacted output all proven |
| **I3** | `web_search` | **Codex** | Cases on parsing and capping |

---

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
