# Codex task prompts — batch 3

Same rules as `CODEX-TASKS.md`'s "Git workflow" section, unchanged: branch
`claude/magical-fermat-zr857z`, pull before every task, **one commit per task pushed
immediately**, never `main`, no drive-by refactors, `Co-Authored-By: Codex <noreply@openai.com>`.

**Read `CLAUDE.md` first.** Traps that apply here: trap 7 (bare specifier resolution), trap 9
(never import `e2b-service.ts` outside the server process), and trap 4 (prompt-vs-reality drift —
which is why **none of these tasks wire anything into the agent loop**).

**Do batch 2 first.** TASK 1 here depends on `code_intel` from batch 2. The rest are
independent of it and of each other, so if batch 2 is still in flight, start at TASK 2.

**Every module in this batch is exported and NOT wired.** Claude writes the tool descriptions and
runs the real builds, because tool descriptions are prompt text.

**If an instruction here is wrong, say so instead of building it.** More than one confident,
specific instruction in this repo has turned out to be false against the working code.

---

## TASK 1 — `impact_analysis` (`D2`)

**Depends on `code_intel` from batch 2.** If that is not merged yet, do TASK 2 first.

### Why it is needed

`code_intel` answers "what is this and who calls it". This answers the question that actually
stops a bad edit: **"if I change this, what else has to change, and what will nobody notice is
broken?"** On generated apps the model routinely renames a field in one file and leaves four
call sites and the SQL behind.

### Build

`src/verify/impact.ts`:

```ts
export interface ImpactReport {
  symbol: string;
  callers: Array<{ path: string; line: number }>;
  /** Frontend routes whose files reach this symbol, directly or through one hop. */
  routes: string[];
  /** Backend endpoints defined in files that reach it. */
  endpoints: string[];
  /** Test files that cover any file in the blast radius. */
  tests: string[];
  /** Files in the blast radius with NO test covering them. This is the point. */
  untested: string[];
  /** True when the radius crosses from client code into server/db code. */
  crossesAuthBoundary: boolean;
  degraded: boolean;
}
export function impactAnalysis(files: Record<string, string>, symbol: string): ImpactReport;
export function formatImpact(report: ImpactReport): string;
```

Reuse what exists rather than rebuilding it: `code_intel` for references, `import-graph.ts`
(`buildImportGraph`) for reachability, `wiring.ts`'s `declaredRoutes` and `backendEndpoints` for
routes and endpoints. **Do not write a second import parser.**

### Requirements, each for a reason

- **`untested` is the field that justifies the tool.** Everything else is navigation; this is the
  one that says where a change is dangerous. Compute it as: files in the radius, minus files
  imported by any `*.test.*` file.
- **One hop, not transitive closure.** A full closure on a 40-file app returns the whole app and
  tells the model nothing. Direct importers of the files that contain references — that is the
  radius.
- `crossesAuthBoundary` is true when the radius contains both a file under `src/components/**`
  or `src/pages/**` AND one under `src/server/**` or `src/db/**`.
- Cap each list at 25 with an omitted count, the same split `wiring.ts` makes.
- Never read the real filesystem.

### Cases — `scripts/impact.test.ts`

1. A symbol used by two components and one route: callers, routes, both reported.
2. A symbol only used in one file nothing imports: empty radius, not an error.
3. `untested` is empty when a test file imports the module, and non-empty when none does.
4. `crossesAuthBoundary` true for a component→server chain, false for server→db only.
5. A symbol that does not exist: empty report, `degraded: false`.
6. An unparseable file in the project does not fail the call; `degraded` is true.
7. A 60-file fixture caps at 25 and reports the omitted count.

---

## TASK 2 — duplicate business logic (`E3`)

Held back from batch 2 on purpose: this is the rule with real false-positive risk, and a rule
that cries wolf gets switched off along with the three good ones next to it.

### Build

Add to `src/verify/architecture.ts` (batch 2 TASK 4 creates it; if it is not merged yet, create
the file with just this rule and batch 2 will add to it):

