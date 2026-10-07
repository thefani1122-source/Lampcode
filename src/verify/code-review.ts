import { AgentDispatcher } from "../agents/dispatcher.js";
import { logger } from "../server/logger.js";
import { buildImportGraph } from "./import-graph.js";
import { enumerateUnits, prePass, type PrePassFinding, type ReviewUnit } from "./review-units.js";
import { quoteIsInCitedFile } from "./corroborate.js";

/**
 * Reviewing a project the way a senior engineer does, without paying for it
 * like a naive one.
 *
 * The four reasons a model skips things on a large review, and what each one
 * is answered with here:
 *
 *  1. **Effort per unit, not capacity.** A big project fits in the context
 *     window; that was never the problem. A model spends roughly fixed effort
 *     per response, so per-file attention falls as the file count rises and the
 *     reply becomes a summary that reads like a review. Answered by reviewing
 *     ONE unit per dispatch, each carrying only that unit and the files that
 *     import it.
 *  2. **No ground truth for coverage.** The reviewer picked its own scope and
 *     reported its own coverage, so "I reviewed it" could not be falsified.
 *     Answered by enumerating units in code and counting what happened to each.
 *     A unit nobody looked at is a RECORDED STATE, not a silence.
 *  3. **No definition of what to look for**, so it defaults to advice about
 *     naming. Answered with a catalogue of the failures this product has
 *     actually measured.
 *  4. **The cost shape.** N files times full context is quadratic and spends
 *     most of its budget on irrelevant code. Answered by the import graph:
 *     cost is linear in units, and each unit's input is small.
 *
 * And every finding must quote the line it is about, checked against the real
 * file. A review's entire output is claims, so it is MORE exposed to a
 * confident hallucination than the completion audit was — and that already
 * happened once, in detail, over working code.
 */

/** How many units get a model pass before the budget stops. The rest are
 *  reported as cheap-only rather than quietly dropped. */
const DEFAULT_MAX_UNITS = 25;

/** Ceiling for the whole review. A review that costs more than the build it is
 *  reviewing will not be run twice. */
const DEFAULT_MAX_COST_USD = 1.0;

/** Per-unit input budget. The point of the graph is that this stays small. */
const UNIT_BYTES = 14_000;
const IMPORTER_BYTES = 2_500;

export type ReviewSeverity = "bug" | "risk" | "smell";

export type ReviewFinding = {
  path: string;
  severity: ReviewSeverity;
  summary: string;
  /** Verbatim from the file, and verified to be there. */
  quote: string;
};

/**
 * What happened to every unit. The whole point of the module: a number here is
 * checkable, where "I reviewed the PR" is not.
 *
 * `unreviewed` is the state that matters. It means a unit got neither a model
 * pass nor even a completed one — a dispatch that failed — and it is kept apart
 * from `cheapOnly`, which did at least get the free checks.
 */
export type ReviewCoverage = {
  total: number;
  deep: number;
  cheapOnly: number;
  unreviewed: number;
};

export type ReviewResult = {
  findings: ReviewFinding[];
  prePass: PrePassFinding[];
  coverage: ReviewCoverage;
  /** Claims thrown away because their quote was not in the file they cited.
   *  Surfaced rather than hidden: a high number means the reviewer is
   *  hallucinating and the review should not be trusted. */
  droppedUncorroborated: number;
  costUsd: number;
};

const VALID_SEVERITY = new Set<ReviewSeverity>(["bug", "risk", "smell"]);

/**
 * Parse one unit's reply, keeping only claims that can be checked.
 *
 * A finding whose quote is not in the file it cites is DROPPED rather than
 * downgraded. That differs from the completion audit on purpose: there, an
 * uncorroborated complaint still told the user "nobody has shown this works",
 * which is useful. Here the unit was reviewed either way, so an unquotable
 * finding adds nothing but noise — and noise is what makes a review get
 * ignored. The count is kept so the noise itself is visible.
 */
