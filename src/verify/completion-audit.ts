import { AgentDispatcher } from "../agents/dispatcher.js";
import { config } from "../server/config.js";
import { citations, quoteIsInCitedFile, symbolIsAbsentFromCitedFile } from "./corroborate.js";
import { logger } from "../server/logger.js";
import type {
  AcceptanceCriterion,
  CompletionAudit,
  CriterionStatus,
  CriterionVerdict,
} from "../db/schema.js";

/**
 * An outside check on whether the build did what the user asked.
 *
 * Every gate the agent has — check_page, check_types, run_tests — is a question
 * the agent chose to ask about work it chose to do. That is the whole problem.
 * Finding 4: `editor-undo` rendered, type-checked, and its own tests passed,
 * and it shipped NO persistence at all, over a prompt that said "Notes
 * persist". Nothing failed, because the missing feature produced no code AND
 * no test. Finding 5 is the same shape in the visual domain: MERIDIAN's WebGL
 * scene was painted over by an opaque ancestor and all three gates said yes.
 *
 * The agent is simultaneously the author and the examiner, and the exam is
 * derived from the same understanding that produced the code. A blind spot
 * cannot audit itself. So the signal has to come from somewhere whose CONTENT
 * did not come from that understanding. Here that is two passes, neither of
 * which can write a file:
 *
 *  1. EXTRACT, from the RAW prompt only. Not the plan — a plan is already the
 *     builder's interpretation, so extracting from it would reproduce the
 *     builder's blind spot and then agree with it. Not the expanded prompt
 *     either, for the same reason.
 *  2. AUDIT, whose stated objective is to find what is missing rather than to
 *     finish. It must cite a file for every claim it makes.
 *
 * And the result keeps three states apart, which is the actual point:
 *   proven       — evidence exists, and names where
 *   contradicted — the code does the opposite
 *   unverified   — NOTHING covers this requirement
 *
 * "Done" means `unverified === 0`, not `failures === 0`. Those are different
 * claims and a user hears the second as the first.
 */

/** Cap on extracted criteria. A prompt yielding more than this is being
 *  over-decomposed into assertions too fine to audit one by one. */
const MAX_CRITERIA = 18;

/** Budget for each of the two dispatches. The extractor writes a short JSON
 *  object; the auditor reads code and writes one. Generous, and present only so
 *  a pass that rambles cannot cost more than the build it is checking. */
const EXTRACT_COST_CEILING_USD = 0.15;
const AUDIT_COST_CEILING_USD = 0.35;

/** How much generated code the auditor is shown. Total across all files, and
 *  per file, so one 200 KB bundle cannot crowd out the other twenty files —
 *  breadth matters more than depth here, because the failure being hunted is a
 *  requirement with no implementation ANYWHERE. */
const AUDIT_TOTAL_BYTES = 90_000;
const AUDIT_PER_FILE_BYTES = 6_000;

/** The gates whose verdicts may stand as evidence on their own. A citation
 *  outside this set and outside the generated file list is not checkable, and
 *  an uncheckable citation is treated as no citation. */
const GATE_EVIDENCE = new Set(["check_page", "check_types", "run_tests"]);

const VALID_KINDS = new Set(["visual", "behaviour", "data", "logic"]);


/**
 * Pull the criteria out of whatever the extractor returned.
 *
 * Exported for its own cases. Same reality as parsePlan: models wrap JSON in
 * prose and in ```json fences however plainly the prompt says not to, and a
 * silent parse failure here would turn the audit off with nothing in the log
 * saying why.
 */