- Extract every function/method body of **8 or more statements**. Shorter than that is noise —
  two three-line handlers that look alike usually should look alike.
- Normalise: strip comments and whitespace, rename local identifiers to positional placeholders
  (`v1`, `v2`…) so `const total` and `const sum` do not hide a true duplicate.
- Report pairs whose normalised bodies are **identical**. Not "similar" — no fuzzy threshold in
  this task. A threshold needs tuning data we do not have, and a wrong one poisons the whole gate.

Finding kind: `"duplicate-logic"`. The `detail` names both locations and says what to do:
extract to a shared function in `src/lib/`, not just "these are the same".

### Requirements

- **Never report a pair where either body is a test.** Test setup is repetitive by nature.
- **Never report generated boilerplate**: a body that is only `return` of a literal/JSX, or only
  a `switch`, is excluded.
- Report each pair **once**, not twice (A↔B is one finding).
- Three or more identical bodies report as one finding naming all locations.

### Cases — add to `scripts/architecture.test.ts`

1. Two identical 10-statement functions with different names and different local variable names
   → one finding.
2. The same two, but 5 statements → **no finding** (under the floor).
3. Two functions that differ by one statement → **no finding** (identical only).
4. Two identical test bodies → no finding.
5. Two components that both `return <div>{x}</div>` → no finding.
6. Three identical bodies → one finding naming all three.
7. A clean project → zero findings.

---

## TASK 3 — `build_outcome` as a projection (`C3`)

### Why it is needed

`build_outcome` is written once at the end of a build. Production data from 2026-10-17 shows it
is written for 36/36 successful builds, but it is a **mutable snapshot**: when a verdict goes
stale mid-build, the record says whatever the last write said. A fold over events cannot go
stale, because the events are what happened.

**This task does not introduce events** — `build_events` (C1/C2) is Claude's and does not exist
yet. It builds the **pure fold** so that when events arrive, the projection is already proven.

### Build

`src/verify/outcome-projection.ts`:

```ts
export type BuildEvent =
  | { type: "turn/start"; round: number }
  | { type: "tool/call"; name: string; round: number }
  | { type: "tool/result"; name: string; ok: boolean; round: number }
  | { type: "files/written"; paths: string[]; added: number; removed: number }
  | { type: "verification/result"; gate: "page" | "types" | "tests"; status: "pass" | "fail" }
  | { type: "repair/applied"; kind: string }
  | { type: "turn/end"; round: number; costUsd: number }
  | { type: "build/failed"; reason: string };

export function projectOutcome(events: BuildEvent[]): BuildOutcome;
```

`BuildOutcome` is the existing type in `src/db/schema.ts` — **import it, do not redefine it.**

### Requirements

- **The projection must equal today's shape**, field for field, so it can replace the write with
  no migration and no frontend change.
- A gate with no `verification/result` event projects as `"never"` — the existing value for "it
  was not run", which is a different fact from "it ran and passed".
- **Staleness is derivable and must be derived**: writes after the last `verification/result`
  for a gate produce the `staleCheckPage` / `staleCheckTypes` / `staleCheckTests` counts.
- An empty event list projects a valid, empty outcome — never throws.
- Events arriving out of order by round must not corrupt counts; fold on what is there.

### Cases — `scripts/outcome-projection.test.ts`

1. A realistic 12-round event list projects the same shape today's writer produces.
2. No page-check event → `checkPage: "never"`.
3. A page check, then two writes → `staleCheckPage: 2`.
4. A page check, two writes, another page check → `staleCheckPage: 0`.
5. Empty list → valid empty outcome, no throw.
6. `build/failed` is reflected and does not lose the counts accumulated before it.
7. Rounds out of order do not double-count.

---

## TASK 4 — MCP capability mapper (`H2`)

### Why it is needed

Every MCP server names its tools differently — `create_issue`, `issues.create`, `newIssue`. The
agent currently sees raw names and has to guess. **`src/mcp/providers/` is NOT this** — that is a
REST provider registry for connecting (make, n8n, shopify, wordpress, zapier). This maps *tools*
to *capabilities*.

