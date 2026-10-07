/**
 * Scoring: turns a finished build's files and its recorded outcome into a list
 * of findings. Separate from run.ts so it can be exercised without spending a
 * build — see score.test.ts.
 */

import type { EvalTask } from "./tasks.js";

/** Mirrors BuildOutcome in src/db/schema.ts. Duplicated rather than imported
 *  because this script talks to the API over HTTP and must not pull the server's
 *  module graph (config, db, redis) in just for a type. */
export type BuildOutcome = {
  rounds: number;
  turnsExhausted: boolean;
  filesWritten: number;
  toolCalls: Record<string, number>;
  checkPage: "pass" | "fail" | "unavailable" | "never";
  checkTypes: "pass" | "fail" | "unavailable" | "never";
  /** Optional, unlike in schema.ts: rows written before run_tests existed have
   *  no such key, and the harness has to read those runs too. */
  checkTests?: "pass" | "fail" | "unavailable" | "none" | "never";
  /** Also optional: rows written before the planning pass existed have neither. */
  planned?: boolean;
  plannedFiles?: number;
  /** The outside check's headline, absent on rows from before it existed. A
   *  requirement nothing covers is the failure the agent's own gates cannot
   *  see, so the eval has to read this to know whether the audit is doing
   *  anything — the alternative is judging it by argument again. */
  unverifiedCount?: number;
  costUsd: number;
  durationMs: number;
};

export type FileEntry = { path: string; content: string; lines: number };

export function collectFiles(groups: Record<string, FileEntry[]>): FileEntry[] {
  return Object.values(groups).flat();
}

/** Files the template owns and the model is told never to write. Seeing one in
 *  the output is a real failure (it breaks the Tailwind tokens), but they are
 *  also not the model's own code, so they don't count toward minFiles. */
export const TEMPLATE_OWNED = new Set([
  "src/styles.css",
  "vite.config.ts",
  "tsconfig.json",
  "index.html",
  "package.json",
  "package-lock.json",
]);

export function scoreChecks(task: EvalTask, files: FileEntry[], outcome: BuildOutcome | null): string[] {
  const failed: string[] = [];
  const authored = files.filter((f) => !TEMPLATE_OWNED.has(f.path.replace(/^\.\//, "")));
  const haystack = authored.map((f) => f.content).join("\n");

  for (const needle of task.mustContain ?? []) {
    const hit = typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack);
    if (!hit) failed.push(`missing: ${String(needle)}`);
  }
  for (const needle of task.mustNotContain ?? []) {
    const hit = typeof needle === "string" ? haystack.includes(needle) : needle.test(haystack);
    if (hit) failed.push(`present but shouldn't be: ${String(needle)}`);
  }
  for (const f of files) {
    if (TEMPLATE_OWNED.has(f.path.replace(/^\.\//, ""))) {
      failed.push(`overwrote template-owned file: ${f.path}`);
    }
  }
  if (task.minFiles !== undefined && authored.length < task.minFiles) {
    failed.push(`only ${authored.length} file(s), expected at least ${task.minFiles}`);
  }
  if (task.minTestFiles !== undefined) {
    const testFiles = authored.filter((f) => /\.(test|spec)\.tsx?$/.test(f.path));
    if (testFiles.length < task.minTestFiles) {
      failed.push(`${testFiles.length} test file(s), expected at least ${task.minTestFiles}`);
    }
  }
  if (task.maxLinesPerFile !== undefined) {
    for (const f of authored) {
      if (f.lines > task.maxLinesPerFile) {
        failed.push(`${f.path} is ${f.lines} lines, over the ${task.maxLinesPerFile} cap`);
      }
    }
  }
  // Gate signals. "never" is only a finding on the agentic path — the pipeline
  // has no agent gates to call — and the harness cannot tell which path ran
  // from outside, so an absent outcome is reported, not scored.
  if (outcome) {
    if (outcome.checkPage === "fail") failed.push("the agent's own check_page ended on a failure");
    if (outcome.checkTypes === "fail") failed.push("the agent's own check_types ended on a failure");
    if (outcome.checkPage === "unavailable") failed.push("check_page could not run (sandbox browser)");
    if (outcome.checkTests === "fail") failed.push("the agent's own run_tests ended on a failure");
    if (outcome.checkTests === "unavailable") failed.push("run_tests could not run (vitest in the sandbox)");
    if (outcome.turnsExhausted) failed.push("ran out of turns while still working");
    // Reported as its own finding rather than folded into the gate failures
    // above: those say a check ran and complained, this says NOTHING in the
    // build covers something the user asked for. Collapsing the two would lose
    // the only signal that separates "checked and fine" from "never checked".
    if (outcome.unverifiedCount !== undefined && outcome.unverifiedCount > 0) {
      failed.push(
        `${outcome.unverifiedCount} requirement(s) from the prompt are unverified — nothing in the build proves them`,
      );
    }
  }
  return failed;
}
