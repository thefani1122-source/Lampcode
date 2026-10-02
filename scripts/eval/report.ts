/**
 * Reads the JSON a run left in eval-results/ and prints it as something you can
 * actually act on — and, with --diff, says whether a change made builds better
 * or only different.
 *
 *   npx tsx scripts/eval/report.ts                 # the newest run
 *   npx tsx scripts/eval/report.ts <file>          # a specific run
 *   npx tsx scripts/eval/report.ts --diff old.json new.json
 *
 * Costs nothing and spends nothing — it only reads files on disk.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskResult } from "./run.js";

const RESULTS_DIR = join(process.cwd(), "eval-results");

type Run = {
  startedAt: string;
  baseUrl: string;
  label: string;
  tiers: string[];
  only: string[];
  results: TaskResult[];
};

async function newestRun(): Promise<string> {
  const files = (await readdir(RESULTS_DIR).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const last = files.at(-1);
  if (!last) {
    throw new Error(
      `No runs in ${RESULTS_DIR}. Run one first: npx tsx scripts/eval/run.ts --tier smoke`,
    );
  }
  return join(RESULTS_DIR, last);
}

async function load(path: string): Promise<Run> {
  return JSON.parse(await readFile(path, "utf8")) as Run;
}

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

const MARK: Record<TaskResult["verdict"], string> = {
  pass: "✔ pass",
  "soft-fail": "~ soft",
  fail: "✘ fail",
  error: "! err ",
};

function summarize(run: Run): void {
  const r = run.results;
  console.log(
    `\n${run.startedAt}  ${run.baseUrl}${run.label ? `  [${run.label}]` : ""}` +
    `  tiers: ${run.tiers.join(",") || "—"}${run.only.length ? `  only: ${run.only.join(",")}` : ""}`,
  );
  console.log(
    `\n${pad("task", 18)}${pad("verdict", 8)}${pad("rounds", 7)}${pad("files", 6)}` +
    `${pad("biggest", 8)}${pad("page", 12)}${pad("types", 12)}${pad("tests", 12)}` +
    `${pad("cost", 8)}${"time"}`,
  );
  console.log("─".repeat(104));
  for (const t of r) {
    console.log(
      pad(t.taskId, 18) +
      pad(MARK[t.verdict], 8) +
      pad(t.outcome ? String(t.outcome.rounds) : "—", 7) +
      pad(String(t.fileCount), 6) +
      pad(t.largestFileLines ? `${t.largestFileLines}L` : "—", 8) +
      pad(t.outcome?.checkPage ?? "—", 12) +
      pad(t.outcome?.checkTypes ?? "—", 12) +
      pad(t.outcome?.checkTests ?? "—", 12) +
      pad(t.outcome ? `$${t.outcome.costUsd.toFixed(3)}` : "—", 8) +
      `${t.wallClockSec}s`,
    );
    for (const c of t.failedChecks) console.log(`${" ".repeat(18)}↳ ${c}`);
    if (t.error) console.log(`${" ".repeat(18)}↳ ${t.error}`);
  }

  const n = r.length || 1;
  const count = (p: (t: TaskResult) => boolean) => r.filter(p).length;
  const built = count((t) => t.verdict === "pass" || t.verdict === "soft-fail");
  const withOutcome = r.filter((t) => t.outcome);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // Which tools the model actually reached for, across every build. The point
  // of the harness is that the model verifies its own work; if check_page
  // barely appears here, it isn't doing that, whatever the prompt says.
  const tools: Record<string, number> = {};
  for (const t of withOutcome) {
    for (const [name, c] of Object.entries(t.outcome!.toolCalls)) {
      tools[name] = (tools[name] ?? 0) + c;
    }
  }

  console.log("\n" + "─".repeat(104));
  console.log(`built              ${built}/${r.length}`);
  console.log(`all checks held    ${count((t) => t.verdict === "pass")}/${r.length}` +
    `  (${Math.round((count((t) => t.verdict === "pass") / n) * 100)}%)`);
  console.log(`built but flawed   ${count((t) => t.verdict === "soft-fail")}`);
  console.log(`build failed       ${count((t) => t.verdict === "fail")}`);
  console.log(`harness error      ${count((t) => t.verdict === "error")}`);
  if (withOutcome.length > 0) {
    console.log(`mean rounds        ${mean(withOutcome.map((t) => t.outcome!.rounds)).toFixed(1)}`);
    console.log(`turns exhausted    ${count((t) => t.outcome?.turnsExhausted === true)}`);
    console.log(`check_page pass    ${count((t) => t.outcome?.checkPage === "pass")}` +
      `  fail ${count((t) => t.outcome?.checkPage === "fail")}` +
      `  unavailable ${count((t) => t.outcome?.checkPage === "unavailable")}` +
      `  never called ${count((t) => t.outcome?.checkPage === "never")}`);
    console.log(`check_types pass   ${count((t) => t.outcome?.checkTypes === "pass")}` +
      `  fail ${count((t) => t.outcome?.checkTypes === "fail")}` +
      `  unavailable ${count((t) => t.outcome?.checkTypes === "unavailable")}` +
      `  never called ${count((t) => t.outcome?.checkTypes === "never")}`);
    // "no tests written" is tracked separately from "never called": the first
    // is an agent that looked and had nothing to run, the second is one that
    // never thought to check correctness at all.
    console.log(`run_tests   pass   ${count((t) => t.outcome?.checkTests === "pass")}` +
      `  fail ${count((t) => t.outcome?.checkTests === "fail")}` +
      `  no tests ${count((t) => t.outcome?.checkTests === "none")}` +
      `  unavailable ${count((t) => t.outcome?.checkTests === "unavailable")}` +
      `  never called ${count((t) => t.outcome?.checkTests === "never")}`);
  }
  // Planned vs unplanned is the question the planning pass exists to settle,
  // and it can only be settled by comparing runs — not by looking at one build.
  if (withOutcome.some((t) => t.outcome?.planned !== undefined)) {
    const planned = r.filter((t) => t.outcome?.planned === true);
    console.log(`planned builds     ${planned.length}/${withOutcome.length}` +
      (planned.length > 0
        ? `  mean planned files ${mean(planned.map((t) => t.outcome?.plannedFiles ?? 0)).toFixed(1)}`
        : ""));
  }
  console.log(`one-file builds    ${count((t) => t.fileCount === 1)}`);
  console.log(`mean wall clock    ${mean(r.map((t) => t.wallClockSec)).toFixed(0)}s`);
  const spend = withOutcome.reduce((s, t) => s + t.outcome!.costUsd, 0);
  console.log(`model spend        $${spend.toFixed(3)}  (our own reckoning — a ceiling, see CLAUDE.md)`);
  if (r.length - withOutcome.length > 0) {
    console.log(
      `\n${r.length - withOutcome.length} task(s) recorded no outcome. Either the build failed before ` +
      `it could be written, or that\nsession predates build_outcome, or the build ran the pipeline ` +
      `path, which has no agent gates.`,
    );
  }
  if (Object.keys(tools).length > 0) {
    console.log(
      "\ntool calls         " +
      Object.entries(tools).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join("  "),
    );
  }
}

function diff(a: Run, b: Run): void {
  console.log(`\nold: ${a.startedAt}${a.label ? ` [${a.label}]` : ""}`);
  console.log(`new: ${b.startedAt}${b.label ? ` [${b.label}]` : ""}`);
  const byId = (run: Run) => new Map(run.results.map((t) => [t.taskId, t]));
  const oldMap = byId(a);
  const newMap = byId(b);
  const ids = [...new Set([...oldMap.keys(), ...newMap.keys()])];

  console.log(
    `\n${pad("task", 18)}${pad("old", 10)}${pad("new", 10)}${pad("rounds", 14)}${"cost"}`,
  );
  console.log("─".repeat(72));
  let better = 0;
  let worse = 0;
  const RANK: Record<TaskResult["verdict"], number> = { error: 0, fail: 1, "soft-fail": 2, pass: 3 };
  for (const id of ids) {
    const o = oldMap.get(id);
    const nw = newMap.get(id);
    if (o && nw) {
      if (RANK[nw.verdict] > RANK[o.verdict]) better++;
      if (RANK[nw.verdict] < RANK[o.verdict]) worse++;
    }
    const rounds =
      o?.outcome && nw?.outcome ? `${o.outcome.rounds} → ${nw.outcome.rounds}` : "—";
    const cost =
      o?.outcome && nw?.outcome
        ? `$${o.outcome.costUsd.toFixed(3)} → $${nw.outcome.costUsd.toFixed(3)}`
        : "—";
    console.log(
      pad(id, 18) +
      pad(o ? MARK[o.verdict] : "—", 10) +
      pad(nw ? MARK[nw.verdict] : "—", 10) +
      pad(rounds, 14) +
      cost,
    );
  }
  console.log("─".repeat(72));
  console.log(`${better} task(s) better, ${worse} worse, ${ids.length - better - worse} unchanged`);
  // Four tasks is not a sample. Say so, because the entire reason this harness
  // exists is that one build was being treated as evidence.
  if (ids.length < 8) {
    console.log(
      `\nOn ${ids.length} task(s) a one-task swing is noise. Run the core tier before concluding a change helped.`,
    );
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv[0] === "--diff") {
    const [, oldPath, newPath] = argv;
    if (!oldPath || !newPath) throw new Error("--diff needs two result files: --diff old.json new.json");
    diff(await load(oldPath), await load(newPath));
    return;
  }
  const path = argv[0] ?? (await newestRun());
  summarize(await load(path));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
