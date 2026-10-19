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

if (failures > 0) {
  console.error(`\n${failures} outcome projection case(s) FAILED`);
  process.exit(1);
}
console.log("\nAll outcome projection cases passed.");