### Build

`src/mcp/capabilities.ts`:

```ts
export type Capability =
  | "repo.read" | "repo.write" | "issue.read" | "issue.write"
  | "deploy.create" | "deploy.read" | "deploy.rollback"
  | "db.query" | "db.write" | "message.send" | "file.read" | "file.write";

export function mapTool(serverSlug: string, toolName: string): Capability | null;
export function mapTools(serverSlug: string, toolNames: string[]):
  Array<{ toolName: string; capability: Capability | null }>;
```

- A **hand-seeded table** for the servers we actually have: `github`, `vercel`, `railway`,
  `supabase`, `n8n`, `wordpress`, `shopify`, `zapier`, `make`, `figma`, `linear`, `sentry`,
  `cloudflare`, `netlify`.
- An unmapped tool returns `null`. **`null` must stay usable** — the agent still sees the raw
  tool; the capability is extra information, never a filter.

### Requirements

- **No network, no LLM call, no cache in this task.** The plan once described a "classification
  dispatch for unknown servers"; that is a later task and it needs a cache design. A pure lookup
  with an honest `null` is better than a guess.
- Case-insensitive on the tool name; exact on the server slug.
- The table lives in one exported const so a new server is one object literal.

### Cases — `scripts/capabilities.test.ts`

1. `github` / `create_issue` → `issue.write`.
2. `github` / `get_file_contents` → `repo.read`.
3. `vercel` / `create_deployment` → `deploy.create`.
4. An unknown tool on a known server → `null`.
5. An unknown server → `null` for everything, no throw.
6. Case differences in the tool name still map.
7. `mapTools` returns one entry per input, preserving order, including the nulls.

---

## TASK 5 — permission tiers (`H3`)

### Why it is needed

Today there are two states: a tool runs, or it is behind the approval gate. That is too blunt —
reading a repo and deleting one should not feel the same, and neither should cost the user an
approval click every time.

### Build

`src/mcp/tiers.ts`:

```ts
export type Tier = "read" | "sandbox" | "approval" | "strong-approval";
export function tierFor(capability: Capability | null, toolName: string): Tier;
export function describeTier(tier: Tier): string;
```

- `read` — runs freely. Anything mapped to a `*.read` or `*.query` capability.
- `sandbox` — runs freely but only affects the build's own sandbox.
- `approval` — the existing gate: one click. Writes that create.
- `strong-approval` — destructive and hard to undo: delete, rollback, force-push, drop. The
  description must name **what cannot be undone**.

### Requirements

- **An unmapped capability (`null`) defaults to `approval`, never `read`.** Fail closed. This is
  the exact mistake fixed on 2026-10-16: an unclassified tool must be *asked about*, never
  silently allowed and never silently hidden.
- Name-based escalation on top of the capability: a tool whose name contains `delete`, `drop`,
  `destroy`, `rollback`, `force` is `strong-approval` **even if its capability says otherwise**.
  The capability table can be wrong; the word "delete" rarely is.
- Pure function, no state.

### Cases — `scripts/tiers.test.ts`

1. `repo.read` → `read`.
2. `issue.write` → `approval`.
3. `deploy.rollback` → `strong-approval`.
4. **`null` → `approval`, not `read`** — the fail-closed case.
5. A tool named `delete_branch` mapped to `repo.write` → `strong-approval` (name escalates).
6. A tool named `get_deleted_items` mapped to `repo.read` → stays `read` (the word appears but
   the action is a read — match on word boundaries, not substrings).
7. `describeTier("strong-approval")` names irreversibility.

Case 6 is the one to get right. A naive `includes("delete")` fails it.

---

## TASK 6 — retire the weak security checks (`G4`)

### Why it is needed

`src/verify/security.ts` is ~520 lines of pattern matching. The research says this class catches
little, and this file was itself caught reporting a clean pass over zero files scanned. **That
specific bug is fixed** (there is now a `scanned === 0` branch that reports "unavailable" rather
than "pass") — this task is about the checks that remain thin.