export function parseCriteria(
  raw: string,
  /** Optional out-param: receives how many well-formed criteria the
   *  MAX_CRITERIA cap discarded. Optional so every existing caller and case
   *  keeps its signature; the extractor below passes one. */
  stats?: { dropped: number },
): AcceptanceCriterion[] {
  const text = raw.trim();
  if (text.length === 0) return [];

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null) return [];

  const rawList = (parsed as Record<string, unknown>)["criteria"];
  if (!Array.isArray(rawList)) return [];

  const out: AcceptanceCriterion[] = [];
  const seen = new Set<string>();
  for (const entry of rawList) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const criterionText = typeof e["text"] === "string" ? e["text"].trim() : "";
    if (criterionText === "") continue;
    // Renumber rather than trusting the model's ids. A duplicated or skipped id
    // would make the verdict mapping below silently drop a criterion, and the
    // whole value of this module is that nothing goes missing quietly.
    const id = `R${out.length + 1}`;
    const key = criterionText.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const rawKind = typeof e["kind"] === "string" ? e["kind"].trim().toLowerCase() : "";
    const kind = VALID_KINDS.has(rawKind) ? (rawKind as AcceptanceCriterion["kind"]) : "behaviour";
    out.push({ id, text: criterionText, kind });
    if (out.length >= MAX_CRITERIA) {
      // Count what the cap throws away rather than returning quietly. A
      // criterion dropped here is never audited, so it can never be anything
      // but silently absent from the tallies — and `unverified === 0` then
      // reads as "everything the user asked for is covered" over a prompt
      // whose later requirements were never looked at. ROTA extracted exactly
      // 18, i.e. it sat on the cap, which is how this surfaced.
      if (stats) {
        for (const rest of rawList.slice(rawList.indexOf(entry) + 1)) {
          if (typeof rest !== "object" || rest === null) continue;
          const t = (rest as Record<string, unknown>)["text"];
          if (typeof t !== "string" || t.trim() === "") continue;
          if (seen.has(t.trim().toLowerCase())) continue;
          stats.dropped += 1;
        }
      }
      break;
    }
  }
  return out;
}

/**
 * Turn the auditor's reply into one verdict per criterion — FAIL CLOSED.
 *
 * This function is the safety property of the whole module, so it is written to
 * be read: `unverified` is the default, and the auditor can only move a
 * criterion OFF it by naming evidence that can be checked. Specifically, a
 * criterion ends up `unverified` when
 *   - the auditor did not mention it at all,
 *   - it gave a status outside the three,
 *   - it claimed `proven` with no citation, or
 *   - it claimed `proven` citing a file that is not in the generated set, or a
 *     gate name that does not exist.
 *
 * The last case is the one worth having: a model that invents
 * `src/lib/persistence.ts` to justify a verdict cannot thereby mark a missing
 * requirement as done. `contradicted` needs no citation — it is a complaint,
 * and downgrading a complaint to "unverified" for want of a file path would
 * hide the strongest finding the pass can produce.
 */
