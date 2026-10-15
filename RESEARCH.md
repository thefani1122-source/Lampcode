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

---

## REPORT 3 — OpenAI harness engineering: making the app legible — 2026-10-15

### 1. Verified — all of it

Fetched the article in full. Every claim the report makes about it is accurate, including the
caveat, which matters more than the rest:

- *"we made the app bootable per git worktree, so Codex could launch and drive one instance per
  change. We also wired the Chrome DevTools Protocol into the agent runtime and created skills
  for working with DOM snapshots, screenshots, and navigation."*
- *"Logs, metrics, and traces are exposed to Codex via a local observability stack that's
  ephemeral for any given worktree… Agents can query logs with LogQL and metrics with PromQL."*
- The end-to-end list: validate state → reproduce bug → **record a video of the failure** → fix
  → validate by driving the app → **record a second video** → open PR → respond to feedback →
  remediate build failures → escalate only when judgment is required → merge.
- *"what capability is missing, and how do we make it both legible and enforceable for the
  agent?"*
- **The caveat, verbatim:** *"This behavior depends heavily on the specific structure and tooling
  of this repository and should not be assumed to generalize without similar investment—at least,
  not yet."*

Scale, for calibration: ~1M lines, ~1,500 PRs, 3 engineers rising to 7, five months, zero
manually written lines.

### 2. The biggest lesson in the article is one the report skipped — and it is about us

An entire section is devoted to this, and it is not about browsers at all:

> **Give Codex a map, not a 1,000-page instruction manual.**

They tried one big `AGENTS.md` and it failed in four named ways: context is a scarce resource; too
much guidance becomes non-guidance; it rots instantly; it is hard to verify mechanically. Their
answer: `AGENTS.md` as a ~100-line **table of contents**, with a structured `docs/` directory as
the system of record, plans checked in as first-class artifacts under `active/` and `completed/`,
linters that validate the knowledge base, and a recurring **doc-gardening agent** that opens
fix-up PRs for documentation that no longer matches the code.

**We hit this exact wall independently and made the exact same fix.** CLAUDE.md reached 2,465
lines and 162 KB and was costing roughly 40k tokens before any work began; on 2026-10-10 it was
split into a 12 KB CLAUDE.md plus HISTORY.md, explicitly so the big file is not loaded unless
needed. That is their finding, arrived at from our own pain, and it is the strongest evidence in
this whole research pass that the article's reasoning transfers.

What we have not copied: the mechanical enforcement. They lint the knowledge base for staleness
and run an agent that fixes it. Our CLAUDE.md said the preview Supabase was PAUSED for days after
it was active again — a human caught it, nothing mechanical did.

### 3. The asymmetry neither the report nor the article names — and it favours us

OpenAI invested five months in **one repository** they controlled. Lampcode generates a **new app
per prompt**. On the face of it their lesson does not transfer: you cannot spend months
instrumenting a repository that does not exist yet.

But that reading is wrong, and the correct one is better for us:

> **`e2b-template/template.ts` IS our repository.**

It defines the world every generated app lives in — its dependencies, its config, its baked
tooling, its `vite.config.ts`, its test runner. Everything OpenAI did once to their repo, we do
once to the template, and it applies to **every app we will ever generate**. They instrumented one
codebase. The same work here instruments all of them.

That reframes "make the app legible" from an impossible per-user investment into a single
template-level one. It is also why trap 6 (a failed template build silently leaves the last good
image serving) is a much more serious operational risk than it looks: the template is the one
place where this leverage lives.

### 4. We already have the half the article does not solve

The report is right that observation gives *what happened* and not *what should have happened*.
The article's own answer to that is **humans**: *"We prioritize work, translate user feedback into
acceptance criteria, and validate outcomes."* A person writes the expectation.

**We generate it.** `completion-audit.ts` turns the user's own prompt into checkable requirements
with a pass that cannot write code, then marks each `proven` / `contradicted` / `unverified`. On
ROTA it correctly reported four requested views were never wired in while all three gates passed.

So the two systems are mirror images:

| | expectation | observation |
|---|---|---|
| OpenAI / Codex | human-written acceptance criteria | **very strong** — DOM, screenshots, video, logs, metrics, traces |
| Lampcode | **automatic, from the user's own words** | weak, and only now improving |

The thesis follows directly, and it is not "copy their observation stack". It is: **we have the
scarce half already.** Their expectation side needs a person per task; ours does not. Closing the
observation gap is what makes the audit's verdicts enforceable instead of advisory.

### 5. Where we actually stand against the report's ten signals

