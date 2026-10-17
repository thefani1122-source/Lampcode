# Codex task prompts — batch 2

Everything in `CODEX-TASKS.md`'s "Git workflow" section still applies **unchanged**: same branch
`claude/magical-fermat-zr857z`, pull before every task, one commit per task pushed immediately,
never `main`, no drive-by refactors, `Co-Authored-By: Codex <noreply@openai.com>`.

**Read `CLAUDE.md` first.** The two traps that will bite you in this batch: trap 7 (Node resolves
a bare specifier relative to the importing file) and trap 9 (importing `e2b-service.ts` outside
the server process hangs — read it as TEXT if you need its contents).

**House style:** comments explain WHY, especially where the obvious implementation is wrong.
Read `src/verify/wiring.ts` or `src/verify/data-layer.ts` before writing. A comment that restates
the code is worse than none.

**Order matters here.** TASK 1 is a measured defect in code you already shipped and it blocks a
real build; do it first. TASK 2 pays for itself before the rest land. The others are independent.

---

## TASK 1 — `diff_since` drops real edits (defect, do this first)

### What is wrong

Measured on 2026-10-17, reproduced from a script:

```
4 files of 11,000 NEW lines + a one-line edit to src/small.ts
  → filesChanged=0  added=0  removed=0   and src/small.ts is ABSENT from the output
the same edit alone               → filesChanged=1, present
the same edit + ONE large file    → filesChanged=1, present
```

### Why it happens

In `src/verify/diff.ts`, the per-file loop builds `oldLines`/`newLines` and then always calls
`myers(oldLines, newLines, remaining)`. For a **pure create** `beforePresent` is false so
`oldLines` is empty, and for a **pure delete** `newLines` is empty. In both cases the answer
needs no search at all — it is trivially every line added, or every line removed — but Myers is
still run, and it spends work proportional to the file, drawn from the shared `MAX_TOTAL_WORK`.
Three or four large new files exhaust that budget, and every file after them is dropped into
`computeOmitted`.

Your reporting is honest — the text says "these counts are not complete project totals", so
nothing is misreported. The problem is that the model cannot see the change it just made, on
exactly the builds where it would ask: ones that created several large files.

### Build

In the loop in `unifiedDiff`, before computing `remaining` and calling `myers`:

- If `!beforePresent` (and the file is not `tooLarge`), produce ops that are every line of
  `newLines` as `add`. Spend **no** budget.
- If `!afterPresent`, produce ops that are every line of `oldLines` as `remove`. Spend **no**
  budget.
- Everything downstream (`renderFile`, the counters, the output cap) stays exactly as it is —
  a created file already renders correctly today when the budget happens to allow it, so this
  must produce byte-identical output for that case.

Keep `MAX_FILE_CHARS` / `MAX_FILE_LINES` applying as they do now: a 2-million-character new file
is still refused, because rendering it would blow the output cap rather than the work budget.

### Cases — add to `scripts/diff.test.ts`

1. A pure-created file's diff is identical whether or not other files are present.
2. **The regression itself:** four created files of 11,000 lines plus a one-line edit → the edit
   is in the output and `filesChanged` counts it. This is the case that would have caught it.
3. A pure-deleted large file does not consume budget either — same shape, reversed.
4. A file that is created AND is over `MAX_FILE_LINES` is still omitted, not rendered.
5. A real modification (both sides present) still goes through Myers and still respects the
   budget — prove the fast path did not swallow the normal one.

### Done means

The reproduction above returns the small edit; all five cases pass; `npm run typecheck`,
`npm test`, `npm run build` green; and a written note of what you could not verify.

---

## TASK 2 — tool registry (`I1`)

### Why it is needed now and not later

`executeTool` in `src/agents/tools.ts` is **965 lines with 21 `if (name === …)` branches**,
re-measured 2026-10-17. Our own plan recorded 758 and 29, so it is growing. Four more tools are
coming in this batch and the next; each one lands in the middle of that function, which means
every tool's diff touches the same file and no two tools can be reviewed independently.

### Build

- `src/agents/tools/` — one file per tool, each exporting a handler with a single shape, e.g.
  `export const handler: ToolHandler = async (args, ctx) => string`.