export function parseVerdicts(
  raw: string,
  criteria: AcceptanceCriterion[],
  /** Either the paths alone, or path → content. Content is what lets a
   *  `contradicted` claim be corroborated; without it, every such claim is
   *  unquotable and therefore downgraded, which is the safe direction. */
  project: string[] | Record<string, string>,
): CriterionVerdict[] {
  const fileContents: Record<string, string> = Array.isArray(project)
    ? Object.fromEntries(project.map((p) => [p.replace(/^\.?\//, ""), ""]))
    : Object.fromEntries(Object.entries(project).map(([p, c]) => [p.replace(/^\.?\//, ""), c]));
  const known = new Set(Object.keys(fileContents));
  const byId = new Map<
    string,
    { status: string; evidence: string; note: string; quote: string; missing: string }
  >();

  const text = raw.trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
      const list = parsed["verdicts"];
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry !== "object" || entry === null) continue;
          const e = entry as Record<string, unknown>;
          const id = typeof e["id"] === "string" ? e["id"].trim().toUpperCase() : "";
          if (id === "") continue;
          byId.set(id, {
            status: typeof e["status"] === "string" ? e["status"].trim().toLowerCase() : "",
            evidence: typeof e["evidence"] === "string" ? e["evidence"].trim() : "",
            note: typeof e["note"] === "string" ? e["note"].trim() : "",
            quote: typeof e["quote"] === "string" ? e["quote"] : "",
            missing: typeof e["missing"] === "string" ? e["missing"] : "",
          });
        }
      }
    } catch {
      // Leave byId empty: every criterion then falls through to unverified
      // below, which is the correct reading of an unparseable audit.
    }
  }

  return criteria.map((c) => {
    const found = byId.get(c.id);
    if (!found) {
      return {
        id: c.id,
        status: "unverified" as CriterionStatus,
        evidence: "",
        note: "the audit did not cover this",
      };
    }

    if (found.status === "contradicted") {
      // A complaint has to be corroborated, or it is just an opinion with a
      // confident voice. Measured 2026-10-07 on the `editor-undo` build: the
      // auditor reported, in precise detail, that NotesView did a named import
      // of a component that "only has export default", that the prop names
      // disagreed, and that markdownToHtml was never called. All three were
      // false — the file has a named export, the prop matches, and the function
      // is called inside it. Nothing in the pipeline could tell that verdict
      // apart from a real one, and it would have been shown to the user as
      // "NOT DONE" over working code.
      //
      // So contradicted now needs a verbatim quote from a cited file, and the
      // quote is looked up in the real content. The auditor cannot invent an
      // `export default` that is not there. This is the same move that makes
      // `proven` trustworthy — the model's claim is checked against something
      // it does not control — applied to the other direction.
      // Either a line that IS there, or a symbol that is NOT. The second half
      // was added after the ROTA build, where every true finding was an absence
      // and the quote rule threw four of them away.
      if (
        quoteIsInCitedFile(found.quote, found.evidence, fileContents) ||
        symbolIsAbsentFromCitedFile(found.missing, found.evidence, fileContents)
      ) {
        return {
          id: c.id,
          status: "contradicted" as CriterionStatus,
          evidence: found.evidence,
          note: found.note || "the code does the opposite of what was asked",
        };
      }
      // Downgraded, not discarded: something still made the auditor stop here,
      // and the user should see that nobody has shown this works. Saying "not
      // done" on an unquotable claim is what must not happen.
      return {
        id: c.id,
        status: "unverified" as CriterionStatus,
        evidence: found.evidence,
        note: found.note
          ? `reported as broken, but the claim could not be confirmed against the code — ${found.note}`
          : "reported as broken, but the claim could not be confirmed against the code",
      };
    }

    if (found.status === "proven") {
      // A citation that cannot be checked is not a citation. One cited file
      // that really exists is enough; the auditor is allowed to list several.
      const cited = citations(found.evidence);
      const checkable = cited.some((s) => known.has(s) || GATE_EVIDENCE.has(s));
      if (checkable) {
        return {
          id: c.id,
          status: "proven" as CriterionStatus,
          evidence: found.evidence,
          note: found.note,
        };
      }
      return {
        id: c.id,
        status: "unverified" as CriterionStatus,
        evidence: "",
        note: found.evidence
          ? `claimed proven citing "${found.evidence}", which is not in this project`
          : "claimed proven without citing anything",
      };
    }

    return {
      id: c.id,
      status: "unverified" as CriterionStatus,
      evidence: "",
      note: found.note || "no evidence found for this",
    };
  });
}

/** Count the three states. Separate from parseVerdicts so a caller holding
 *  stored verdicts can recount them without re-parsing anything. */
export function tallyVerdicts(verdicts: CriterionVerdict[]): {
  proven: number;
  contradicted: number;
  unverified: number;
} {
  let proven = 0;
  let contradicted = 0;
  let unverified = 0;
  for (const v of verdicts) {
    if (v.status === "proven") proven += 1;
    else if (v.status === "contradicted") contradicted += 1;
    else unverified += 1;
  }
  return { proven, contradicted, unverified };
}

/**
 * The lines the user actually reads. Deliberately shaped so that a build with
 * something unverified cannot be summarised as finished.
 *
 * Exported and pure, so what the user is told is covered by cases rather than
 * being assembled inline at an emit site where nobody can check it.
 */
export function formatAuditForUser(audit: CompletionAudit): string[] {
  const { proven, contradicted, unverified } = audit;
  const total = audit.criteria.length;
  if (total === 0) return [];

  const lines: string[] = [];
  if (contradicted === 0 && unverified === 0) {
    lines.push(
      total === 1
        ? "I checked the one thing you asked for, and it's there."
        : `I checked all ${total} things you asked for, and they're all there.`,
    );
    return lines;
  }

  const byId = new Map(audit.criteria.map((c) => [c.id, c.text]));
  const pick = (status: CriterionStatus) =>
    audit.verdicts
      .filter((v) => v.status === status)
      .map((v) => byId.get(v.id))
      .filter((t): t is string => typeof t === "string" && t.length > 0);

  const missing = pick("contradicted");
  const unsure = pick("unverified");

  lines.push(`I checked what you asked for: ${proven} of ${total} are there.`);

  // The criterion TEXT is the user's own words, pulled from their prompt by the
  // acceptance pass. That is the only part of a verdict written in their
  // language, so it is the only part shown. `note` and `evidence` are the
  // auditor talking to a maintainer — "the store has a deleteHabit action but no
  // UI component invokes it" is true, useful to us, and not what somebody who
  // asked for a habit tracker is here to read. They are kept in
  // build_outcome.completionAudit for the eval and for triage.
  if (missing.length > 0) {
    lines.push(missing.length === 1 ? "This one looks missing:" : "These look missing:");
    for (const t of missing) lines.push(`  • ${t}`);
  }
  if (unsure.length > 0) {
    lines.push(
      unsure.length === 1
        ? "And this one I couldn't confirm either way:"
        : "And these I couldn't confirm either way:",
    );
    for (const t of unsure) lines.push(`  • ${t}`);
  }

  // Said plainly because the two states are genuinely different and users hear
  // the second as the first. The hedging is also honest about the check itself:
  // it reads the delivered code, so it is good at "was this written" and weaker
  // at "does it actually run" — see HISTORY.md, Finding 24.
  lines.push(
    unsure.length > 0 && missing.length > 0
      ? "Couldn't confirm doesn't mean broken — just that I found no proof either way. Ask me to fix anything above."
      : unsure.length > 0
        ? "That doesn't mean it's broken — only that I found no proof either way. Ask me to check it properly."
        : "Just tell me and I'll add it.",
  );
  return lines;
}

/** Assemble the code excerpt the auditor reads. Smaller files first, so a
 *  budget that runs out costs depth on the largest file rather than dropping
 *  whole small ones — a missing requirement is usually a missing small file. */
export function formatFilesForAudit(files: Record<string, string>): string {
  const entries = Object.entries(files).sort((a, b) => a[1].length - b[1].length);
  const parts: string[] = [];
  let budget = AUDIT_TOTAL_BYTES;
  for (const [path, content] of entries) {
    if (budget <= 0) {
      parts.push(`--- ${path} (not shown, budget exhausted) ---`);
      continue;
    }
    const slice = content.slice(0, Math.min(AUDIT_PER_FILE_BYTES, budget));
    budget -= slice.length;
    const truncated = slice.length < content.length ? "\n… (truncated)" : "";
    parts.push(`--- ${path} ---\n${slice}${truncated}`);
  }
  return parts.join("\n\n");
}

/**
 * The audit you get when the audit could not run: every criterion unverified,
 * with the reason attached.
 *
 * Exported because the honest answer to "the budget ran out" or "the dispatch
 * failed" is the same as the honest answer to "nothing covers this" — nobody
 * has shown it works. Returning a clean sheet in those cases would make a
 * broken audit indistinguishable from a verified build, which is the exact
 * confusion this module exists to remove.
 */
export function unverifiedAudit(
  criteria: AcceptanceCriterion[],
  note: string,
  costUsd = 0,
): CompletionAudit {
  const verdicts: CriterionVerdict[] = criteria.map((c) => ({
    id: c.id,
    status: "unverified" as CriterionStatus,
    evidence: "",
    note,
  }));
  return { criteria, verdicts, ...tallyVerdicts(verdicts), costUsd };
}

export type ExtractResult = {
  criteria: AcceptanceCriterion[];
  costUsd: number;
  reason?: string;
  /** Well-formed criteria the MAX_CRITERIA cap discarded. Non-zero means the
   *  audit's coverage is partial and its tallies understate what was asked. */
  dropped?: number;
};

/**
 * Pass 1: the user's own words, turned into checkable claims by something that
 * cannot write code. Never throws — a build must not fail because its audit
 * did, so every failure path returns no criteria and the build proceeds.
 */
export async function extractCriteria(opts: {
  dispatcher: AgentDispatcher;
  /** The RAW prompt, before expansion. Passing the expanded one would audit the
   *  build against our own additions rather than against what the user said. */
  prompt: string;
  sessionId: string;
  userId: string;
  projectId: string;
  provider: "anthropic" | "modal";
}): Promise<ExtractResult> {
  try {
    const result = await opts.dispatcher.dispatch({
      agentType: "acceptance",
      usageCategory: "build",
      provider: opts.provider,
      task: { description: opts.prompt, outputFormat: "json" },
      sessionId: opts.sessionId,
      userId: opts.userId,
      projectId: opts.projectId,
      costGuard: { cumulativeUsd: 0, maxUsd: EXTRACT_COST_CEILING_USD },
    });

    const stats = { dropped: 0 };
    const criteria = parseCriteria(result.finalContent || result.content, stats);
    if (stats.dropped > 0) {
      logger.warn(
        { sessionId: opts.sessionId, kept: criteria.length, dropped: stats.dropped },
        "[audit] criteria cap hit — these requirements will NOT be audited, so unverified=0 does not mean full coverage",
      );
    }
    if (criteria.length === 0) {
      logger.warn(
        { sessionId: opts.sessionId, head: (result.finalContent || result.content).slice(0, 300) },
        "[audit] no criteria extracted — this build will not be audited",
      );
      return { criteria: [], costUsd: result.costUsd, reason: "no criteria parsed" };
    }
    return { criteria, costUsd: result.costUsd, dropped: stats.dropped };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId: opts.sessionId, err: reason }, "[audit] extraction failed");
    return { criteria: [], costUsd: 0, reason };
  }
}

/**
 * Pass 2: compare the criteria against the code that was actually produced.
 *
 * Never throws. On any failure the criteria are returned with every verdict
 * `unverified`, which is the honest answer: the audit could not run, so nothing
 * is proven. Returning "all good" there would make a broken audit indistinguish-
 * able from a clean build, which is the precise mistake this module exists to
 * stop.
 */
export async function auditCompletion(opts: {
  dispatcher: AgentDispatcher;
  criteria: AcceptanceCriterion[];
  files: Record<string, string>;
  gates: { checkPage: string; checkTypes: string; checkTests: string };
  sessionId: string;
  userId: string;
  projectId: string;
  provider: "anthropic" | "modal";
}): Promise<CompletionAudit> {
  const { criteria } = opts;
  const paths = Object.keys(opts.files);

  if (criteria.length === 0) {
    return { criteria: [], verdicts: [], proven: 0, contradicted: 0, unverified: 0, costUsd: 0 };
  }

  const description = [
    "REQUIREMENTS TO CHECK",
    ...criteria.map((c) => `${c.id} [${c.kind}] ${c.text}`),
    "",
    "WHAT THE BUILD'S OWN GATES REPORTED",
    `check_page: ${opts.gates.checkPage}`,
    `check_types: ${opts.gates.checkTypes}`,
    `run_tests: ${opts.gates.checkTests}`,
    "",
    `FILES IN THIS PROJECT (${paths.length})`,
    paths.join("\n"),
    "",
    "THE CODE",
    formatFilesForAudit(opts.files),
  ].join("\n");

  try {
    const result = await opts.dispatcher.dispatch({
      agentType: "audit",
      usageCategory: "build",
      provider: opts.provider,
      task: { description, outputFormat: "json" },
      sessionId: opts.sessionId,
      userId: opts.userId,
      projectId: opts.projectId,
      costGuard: { cumulativeUsd: 0, maxUsd: AUDIT_COST_CEILING_USD },
    });

    // Contents, not just paths: a `contradicted` verdict is only accepted when
    // its quote is found in the file it cites, and that lookup needs the code.
    const verdicts = parseVerdicts(result.finalContent || result.content, criteria, opts.files);
    return { criteria, verdicts, ...tallyVerdicts(verdicts), costUsd: result.costUsd };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logger.warn({ sessionId: opts.sessionId, err: reason }, "[audit] audit dispatch failed");
    return unverifiedAudit(criteria, "the audit could not run");
  }
}

/** Whether this build gets audited at all. A kill switch, and nothing else:
 *  unlike planning there is no size threshold, because a small build can miss a
 *  requirement just as easily as a large one — `editor-undo` was six files. */
export function shouldAudit(): boolean {
  return config.COMPLETION_AUDIT_ENABLED;
}
