import type { BuildOutcome } from "../db/schema.js";

type Gate = "page" | "types" | "tests";
type NonTestGateStatus = Exclude<BuildOutcome["checkPage"], "never">;
type TestGateStatus = Exclude<BuildOutcome["checkTests"], "never">;

type TerminalEvidence = {
  turnsExhausted: boolean;
  filesWritten: number;
  costUsd: number;
  durationMs: number;
  churn?: BuildOutcome["churn"];
};

/**
 * The event contract for C1/C2. The terminal event carries the facts that are
 * only known after the build has finished (or failed); they must never be
 * guessed from a missing event.
 */
export type BuildEvent =
  | { type: "turn/start"; round: number }
  | { type: "plan/ready"; files: string[] }
  | { type: "tool/call"; name: string; round: number }
  | { type: "tool/result"; name: string; ok: boolean; round: number }
  | { type: "files/written"; paths: string[]; added: number; removed: number }
  | { type: "verification/result"; gate: "page" | "types"; status: NonTestGateStatus }
  | { type: "verification/result"; gate: "tests"; status: TestGateStatus }
  | { type: "repair/applied"; kind: string }
  | { type: "turn/end"; round: number; costUsd: number }
  | ({ type: "build/end" } & TerminalEvidence)
  | ({ type: "build/failed"; reason: string } & TerminalEvidence);

const EMPTY_OUTCOME: BuildOutcome = {
  rounds: 0,
  turnsExhausted: false,
  filesWritten: 0,
  toolCalls: {},
  checkPage: "never",
  checkTypes: "never",
  checkTests: "never",
  planned: false,
  plannedFiles: 0,
  costUsd: 0,
  durationMs: 0,
};

/**
 * Fold an ordered build event stream into the existing persisted outcome
 * shape. An empty stream returns the identity value above; it represents no
 * evidence, not a claim about a real build. Real build streams must end in a
 * build/end or build/failed event to supply the final-only required fields.
 */
export function projectOutcome(events: BuildEvent[]): BuildOutcome {
  if (events.length === 0) return { ...EMPTY_OUTCOME, toolCalls: {} };

  const rounds = new Set<number>();
  const toolCalls: Record<string, number> = {};
  const checks: {
    page: BuildOutcome["checkPage"];
    types: BuildOutcome["checkTypes"];
    tests: BuildOutcome["checkTests"];
  } = {
    page: "never",
    types: "never",
    tests: "never",
  };
  const stale: Record<Gate, number> = { page: 0, types: 0, tests: 0 };
  let planned = false;
  let plannedFiles = 0;
  let terminal: TerminalEvidence | undefined;

  for (const event of events) {
    switch (event.type) {
      case "turn/start":
        rounds.add(event.round);
        break;
      case "tool/call":
        toolCalls[event.name] = (toolCalls[event.name] ?? 0) + 1;
        break;
      case "plan/ready":
        planned = true;
        plannedFiles = event.files.length;
        break;
      case "verification/result":
        if (event.gate === "page") checks.page = event.status;
        else if (event.gate === "types") checks.types = event.status;
        else checks.tests = event.status;
        stale[event.gate] = 0;
        break;
      case "files/written":
        if (event.paths.length > 0) {
          for (const gate of ["page", "types", "tests"] as const) {
            if (checks[gate] !== "never") stale[gate]++;
          }
        }
        break;
      case "build/end":
      case "build/failed":
        terminal = event;
        break;
      case "tool/result":
      case "repair/applied":
      case "turn/end":
        break;
    }
  }

  // The C1/C2 contract requires one terminal event. Without it, required
  // outcome facts such as cost and duration are unknowable and a projection
  // would manufacture values that look measured.
  if (!terminal) throw new Error("Build event stream is missing terminal evidence");

  return {
    rounds: rounds.size,
    turnsExhausted: terminal.turnsExhausted,
    filesWritten: terminal.filesWritten,
    toolCalls,
    checkPage: checks.page,
    checkTypes: checks.types,
    checkTests: checks.tests,
    staleCheckPage: stale.page,
    staleCheckTypes: stale.types,
    staleCheckTests: stale.tests,
    planned,
    plannedFiles,
    ...(terminal.churn === undefined ? {} : { churn: terminal.churn }),
    costUsd: terminal.costUsd,
    durationMs: terminal.durationMs,
  };
}
