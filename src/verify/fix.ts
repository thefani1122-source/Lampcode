/**
 * Auto-fix agent — receives a failing security/connection report, reads the
 * offending file, asks an AI agent for a surgical fix, re-runs the check, and
 * repeats up to maxRounds before escalating to the user.
 *
 * All IO and AI are injectable so the module can be tested without DB/network.
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SecurityReport, SecurityCheck } from "./security.js";
import type { ConnectionReport, ConnectionCheck } from "./connection.js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface FixChange {
  file: string;
  lines: [number, number];
  explanation: string;
}

export interface FixResult {
  fixed: boolean;
  rounds: number;
  changes: FixChange[];
  escalated?: string | undefined;
}

/**
 * Given an instruction and the current file content, return the fixed content
 * and a one-line explanation of the change.
 */
export type FixAgent = (
  instruction: string,
  file: string,
  content: string,
) => Promise<{ content: string; explanation: string }>;

export type CheckRerunner = () => Promise<SecurityReport | ConnectionReport>;

// ── Default IO ────────────────────────────────────────────────────────────────

const WORKSPACE_BASE = join(process.cwd(), "workspace");

function defaultReader(projectId: string) {
  return async (path: string): Promise<string | null> => {
    try { return await readFile(join(WORKSPACE_BASE, projectId, path), "utf8"); }
    catch { return null; }
  };
}

function defaultWriter(projectId: string) {
  return async (path: string, content: string): Promise<void> => {
    await writeFile(join(WORKSPACE_BASE, projectId, path), content, "utf8");
  };
}

// ── Default AI fix agent (uses dispatcher) ────────────────────────────────────

async function defaultFixAgent(
  instruction: string,
  file: string,
  content: string,
): Promise<{ content: string; explanation: string }> {
  // Lazy import so the module can be loaded without triggering config.ts
  const { getDispatcher } = await import("../agents/dispatcher.js");
  const dispatcher = getDispatcher();

  const result = await dispatcher.dispatch({
    agentType: "backend",
    task: {
      description: [
        `Fix the following security/connection issue in ${file}:`,
        "",
        instruction,
        "",
        "Rules:",
        "- Make the MINIMAL change that fixes the issue.",
        "- Do NOT refactor surrounding code.",
        "- Return ONLY the complete corrected file, no commentary.",
      ].join("\n"),
      constraints: ["Return the full corrected file content only"],
      outputFormat: "code",
      targetFiles: [file],
    },
    sessionId: crypto.randomUUID(),
  });

  return {
    content: result.content,
    explanation: `${result.modelUsed}: fixed ${instruction.split("\n")[0] ?? instruction}`,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

type AnyCheck = SecurityCheck | ConnectionCheck;

function isFail(c: AnyCheck): boolean { return c.status === "fail"; }

function instructionFor(c: AnyCheck): string {
  if ("message" in c) return `[${c.id}] ${c.message}`;
  return `[${c.id}] ${c.detail}`;
}

function fileFor(c: AnyCheck): string | undefined {
  return "file" in c ? c.file : undefined;
}

/** Group failing checks by file (undefined = no specific file). */
function groupByFile(checks: AnyCheck[]): Map<string | undefined, AnyCheck[]> {
  const map = new Map<string | undefined, AnyCheck[]>();
  for (const c of checks) {
    const f = fileFor(c);
    const bucket = map.get(f) ?? [];
    bucket.push(c);
    map.set(f, bucket);
  }
  return map;
}

function lineRange(c: AnyCheck): [number, number] {
  const line = "line" in c && c.line != null ? c.line : 1;
  return [line, line];
}

// ── autoFix ───────────────────────────────────────────────────────────────────

export async function autoFix(
  initialReport: SecurityReport | ConnectionReport,
  options: {
    projectId: string;
    recheck: CheckRerunner;
    reader?: ((path: string) => Promise<string | null>) | undefined;
    writer?: ((path: string, content: string) => Promise<void>) | undefined;
    agent?: FixAgent | undefined;
    maxRounds?: number | undefined;
  },
): Promise<FixResult> {
  const {
    projectId,
    recheck,
    reader = defaultReader(projectId),
    writer = defaultWriter(projectId),
    agent = defaultFixAgent,
    maxRounds = 3,
  } = options;

  const allChanges: FixChange[] = [];
  let currentReport = initialReport;
  let round = 0;

  while (round < maxRounds) {
    const failing = currentReport.checks.filter(isFail);
    if (failing.length === 0) break;

    round++;

    const byFile = groupByFile(failing);

    for (const [file, checks] of byFile) {
      if (file === undefined) {
        // No file to edit — skip file-less checks (they need manual resolution)
        continue;
      }

      const content = await reader(file);
      if (content === null) continue; // file not found — skip

      const instruction = checks.map(instructionFor).join("\n");

      let fixed: { content: string; explanation: string };
      try {
        fixed = await agent(instruction, file, content);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          fixed: false,
          rounds: round,
          changes: allChanges,
          escalated: `Fix agent failed on ${file}: ${msg}`,
        };
      }

      await writer(file, fixed.content);

      for (const c of checks) {
        allChanges.push({
          file,
          lines: lineRange(c),
          explanation: fixed.explanation,
        });
      }
    }

    // Re-run all checks
    currentReport = await recheck();
  }

  const stillFailing = currentReport.checks.filter(isFail);

  if (stillFailing.length > 0) {
    const ids = stillFailing.map((c) => c.id).join(", ");
    return {
      fixed: false,
      rounds: round,
      changes: allChanges,
      escalated: `${stillFailing.length} check(s) still failing after ${round} round(s): ${ids}`,
    };
  }

  return { fixed: true, rounds: round, changes: allChanges };
}
