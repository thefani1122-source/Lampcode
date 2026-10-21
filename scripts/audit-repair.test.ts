/**
 * Cases for the audit → repair loop. Run by `npm test`.
 *
 * WHAT THIS CLOSES. The completion audit is the strongest thing in this
 * product and it was only ever a report: on the 2026-10-19 build it said 0
 * proven, 2 unverified, and the build completed anyway. Seeing a gap and
 * shipping it is barely better than not seeing it.
 *
 * So the risk is no longer "it misses things" — it is a repair that fires on a
 * build already beyond saving, spends the user's money and leaves the app
 * worse than the one the gates had already approved. Every rule below exists
 * to make that impossible, and the cases are mostly about REFUSING to repair.
 */

import { readFileSync } from "node:fs";
import {
  MAX_REPAIRABLE,
  repairStatusLine,
  auditRepairInstruction,
  describeRepair,
  formatFilesForRepair,
  judgeRepair,
  planAuditRepair,
  whyNoRepair,
} from "../src/verify/audit-repair.js";
import type { AcceptanceCriterion, CompletionAudit, CriterionVerdict } from "../src/db/schema.js";

let checks = 0;
let failures = 0;
function ok(name: string, condition: boolean): void {
  checks++;
  if (condition) console.log(`✔ ${name}`);
  else { failures++; console.error(`✘ ${name}`); }
}

const criterion = (id: string, text = `requirement ${id}`): AcceptanceCriterion =>
  ({ id, text, kind: "behaviour" });
const verdict = (
  id: string,
  status: CriterionVerdict["status"],
  note = "",
): CriterionVerdict => ({ id, status, evidence: "", note });

function audit(
  criteria: AcceptanceCriterion[],
  verdicts: CriterionVerdict[],
): CompletionAudit {
  return {
    criteria,
    verdicts,
    proven: verdicts.filter((v) => v.status === "proven").length,
    contradicted: verdicts.filter((v) => v.status === "contradicted").length,
    unverified: verdicts.filter((v) => v.status === "unverified").length,
    costUsd: 0,
  };
}

// ── What is worth one attempt ───────────────────────────────────────────────

console.log("\n— the plan —");
{
  const a = audit(
    [criterion("c1"), criterion("c2"), criterion("c3")],
    [verdict("c1", "proven"), verdict("c2", "unverified"), verdict("c3", "contradicted")],
  );
  const plan = planAuditRepair(a);
  ok("unverified and contradicted are both repaired", plan?.items.length === 2);
  ok("proven is left alone", !plan?.items.some((i) => i.criterion.id === "c1"));
  ok("the criterion's own text travels with the verdict", plan?.items[0]?.criterion.text === "requirement c2");
}

console.log("\n— refused, with a reason —");
{
  const allGood = audit([criterion("c1")], [verdict("c1", "proven")]);
  ok("nothing to do when everything is proven", planAuditRepair(allGood) === null);
  ok("and it says so", whyNoRepair(allGood).includes("every requirement was proven"));
}
{
  // The important refusal. A build with ten unmet requirements is not nearly
  // finished, and one dispatch cannot rescue it — trying costs real money to
  // produce a worse mess, and the honest move is to report.
  const many = audit(
    Array.from({ length: 10 }, (_, i) => criterion(`c${i}`)),
    Array.from({ length: 10 }, (_, i) => verdict(`c${i}`, "unverified")),
  );
  ok(`more than ${MAX_REPAIRABLE} unmet is not repaired`, planAuditRepair(many) === null);
  ok("and the reason names the count", whyNoRepair(many).includes("10 requirements are unmet"));
  ok("the boundary itself is repaired", planAuditRepair(audit(
    Array.from({ length: MAX_REPAIRABLE }, (_, i) => criterion(`c${i}`)),
    Array.from({ length: MAX_REPAIRABLE }, (_, i) => verdict(`c${i}`, "unverified")),
  ))?.items.length === MAX_REPAIRABLE);
}
ok("no audit is no repair", planAuditRepair(null) === null);
ok("and it says why", whyNoRepair(null).includes("no requirements"));
ok("an empty criteria list is no repair", planAuditRepair(audit([], [])) === null);
{
  // A verdict about a requirement that is not in the list is a parser bug. It
  // must not become an instruction to fix something nobody asked for.
  const orphan = audit([criterion("c1")], [verdict("c1", "proven"), verdict("ghost", "unverified")]);
  ok("a verdict with no criterion is not repairable", planAuditRepair(orphan) === null);
}

// ── The instruction ────────────────────────────────────────────────────────

