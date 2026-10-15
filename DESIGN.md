# The actual designs

`RESEARCH.md` says what the six reports claim and which parts survived checking. This file says
**what we build and how**, in enough detail to implement without re-deciding anything.

Every design here is written against the code as it exists today. Where something already exists
it is named, because the recurring finding across all six reports is that we keep rebuilding
what we already have.

---

## 1. From DeepSeek Harness — take the log, take one seam, leave the framework

### 1.1 The session event log — THE thing to take

Today a build writes one `build_outcome` jsonb at the end. That single fact is why:

- a deploy mid-build loses everything (nothing to resume from),
- `build_plan` writes to a column that does not exist and nobody noticed,
- `deadCode.orphanStylesheets` recorded **1** against files that scan **clean**, because
  `finishPreview`'s repair loops mutate `allFiles` after the record is written.

DeepSeek's rule is the fix: **model-visible means logged.** Every model request must be
reconstructable from the log.

**Schema.** One table, append-only, never updated:

```sql
create table build_events (
  id          bigserial primary key,
  session_id  uuid        not null references build_sessions(id),
  seq         integer     not null,           -- monotonic per session
  at          timestamptz not null default now(),
  kind        text        not null,
  data        jsonb       not null,
  unique (session_id, seq)
);
create index on build_events (session_id, seq);
```

**Event kinds**, chosen so the model's whole view is reconstructable:

```
turn/start          { prompt, hasExistingCode, provider, model }
plan/ready          { files[], summary }           -- replaces the build_plan column
step/start          { round }
model/request       { messages: digest, tokens }
model/response      { stopReason, tokens, costUsd }
tool/call           { name, args }
tool/result         { name, resultDigest, ms }
files/written       { paths[], added, removed }
verification/result { gate, verdict, detail }      -- checkPage/checkTypes/run_tests/wiring/…
repair/applied      { loop, files[], costUsd }
turn/end            { status, rounds, costUsd }
build/failed        { reason }
```

**`build_outcome` becomes a projection, not a write.** A pure function folds the events into the
same shape that is stored today. Two consequences, both of which kill whole bug classes:

- It **cannot go stale.** Repairs after the fact are more events; the projection recomputes.
- A post-mortem becomes a query instead of grepping Railway logs for `<minimax:tool_call>`.

**Resume.** On SIGTERM the events are already durable. `failRunningBuildsOnShutdown` stops being
"nothing was saved" and becomes "resuming from seq N".

**Cost and risk.** One migration — and migrations here are applied BY HAND, which is exactly how
`build_plan` was lost. The migration must be applied and verified as its own step, before any
code depends on the table.

### 1.2 One seam, not a framework: the tool registry

`executeTool` is **758 lines** with a **29-branch** `name === "…"` chain. Every tool in section 2
would be another branch.

```ts
export interface ToolHandler {
  name: string;
  definition: ToolDefinition;
  /** Runs with the same ctx every tool gets today. */
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<string>;
  /** Writes go through the approval gate; reads do not. */
  mutates?: boolean;
}

const REGISTRY = new Map<string, ToolHandler>();
```

`executeTool` becomes: shared guards (sandbox presence, write counting, churn) → lookup → run.
One file per tool. No plugin loading, no config layers, no lifecycle, no Cordis.

### 1.3 Deliberately NOT taken

Cordis, profiles, bundles, ordered patch layers, HMR coordination, isolate realms, session-format
migration packages, a pluggable agent loop. That is a framework, it is in developer preview with
breaking changes expected in capitals, and our measured failures are not in the loop's structure.

---

## 2. The eight tools — concrete design for each

All eight are real. Here is how each is actually built here.

### 2.1 `search_code` — free, no sandbox

Operates on `{ ...ctx.projectFiles, ...ctx.generatedFiles }`, which every tool call already
holds in memory. This is the hard problem for anyone indexing a repo on disk; for us it is a loop.

```
search_code({ query, isRegex?, pathGlob?, maxResults = 40 })
→ path:line  matched line, with ±2 lines of context
→ capped total characters, newest-written files first
```

~80 lines. No sandbox, no index, no latency. **RelayOps is the argument**: the model called
`list_files` once, `read_file` three times, then gave up and wrote prose — it had no way to look
for anything.

### 2.2 `code_intel` — TypeScript compiler API over the in-memory files

`typescript@6.0.3` is already a dependency. Build a `ts.SourceFile` per file from the in-memory
map (no disk), and answer:

```
code_intel({ op: "definition" | "references" | "symbols", symbol?, path? })
```

Fall back to the existing regex helpers — `parseImports`, `parseNamedExports`,
`identifierCount` — when a file does not parse, which generated code sometimes will not. The
fallback is not a nicety: a half-written file is exactly when the model asks.

