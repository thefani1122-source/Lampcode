import type { AcceptanceCriterion, CompletionAudit, CriterionVerdict } from "../db/schema.js";

/**
 * Act on what the audit found, instead of only reporting it.
 *
 * The completion audit is the strongest thing this product has: it turns the
 * person's own words into checkable requirements and marks each one `proven`,
 * `contradicted` or **`unverified`** — and `unverified` is not a soft pass, it
 * means nothing in the build covers what they asked for. On one real build it
 * correctly reported that four views the user asked for were never wired in
 * while all three gates passed.
 *
 * And then nothing happened. The 2026-10-19 follow-up build ended **0 proven,
 * 2 unverified** and the build completed anyway. Seeing a gap and shipping it
 * is better than not seeing it, but only barely: the person still receives an
 * app that does not do what they asked, now with a note.
 *
 * So this is the other half. The rules below are deliberately strict, because
 * a repair that fires too eagerly is worse than none — it spends the user's
 * money, invalidates every gate above it, and can break code that worked.
 */

/** More than this and the build is not nearly finished; one dispatch will not
 *  rescue it, and trying costs money to produce a worse mess. Report instead. */
export const MAX_REPAIRABLE = 5;

export type AuditRepairPlan = {
  /** The requirements to fix, paired with what the audit said about them. */
  items: Array<{ criterion: AcceptanceCriterion; verdict: CriterionVerdict }>;
};

/**
 * What is worth one repair attempt, or null for "leave it alone and say so".
 *
 * `proven` is skipped — there is nothing to do. Both other states are in:
 * `unverified` means the requirement is missing, `contradicted` means the code
 * does the opposite of what was asked, and a person who asked for either and
 * got neither cannot tell the difference.
 */
export function planAuditRepair(audit: CompletionAudit | null): AuditRepairPlan | null {
  if (!audit || audit.criteria.length === 0) return null;

  const byId = new Map(audit.criteria.map((c) => [c.id, c]));
  const items: AuditRepairPlan["items"] = [];
  for (const verdict of audit.verdicts) {
    if (verdict.status === "proven") continue;
    const criterion = byId.get(verdict.id);
    // A verdict about a requirement that is not in the list is not actionable
    // — and is a parser bug worth not papering over.
    if (!criterion) continue;
    items.push({ criterion, verdict });
  }

  if (items.length === 0) return null;
  if (items.length > MAX_REPAIRABLE) return null;
  return { items };
}

/** Why no repair was attempted, in words the log and the user can both take. */
export function whyNoRepair(audit: CompletionAudit | null): string {
  if (!audit || audit.criteria.length === 0) return "no requirements were extracted";
  const unmet = audit.verdicts.filter((v) => v.status !== "proven").length;
  if (unmet === 0) return "every requirement was proven";
  if (unmet > MAX_REPAIRABLE) {
    return `${unmet} requirements are unmet — too many for one repair, so the build reports them instead of guessing`;
  }
  return "nothing to repair";
}

/**
 * The instruction for the repair dispatch.
 *
 * Written to be acted on rather than discussed: the requirement in the user's
 * own words, what the audit said was wrong with it, and one hard rule about
 * faking. That last paragraph is not boilerplate — the fake-persistence
 * detector exists because a model asked to make a failing feature work reached
 * for a localStorage fallback and a demo mode, which makes a broken feature
 * LOOK fixed and is the single worst outcome available here.
 */
export function auditRepairInstruction(plan: AuditRepairPlan): string {
  const lines = plan.items.map(({ criterion, verdict }) => {
    const said = verdict.note.trim() || (verdict.status === "contradicted"
      ? "the code does the opposite of this"
      : "nothing in the build covers this");
    return `- ${criterion.id} (${criterion.kind}): ${criterion.text}\n  What the check found: ${said}`;
  });

  return [
    "The build is finished and one thing is wrong with it: some of what the user asked for is",
    "not actually there. Each line below is a requirement taken from THEIR OWN WORDS, and what",
    "the check found when it looked for it.",
    "",
    ...lines,
    "",
    "Fix these, and only these. Do not refactor anything else, do not rename anything, and do",
    "not change a file that is not needed for one of the lines above — every other check in this",
    "build has already run, and anything you touch beyond these has to be re-checked.",
    "",
    "NEVER FAKE IT. Do not add demo data, a mock, an in-memory store or a localStorage fallback",
    "to make one of these look satisfied. A requirement that LOOKS met and saves nothing is worse",
    "than one that is honestly missing, because nobody finds out until the user's data is gone.",
    "If you genuinely cannot do one of them, leave it alone and say which, in one line, at the end.",
    "",
    "Return the COMPLETE contents of every file you change, each in its own fence:",
    "```filename:src/components/Thing.tsx",
    "…the whole file…",
    "```",
    "New files are allowed when a requirement needs one.",
  ].join("\n");
}

