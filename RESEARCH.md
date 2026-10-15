# Outside research, checked against this codebase

One section per report the owner brings. Each one answers four questions in order:

1. **Is the claim true?** Checked against the primary source, not recalled. This repo's first
   working rule exists because confident outside claims have repeatedly been false here.
2. **What does it actually suggest for us?** Most of this research is about agents maintaining
   long-lived existing codebases. Lampcode generates new apps for people who do not write code.
   Some lessons transfer directly, some transform, some do not apply at all — and saying which
   is the work.
3. **Where do we actually stand?** Measured against the real files, not assumed.
4. **What would production-level implementation mean?** Not "add a plugin system" — the concrete
   seam, its cost, and what it breaks.

`HISTORY.md` holds what we measured ourselves. This file holds what others claim and what it is
worth to us.

---

## REPORT 1 — DeepSeek Harness: "everything is a plugin" — 2026-10-15

### 1. Verified

Fetched `docs/architecture.md` and `README.md` from the repository directly. **The report's
reading is accurate.** That is worth saying plainly, because it is not the usual outcome here.

Confirmed verbatim from the architecture document:

- *"Every part of the product is a plugin, including the model adapter, the tool registry, the
  session log, and the agent loop itself, so each is replaceable from configuration."*
- *"There is no privileged core to patch: you extend dsh by mounting a plugin beside the
  others."*
- *"Events are the extension points, and picking the right domain is the first decision in most
  changes."* — three domains: **session** (durable, survives reload), **agent** (live, intercept
  work in flight), **capability** (attach policy/adapters to a seam without importing the loop).
- *"**Model-visible means logged.** Every model request must be reconstructable from the log."*
- A **seam** has exactly three roles — Service Definition, Service Provider, Consumer — and
  *"one role alone is not a seam; adding a capability means designing all three."*
- *"Seams are why one provider swap changes the whole product. Filesystem and subprocess
  providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and
  LSP with them, with no provider forks."*

The turn flow in the document matches the report's shape: `agent/pre-step` → `agent/request` →
`tools/pre-execute` → `tools/execute` → `tools/post-execute` → `agent/turn-stopping`. Four of
those are **waterfalls** whose listeners must call `next()` to delegate — so a listener can
rewrite, reject or short-circuit. That is a stronger mechanism than the report conveys: it is
not only observation, it is interception.

Also confirmed: MIT licence, built on Cordis (`arxiv.org/abs/2608.25512`).

### 2. What the report overstates, or did not verify

- **"DeepSeek's recent direction even allows Claude Code/Codex-oriented bundles."** Not
  supported by the architecture document. It documents `web`, `headless`, `sdk`, `sdk-minimal`
  and `acp` profiles — `acp` being an automation server, not a Claude Code bundle. The strategic
  point the report draws from it (point 5, Lampcode orchestrating other agents) may still be
  right, but **this source does not establish it** and it should not be cited as if it does.
- **The cost of the abstraction is much larger than the report implies.** The report lists
  "abstraction, dependency management, lifecycle complexity" as a caveat. The actual document
  additionally requires: profiles, bundles, ordered patch layers, `cordis.patch.yml`, HMR
  coordination, isolate realms, session format generations with per-version migration packages,
  mandatory projection seams, and an entrypoint verifier script that rejects any Node path
  bypassing `dsh`. This is a framework, not a pattern.
- **Stability, confirmed from the README:** *"DeepSeek Harness is in developer preview and
  iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**"* The report mentions
  this; it deserves more weight than it was given. We cannot depend on it, and copying an
  architecture that is itself unstable buys instability twice.

### 3. Where Lampcode actually stands — measured today, not assumed