### 2.3 `impact_analysis` — assembly, not invention

Every input already exists and already runs on every build, then is discarded:

| Question | Existing function |
|---|---|
| who calls it | `parseImports` + `identifierCount` (dead-code.ts) |
| which pages render it | `declaredRoutes` (wiring.ts) |
| which endpoints it touches | `backendEndpoints` / `requestedEndpoints` (wiring.ts) |
| which tests cover it | path match `.test.` + imports |
| what handlers use it | `handlerExpressions` (wiring.ts) |

```
impact_analysis("refreshSession")
→ 7 files import it
→ reachable from routes: /, /account, /billing
→ endpoints in those files: POST /api/session, DELETE /api/session
→ tests importing it: 2
→ crosses an auth boundary: YES (src/server/auth.ts)
→ NOT covered by any test: src/lib/billing.ts
```

The last two lines are the product. "This change touches auth and one of the files has no test"
is the sentence an ordinary agent never says.

### 2.4 `browser_interact` — generalise `interactions.ts`

Today: `const target = "http://localhost:5173"`, homepage only, fixed click-everything script,
runs after the build, model never sees it.

```
browser_interact({
  route: "/checkout",
  steps: [ {click:"Pay"}, {type:{sel:"#card", text:"4242…"}}, {waitFor:"text:Thank you"} ],
  capture: ["text", "console", "network", "storage", "screenshot"]
})
```

Returns one evidence block per step: visible text, console errors, failed requests with URL and
status, `localStorage`/`sessionStorage` diff, final URL, and a screenshot reference.

Reuses the runtime-script pattern (`lampcode-interact.mjs`, `lampcode-render.mjs`) — **no
template rebuild**, so trap 6 does not apply.

### 2.5 `shell` — plumbing is done, the decision is not

`sandbox.commands.run` is already used by four callers. What is missing is safety, and it is a
real blocker, not a formality:

**`e2b-service.ts` writes a `.env` into the sandbox containing `SUPABASE_URL`,
`SUPABASE_ANON_KEY`, and where configured `PREVIEW_SUPABASE_SERVICE_KEY`.** A service key
bypasses row-level security. An unrestricted shell plus a prompt-injected model is an
exfiltration path.

Decide these three, in order, before the tool ships:

1. **Does the service key belong in the sandbox at all?** The generated app needs the anon key.
   The service key is only needed for schema application, which `supabase-mcp.ts` does from the
   server. Likely answer: remove it from the sandbox.
2. **Output scanning.** Shell stdout goes into model context. Redact anything matching the known
   key shapes before it does.
3. **Denylist + approval tiers.** Read-ish commands (`ls`, `cat` outside `.env`, `npm ls`,
   `tsc`, `vitest`) run freely. Installs and writes outside the project ask. `rm -rf`, `curl`
   piped to a shell, and anything touching `.env` are refused outright with a message saying why.

### 2.6 `git_change` — and a way to skip the template rebuild entirely

The obvious design needs `git init` baked into the template, which means a template rebuild and
trap 6.

**It is not necessary.** We already hold the complete file map before and after every write, and
`persistFilesAsWritten` stores each version. So:

```
diff_since({ checkpoint })  →  unified diff, computed in-process
```

That gives the model what it actually wants from `git diff` — what changed since a known point —
with no git, no template change, and no new failure mode. Real git stays available later for the
user's own repository through the GitHub MCP, which is where it belongs.

### 2.7 `checkpoint` / `revert` — mostly built

`persistFilesAsWritten` already stores files as they are written. A checkpoint is a **named**
snapshot of the file map; a revert restores it and re-runs the gates.

```
checkpoint({ label: "before auth refactor" })
revert({ to: "before auth refactor" })
```

This is also the safety net that makes section 5's automatic code-cutting acceptable: a cut that
can be undone is a cut worth making.

### 2.8 `web_search`

A provider call, result count capped, snippets only, URL + title + extract. `fetch_reference`
already handles the known-URL case; this is the unknown-library and unknown-error case.

### 2.9 Order, and why

1. `search_code` — free, zero risk, measured need
2. `browser_interact` — ~60% exists, and it is the observation half
3. `diff_since` + `checkpoint`/`revert` — enables safe cutting
4. `code_intel` → `impact_analysis` — the differentiator
5. `shell` — after the three decisions above
6. `web_search` — last, least coupled

---

## 3. MCP — the one missing layer, and one thing to check first

### 3.1 Check this before building anything

`package.json` pins `@modelcontextprotocol/sdk: ^1.29.0`. The spec went **stateless** on
`2026-07-28` — the `initialize` handshake removed, `Mcp-Session-Id` removed, `Mcp-Method` and
`Mcp-Name` headers now required, `tasks/list` removed. The final spec shipped nearly three months
ago. A client on the old handshake against a server on the new spec fails in ways that look like
"the integration is flaky". **Resolve the installed SDK version and its negotiated protocol
first.**