export function parseFindings(
  raw: string,
  files: Record<string, string>,
): { findings: ReviewFinding[]; dropped: number } {
  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return { findings: [], dropped: 0 };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { findings: [], dropped: 0 };
  }
  const list = (parsed as Record<string, unknown>)["findings"];
  if (!Array.isArray(list)) return { findings: [], dropped: 0 };

  const findings: ReviewFinding[] = [];
  let dropped = 0;
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const path = typeof e["path"] === "string" ? e["path"].trim().replace(/^\.?\//, "") : "";
    const summary = typeof e["summary"] === "string" ? e["summary"].trim() : "";
    const quote = typeof e["quote"] === "string" ? e["quote"] : "";
    const rawSeverity = typeof e["severity"] === "string" ? e["severity"].trim().toLowerCase() : "";
    if (path === "" || summary === "") continue;

    if (!quoteIsInCitedFile(quote, path, files)) {
      dropped += 1;
      continue;
    }
    // An unknown severity is read as the mildest rather than discarded: the
    // claim is corroborated, so it is real; only its grading is unclear.
    const severity = VALID_SEVERITY.has(rawSeverity as ReviewSeverity)
      ? (rawSeverity as ReviewSeverity)
      : "smell";
    findings.push({ path, severity, summary, quote });
  }
  return { findings, dropped };
}

/** Assemble one unit's prompt input: the file, the files that import it, and
 *  the free findings already known about it. Nothing else — that restraint is
 *  what keeps attention high and cost linear. */
export function formatUnitForReview(
  unit: ReviewUnit,
  files: Record<string, string>,
  unitPrePass: PrePassFinding[],
): string {
  const own = (files[unit.path] ?? "").slice(0, UNIT_BYTES);
  const parts = [
    `FILE UNDER REVIEW: ${unit.path} (${unit.lines} lines)`,
    unit.hasTest ? "It has a sibling test." : "It has NO sibling test.",
    "",
    own,
  ];

  if (unit.importedBy.length > 0) {
    parts.push(
      "",
      `USED BY ${unit.importedBy.length} file(s) — this is the blast radius of anything wrong above.`,
      "Judge the file by how these actually call it, not in isolation.",
    );
    for (const importer of unit.importedBy.slice(0, 6)) {
      parts.push("", `--- ${importer} (excerpt) ---`, (files[importer] ?? "").slice(0, IMPORTER_BYTES));
    }
  } else {
    parts.push("", "No file in this project imports it.");
  }

  if (unitPrePass.length > 0) {
    parts.push(
      "",
      "ALREADY KNOWN about this file, found without a model — do not repeat these, look for what they miss:",
      ...unitPrePass.map((f) => `- [${f.kind}] ${f.detail}`),
    );
  }
  return parts.join("\n");
}

export type ReviewOptions = {
  dispatcher: AgentDispatcher;
  files: Record<string, string>;
  sessionId: string;
  userId: string;
  projectId: string;
  provider: "anthropic" | "modal";
  maxUnits?: number;
  maxCostUsd?: number;
  /** Called with each unit as it starts, so a long review can report progress
   *  instead of going quiet for two minutes. */
  onProgress?: (done: number, total: number, path: string) => void;
};

/**
 * Review a whole project, riskiest unit first, within a budget.
 *
 * Never throws. A unit whose dispatch fails is recorded as `unreviewed` and the
 * review continues — one bad unit must not cost the other twenty-four, and
 * silently treating it as clean is the failure this whole module exists to
 * prevent.
 */