| Seam | Reality | Verdict |
|---|---|---|
| **Model adapter** | `dispatcher.ts:339` — `effectiveProvider: "anthropic" \| "modal"`, routing to `model-gateway.ts` / `modal-gateway.ts` | **A real seam already.** Binary rather than open, but the shape is right and it is the one thing we would not have to invent. |
| **Tool registry** | `executeTool` is **758 lines** with a **29-branch** `name === "…"` if-chain; definitions are two static arrays | **No seam.** Adding a capability means editing one enormous function. This is the worst of the five. |
| **Sandbox / execution** | `e2b-service.ts` imported DIRECTLY by **6 files** — `build.ts`, `tools.ts`, `build-planner.ts`, `server/index.ts`, `build-handler.ts`, `review-units.ts` | **No seam.** Every consumer knows the implementation. Trap 9 in CLAUDE.md — that importing it outside the server process hangs — is a *symptom* of exactly this: a capability welded to one provider that drags config, Redis and the E2B SDK in with it. |
| **Session / state** | A `build_sessions` row, a `build_outcome` jsonb written at the end, and Socket.IO emits that are not stored | **No seam, and no log.** There is no event stream and nothing is replayable. |
| **Agent loop** | Hardcoded in `dispatcher.ts:550`, `for (let round = 1; round <= maxRounds; round++)` | **No seam.** Not necessarily wrong — see below. |

### 4. What this is actually worth to us — ranked by evidence, not by elegance

**(a) The session event log is the one idea with measured evidence behind it in OUR data.**

This is not borrowed enthusiasm; we have already paid for its absence, three times over:

- 2026-10-14: a deploy landed mid-build, SIGTERM fired, and two builds were simply gone. The
  shutdown handler can only tell the user "nothing was saved — run it again", because there is
  nothing to resume from.
- 2026-10-14: `build_plan` is written by `build.ts` and **the column does not exist in
  production**. The `.catch()` logs a warning. The feature whose entire purpose is "the plan
  survives a build that does not finish" has never once worked, and nothing noticed, because
  there is no log that would have shown the write failing.
- 2026-10-15: `build_outcome` goes **stale** — `deadCode.orphanStylesheets` recorded 1 while the
  delivered files scanned clean, because `finishPreview`'s repair loops mutate `allFiles` after
  the record is written. A fact written once at the end cannot describe a process that continues
  afterwards. An append-only log does not have this failure mode at all.

DeepSeek's rule — *model-visible means logged* — would also have caught the RelayOps failure
faster: 5 rounds, 0 files, and the only way to find out what the model actually saw was to grep
Railway logs for a `<minimax:tool_call>` string.

**This is the lesson to take. Not the plugin system — the log.**

**(b) The tool registry seam is cheap, and we have a concrete reason to want it now.**

A 758-line function with a 29-branch if-chain is not an architecture argument, it is a
maintenance fact. And the list of tools we know we are missing for long projects — content
search, shell, delete, git — means four more branches in that function as things stand.

The minimal version is not Cordis. It is: a `ToolHandler` interface, a `Map<string, handler>`,
and each tool as its own module. No plugin loading, no config layers, no lifecycle. That is a
refactor with a clear end state, testable, and it makes every subsequent tool cheap.

**(c) The sandbox seam is real but should follow, not lead.**

Six direct importers is a genuine coupling problem and trap 9 is its scar. But we have exactly
one provider (E2B) and no concrete second one. Designing an interface with one implementation is
how you get the wrong interface. The honest sequencing: extract it **when** a second execution
target appears — the user's own machine, a Docker runner, or Vercel sandboxes — and let that
second case define the shape.

**(d) The agent loop should NOT be made pluggable, and this is where I disagree with the
report.**

DeepSeek makes the loop replaceable because it is a general-purpose harness serving many
products. Lampcode is one product with one loop. Making it pluggable would cost us the ability
to reason about it, and our measured failures are not in the loop's structure — they are in what
the loop can SEE (the render check) and what it is steered to do (5 rounds, 0 files). A seam
there solves nothing we have evidence for.

**(e) The capability-event idea has one immediate, concrete use.**

Not as a general bus. But `build.ts` at ~3,700 lines now contains the security loop, the orphan
loop, the wiring loop, the audit, the dead-code scan, the hollow-test scan and the interaction
probe, each as an inline block. Those are exactly the things DeepSeek would attach to
`tools/post-execute` and `agent/turn-stopping`. **The seam to want is not "events everywhere" —
it is one: a place where verification passes register themselves instead of being inlined.**