### 3.2 The capability mapper — the one layer we do not have

Four of five layers exist in `mcp-tool-classifier.ts`: discovery with per-server failure
reporting, schema inspection via `readOnlyHint`/`destructiveHint`, a permission engine that
denylists writes behind `request_write_action`, and `McpToolsetConfig` for per-tool enable/disable.

What is missing is normalisation, so the agent reasons about capabilities rather than vendor
vocabulary:

```
CapabilityId =
  | "deployment.deploy" | "deployment.status" | "deployment.build_logs"
  | "deployment.runtime_logs" | "deployment.rollback" | "deployment.env_names"
  | "vcs.open_pr" | "vcs.ci_status" | "vcs.ci_logs"
  | "issues.search" | "errors.recent"
```

Resolution order:

1. **Hand-seeded table** for our 14 registered providers. Small, exact, no model call.
2. **One classification dispatch** for an unknown server, reading `tools/list` names,
   descriptions and schemas — and the result is **cached per server version**, so it is paid once.
3. **Unmapped tools stay raw.** The model still sees their schemas. Known providers get excellent
   integration; unknown ones remain usable. Never refuse a server because we could not classify it.

### 3.3 Four permission tiers, not two

Today reads are automatic and everything else hits one gate. Split it:

```
L1 automatic         reads: repo, PR, CI status, logs, issues, security findings
L2 automatic in sandbox   create branch, push to that branch, open DRAFT PR
L3 approval          merge, change a workflow, create a release, set an env var
L4 strong approval   production deploy, rollback, anything touching secrets or settings
```

The gate exists; this is a classification table over it.

### 3.4 Build logs and runtime logs are different things

A build failure and a deployed-app failure need different fixes, and an agent that cannot tell
them apart edits at random. Triage before touching code:

```
BUILD   → install failure · typecheck · missing env at build · bad build command · OOM
RUNTIME → 500 · DB connection · migration · missing key at runtime · timeout · bad route
```

Both land as `verification/result` events in section 1.1's log, which is what makes the
before/after pair provable.

### 3.5 Secrets

The agent sees **names and configured/missing**, never values. And the same rule has to apply
internally — see 2.5. We currently do the opposite inside our own sandbox, which is the single
decision that sits behind both findings.

---

## 4. Security — replace the gate, do not extend it

### 4.1 What we have is the wrong kind

`src/verify/security.ts` is 520 lines: `checkAuth`, `checkRLS`, `checkSecrets`, `checkOWASP`
(XSS/SQLi/CSRF), `checkPackages` (slopsquatting). All **pattern matching** — the category the
OWASP work singles out as catching a small fraction of seeded issues versus contextual analysis.

And it has already been caught producing false evidence: Finding 18, 2026-10-10 — `checkAuth`
selected route files by `p.includes("/routes/")`, our generated backend is
`src/server/index.ts`, so it **reported a clean pass over zero files scanned**. A gate that
passes having examined nothing is worse than no gate.

### 4.2 The replacement reuses a shape we have already proven

`completion-audit.ts` already derives checkable requirements from the user's own words with a
pass that cannot write code, and marks each `proven` / `contradicted` / `unverified`. The
security gate is the same machine pointed at a different question.

**Before implementation — derive the threat model from the prompt.**

```
prompt: "notes app where each user sees only their own notes"
→ SEC-1  a user must not read another user's notes        (authorization, server-side)
→ SEC-2  the notes endpoint must reject an unauthenticated request
→ SEC-3  the user id must come from the session, never from the request body
```

These are task-specific. A notes app and a payments app get different checks, which is exactly
what a regex cannot do.

**After implementation — test each one, three ways, in order of strength.**

1. **Statically**, where the question allows it — "does any handler read a user id from the body
   and use it in a query?"
2. **By driving the app**, which is the part no pattern matcher can reach: sign in as user A,
   create a note, sign in as user B, request A's note, assert it fails. This is
   `browser_interact` plus the journey runner from section 6.
3. **Adversarially** — a pass whose only job is to break the implementation, that cannot write
   code, in the same way the audit cannot.

**Verdicts keep the three-state discipline.** `unverified` is not a pass. A security check that
could not be run must say so, because that is precisely the failure of Finding 18.

### 4.3 Keep from the old gate

`checkPackages` (slopsquatting — a hallucinated dependency name is a real modern attack) and
`checkSecrets` (a committed key is cheap to find and catastrophic to miss). Those two are the
right shape for pattern matching. The rest is replaced.

---

## 5. Ugly code — the architecture gate, with rules computable today