console.log("\n— the instruction —");
{
  const plan = planAuditRepair(audit(
    [criterion("c1", "the list survives a page reload")],
    [verdict("c1", "unverified", "nothing writes to a server")],
  ))!;
  const text = auditRepairInstruction(plan);
  ok("the user's own words are in it", text.includes("the list survives a page reload"));
  ok("so is what the check found", text.includes("nothing writes to a server"));
  ok("it says to change nothing else", text.includes("only these"));

  // THE RULE THAT MATTERS. The fake-persistence detector exists because a
  // model asked to make a failing feature work reaches for localStorage and a
  // demo mode — which makes a broken feature LOOK fixed, and is strictly worse
  // than an honestly missing one.
  ok("faking is forbidden by name", text.includes("NEVER FAKE IT")
    && text.includes("localStorage") && text.includes("demo data"));
  ok("and it may say it could not do one", text.includes("cannot do one of them"));
  ok("complete files, in fences", text.includes("COMPLETE contents") && text.includes("```filename:"));
  ok("new files are allowed", text.includes("New files are allowed"));
}
{
  // A verdict with no note still has to produce a usable line: "contradicted"
  // and "unverified" mean different things and the fallback keeps them apart.
  const contra = auditRepairInstruction(planAuditRepair(audit(
    [criterion("c1")], [verdict("c1", "contradicted")],
  ))!);
  ok("a contradicted requirement with no note still reads", contra.includes("opposite"));
  const unver = auditRepairInstruction(planAuditRepair(audit(
    [criterion("c1")], [verdict("c1", "unverified")],
  ))!);
  ok("an unverified one says nothing covers it", unver.includes("nothing in the build covers this"));
}

// ── The files handed over ──────────────────────────────────────────────────

console.log("\n— the files —");
{
  const files = { "src/App.tsx": "const a = 1;\n", "src/lib/api.ts": "export const x = 2;\n" };
  const text = formatFilesForRepair(files);
  ok("every file is fenced with its path", text.includes("```filename:src/App.tsx") && text.includes("```filename:src/lib/api.ts"));
  ok("contents are whole", text.includes("const a = 1;") && text.includes("export const x = 2;"));
  ok("nothing is omitted when it all fits", !text.includes("not shown"));
}
{
  // THE REASON THIS IS NOT formatFilesForAudit. That one truncates a long file
  // to fit its budget, which is correct for reading and catastrophic for
  // something asked to return the file COMPLETE: shown two thirds, it returns
  // two thirds, and the rest is deleted without anyone noticing.
  const huge = { "src/Big.tsx": "x".repeat(300_000), "src/Small.tsx": "const s = 1;\n" };
  const text = formatFilesForRepair(huge);
  ok("a file too large to fit is left out whole", !text.includes("```filename:src/Big.tsx"));
  ok("no included file is truncated", !text.includes("(truncated)") && !text.includes("…"));
  ok("a small file still gets through", text.includes("```filename:src/Small.tsx"));
  ok("the omitted file is NAMED", text.includes("src/Big.tsx"));
  ok("and rewriting it from memory is forbidden", text.includes("from memory"));
}

// ── Whether to keep it ─────────────────────────────────────────────────────

console.log("\n— the judgement —");
ok("a clean repair is kept", judgeRepair({
  typesWereGreen: true, typesAreGreen: true, provenBefore: 1, provenAfter: 3,
}) === "kept");
ok("breaking the compile reverts it", judgeRepair({
  typesWereGreen: true, typesAreGreen: false, provenBefore: 1, provenAfter: 3,
}) === "reverted-types");
ok("un-proving something that worked reverts it", judgeRepair({
  typesWereGreen: true, typesAreGreen: true, provenBefore: 3, provenAfter: 2,
}) === "reverted-worse");

// A repair that did not work is disappointing, not harmful — and the re-audit
// is a model's reading, so "no improvement" is far too noisy a signal to
// revert on. Only a REGRESSION is grounds.
ok("a repair that changed nothing is still kept", judgeRepair({
  typesWereGreen: true, typesAreGreen: true, provenBefore: 2, provenAfter: 2,
}) === "kept");

// A project that did not compile BEFORE the repair cannot have been broken by
// it. Reverting there would throw away the only attempt at a fix.
ok("types already red is not the repair's fault", judgeRepair({
  typesWereGreen: false, typesAreGreen: false, provenBefore: 0, provenAfter: 1,
}) === "kept");
ok("a type check that could not run does not revert", judgeRepair({
  typesWereGreen: true, typesAreGreen: null, provenBefore: 1, provenAfter: 2,
}) === "kept");
ok("a regression outranks a passing compile", judgeRepair({
  typesWereGreen: true, typesAreGreen: false, provenBefore: 5, provenAfter: 1,
}) === "reverted-types");

// ── What the user is told ──────────────────────────────────────────────────

console.log("\n— the sentence the user reads —");
{
  ok("everything fixed says so plainly", describeRepair("kept", 2, 0).includes("everything you asked for is in"));
  ok("a partial fix counts both halves", describeRepair("kept", 1, 2).includes("1 of the missing")
    && describeRepair("kept", 1, 2).includes("2 still"));
  ok("singular reads correctly", describeRepair("kept", 1, 1).includes("1 still is not there"));
  ok("a fix that did not take is admitted", describeRepair("kept", 0, 2).includes("did not take"));
  ok("a reverted-for-types repair says the project stopped compiling", describeRepair("reverted-types", 0, 1).includes("compiling"));
  ok("a reverted-for-regression repair says it broke something working", describeRepair("reverted-worse", 0, 1).includes("broke something"));
  ok("nothing usable is said out loud", describeRepair("no-files", 0, 1).includes("nothing usable"));
  ok("not-attempted says nothing at all", describeRepair("not-attempted", 0, 0) === "");

  // Every branch is in the user's words, not the audit's vocabulary.
  for (const outcome of ["kept", "reverted-types", "reverted-worse", "no-files"] as const) {
    const line = describeRepair(outcome, 0, 1);
    ok(`${outcome} avoids the word "unverified"`, !line.includes("unverified") && !line.includes("criterion"));
  }
}