| Signal | Status |
|---|---|
| Code | ✅ `projectFiles` + `generatedFiles`, whole project in memory |
| Console errors | ✅ `checkRender`, per route |
| Network requests | ✅ `checkRender` failed requests with URL and status — **built 2026-10-15** |
| Browser DOM | ⚠️ partial — we return `body.innerText`, not a DOM snapshot |
| App runtime / logs | ⚠️ partial — `read_logs` gives the dev server's output |
| Screenshot | ❌ `capturePreviewScreenshot` EXISTS and is not exposed as a tool |
| Click / type / navigate | ⚠️ `interactions.ts` clicks and navigates; not a tool, and cannot type |
| DB / state | ❌ nothing |
| Metrics | ❌ nothing |
| Traces | ❌ nothing |

Five of ten, two of them built this week. The cheapest remaining wins are a DOM snapshot and the
screenshot tool, because both already have their machinery in place.

Metrics and traces are the ones to be honest about: OpenAI ran Victoria Logs/Metrics/Traces per
worktree. For a generated app that a non-coder will use, that is almost certainly the wrong
investment — their product is a complex internal service and ours is a new small app. **This is
the part of the report I would not pursue.**

### 6. Observe → diagnose → change → reproduce → prove needs one thing we do not have

The report's loop is right, and it has a hidden prerequisite: **before** and **after** must be
comparable. OpenAI records a video of the failure and a second video of the resolution. That is
not theatre — it is the proof artifact.

Comparing before and after requires keeping both. We do not keep either: `build_outcome` is
written once at the end, and even that goes stale when `finishPreview`'s repair loops mutate the
files after it.

**This is the same conclusion Report 1 reached from a completely different direction.** DeepSeek
arrived at an append-only session event log from architecture; OpenAI arrives at an evidence
timeline from debugging practice. Two independent sources, two different motivations, one missing
primitive. That convergence is the strongest signal in the research so far.

### 7. One lesson that explicitly does NOT transfer

The article recommends **minimal blocking merge gates**: *"Test flakes are often addressed with
follow-up runs rather than blocking progress indefinitely… corrections are cheap, and waiting is
expensive."*

That is right for an internal product with its own engineers watching, where a bad merge is
noticed and fixed within the hour. For Lampcode a bad result **is** the product — it is what a
stranger sees on their first build, and there is no one to catch it. Our gates should get
stronger, not weaker. The report did not flag this; it should be flagged, because the article is
persuasive and this part of it would be actively harmful here.

### 8. The owner's "code gets ugly, old code never removed" problem is in this article

Verbatim: *"Codex replicates patterns that already exist in the repository—even uneven or
suboptimal ones. Over time, this inevitably leads to drift."* Their team spent **20% of every
week** cleaning up AI slop before they automated it with golden principles plus recurring cleanup
agents, and their framing is exactly the owner's: *"Technical debt is like a high-interest loan:
it's almost always better to pay it down continuously in small increments."*

That is open tasks #11 and #12, independently arrived at, and now with a large organisation's
measured experience behind the same design.

One technique from it worth stealing outright, because it is free: *"Because the lints are custom,
we write the error messages to inject remediation instructions into agent context."* The error
message carries the fix. We already do this in two places without having named it — `write_files`
refusing a template-owned path tells the model to make its own stylesheet and import it, and the
edit-marker refusal explains why a fragment would destroy the file. It should be a rule, not an
accident.

---

## REPORT 4 — external engineering systems: GitHub, deploy, MCP — 2026-10-15

### 1. Verified — and the report missed the headline