The study behind this: 302.6k AI-authored commits, 484,366 issues, **89.3% code smells**, and
**22.7% still present at the latest revision**. Between **7.5% and 14.8% of each assistant's
commits introduce at least one issue**. OpenAI's team spent **20% of every week** cleaning AI
slop before they automated it.

### 5.1 The mechanism, which we already wrote down

`edit_file(old → new)` is **additive by nature**. The cheapest way to satisfy "add X" is to
insert X; removing what X superseded requires knowing what just became unreachable — and
reachability is a whole-program property that the model, seeing one file, cannot compute.

**But a program can.** That is the whole opening.

### 5.2 Rules, every one computable from what exists

| Rule | How | Have it? |
|---|---|---|
| No circular imports | `parseImports` → build graph → cycle detect | inputs exist |
| UI must not import the DB layer | path rule: `src/components/**` ↛ `src/db/**`, `src/server/**` | trivial |
| One canonical auth path | count files defining session/token logic | partly |
| No duplicate business logic | normalise function bodies, compare | new, small |
| File size ceiling | line count | trivial |
| No orphan implementations | `findDeadCode` | **built** |
| Growth without removal | `churn.removed ≈ 0` while `added` climbs | **built** |
| Every route reachable from a link | `declaredRoutes` vs `linkTargets` | **built** |

Four of eight already exist. The gate is mostly a place to put them plus a cycle detector.

### 5.3 Error messages carry the fix

OpenAI's trick, which we already do twice by accident and should do by rule: *"because the lints
are custom, we write the error messages to inject remediation instructions into agent context."*
`write_files` refusing a template-owned path already tells the model to make its own stylesheet
and import it. Every architecture finding gets the same treatment — the violation **and** the
move that resolves it.

### 5.4 The garbage collector: cut superseded code once the new code is proven

The owner's design, and the ordering is the whole safety argument:

```
change lands
  → gates green?            no  → stop, do not cut
  → yes
  → findDeadCode over final files        (deliberately UNDER-reports; right temperament)
  → checkpoint
  → remove what is provably unreachable
  → RE-RUN the gates
  → still green?  keep.    broken?  revert to the checkpoint.
```

"A repair that changes working code is a regression, not a fix" — so the cut only ever happens
from a green state, and is undone the moment it costs one.

**Blocked on one thing:** there is no way to remove code at all. No `delete_file` among the 17
tools, and a file written empty is dropped by `isEffectivelyEmpty`. That is task #11 and it is a
prerequisite, not a detail.

---

## 6. Seeing its own work — what remains after the V1

Shipped and proven on a real build (`routes=4`): every declared route opened, page text, blank
detection, console errors, Vite overlay, failed requests with URL and status, and a diff so a
repeat check costs ~21 tokens regardless of app size.

What remains, in order of value:

### 6.1 Journeys derived from the criteria we already extract — the biggest one

The audit already turns "notes persist after refresh" into a criterion, and then marks it
`unverified` because nothing can check it. A journey runner is **an executor for criteria we are
already producing**:

```
criterion R4: "notes persist after refresh"
→ journey: open / · click New Note · type "x" · save · reload · expect text "x"
→ run BEFORE the fix   → FAIL   (this is the reproduction)
→ repair
→ run AFTER            → PASS   (this is the proof)
```

The before/after pair is the proof artifact OpenAI records as two videos. It turns `unverified`
from "nobody looked" into "we drove it and it did not happen" — which is the single largest
upgrade available to the thing that already differentiates this product.

### 6.2 Screenshot as a vision input

`capturePreviewScreenshot()` exists and feeds the project-card thumbnail. The model has never
seen it. Pointing it at the model catches what text cannot: cut-off headings, overlapping
elements, invisible text, broken responsive layout, bad spacing.

**Depends on a vision-capable model**, so it is downstream of the Anthropic key. Verify the model
accepts image input before building the plumbing.

### 6.3 Dynamic routes

`routesToVisit` drops `/user/:id` on purpose — visiting it literally lands on a record that does
not exist and reports an empty state as a failure. The fix is to seed an id from the app's own
data: run the journey that creates a record, then visit the route with the id it produced.
Depends on 6.1.

### 6.4 Storage and state

`page.evaluate` over `localStorage`, `sessionStorage` and IndexedDB keys. Cheap, and it is what
makes a persistence journey verifiable at the state level rather than only through the UI.

### 6.5 DOM snapshot rather than `innerText`

Text answers "what does it say". A pruned DOM answers "is the button inside the form", "is this
element actually visible", "does the input have a name". Needed for 6.1's assertions to be
precise.

### 6.6 Wire the interaction probe into the loop

It runs after the build and the model never sees it, and it only ever touches the home page.
Both are fixed by 2.4. That is open task #10.
