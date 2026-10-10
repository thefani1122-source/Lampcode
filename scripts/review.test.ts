/**
 * Cases for the review spine's deterministic half. Run by `npm test`.
 *
 * Two properties matter here and the cases are weighted to them:
 *
 *  1. **Coverage is countable.** The units come from code, so "I reviewed it"
 *     becomes a number. A unit that got no model pass must be visible, and the
 *     report must say so before it says anything about findings.
 *  2. **A finding must be corroborated.** A review's whole output is claims,
 *     so it is more exposed to a confident hallucination than the completion
 *     audit was — and that already happened once here, in convincing detail,
 *     over working code.
 */

import { buildImportGraph, resolveSpecifier, importSpecifiers } from "../src/verify/import-graph.js";
import { enumerateUnits, prePass, hasSiblingTest, templateOwnsFile } from "../src/verify/review-units.js";
import { readFileSync } from "node:fs";
import { parseFindings, formatReview, formatUnitForReview } from "../src/verify/code-review.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
const ok = (name: string, cond: boolean) => check(name, cond, true);

// ── import graph ─────────────────────────────────────────────────────────────

const PROJECT: Record<string, string> = {
  "src/App.tsx":
    `import { Summary } from "./views/Summary"\nimport { formatCurrency } from "@/lib/money"\n` +
    `export default function App() { return (<Summary x={formatCurrency(1)} />) }`,
  "src/views/Summary.tsx":
    `import { total } from "../lib/money"\nexport function Summary({ x }: { x: string }) { return (<p>{x}{total([])}</p>) }`,
  "src/lib/money.ts":
    `export function formatCurrency(n: number) { return String(n) }\nexport function total(xs: number[]) { return xs.length }`,
  "src/lib/money.test.ts": `import { total } from "./money"\nit("x", () => { total([]) })`,
  "src/orphan.tsx": `export function Orphan() { return (<p>hi</p>) }`,
};

const G = buildImportGraph(PROJECT);

check(
  "resolves a relative specifier without an extension",
  resolveSpecifier("src/App.tsx", "./views/Summary", new Set(Object.keys(PROJECT))),
  "src/views/Summary.tsx",
);
check(
  "resolves the @/ alias to src/",
  resolveSpecifier("src/App.tsx", "@/lib/money", new Set(Object.keys(PROJECT))),
  "src/lib/money.ts",
);
check(
  "resolves a parent-relative specifier",
  resolveSpecifier("src/views/Summary.tsx", "../lib/money", new Set(Object.keys(PROJECT))),
  "src/lib/money.ts",
);
check(
  "resolves a directory to its index file",
  resolveSpecifier("src/App.tsx", "./ui", new Set(["src/App.tsx", "src/ui/index.tsx"])),
  "src/ui/index.tsx",
);
// The ESM convention this repo itself writes: import "./x.js", file is x.ts.
check(
  "resolves a .js specifier to the .ts file on disk",
  resolveSpecifier("src/a.ts", "./b.js", new Set(["src/a.ts", "src/b.ts"])),
  "src/b.ts",
);
// A bare package is not a project file and must not be invented as one.
check(
  "a bare package specifier resolves to nothing",
  resolveSpecifier("src/App.tsx", "react", new Set(Object.keys(PROJECT))),
  null,
);

check(
  "importSpecifiers catches side-effect, re-export and dynamic imports",
  importSpecifiers(
    `import "./styles.css"\nexport { a } from "./a"\nconst m = await import("./lazy")\n`,
  ).sort(),
  ["./a", "./lazy", "./styles.css"],
);

check(
  "fan-in counts the files that import a module",
  (G.importedBy["src/lib/money.ts"] ?? []).sort(),
  ["src/App.tsx", "src/lib/money.test.ts", "src/views/Summary.tsx"],
);
check("a module nothing imports has no importers", G.importedBy["src/orphan.tsx"], []);
check("a bare package lands in unresolved, not imports", G.imports["src/orphan.tsx"], []);

// ── units and ranking ────────────────────────────────────────────────────────

const UNITS = enumerateUnits(PROJECT, G);

check(
  "test files are not units — reviewing assertions is a different job",
  UNITS.some((u) => u.path.includes(".test.")),
  false,
);
check(
  "the most-imported module ranks above an orphan",
  UNITS.findIndex((u) => u.path === "src/lib/money.ts") <
    UNITS.findIndex((u) => u.path === "src/orphan.tsx"),
  true,
);
check(
  "fan-in is named as the reason when it dominates",
  UNITS.find((u) => u.path === "src/lib/money.ts")?.riskReason,
  "3 file(s) import it",
);
check("a sibling test is detected", hasSiblingTest("src/lib/money.ts", PROJECT), true);
check("a missing sibling test is detected", hasSiblingTest("src/orphan.tsx", PROJECT), false);
// A component file exports markup, not logic — it should not be scored as
// untested logic, or every view in the app outranks the real risks.
check(
  "a component-only file is not counted as untested logic",
  UNITS.find((u) => u.path === "src/orphan.tsx")?.hasLogic,
  false,
);
// Ordering must be stable, or two reviews of the same project cannot be diffed.
check(
  "ordering is stable across runs",
  enumerateUnits(PROJECT, G).map((u) => u.path),
  UNITS.map((u) => u.path),
);