export async function reviewProject(opts: ReviewOptions): Promise<ReviewResult> {
  const graph = buildImportGraph(opts.files);
  const units = enumerateUnits(opts.files, graph);
  const allPrePass = prePass(opts.files, graph);
  const maxUnits = opts.maxUnits ?? DEFAULT_MAX_UNITS;
  const maxCost = opts.maxCostUsd ?? DEFAULT_MAX_COST_USD;

  const findings: ReviewFinding[] = [];
  let dropped = 0;
  let costUsd = 0;
  let deep = 0;
  let unreviewed = 0;

  for (const unit of units) {
    if (deep >= maxUnits || costUsd >= maxCost) break;
    opts.onProgress?.(deep + 1, Math.min(units.length, maxUnits), unit.path);

    const unitPrePass = allPrePass.filter((f) => f.path === unit.path);
    try {
      const result = await opts.dispatcher.dispatch({
        agentType: "review",
        usageCategory: "build",
        provider: opts.provider,
        task: {
          description: formatUnitForReview(unit, opts.files, unitPrePass),
          outputFormat: "json",
        },
        sessionId: opts.sessionId,
        userId: opts.userId,
        projectId: opts.projectId,
        costGuard: { cumulativeUsd: costUsd, maxUsd: maxCost },
      });
      costUsd += result.costUsd;
      const parsed = parseFindings(result.finalContent || result.content, opts.files);
      findings.push(...parsed.findings);
      dropped += parsed.dropped;
      deep += 1;
    } catch (err) {
      unreviewed += 1;
      logger.warn(
        { sessionId: opts.sessionId, path: unit.path, err: err instanceof Error ? err.message : String(err) },
        "[review] unit could not be reviewed",
      );
    }
  }

  // Order the report by how much it matters, not by the order units happened to
  // be visited in.
  const rank: Record<ReviewSeverity, number> = { bug: 0, risk: 1, smell: 2 };
  findings.sort((a, b) => (rank[a.severity] - rank[b.severity]) || a.path.localeCompare(b.path));

  return {
    findings,
    prePass: allPrePass,
    coverage: {
      total: units.length,
      deep,
      cheapOnly: Math.max(0, units.length - deep - unreviewed),
      unreviewed,
    },
    droppedUncorroborated: dropped,
    costUsd,
  };
}

/**
 * The report a person reads.
 *
 * It leads with coverage, deliberately. "No problems found" over a project
 * where four of forty files got a real look is the claim this module was built
 * to stop anyone making, and putting the number first makes that impossible to
 * state by accident.
 */
export function formatReview(result: ReviewResult): string {
  const { coverage: c } = result;
  const lines: string[] = [];

  lines.push(
    `Reviewed ${c.deep} of ${c.total} file(s) in depth` +
    (c.cheapOnly > 0 ? `, ${c.cheapOnly} with the free checks only` : "") +
    (c.unreviewed > 0 ? `, and ${c.unreviewed} NOT reviewed (the pass failed)` : "") +
    ".",
  );
  if (c.cheapOnly > 0) {
    lines.push(
      "The budget ran out before the rest. They are ranked riskiest first, so what was skipped " +
      "is the lower-risk end — but it was skipped, not cleared.",
    );
  }

  const bugs = result.findings.filter((f) => f.severity === "bug");
  const risks = result.findings.filter((f) => f.severity === "risk");
  const smells = result.findings.filter((f) => f.severity === "smell");

  for (const [label, group] of [["BUGS", bugs], ["RISKS", risks], ["SMELLS", smells]] as const) {
    if (group.length === 0) continue;
    lines.push("", `${label} (${group.length})`);
    for (const f of group) lines.push(`- ${f.path}: ${f.summary}`, `    ${f.quote.trim().slice(0, 160)}`);
  }

  if (result.prePass.length > 0) {
    lines.push("", `FOUND WITHOUT A MODEL (${result.prePass.length})`);
    for (const f of result.prePass.slice(0, 20)) lines.push(`- [${f.kind}] ${f.path}: ${f.detail}`);
    if (result.prePass.length > 20) lines.push(`… and ${result.prePass.length - 20} more.`);
  }

  if (result.findings.length === 0 && result.prePass.length === 0) {
    lines.push("", "Nothing found in what was reviewed.");
  }
  if (result.droppedUncorroborated > 0) {
    lines.push(
      "",
      `${result.droppedUncorroborated} claim(s) were discarded because the line they quoted is not ` +
      `in the file they named. A high number here means the review itself is unreliable.`,
    );
  }
  return lines.join("\n");
}