The Tasks claim is correct: Tasks graduates to an official extension in MCP `2026-07-28`, with
`tasks/get`, `tasks/update`, `tasks/cancel`, exactly for durable asynchronous calls like a
six-minute deploy. One correction: **task creation is SERVER-directed** — the client advertises
the extension and the server decides when a call runs as a task. The report's `deploy() →
task_id` flow implies the client chooses. It does not.

But Tasks is a side note in that release. **The headline is that MCP went stateless**, and the
report does not mention it at all:

- The `initialize`/`initialized` **handshake is removed** (SEP-2575). Protocol version, client
  info and capabilities now travel in `_meta` on every request.
- **`Mcp-Session-Id` is removed** (SEP-2567), along with the protocol-level session.
- Streamable HTTP now **requires `Mcp-Method` and `Mcp-Name` headers** (SEP-2243), and servers
  reject requests whose headers and body disagree.
- `tasks/list` is **removed** — it cannot be scoped safely without sessions.
- **Roots, Sampling and Logging are deprecated.**
- Tool schemas lift to **full JSON Schema 2020-12**.
- *"Anyone who shipped against the `2025-11-25` experimental Tasks API will need to migrate."*

Timeline, which matters: the RC locked 2026-05-21 and **the final specification shipped
2026-07-28**. That is nearly three months ago. This is not a thing to plan for; it is a thing to
check against.

### 2. Where we actually stand — and most of the "MCP Compatibility Layer" already exists

The report draws a diagram — discovery → schema inspection → permission engine → capability
mapper → progressive tool loading — as something to build. Measured against the code, **four of
those five are already implemented** in `src/agents/mcp-tool-classifier.ts`:

| Report's layer | What exists |
|---|---|
| Capability discovery | `classifyMcpServers(servers)`, with `McpDiscoveryFailure` carrying a per-server transport error into the build log |
| Schema inspector | reads each tool's `annotations.readOnlyHint` / `destructiveHint` |
| Permission engine | builds a **denylist** per server; `buildReadToolDefinitions` vs `buildWriteProxyDefinitions` splits reads from writes, and writes go through `request_write_action`'s approval gate |
| Progressive tool loading | `McpToolsetConfig` with `default_config.enabled` plus per-tool `configs` — this IS toolset filtering, the thing GitHub recommends |
| **Capability mapper** | **MISSING.** Nothing maps `vercel_get_logs` and `railway_logs` onto one `deployment.read_logs` |

And the registry already carries 14 providers — `github`, `vercel`, `cloudflare`, `stripe`,
`linear`, `sentry`, `notion`, `figma`, `shopify`, `wordpress`, `n8n`, `make`, `zapier`,
`google-stitch` — plus Supabase through its own module.

**So the one genuinely missing piece is the capability mapper**, which is also the report's best
idea: the agent should reason about `deployment.read_logs`, not about each vendor's vocabulary.
That is a much smaller task than the diagram suggests, because everything feeding it is built.

### 3. A risk worth checking before any of this

`package.json` pins `@modelcontextprotocol/sdk: ^1.29.0`. That range predates the stateless
rework described above. Whether the installed SDK negotiates `2026-07-28` could not be resolved
in this environment, so **this is flagged, not asserted** — but it is the first thing to verify
before building on MCP, because a client on the old handshake against a server on the new spec
is a failure mode that will look like "the integration is flaky".

Our own client shows no `initialize` call and no `Mcp-Session-Id` handling anywhere in
`src/mcp/`, which is consistent with the SDK owning the transport. That is the right place for
it to live; it just means the SDK version is the whole answer.

### 4. Tiered permissions — we have two of the four

The report's four levels are right in shape. We already have the hard half: reads are automatic,
writes are proxied through an approval gate the agent has driven end to end. What we do not have
is the distinction between **Level 2** (push a branch, open a draft PR — safe inside a sandbox)
and **Level 3/4** (merge, change workflows, touch production). Today everything that writes gets
the same gate, which means either too much friction on safe actions or too little on dangerous
ones.

That is a real gap and a cheap one to close, since the gate already exists.

### 5. Build logs vs runtime logs — the most useful distinction in this report

A deployment that fails to build and an app that fails after deploying are different problems
with different fixes, and the report is right that an agent which cannot tell them apart will
edit code at random. We have **neither**: `read_logs` reads the sandbox dev server, and nothing
reads a deployment's logs, because `deploy_app`'s real path has never run.

This also sharpens Report 3's lesson. "Observe → diagnose → prove" currently stops at the
preview. Build logs and runtime logs are the two observations that extend it past deploy, and
they are the specific thing that would let a failure be classified rather than guessed at.

### 6. Secrets: the report is right, and we do the opposite today

The principle — the agent should see **names and configured/missing status, never values** — is
correct and worth adopting as a rule.

It is also worth recording next to Report 2's finding: `e2b-service.ts` writes a `.env` into the
sandbox containing actual Supabase keys, including a service key where configured. So the
pattern we would enforce for external providers is the opposite of what we already do internally.
Two findings, one underlying decision to make.

### 7. What is blocked, and on what

The entire deployment half of this report — ten normalized capabilities, the failure-triage loop,
build-vs-runtime logs — is blocked on the same thing PLAN.md has recorded as A4 since 2026-10-11:
**a Vercel token has never been connected**, so `vercel.ts` has never executed once. The
architecture here is sound and none of it can be verified until that happens.

### 8. The sentence that is actually right

> MCP becomes genuinely valuable not because the agent has 100 integrations, but because external
> systems become part of a closed engineering feedback loop.

That matches what the measurement says: we already have 14 providers and an approval gate and a
classifier. What we have never had is a single loop that runs from code to deploy to observation
and back. The missing piece was never the integrations.