/** Characters of file content one repair dispatch may read. Generous — a
 *  repair that cannot see the file it must rewrite produces a plausible
 *  invention instead of a fix. */
const REPAIR_CONTEXT_BUDGET = 180_000;

/**
 * The files, for something that has to return COMPLETE files.
 *
 * Deliberately not `formatFilesForAudit`. That one truncates a long file to
 * fit its budget, which is right for reading and catastrophic here: a model
 * shown two thirds of a file and asked to return the whole of it returns two
 * thirds, and the rest is silently deleted. So a file is included whole or not
 * at all, and the ones left out are NAMED — a model that knows a file exists
 * and was not shown asks for it or leaves it alone, where one that was never
 * told invents it.
 */
export function formatFilesForRepair(files: Record<string, string>): string {
  const entries = Object.entries(files).sort((a, b) => a[1].length - b[1].length);
  const shown: string[] = [];
  const omitted: string[] = [];
  let budget = REPAIR_CONTEXT_BUDGET;
  for (const [path, content] of entries) {
    if (content.length > budget) { omitted.push(path); continue; }
    budget -= content.length;
    shown.push(`\`\`\`filename:${path}\n${content}\n\`\`\``);
  }
  const tail = omitted.length > 0
    ? `\n\nAlso in this project, not shown here (too large to include): ${omitted.join(", ")}. ` +
      "Do not rewrite one of these from memory — if a fix needs one, change something else instead."
    : "";
  return shown.join("\n\n") + tail;
}

export type RepairOutcome = "kept" | "reverted-types" | "reverted-worse" | "no-files" | "not-attempted";

/**
 * Whether to keep what the repair wrote.
 *
 * Two ways to refuse it, and both exist because the alternative is shipping
 * something worse than what was there:
 *
 *  - TYPES. If the project compiled before and does not now, the repair broke
 *    the build. No judgement needed and no argument possible.
 *  - PROVEN WENT DOWN. A re-audit is a model's reading and it is noisy, so
 *    "unverified did not improve" is NOT grounds to revert — that is a repair
 *    that did not work, which is disappointing rather than harmful. But a
 *    requirement that WAS proven and no longer is means the repair broke
 *    something that worked, and that is a different thing.
 */
export function judgeRepair(opts: {
  typesWereGreen: boolean;
  typesAreGreen: boolean | null;
  provenBefore: number;
  provenAfter: number;
}): RepairOutcome {
  if (opts.typesWereGreen && opts.typesAreGreen === false) return "reverted-types";
  if (opts.provenAfter < opts.provenBefore) return "reverted-worse";
  return "kept";
}

/** One line for the user, in their words rather than the audit's. */
export function describeRepair(outcome: RepairOutcome, fixed: number, remaining: number): string {
  switch (outcome) {
    case "kept":
      return remaining === 0
        ? "I went back and finished the parts that were missing — everything you asked for is in now."
        : fixed > 0
          ? `I went back and finished ${fixed} of the missing parts. ${remaining} still ${remaining === 1 ? "is" : "are"} not there, and I have said which below.`
          : "I tried to finish the missing parts and it did not take. They are listed below as they were.";
    case "reverted-types":
      return "I tried to finish the missing parts, but the fix stopped the project compiling, so I put it back. They are listed below.";
    case "reverted-worse":
      return "I tried to finish the missing parts, but the fix broke something that was working, so I put it back. They are listed below.";
    case "no-files":
      return "I tried to finish the missing parts and the attempt produced nothing usable. They are listed below.";
    case "not-attempted":
      return "";
  }
}

/**
 * The one line for the closing status block, which is the durable record the
 * user can scroll back to — `describeRepair` is for the live stream, where the
 * audit's own lines follow it, and says "listed below" accordingly.
 *
 * Says what was attempted even when nothing was fixed. A repair that spent
 * money and achieved nothing is a fact the user is entitled to, and silence
 * there would read exactly like a build that needed no repair at all.
 */
export function repairStatusLine(repair: {
  outcome: RepairOutcome;
  attempted: number;
  fixed: number;
  remaining: number;
}): string {
  const found = `${repair.attempted} part(s) of what you asked for were missing after the checks`;
  switch (repair.outcome) {
    case "kept":
      if (repair.remaining === 0) return `• ${found} — I went back and finished them.`;
      if (repair.fixed > 0) {
        return `• ${found}; I finished ${repair.fixed} and ${repair.remaining} ${repair.remaining === 1 ? "is" : "are"} still missing.`;
      }
      return `• ${found}; my attempt to finish them did not work, so they are still missing.`;
    case "reverted-types":
      return `• ${found}; the fix stopped the project compiling so I undid it. The app is as described above.`;
    case "reverted-worse":
      return `• ${found}; the fix broke something that was working so I undid it. The app is as described above.`;
    case "no-files":
      return `• ${found}; the attempt to finish them produced nothing usable.`;
    case "not-attempted":
      return `• ${found}, and I did not attempt a fix.`;
  }
}
