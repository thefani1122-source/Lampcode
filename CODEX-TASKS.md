# Codex task prompts — batch 1

Four self-contained tools. Each is provable without Railway, E2B, money or a real build, which
is why they are Codex's and not Claude's.

**Do them ONE AT A TIME and push after each** to `claude/magical-fermat-zr857z`. Not in a batch:
Claude can only review what is pushed, and one task's diff is reviewable where four are not.

**Read `CLAUDE.md` first.** It is 12 KB and holds the traps. The two that will bite you here:
trap 7 (Node resolves a bare specifier relative to the importing file) and the rule that
`npm test` is the free gate and costs nothing, so run it constantly.

**Every task ends with:** `npm run typecheck`, `npm test`, `npm run build`, and an explicit
written list of what you could **not** verify. "It should work" is not a result. If the Windows
esbuild parent-directory denial stops the build, say so and push anyway — Claude re-runs all
three on Linux.

**House style, non-negotiable:** comments explain WHY a thing is the way it is, especially where
the obvious implementation is wrong. Look at `src/verify/wiring.ts` or `src/verify/render.ts`
before writing. A comment that restates the code is worse than none.

---

## TASK 1 — `search_code`

### Why it is needed

The agent has `list_files` and `read_file` and nothing else. It cannot look for anything. On a
real build on 2026-10-14 the model called `list_files` once, `read_file` three times, then gave
up and wrote prose instead of code. It had no way to answer "where is this used".

### The thing that makes this cheap

**The whole project is already in memory on every tool call.** `ctx.projectFiles` holds the
existing project and `ctx.generatedFiles` holds what this build wrote. Merge them. No sandbox,
no index, no disk, no latency. This is the hard problem for anyone indexing a repo; here it is a
loop over a `Record<string, string>`.

### Build

`src/verify/search.ts` — a pure module, no imports from `e2b-service.ts` (trap 9: importing it
outside the server process hangs).

```ts
export type SearchHit = { path: string; line: number; text: string; before: string[]; after: string[] };
export function searchFiles(
  files: Record<string, string>,
  opts: { query: string; isRegex?: boolean; pathGlob?: string; maxResults?: number },
): { hits: SearchHit[]; truncated: boolean; filesSearched: number };
export function formatSearchHits(r: ReturnType<typeof searchFiles>): string;
```

Then register the tool in `src/agents/tools.ts` next to `list_files`, and add the definition to
`AGENTIC_BUILD_TOOLS`.

### Requirements, each for a reason

- **Default `maxResults` 40, and cap total output characters too.** Output is re-paid in the
  model's context on every later round. A search that returns 300 hits costs more than it is
  worth. When truncated, say so — a silently truncated result is a lie.
- **±2 lines of context** per hit. One line is not enough to judge a match; ten is waste.
- **An invalid regex must not throw.** Return a result that says the pattern was invalid and
  what was wrong with it. The model will send bad regexes; a thrown error wastes a whole round.
- **`pathGlob`** supporting `*` and `**` only. Do not pull in a glob library for this.
- **Skip binary-ish and generated content**: anything in `node_modules/`, `dist/`, `.git/`, and
  files over ~200 KB. Say how many files were skipped.
- **Literal mode is the default**, `isRegex` opt-in. Most searches are for a symbol name and
  escaping is the model's problem otherwise.

### Cases — `scripts/search.test.ts`, added to the `npm test` chain in `package.json`

Follow the existing harness exactly (see `scripts/render.test.ts`): a local `check()`/`ok()`,
console output, `process.exit(1)` on failure. Do **not** introduce vitest for repo-side tests.

Pin at least: literal match; regex match; invalid regex does not throw and explains itself;
`pathGlob` include and exclude; `maxResults` cap sets `truncated`; context lines at the start and
end of a file (no negative indexing, no overflow); a match on the first and last line of a file;
empty query rejected; no matches reads as "no matches" and not as an error; skipped directories
really skipped.

### Done means

All three gates pass, the cases above exist, and you have written down what you could not verify
— which will include "not yet seen on a real build", because that is Claude's step.

---

## TASK 2 — `delete_file`

### Why it is needed

**There is no way to remove code at all.** Verified: no delete tool among the 17, and a file
written empty is dropped by `isEffectivelyEmpty` in `build.ts`. The agent can create and replace
but never remove. Nothing about cleaning up superseded code is possible until this exists, and
it is the blocker for the task that cuts stale code after a change is proven.

### Build

A new handler in `src/agents/tools.ts` beside `write_files`, plus its definition.

**Read `write_files` first and mirror its guards.** It is the reference implementation and its
comments explain why each guard exists.

### Requirements, each one already paid for once

- **Refuse template-owned paths OUT LOUD** (`isTemplateOwnedFile`). The history here is exact: a
  model wrote animations into `src/styles.css`, was told "Wrote 2 files", and reported the work
  as done — while the file was discarded on the way in. Silent rejection is how an agent
  honestly describes work that does not exist. Say what was refused and why.
- **Never delete the entry point.** `src/App.tsx` (or the framework's equivalent — see
  `expectedEntryPoint` in `build.ts`). A build without it fails outright, so this must be refused
  with an explanation rather than obeyed.
- **Record churn** via `noteChurn(ctx, before, "", "deleted")` — the file's content out, nothing
  in. `churn.removed` is the number that answers "do edits cut anything"; a delete that does not
  record is a hole in the one measurement we have of this.