console.log("\n— the durable status line —");
{
  const line = (outcome: Parameters<typeof repairStatusLine>[0]["outcome"], fixed: number, remaining: number): string =>
    repairStatusLine({ outcome, attempted: 3, fixed, remaining });
  ok("it says how many were missing", line("kept", 3, 0).includes("3 part(s)"));
  ok("all fixed reads as finished", line("kept", 3, 0).includes("went back and finished them"));
  ok("a partial fix gives both numbers", line("kept", 1, 2).includes("finished 1") && line("kept", 1, 2).includes("2 are still missing"));
  ok("singular reads correctly", line("kept", 2, 1).includes("1 is still missing"));
  // The case that silence would misreport: money spent, nothing achieved.
  ok("a fix that did nothing still says it was attempted", line("kept", 0, 3).includes("did not work"));
  ok("a revert says the app is as described above", line("reverted-types", 0, 3).includes("as described above"));
  ok("a regression revert says so too", line("reverted-worse", 0, 3).includes("broke something that was working"));
  ok("nothing usable is said", line("no-files", 0, 3).includes("nothing usable"));
  ok("not-attempted is still reported, not hidden", line("not-attempted", 0, 3).includes("did not attempt"));
  ok("every line is a bullet for the status block", ["kept", "reverted-types", "reverted-worse", "no-files", "not-attempted"]
    .every((o) => line(o as Parameters<typeof repairStatusLine>[0]["outcome"], 0, 3).startsWith("• ")));
}

// ── How it is wired into the build ─────────────────────────────────────────

console.log("\n— the wiring —");
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

  ok("the repair runs AFTER the audit it acts on",
    build.indexOf("formatAuditForUser(completionAudit)") < build.indexOf("planAuditRepair(completionAudit)"));
  ok("it needs a live sandbox", build.includes("hasSandbox(projectId) ? planAuditRepair"));
  ok("and it respects the cost ceiling", build.includes("cumulativeCostUsd < MAX_BUILD_COST_USD"));
  ok("a skipped repair is logged with its reason", build.includes("skipped=${whyNoRepair(completionAudit)}"));

  // The repair is the one loop that lands after the gates, so the gates have
  // to be re-validated against what it wrote. A single freshness pass ahead of
  // it would have left a page verdict obtained before the repair existed.
  ok("the freshness pass is a function, so it can run twice", build.includes("const revalidateStaleGates = async ()"));
  ok("it runs once where it always did", build.includes("};\n    await revalidateStaleGates();"));
  ok("and again after the repair", build.lastIndexOf("await revalidateStaleGates();") > build.indexOf("planAuditRepair(completionAudit)"));

  // A revert restores the old bytes but the stream already says a write
  // landed, so both branches must report one.
  ok("a kept repair reports its writes", build.includes('recorder.record({ type: "repair/applied", kind: "completion-audit" })'));
  ok("a revert is recorded as its own event", build.includes('kind: "completion-audit-reverted"'));
  ok("the repaired audit replaces the stored one", build.includes("completionAudit = after;"));
  ok("the re-audit reuses the SAME criteria", build.includes("criteria: before.criteria"));
  ok("stale gate verdicts are labelled to the re-audit", build.includes("(STALE — a repair landed after it)"));
  ok("template-owned files are still refused", build.includes("!isTemplateOwnedFile(file.path)"));
  ok("a failed dispatch does not fail the build", build.includes("Completion-audit repair dispatch failed"));
  ok("tools are off — this is one shot at a file set", build.includes("enableTools: false"));
  ok("the outcome is logged with its numbers", build.includes("[build] audit repair session="));

  // In the record as well as the log. A loop that spent money and achieved
  // nothing has to be visible later — an unchanged audit alone would read as
  // if no repair had ever run.
  ok("the repair is stored in build_outcome", build.includes("...(auditRepair ? { auditRepair } : {})"));
  ok("with how many it attempted", build.includes("attempted: repairPlan.items.length"));
  const schema = readFileSync(new URL("../src/db/schema.ts", import.meta.url), "utf8");
  ok("the field is declared optional, so absent means never attempted", schema.includes("auditRepair?: {"));
  ok("and it records the cost", /auditRepair\?: \{[^}]*costUsd: number/s.test(schema));
  ok("the closing status block carries it too", build.includes("closingLines.push(repairStatusLine(auditRepair))"));
}

console.log(`\n${checks} audit-repair checks, ${failures} failed`);
if (failures > 0) process.exit(1);