- `src/agents/tools/registry.ts` — `export const REGISTRY: Map<string, ToolHandler>`.
- `executeTool` keeps **every guard it has today** — the approval gate, the write-proxy
  dispatch, the MCP read path, the baked-file refusal, the churn accounting — and ends with a
  registry lookup instead of a branch chain.

### Requirements, each for a reason

- **Behaviour must not change at all.** This is a move, not a redesign. If you find a bug while
  moving a tool, leave it and say so in the commit message — a refactor that also fixes things
  cannot be reviewed, because the diff no longer shows what moved.
- **The guards stay in `executeTool`, not in the handlers.** A guard copied into 21 files is a
  guard that will be forgotten in the 22nd.
- The write-proxy and MCP-read dispatch are NOT registry entries — they are name-pattern
  dispatch over a runtime registry and must stay where they are.
- Tool *definitions* (`AGENTIC_BUILD_TOOLS` and friends) stay where they are. This task moves
  execution only.

### Cases — extend the existing suites, do not write a new one

The existing cases across `scripts/*.test.ts` already exercise these tools. They must pass
**unchanged** — that is the entire proof for this task. Add one new case: every name in the
tool-definition arrays resolves to a registry entry or to one of the named dispatch paths, so a
tool defined but never wired cannot ship again.

### Done means

All three gates green with no existing case modified, `executeTool` under 200 lines, and the new
coverage case passing.

---

## TASK 3 — `code_intel` (`D1`)

### Why it is needed

This is the first half of what makes Lampcode different from a coding agent with a sandbox. The
model can search text (`search_code`) but cannot ask what a symbol **is** or what **uses** it, so
on a 40-file app it re-reads files to answer questions a compiler answers exactly.

### Build

`src/verify/code-intel.ts`, a pure function over the in-memory file map:

```ts
export interface SymbolRef { path: string; line: number; text: string }
export interface CodeIntelResult {
  definition?: SymbolRef;
  references: SymbolRef[];
  /** Exported symbols per file, when asked for a file rather than a symbol. */
  symbols?: Array<{ name: string; kind: string; line: number }>;
  /** True when the TypeScript path failed and the regex fallback answered. */
  degraded: boolean;
}
export function codeIntel(
  files: Record<string, string>,
  query: { symbol?: string; path?: string },
): CodeIntelResult
```

Use the **TypeScript compiler API** (`typescript` is already a dependency) over an in-memory
`CompilerHost` backed by the file map — no disk, no `tsconfig` resolution against the real
project.

### Requirements, each for a reason

- **A file that does not parse must not fail the whole call.** Generated code is frequently
  mid-edit and syntactically broken; a tool that returns nothing on the one file the model is
  fixing is a tool it stops calling. Fall back to a regex scan for that file, set `degraded`, and
  keep the compiler results for every file that did parse.
- **Cap the output.** References for a symbol like `useState` can be hundreds. Cap at 40 and say
  how many were omitted — the same split `wiring.ts` and `dead-code.ts` make between what is
  found and what is printed.
- **Never read the real filesystem.** The file map is the project; `e2b-service` is not
  importable here (trap 9) and the sandbox is not where this runs.
- Handle `.tsx` as well as `.ts`. Most generated files are `.tsx`.

### Cases — `scripts/code-intel.test.ts`

1. A function defined in one file and called in two others: definition found, two references.
2. The definition is not also counted as a reference.
3. A symbol that does not exist: no definition, empty references, `degraded: false`.
4. **A file with a syntax error alongside three good ones**: the good ones still answer and
   `degraded` is true.
5. A symbol with more than 40 references: capped, and the omitted count reported.
6. `path`-mode returns the file's exported symbols with kinds.
7. A `.tsx` component is found the same as a `.ts` function.
8. Same-named local variables in two files are not conflated into one symbol.

### Done means

All three gates green, the eight cases pass, and the module is exported but **not yet wired into
`tools.ts`** — Claude wires it, because the tool description is prompt text.

---

## TASK 4 — architecture rules E1, E2, E4

Three of the four rules, in one module, because they share the same walk over the file map.
**E3 (duplicate logic) is deliberately not in this batch** — it is the one with real false-positive
risk and it deserves its own task.

### E1 — circular imports