### 5. What production-level implementation means here

Not "add a plugin system". Concretely, and in this order:

**Step 1 — the session event log.** An append-only table, typed events, written as they happen:
`turn/start`, `tool/call`, `tool/result`, `verification/result`, `turn/end`. The existing
`build_outcome` becomes a projection derived from it rather than a thing written once at the
end. This fixes the staleness class permanently rather than one field at a time, makes the
RelayOps-style post-mortem a query instead of a log grep, and is the prerequisite for ever
resuming a build that a deploy killed.

Cost: a real migration — and note that the one migration this repo most recently needed,
`build_plan`, was never applied, which is itself a warning about how migrations happen here.
They are applied by hand. That has to be part of the plan, not an afterthought.

**Step 2 — the tool registry.** `Map<string, ToolHandler>`, one module per tool, and
`executeTool` becomes a lookup plus the shared guards. Delete, grep, shell and git then cost one
small file each instead of one more branch in a 758-line function.

**Step 3 — one verification seam.** The passes that currently sit inline in `build.ts` register
themselves. `build.ts` shrinks by what it no longer inlines.

**Not now:** sandbox interface (one provider), pluggable loop (no evidence), profiles/bundles/
patch layers (a framework we do not need), and anything requiring Cordis.

### 6. The sentence worth keeping

The report's own summary is the right one and survives verification:

> Don't build the smartest fixed coding agent. Build a system whose models, agents, tools and
> strategies can keep evolving while its engineering state, control and proof remain stable.

With one correction from the measurement above: for us, **"engineering state" is the part we do
not have.** Models are already swappable here. Tools are one refactor away. State is missing
entirely — and every one of the three failures in (a) is a state failure.

---

## REPORT 2 — the eight missing tools — 2026-10-15

### 1. Verified

The premise — that search, terminal, browser and code intelligence are table stakes rather than
innovations — is plainly right and matches Report 1's primary source, where DeepSeek lists
`ctx.shell`, `ctx.terminals`, `ctx.fs`, `ctx.jobs` and subagents as registered capabilities.

**One citation did not resolve.** `docs.cursor.com/en/agent/tools` redirects to the
documentation home. The navigation there does list Tools, Subagents, Hooks, MCP, Browser,
Rollouts and Security Agents, which is consistent with the claim, but the specific tool list was
not read. **Not treated as proof here.** It does not matter much: the value of this report is
the list itself, not who else has it.

### 2. The report's real contribution, and where I would change it

Its framing is correct and better than a tool count: **capability classes, not tools.** And its
rule — build a special tool only where there is extra intelligence or safety, otherwise let the
shell do it — is the right test. `run_build`, `install_package`, `npm_install` as separate tools
would be noise.

But the recommended ORDER assumes we are starting from nothing. We are not, and what already
exists changes the order substantially. Measured today:

| Report's tool | What we already have | Real cost |
|---|---|---|
| `search_code` | Nothing — **but** `ctx.projectFiles` + `ctx.generatedFiles` hold the WHOLE project in memory on every tool call | **Trivial.** No sandbox, no index, no disk. This is the hard problem for Cursor, which must index a large repo; for us it is a loop over a Record we already have. |
| `code_intel` | `parseImports()` → `{local, source}[]`, `parseNamedExports()`, `identifierCount()`, `stripComments()` — all in `dead-code.ts`. **typescript 6.0.3 is already a dependency**, so real AST work is available, not just regex | **Moderate.** The graph material exists and is thrown away after each scan. |
| `impact_analysis` | `declaredRoutes`, `linkTargets`, `backendEndpoints`, `requestedEndpoints`, `handlerExpressions` in `wiring.ts`, plus the import/export graph above | **This is the finding.** See below. |
| `browser_interact` | `interactions.ts` already does `page.goto`, `page.click`, fresh context per control, console capture. `checkRender` now adds multi-route, page text and failed requests | **~60% built.** Missing: type/fill, login, screenshot — and it is not exposed as a tool (that is open task #10). |
| `shell` | `sandbox.commands.run` is already used by `checkRender`, `checkInteractions`, `runTypeCheck`, `runTests` | Plumbing is **done**. The work is entirely safety, not capability. See the warning below. |
| `git_change` | Nothing. Generated projects are not git repos at all | Needs `git init` in the template first — a template rebuild, trap 6 applies. |
| `checkpoint` / `revert` | `persistFilesAsWritten` per write, plus `churn` tracking | Partly there: we already store files as they are written. What is missing is a NAMED restore point and a restore path. |
| `web_search` | `fetch_reference` (known URL only) | Straightforward; an external dependency and a cost per call. |

### 3. THE finding: impact_analysis is assembly, not invention

The owner's instinct that this is the differentiator is right, and it is much closer than the
report assumes. `impact_analysis("refreshSession")` needs:

- **callers** → `parseImports` gives who imports what; `identifierCount` gives usage per file
- **routes affected** → `declaredRoutes` over the files that import it
- **API contract** → `backendEndpoints` / `requestedEndpoints`
- **tests** → files matching `.test.` that import it
- **handlers** → `handlerExpressions`

**Every one of those functions already exists and already runs on every build.** We compute this
graph, use it for one narrow verdict, and discard it. The gap is not analysis — it is that
nothing keeps the graph or lets the model query it.

That reframes the Code Intelligence Engine from "a thing to build" to "a thing to stop throwing
away", which is a completely different size of task.

### 4. A safety finding the report does not mention, and it blocks `shell` as written

`e2b-service.ts` writes into the sandbox a `.env` containing `VITE_SUPABASE_URL`,
`VITE_SUPABASE_ANON_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and where configured
`PREVIEW_SUPABASE_SERVICE_KEY`. A service key bypasses row-level security entirely.

An unrestricted shell in that sandbox means any model turn — including one steered by content
inside a user's own prompt — can `cat .env`. The code already shows this class of risk was
thought about once: there is an explicit guard refusing to run when the preview Supabase URL
equals the platform `SUPABASE_URL`, logged as a data-safety refusal. That guard protects the
platform database. **Nothing protects the preview service key from a shell.**

So `shell` is not simply "the plumbing exists, expose it". Production level here means deciding,
before shipping it: whether the service key belongs in the sandbox at all, whether shell runs
under a restricted user, what the approval policy is, and whether output is scanned before it
reaches the model's context. `request_write_action` already establishes an approval-gate pattern
in this codebase, so the shape exists.

### 5. The order I would actually build in, and why it differs

The report says: shell → search_code → code_intel → browser_interact → impact_analysis →
git/checkpoint → web_search.

Mine:

1. **`search_code`** — free, instant, zero risk, files already in memory. RelayOps is the
   argument: the model called `list_files` once and `read_file` three times, then gave up and
   wrote prose. It had no way to look for anything.
2. **`browser_interact` as a tool** — ~60% built, and open task #10 is already this. Highest
   ratio of value to remaining work.
3. **`code_intel` + `impact_analysis`** — the differentiator, and mostly assembly of functions
   that already run.
4. **`shell`** — biggest capability gap, agreed, but the only one with a security consequence
   that must be designed first. Shipping it badly is worse than not shipping it.
5. **`checkpoint`/`revert`** — pairs with open tasks #11/#12: a cut that can be undone is a much
   safer cut.
6. **`git_change`**, **`web_search`** — real, later, and `git` needs the template changed.

### 6. Where I agree without reservation

- **Stop at ~25 tools.** Supported by Report 1's own source: DeepSeek's answer to tool growth is
  scoped registries and per-agent presets, not a longer list.
- **No `run_build` / `install_package` / `npm_install` as separate tools.** The shell covers
  them; a special tool must earn itself with intelligence or safety.
- **`impact_analysis` is the one that differentiates.** Everything else on this list is parity.