### Build

**Keep exactly two, unchanged:** `checkPackages` (slopsquatting — a hallucinated package name is
a real, cheap-to-detect supply-chain risk) and `checkSecrets` (a committed key is unambiguous).

**Remove the rest**, including `checkAuth` and `checkCORS`. Remove, not disable: a commented-out
check is a check nobody can see is gone.

Update every caller — `build.ts` drives a hard-block and auto-fix loop from this module, so the
removal must leave that loop coherent, not calling into nothing.

### Requirements

- **Delete the cases for removed checks too.** Leaving `scripts/security.test.ts` asserting
  behaviour that no longer exists is how a suite becomes noise.
- The two kept checks must still fire — their existing cases pass unchanged.
- If removing a check leaves a now-dead helper, remove it as well. Run `find_dead_code`'s logic
  over the file, or just read it.
- **Say in the commit message what you removed and what the gate no longer catches.** That list
  is the honest cost of this task and Claude needs it to decide what G2/G3 must replace.

### Cases

`scripts/security.test.ts`, reduced to the two kept checks plus one new case: calling the module
on a project with zero scannable files still reports "unavailable", not "pass". That is the
regression that started all of this.

---

## TASK 7 — browser storage capture (`F3`)

### Why it is needed

Generated apps keep real state in `localStorage` — a cart, a draft, a signed-in flag. The render
and interaction probes cannot see it, so "the button worked" and "the button worked and saved
something" look identical.

### Build

Two pieces, and **only the parser is yours to prove**:

1. `src/verify/storage-script.ts` — exports the browser-side snippet as a string, the way
   `interactions.ts` exports `INTERACTION_SCRIPT`. It reads `localStorage`, `sessionStorage` and
   the names of IndexedDB databases, and prints one JSON line.
2. `src/verify/storage.ts` — `parseStorageSnapshot(raw: string): StorageSnapshot` plus
   `formatStorage(snapshot)`.

```ts
export interface StorageSnapshot {
  local: Array<{ key: string; bytes: number; preview: string }>;
  session: Array<{ key: string; bytes: number; preview: string }>;
  indexedDb: string[];
  ran: boolean;
}
```

### Requirements

- **Values are never returned whole.** A `preview` of at most 80 characters plus a byte count.
  An auth token in `localStorage` is normal, and copying it into the model's context is not.
- **Redact anything that looks like a credential**: a key matching `/token|secret|key|password|
  jwt|session/i` reports its byte count and `preview: "[redacted]"`.
- Malformed or empty input returns `{ ran: false }` and never throws — the same contract
  `interactions.ts` has, for the same reason: a probe failure must not fail a build.
- **Do not wire this into `e2b-service.ts`.** Claude does that, because it needs a real sandbox
  to prove and trap 9 makes that module unimportable here.

### Cases — `scripts/storage.test.ts`

1. A well-formed snapshot parses into keys with byte counts.
2. A key named `auth_token` is redacted but keeps its byte count.
3. A key named `cart` is not redacted.
4. A 4 KB value's preview is 80 characters, and `bytes` reports the real size.
5. Empty input → `ran: false`, no throw.
6. Malformed JSON → `ran: false`, no throw.
7. `formatStorage` on an empty snapshot returns an empty string, not a header with nothing
   under it.

---

## What is NOT in this batch, and why

These stay with Claude because each is prompt text, a production migration, or needs a real
build — the three things that have cost this project most when treated as ordinary code:

`G5` (JWT forwarding), `G6` proof, `E5` (the combined architecture gate's output), `C1`/`C2`
(the events table and the writes into it), `C4` (resume), `B8` (stale-code cutting), `D3`
(journeys), `F1`/`F2`/`F4`, `H4` (deploy operations), `H5` (failure triage), `I2` (`shell`), and
wiring every module from batches 2 and 3 into the agent loop.