**Most of this already exists.** `src/verify/import-graph.ts` exports `buildImportGraph`,
`resolveSpecifier` and `importSpecifiers`. You need the cycle walk over that graph, not a new
graph. Do not duplicate it.

Report each cycle once, as its path: `a.ts → b.ts → c.ts → a.ts`. A file importing itself is a
cycle of length one and must be reported.

### E2 — layer rule

`src/components/**` must not import `src/db/**` or `src/server/**`. Report the importing file,
the imported file, and which rule was crossed.

This matters in generated apps specifically: a component importing the server's database client
compiles in the preview, then fails in a production build where that module is not bundled — the
same class of bug as `hardcoded-dev-host` in `wiring.ts`.

### E4 — file-size ceiling

Report a source file over **600 lines**. Not a hard rule, a signal: the model's answer to "add a
feature" is often to append to `App.tsx` until it is 2,000 lines and nothing can be edited
surgically any more.

Exclude generated SQL, `.json`, and anything in `BAKED_FILES`.

### Shape

`src/verify/architecture.ts`, following `wiring.ts` exactly:

```ts
export type ArchitectureKind = "circular-import" | "layer-violation" | "file-too-large";
export type ArchitectureFinding = {
  kind: ArchitectureKind; path: string; symbol: string; detail: string;
};
export function findArchitectureGaps(files: Record<string, string>): ArchitectureFinding[];
export function formatArchitectureGaps(findings: ArchitectureFinding[]): string;
```

**Every `detail` must name the fix, not just the violation.** "src/components/Chart.tsx imports
src/db/client.ts" is a complaint; "move the query behind an /api route and fetch it, so the
component does not bundle the database client" is a finding someone can act on.

### Cases — `scripts/architecture.test.ts`

Per rule: the violating shape, the near-miss that must NOT fire, and the boundary.

1. Two-file cycle, three-file cycle, self-import, and a diamond that is **not** a cycle.
2. A cycle is reported once, not once per file in it.
3. Component → db violation; component → `src/lib` **not** a violation; server → db **not** a
   violation.
4. 601 lines fires, 600 does not, a `.sql` file of 5,000 lines does not, a baked file does not.
5. A clean project produces zero findings — the quiet-majority case `data-layer.test.ts` has.

### Done means

Three gates green, cases pass, module exported and **not wired** — E5 (the combined gate, whose
output is prompt-adjacent) is Claude's.

---

## TASK 5 — `web_search` (`I3`)

### Why it is needed

The model hits an unfamiliar library or an error string it has not seen and has no way to look
it up. `fetch_reference` fetches a URL it already knows; this finds the URL.

### Build

`src/agents/web-search.ts`. `FIRECRAWL_API_KEY` and `EXA_API_KEY` are both already in config and
set on Railway — use Exa for search, and fall back to Firecrawl if Exa errors.

```ts
export interface SearchHit { title: string; url: string; snippet: string }
export async function webSearch(query: string, limit?: number): Promise<SearchHit[]>
export function formatSearchHits(hits: SearchHit[]): string
```

### Requirements

- **Cap hard: 5 hits, 300 characters of snippet each.** This goes into every subsequent round's
  context. A tool that returns 20 results with full page text costs more than the answer is
  worth.
- **Never throw.** A search failure returns an empty list and a one-line reason. A build must not
  die because a search API had a bad minute.
- Timeout at 10 s.
- No key configured → return empty with a reason, do not crash at import time.

### Cases — `scripts/web-search.test.ts`

Parse and formatting only — **do not call the network in a case.** `npm test` must stay free and
offline. Feed recorded response shapes to the parser.

1. A well-formed Exa response parses to hits.
2. A response with 20 results is capped to 5.
3. A 2,000-character snippet is cut to 300.
4. A malformed response yields an empty list, not an exception.
5. An empty result set formats as a readable "nothing found", not an empty string.

### Done means

Three gates green, five cases, module exported and **not wired** — Claude writes the tool
description.

---

## After these five

Push each one separately. Claude re-runs all three gates on Linux, wires the three unwired
modules into the agent loop (tool descriptions are prompt text, which is this repo's top bug
class), and runs the real builds that none of this has had yet.

**If something here is wrong, say so instead of building it.** More than one confident, specific
instruction in this repo has turned out to be false against the working code, and an hour spent
arguing is cheaper than a day spent implementing the wrong thing.
