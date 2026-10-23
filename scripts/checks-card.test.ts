/**
 * The card a user reads to see that the build checked itself.
 *
 * Most of these tests are about what it must NOT say. A card is only worth
 * showing if a tick means something was proven, so the first test here is the
 * one that matters: a gate that never ran must never round up to a pass.
 */

import { buildChecksCard, type ChecksInput } from "../src/verify/checks-card.js";

let failures = 0;
let checks = 0;
function ok(name: string, pass: boolean, detail?: string): void {
  checks++;
  if (pass) { console.log(`✔ ${name}`); return; }
  failures++;
  console.log(`✘ ${name}${detail ? `\n    ${detail}` : ""}`);
}
function eq(name: string, got: unknown, want: unknown): void {
  ok(name, JSON.stringify(got) === JSON.stringify(want),
    `got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}

const base: ChecksInput = { checkPage: "pass", checkTypes: "pass", checkTests: "none" };
const row = (input: ChecksInput, id: string) =>
  buildChecksCard(input).rows.find((r) => r.id === id);

// ── the honesty rule ────────────────────────────────────────────────────────

eq("a gate that never ran is skipped, not passed",
  row({ ...base, checkPage: "never" }, "opens")?.status, "skip");

eq("a gate that could not run is also skipped",
  row({ ...base, checkPage: "unavailable" }, "opens")?.status, "skip");

eq("a failing gate says so", row({ ...base, checkTypes: "fail" }, "compiles")?.status, "fail");

ok("no row ever claims a pass it was not given",
  buildChecksCard({ checkPage: "never", checkTypes: "never", checkTests: "never" })
    .rows.every((r) => r.status !== "pass"));

// ── rows that should not exist ──────────────────────────────────────────────

eq("a build with no tests gets no test row", row(base, "tests"), undefined);
eq("a build that was never type-checked still gets the row, as a skip",
  row({ ...base, checkTypes: "never" }, "compiles")?.status, "skip");
eq("a frontend-only build gets no database row", row(base, "data"), undefined);

eq("tests that ran get a row",
  row({ ...base, checkTests: "pass" }, "tests")?.status, "pass");

// ── the database row ────────────────────────────────────────────────────────

eq("a created schema reads as saved data",
  row({ ...base, schemaApply: { ran: true, ok: true } }, "data")?.status, "pass");

eq("no connected Supabase is a skip, not a failure",
  row({ ...base, schemaApply: { ran: false, ok: false, error: "no Supabase connected" } }, "data")?.status,
  "skip");

eq("a schema that would not apply is a failure",
  row({ ...base, schemaApply: { ran: true, ok: false, error: "syntax error" } }, "data")?.status,
  "fail");

ok("the failure does not leak the database's own error text",
  !(row({ ...base, schemaApply: { ran: true, ok: false, error: "relation already exists" } }, "data")
    ?.detail ?? "").includes("relation"));

// ── controls ────────────────────────────────────────────────────────────────

const noGaps = { deadHandlers: 0, bareButtons: 0, formsNoSubmit: 0, deadLinks: 0, missingEndpoints: 0 };

eq("every control wired is a pass",
  row({ ...base, wiring: noGaps }, "controls")?.status, "pass");

{
  const r = row({ ...base, wiring: { ...noGaps, bareButtons: 2 } }, "controls");
  eq("hollow controls warn rather than fail", r?.status, "warn");
  ok("and the count is named", (r?.detail ?? "").startsWith("2 controls"), r?.detail);
}

eq("one hollow control is not pluralised",
  row({ ...base, wiring: { ...noGaps, deadLinks: 1 } }, "controls")?.detail,
  "1 control does nothing yet");

{
  // orphan endpoints and placeholder text are reported elsewhere on purpose:
  // their fix is a product decision, so they must not mark a sound build.
  const tally = { ...noGaps, orphanEndpoints: 3, placeholders: 5, hardcodedDevHosts: 0, total: 8 };
  eq("report-only findings do not mark a build as hollow",
    row({ ...base, wiring: tally }, "controls")?.status, "pass");
}

// ── what the build could not prove ──────────────────────────────────────────

{
  const audit = {
    criteria: [
      { id: "R1", text: "I can add a task", kind: "behaviour" as const },
      { id: "R2", text: "I can export to CSV", kind: "behaviour" as const },
      { id: "R3", text: "Tasks survive a refresh", kind: "data" as const },
    ],
    verdicts: [
      { id: "R1", status: "proven" as const, evidence: "src/App.tsx", note: "" },
      { id: "R2", status: "unverified" as const, evidence: "", note: "nothing exports anything" },
      { id: "R3", status: "contradicted" as const, evidence: "", note: "state is in memory only" },
    ],
  };
  const card = buildChecksCard({ ...base, audit });
  eq("anything not proven is listed in the user's own words",
    card.missing.map((m) => m.text),
    ["I can export to CSV", "Tasks survive a refresh"]);
  ok("with the reason attached", card.missing[0]?.note === "nothing exports anything");
  eq("a proven requirement is not listed", card.missing.find((m) => m.text.includes("add a task")), undefined);
}

eq("no audit means nothing is claimed missing", buildChecksCard(base).missing, []);

// ── repairs: the part that shows the product watching its own work ──────────

{
  const card = buildChecksCard({ ...base, wiringRepaired: 2, auditRepaired: 1 });
  eq("both kinds of repair are reported", card.repairs.length, 2);
  ok("the wiring repair reads as a fix, not a metric",
    card.repairs[0]?.includes("fixed them") === true, card.repairs[0]);
  ok("a single missing feature is phrased singular",
    card.repairs[1]?.includes("1 thing you asked for that was missing") === true, card.repairs[1]);
}

eq("a build that needed no repair reports none", buildChecksCard(base).repairs, []);

console.log(`\n${checks} checks-card checks, ${failures} failed`);
if (failures > 0) process.exit(1);