- **Persist the deletion**, do not only mutate `ctx.generatedFiles`. Files are stored as they are
  written specifically so a build that dies partway leaves something recoverable; a deletion that
  lives only in memory reappears on the next restore.
- **Deleting something that does not exist is not an error.** Say so plainly and continue — the
  model asking twice must not cost a failed round.
- **Accept multiple paths** in one call, and report per path. Four separate rounds to delete four
  files is four rounds of context.

### Cases — `scripts/delete-file.test.ts`

Template-owned path refused and named; entry point refused and named; a normal delete removes it
from the file map; churn records the removal; a missing path is reported, not thrown; mixed
batch where some succeed and some are refused reports both halves; deleting everything still
leaves the entry point.

### Done means

Three gates, the cases, and your list of what is unverified.

---

## TASK 3 — `checkpoint` / `revert`

### Why it is needed

Two reasons, and the second is the real one.

An agent that repairs repeatedly can damage working code — that is a known failure of coding
agents generally. And more specifically: **this is the safety net that makes automatically
cutting stale code acceptable.** A cut that can be undone is a cut worth making. Without it,
nobody should let a program delete code on its own.

### The thing that makes this cheap

`persistFilesAsWritten` already stores files as they are written, and the complete file map is
already in memory. A checkpoint is a **named snapshot of that map**. There is no new storage
problem to solve.

### Build

`src/verify/checkpoints.ts` for the pure part (snapshot store, diff of what a restore would
change), plus two tool handlers in `tools.ts`.

```ts
export type Checkpoint = { label: string; at: number; files: Record<string, string> };
export function takeCheckpoint(label: string, files: Record<string, string>): Checkpoint;
export function restorePlan(cp: Checkpoint, current: Record<string, string>):
  { toWrite: string[]; toDelete: string[]; unchanged: number };
export function formatRestorePlan(p: ReturnType<typeof restorePlan>): string;
```

Keep checkpoints on the dispatch context, one map for the whole build, the same shape and
reasoning as `gateResults` and `lastRender` (see `dispatcher.ts` around line 529).

### Requirements

- **A restore must handle deletions**, not only writes. If the checkpoint had `a.ts` and the
  current state does not, restoring puts it back. If the current state has `b.ts` and the
  checkpoint did not, restoring removes it. A restore that only writes is not a restore.
- **Re-taking a checkpoint with the same label replaces it**, and says so.
- **Restoring an unknown label is not an error** — list the labels that exist. The model will
  guess labels.
- **Cap how many checkpoints are kept** (say 5, oldest dropped) and say when one is dropped.
  These hold whole file maps.
- **`restorePlan` is pure and separately testable.** The tool handler applies it. Keep the
  decision and the effect apart — it is the only way to test this without a sandbox.

### Cases — `scripts/checkpoints.test.ts`

Snapshot then restore returns exact content; a file added after the checkpoint is removed by the
restore; a file deleted after the checkpoint is restored; an unchanged file is reported as
unchanged and not rewritten; same-label replacement; unknown label lists what exists; the cap
drops the oldest; an empty project checkpoints and restores without error.

### Done means

Three gates, the cases, and your unverified list. Note explicitly that the tool handler's
sandbox write path is **not** proven by these cases — that is Claude's real-build step.

---

## TASK 4 — `diff_since`

### Why it is needed

The agent cannot see what it changed. `git` is not an option: generated projects are not git
repositories, and baking `git init` into the E2B template means a template rebuild — where a
failed build silently leaves the last good image serving, which is how `check_page` stayed
broken for three weeks (trap 6).

**It is not necessary.** We hold the complete file map before and after every write. A unified
diff can be computed in-process, with no git, no template change and no new failure mode.

### Build

`src/verify/diff.ts`, pure, plus a tool handler.

```ts
export function unifiedDiff(
  before: Record<string, string>,
  after: Record<string, string>,
  opts?: { context?: number; maxChars?: number },
): { text: string; filesChanged: number; added: number; removed: number; truncated: boolean };
```

Takes its `before` from a checkpoint (task 3) or from `ctx.projectFiles` when no checkpoint
exists — that is "everything this build changed", which is the common question.

### Requirements

- **Write your own LCS diff.** Do not add a dependency for this. A standard
  Myers/LCS line diff is a well-understood exercise and keeps the output ours to shape.
- **Output is for a model, not a terminal.** No colour. Keep `---`/`+++` file headers and
  `@@` hunks, because that format is heavily represented in training data and models read it
  reliably.
- **Cap the output and say when truncated**, same reason as search: every character is re-paid
  in context. When truncating, prefer showing a few files completely over showing all files
  partially — a half-shown hunk is unreadable.
- **A new file shows as all-added, a deleted file as all-removed**, each with a clear header. Do
  not try to detect renames; a rename shown as a delete plus an add is honest and a wrong rename
  guess is not.
- **Identical input produces an empty diff and says "no changes"**, not an empty string.

### Cases — `scripts/diff.test.ts`

Single-line change; multi-hunk change in one file; new file; deleted file; several files at once;
identical input says no changes; truncation sets the flag and does not cut a hunk in half;
context lines at the very start and end of a file; a file ending without a trailing newline;
empty before (everything new); empty after (everything deleted).

### Done means

Three gates, the cases, and your unverified list.

---

## After all four

Push each one separately. Claude reviews on Linux, re-runs all three gates, and takes them
through a real build — which is the step none of these cases can do and none of them should
claim.
