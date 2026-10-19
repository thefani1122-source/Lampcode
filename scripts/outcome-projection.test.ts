import { projectOutcome, type BuildEvent } from "../src/verify/outcome-projection.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, condition: boolean): void { check(name, condition, true); }

const terminal = {
  type: "build/end" as const,
  turnsExhausted: false,
  filesWritten: 6,
  costUsd: 0.42,
  durationMs: 18_000,
};

const realistic: BuildEvent[] = [
  { type: "plan/ready", files: ["src/App.tsx", "src/lib/data.ts"] },
  ...Array.from({ length: 12 }, (_, i): BuildEvent => ({ type: "turn/start", round: i + 1 })),
  { type: "tool/call", name: "write_files", round: 1 },
  { type: "tool/call", name: "check_page", round: 4 },
  { type: "tool/call", name: "check_types", round: 6 },
  { type: "tool/call", name: "run_tests", round: 8 },
  { type: "verification/result", gate: "page", status: "pass" },
  { type: "verification/result", gate: "types", status: "pass" },
  { type: "verification/result", gate: "tests", status: "none" },
  { type: "files/written", paths: ["src/App.tsx"], added: 2, removed: 1 },
  { type: "turn/end", round: 12, costUsd: 0.21 },
  terminal,
];

check("a realistic 12-round stream projects the current core outcome", projectOutcome(realistic), {
  rounds: 12,
  turnsExhausted: false,
  filesWritten: 6,
  toolCalls: { write_files: 1, check_page: 1, check_types: 1, run_tests: 1 },
  checkPage: "pass",
  checkTypes: "pass",
  checkTests: "none",
  staleCheckPage: 1,
  staleCheckTypes: 1,
  staleCheckTests: 1,
  planned: true,
  plannedFiles: 2,
  costUsd: 0.42,
  durationMs: 18_000,
});

check("no page-check event remains never", projectOutcome([{ ...terminal }]).checkPage, "never");
check("unavailable remains distinct from fail", projectOutcome([
  { type: "verification/result", gate: "types", status: "unavailable" }, terminal,
]).checkTypes, "unavailable");
check("tests with no discovered test files remain none", projectOutcome([
  { type: "verification/result", gate: "tests", status: "none" }, terminal,
]).checkTests, "none");

check("a page check followed by two write batches is stale twice", projectOutcome([
  { type: "verification/result", gate: "page", status: "pass" },
  { type: "files/written", paths: ["a.ts"], added: 1, removed: 0 },
  { type: "files/written", paths: ["b.ts"], added: 1, removed: 0 }, terminal,
]).staleCheckPage, 2);
check("a later page recheck clears staleness", projectOutcome([
  { type: "verification/result", gate: "page", status: "pass" },
  { type: "files/written", paths: ["a.ts"], added: 1, removed: 0 },
  { type: "files/written", paths: ["b.ts"], added: 1, removed: 0 },
  { type: "verification/result", gate: "page", status: "pass" }, terminal,
]).staleCheckPage, 0);

const empty = projectOutcome([]);
ok("an empty event list returns a valid identity outcome", empty.rounds === 0 && empty.checkPage === "never" && empty.toolCalls !== undefined);

const failed = projectOutcome([
  { type: "tool/call", name: "write_files", round: 1 },
  { type: "verification/result", gate: "types", status: "fail" },
  { type: "build/failed", reason: "verification failed", turnsExhausted: false, filesWritten: 2, costUsd: 0.08, durationMs: 1_200 },
]);
check("a failed build retains tool and gate evidence accumulated before failure", {
  toolCalls: failed.toolCalls,
  checkTypes: failed.checkTypes,
  filesWritten: failed.filesWritten,
  costUsd: failed.costUsd,
}, { toolCalls: { write_files: 1 }, checkTypes: "fail", filesWritten: 2, costUsd: 0.08 });

check("repeated and out-of-order round metadata does not inflate rounds", projectOutcome([
  { type: "turn/start", round: 4 },
  { type: "tool/call", name: "write_files", round: 2 },
  { type: "turn/start", round: 2 },
  { type: "turn/start", round: 4 },
  terminal,
]).rounds, 2);

check("plan metadata is represented explicitly", {
  planned: projectOutcome([{ type: "plan/ready", files: ["a.ts", "b.ts", "c.ts"] }, terminal]).planned,
  plannedFiles: projectOutcome([{ type: "plan/ready", files: ["a.ts", "b.ts", "c.ts"] }, terminal]).plannedFiles,
}, { planned: true, plannedFiles: 3 });