// ── the free pre-pass ────────────────────────────────────────────────────────

const BROKEN = {
  "src/App.tsx": `import { Gone } from "./nope"\nexport default function App() { return <Gone /> }`,
};
check(
  "a relative import that resolves to nothing is a broken-import finding",
  prePass(BROKEN).filter((f) => f.kind === "broken-import").map((f) => f.path),
  ["src/App.tsx"],
);
// react resolves to no project file either — flagging it would bury the real
// finding under every dependency in the app.
check(
  "a bare package import is NOT reported as broken",
  prePass({ "src/a.tsx": `import React from "react"\nexport const A = React` })
    .filter((f) => f.kind === "broken-import"),
  [],
);
check(
  "logic that other files depend on, with no test, is reported",
  prePass(PROJECT).some((f) => f.kind === "untested-logic"),
  false, // money.ts HAS a sibling test
);
const WITHOUT_TEST = Object.fromEntries(
  Object.entries(PROJECT).filter(([p]) => p !== "src/lib/money.test.ts"),
);
check(
  "the same logic without its test is reported",
  prePass(WITHOUT_TEST).filter((f) => f.kind === "untested-logic").map((f) => f.path),
  ["src/lib/money.ts"],
);

// ── what real projects taught these rules, kept as regressions ──────────────
// Each of the three below was a FALSE POSITIVE on real generated output, found
// by running the spine over two downloaded projects rather than by reasoning.

// 1. The generated file set is not the whole project: the E2B template writes
//    src/styles.css and src/lib/utils.ts into every sandbox. The first version
//    of the broken-import rule accused both projects of importing files that
//    "do not exist".
check(
  "an import of a template-owned file is not reported as broken",
  prePass({
    "src/index.tsx": `import "./styles.css"\nimport { cn } from "./lib/utils"\nexport const x = cn("a")`,
  }).filter((f) => f.kind === "broken-import"),
  [],
);
check(
  "a stylesheet import is never a broken import",
  prePass({ "src/a.tsx": `import "./app.css"\nexport const A = 1` })
    .filter((f) => f.kind === "broken-import"),
  [],
);

// 2. Fan-in measures the blast radius of a BEHAVIOUR change. A types module has
//    no behaviour, and ranking by fan-in put src/types.ts first in both real
//    projects — spending the first, most expensive dispatch on the lowest-yield
//    file there is.
const TYPES_PROJECT = {
  "src/types.ts": `export interface Note { id: string }\nexport type Id = string`,
  "src/a.tsx": `import type { Note } from "./types"\nexport function A(n: Note) { return (<p>{n.id}</p>) }`,
  "src/b.tsx": `import type { Note } from "./types"\nexport function B(n: Note) { return (<p>{n.id}</p>) }`,
  "src/big.ts": `${"const filler = 1\n".repeat(120)}export function compute() { return filler }`,
};
check(
  "a type-only module does not outrank a real module on fan-in",
  enumerateUnits(TYPES_PROJECT).findIndex((u) => u.path === "src/big.ts") <
    enumerateUnits(TYPES_PROJECT).findIndex((u) => u.path === "src/types.ts"),
  true,
);
check(
  "a type-only module is not reported as untested logic",
  prePass(TYPES_PROJECT).filter(
    (f) => f.path === "src/types.ts" && f.kind === "untested-logic",
  ),
  [],
);

// 3. A const holding a literal is data, not logic. LEDGER's types.ts exports
//    `export const CATEGORIES = [...]`, a list of names, and it was reported as
//    untested logic. Nobody writes a test for a list of names, and a finding
//    like that teaches the reader to skim the rest.
check(
  "a data constant is not called untested logic",
  prePass({
    "src/data.ts": `export const CATEGORIES = ["food", "rent"]`,
    "src/use.tsx": `import { CATEGORIES } from "./data"\nexport const U = CATEGORIES`,
  }).filter((f) => f.kind === "untested-logic"),
  [],
);
check(
  "an exported function with no test IS called untested logic",
  prePass({
    "src/calc.ts": `export const total = (xs: number[]) => xs.reduce((a, b) => a + b, 0)`,
    "src/use.tsx": `import { total } from "./calc"\nexport const U = total([1])`,
  }).filter((f) => f.kind === "untested-logic").map((f) => f.path),
  ["src/calc.ts"],
);