check("turn exhaustion, cost, and duration come from terminal evidence", {
  turnsExhausted: projectOutcome([{ type: "build/end", turnsExhausted: true, filesWritten: 1, costUsd: 1.25, durationMs: 55_000 }]).turnsExhausted,
  costUsd: projectOutcome([{ type: "build/end", turnsExhausted: true, filesWritten: 1, costUsd: 1.25, durationMs: 55_000 }]).costUsd,
  durationMs: projectOutcome([{ type: "build/end", turnsExhausted: true, filesWritten: 1, costUsd: 1.25, durationMs: 55_000 }]).durationMs,
}, { turnsExhausted: true, costUsd: 1.25, durationMs: 55_000 });

check("staleness follows event chronology even when round metadata is out of order", projectOutcome([
  { type: "verification/result", gate: "page", status: "pass" },
  { type: "files/written", paths: ["late.ts"], added: 1, removed: 0 },
  terminal,
]).staleCheckPage, 1);


// ── The seven sequences the launch pass asked for ───────────────────────────
// Each is a full stream, terminal event included, because the projection
// refuses to answer without one — a half-recorded build must never read as a
// measured one.

const END = { type: "build/end", turnsExhausted: false, filesWritten: 3, costUsd: 0.1, durationMs: 1000 } as const;

{
  // check → write → the verdict is about code the build no longer has.
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "tool/call", name: "check_page", round: 1 },
    { type: "verification/result", gate: "page", status: "pass" },
    { type: "files/written", paths: ["src/App.tsx"], added: 10, removed: 2 },
    END,
  ]);
  ok("check → write leaves the page verdict stale", outcome.checkPage === "pass" && outcome.staleCheckPage === 1);
  ok("a gate that was never called is not made stale by the same write", outcome.checkTypes === "never" && outcome.staleCheckTypes === 0);
}

{
  // check → write → recheck: the re-run clears it.
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "verification/result", gate: "page", status: "pass" },
    { type: "files/written", paths: ["src/App.tsx"], added: 10, removed: 2 },
    { type: "verification/result", gate: "page", status: "pass" },
    END,
  ]);
  ok("check → write → recheck resets staleness", outcome.staleCheckPage === 0 && outcome.checkPage === "pass");
}

{
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "files/written", paths: ["src/App.tsx"], added: 1, removed: 0 },
    END,
  ]);
  ok("a missing check is \"never\", not a pass", outcome.checkPage === "never" && outcome.checkTypes === "never" && outcome.checkTests === "never");
}

{
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "verification/result", gate: "types", status: "unavailable" },
    END,
  ]);
  ok("unavailable stays unavailable and is not upgraded", outcome.checkTypes === "unavailable");
}

{
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "verification/result", gate: "tests", status: "none" },
    END,
  ]);
  ok("a runner with no tests reports \"none\", never \"pass\"", outcome.checkTests === "none");
}

{
  // A failed build keeps every piece of evidence it had reached.
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "tool/call", name: "write_files", round: 1 },
    { type: "verification/result", gate: "types", status: "fail" },
    { type: "repair/applied", kind: "type-check" },
    { type: "build/failed", reason: "sandbox died", turnsExhausted: false, filesWritten: 4, costUsd: 0.2, durationMs: 900 },
  ]);
  ok("a failed build keeps its gate verdicts", outcome.checkTypes === "fail");
  ok("and its tool calls", outcome.toolCalls["write_files"] === 1);
  ok("and its cost and duration", outcome.costUsd === 0.2 && outcome.durationMs === 900);
}

{
  // An empty files/written must not invent staleness — a tool that touched
  // nothing did not invalidate anything.
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "verification/result", gate: "page", status: "pass" },
    { type: "files/written", paths: [], added: 0, removed: 0 },
    END,
  ]);
  ok("a write of no files leaves the verdict fresh", outcome.staleCheckPage === 0);
}

{
  // Several writes after one check count individually: the number is how far
  // the build has outrun the verdict, not a boolean.
  const outcome = projectOutcome([
    { type: "turn/start", round: 1 },
    { type: "verification/result", gate: "page", status: "pass" },
    { type: "files/written", paths: ["a.tsx"], added: 1, removed: 0 },
    { type: "files/written", paths: ["b.tsx"], added: 1, removed: 0 },
    { type: "files/written", paths: ["c.tsx"], added: 1, removed: 0 },
    END,
  ]);
  ok("staleness counts every write after the verdict", outcome.staleCheckPage === 3);
}

if (failures > 0) {
  console.error(`\n${failures} outcome projection case(s) FAILED`);
  process.exit(1);
}
console.log("\nAll outcome projection cases passed.");