// The template-owned list is COPIED from e2b-service.ts rather than imported,
// because importing that module pulls config, Redis and the E2B SDK into what
// has to stay a pure function — measured: it hung outside the server process.
// This case reads that file as TEXT, so no module loads, and asserts the list
// has not drifted. Prompt-vs-reality drift is this repo's #1 bug class and the
// same risk applies to a copied constant.
{
  const src = readFileSync(
    new URL("../src/preview/e2b-service.ts", import.meta.url),
    "utf8",
  );
  const block = /const BAKED_FILES = new Set\(\[([\s\S]*?)\]\)/.exec(src);
  const authoritative = [...(block?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
  ok("the drift guard actually found BAKED_FILES", authoritative.length > 5);
  const missing = authoritative.filter((p) => !templateOwnsFile(p));
  check("every file e2b-service bakes is in review-units' copy", missing, []);
}

// ── the orphan-file check, and why it exists ────────────────────────────────
// Measured on the ROTA build, 2026-10-07: it wrote WeekGrid, StaffList,
// RulesPage and ConflictsReport — the four views the user asked for — and
// App.tsx imported none of them. check_page, check_types and run_tests all
// passed, because the two pages that ARE routed render fine and the rule
// engine's own tests pass. The feature simply was not in the shipped app.
//
// The dead-code analyser could not see it: all four views are `export default`,
// which it skips on purpose. This check needs no symbol resolution at all —
// the graph already resolved every specifier, so "no file imports this file" is
// a fact about the graph.
const ORPHANED = {
  "src/App.tsx": `import ShiftForm from "./components/ShiftForm"\nexport default function App() { return <ShiftForm /> }`,
  "src/components/ShiftForm.tsx": `export default function ShiftForm() { return (<form />) }`,
  "src/views/WeekGrid.tsx": `export default function WeekGrid() { return (<table />) }`,
  "src/views/ConflictsReport.tsx": `export default function ConflictsReport() { return (<ul />) }`,
};
check(
  "a whole file nothing imports is reported, even with only a default export",
  prePass(ORPHANED).filter((f) => f.kind === "orphan-file").map((f) => f.path).sort(),
  ["src/views/ConflictsReport.tsx", "src/views/WeekGrid.tsx"],
);
// App.tsx and index.tsx are reached by the framework, not by project code.
check(
  "an entry file is never called an orphan",
  prePass(ORPHANED).filter((f) => f.kind === "orphan-file" && f.path === "src/App.tsx"),
  [],
);
check(
  "an imported file is not an orphan",
  prePass(ORPHANED).filter((f) => f.path === "src/components/ShiftForm.tsx" && f.kind === "orphan-file"),
  [],
);
// A test file is run by vitest, not imported by the app.
check(
  "a test file is never called an orphan",
  prePass({ ...ORPHANED, "src/lib/x.test.ts": `it("x", () => {})` })
    .filter((f) => f.kind === "orphan-file" && f.path.includes(".test.")),
  [],
);

// ── finding corroboration ────────────────────────────────────────────────────

const FILES = {
  "src/lib/totals.ts": "export function subtotal(rows: number[]) {\n  let s = 0\n  for (let i = 0; i < rows.length - 1; i++) s += rows[i]\n  return s\n}",
};

check(
  "a finding whose quote is really in the file is kept",
  parseFindings(
    '{"findings":[{"path":"src/lib/totals.ts","severity":"bug","summary":"drops the last row","quote":"for (let i = 0; i < rows.length - 1; i++) s += rows[i]"}]}',
    FILES,
  ).findings.map((f) => [f.severity, f.path]),
  [["bug", "src/lib/totals.ts"]],
);

// The failure this guard exists for: a confident, detailed, invented claim.
check(
  "a finding whose quote is NOT in the file is dropped and counted",
  (() => {
    const r = parseFindings(
      '{"findings":[{"path":"src/lib/totals.ts","severity":"bug","summary":"uses a global","quote":"window.totals = subtotal(rows)"}]}',
      FILES,
    );
    return [r.findings.length, r.dropped];
  })(),
  [0, 1],
);

check(
  "a quote matches across reflowed whitespace",
  parseFindings(
    '{"findings":[{"path":"src/lib/totals.ts","severity":"risk","summary":"x","quote":"let s = 0    for (let i = 0;"}]}',
    FILES,
  ).findings.length,
  1,
);

check(
  "a finding citing a file that is not in the set is dropped",
  parseFindings(
    '{"findings":[{"path":"src/lib/other.ts","severity":"bug","summary":"x","quote":"let s = 0\\n  for (let i = 0;"}]}',
    FILES,
  ).dropped,
  1,
);

// Corroborated but oddly graded is still a real finding; only the grade is
// unclear, so it is kept at the mildest level rather than thrown away.
check(
  "an unknown severity falls back to smell rather than being discarded",
  parseFindings(
    '{"findings":[{"path":"src/lib/totals.ts","severity":"catastrophic","summary":"x","quote":"for (let i = 0; i < rows.length - 1; i++) s += rows[i]"}]}',
    FILES,
  ).findings[0]?.severity,
  "smell",
);

check("an unparseable reply yields nothing, not a crash", parseFindings("sorry", FILES), {
  findings: [],
  dropped: 0,
});

// ── the report leads with coverage ───────────────────────────────────────────

const PARTIAL = formatReview({
  findings: [],
  prePass: [],
  coverage: { total: 40, deep: 4, cheapOnly: 36, unreviewed: 0, truncated: 0 },
  droppedUncorroborated: 0,
  costUsd: 0.2,
});
// "No problems found" over a project where 4 of 40 files were looked at is the
// exact claim this module exists to make impossible to state by accident.
ok("the report states coverage before anything else", PARTIAL.startsWith("Reviewed 4 of 40"));
ok("partial coverage says the rest was skipped, not cleared", PARTIAL.includes("not cleared"));

const FAILED = formatReview({
  findings: [],
  prePass: [],
  coverage: { total: 10, deep: 7, cheapOnly: 1, unreviewed: 2, truncated: 0 },
  droppedUncorroborated: 3,
  costUsd: 0.1,
});
ok("a failed unit is reported as NOT reviewed", FAILED.includes("2 NOT reviewed"));
ok("dropped claims are surfaced, not hidden", FAILED.includes("3 claim(s) were discarded"));

// A unit whose file was cut at UNIT_BYTES still counts in `deep` — it did get a
// pass — so `deep` alone claimed a whole file had been reviewed when only its
// first 14 KB was sent. The qualifier has to appear with the coverage claim.
const TRUNC = formatReview({
  findings: [],
  prePass: [],
  coverage: { total: 5, deep: 5, cheapOnly: 0, unreviewed: 0, truncated: 2 },
  droppedUncorroborated: 0,
  costUsd: 0.1,
});
ok("truncated units are disclosed", TRUNC.includes("2 of those"));
ok("truncation says the remainder is unreviewed", TRUNC.includes("Treat the rest as unreviewed"));
ok(
  "the truncation note sits in the opening paragraph",
  TRUNC.split("\n\n")[0]!.includes("Treat the rest as unreviewed"),
);

const NOT_TRUNC = formatReview({
  findings: [],
  prePass: [],
  coverage: { total: 5, deep: 5, cheapOnly: 0, unreviewed: 0, truncated: 0 },
  droppedUncorroborated: 0,
  costUsd: 0.1,
});
ok("a review with nothing truncated says nothing about it", !NOT_TRUNC.includes("too long to send"));

// The reviewer must be told the file is cut, or it speaks for code it never saw.
{
  const bigPath = "src/big.ts";
  const big = { [bigPath]: `export function a() {}\n${"// pad\n".repeat(4000)}` };
  const bigUnits = enumerateUnits(big, buildImportGraph(big));
  const bigUnit = bigUnits.find((u) => u.path === bigPath)!;
  const body = formatUnitForReview(bigUnit, big, []);
  ok("an oversized unit body declares itself truncated", body.includes("TRUNCATED:"));
  ok(
    "the truncated body tells the reviewer not to speak for the rest",
    body.includes("do not treat the rest as reviewed"),
  );
  const small = { "src/small.ts": "export function a() { return 1; }\n" };
  const smallUnits = enumerateUnits(small, buildImportGraph(small));
  const smallBody = formatUnitForReview(smallUnits[0]!, small, []);
  ok("a small unit body carries no truncation notice", !smallBody.includes("TRUNCATED:"));
}

// ── the unit prompt carries the blast radius and nothing else ────────────────

const unit = UNITS.find((u) => u.path === "src/lib/money.ts")!;
const BODY = formatUnitForReview(unit, PROJECT, prePass(PROJECT).filter((f) => f.path === unit.path));
ok("the unit body contains the file itself", BODY.includes("export function formatCurrency"));
ok("the unit body contains an importer", BODY.includes("src/views/Summary.tsx"));
ok("the unit body states the blast radius", BODY.includes("blast radius"));
// The orphan is unrelated to this unit, and sending it is exactly the quadratic
// cost shape the graph exists to avoid.
ok("the unit body does NOT contain unrelated files", !BODY.includes("export function Orphan"));

console.log(failures === 0 ? "\nAll review cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
