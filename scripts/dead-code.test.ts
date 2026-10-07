/**
 * Cases for the dead-code analyser. Run by `npm test`.
 *
 * The property these protect is PRECISION, not recall. The response to a
 * dead-code finding is deleting code, so a false positive costs a working app
 * while a missed finding costs a few stale lines. Every rule is therefore
 * written to under-report, and most of the cases below assert that something
 * which LOOKS dead is left alone.
 */

import {
  findDeadCode,
  tallyDeadCode,
  formatDeadCode,
  parseImports,
  parseNamedExports,
  stripComments,
  identifierCount,
} from "../src/verify/dead-code.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

const kinds = (files: Record<string, string>) =>
  findDeadCode(files).map((f) => `${f.kind}:${f.path}:${f.symbol}`);

// ── parsing ──────────────────────────────────────────────────────────────────

check(
  "parseImports: named, renamed, default and namespace",
  parseImports(
    `import React from "react"\n` +
    `import { useState, useEffect as fx } from "react"\n` +
    `import * as path from "node:path"\n` +
    `import type { Note } from "./types"\n`,
  ).map((b) => b.local).sort(),
  ["Note", "React", "fx", "path", "useState"],
);

// A side-effect import binds nothing, and is not dead merely because no
// identifier refers to it — a stylesheet import is the common case.
check(
  "parseImports: a side-effect import yields no binding",
  parseImports(`import "./styles.css"`),
  [],
);

check(
  "parseNamedExports: declarations and braced re-exports",
  parseNamedExports(
    `export const MAX = 1\n` +
    `export function helper() {}\n` +
    `export type Note = { id: string }\n` +
    `export interface Props { a: 1 }\n` +
    `const inner = 2\nexport { inner as outer }\n`,
  ).sort(),
  ["MAX", "Note", "Props", "helper", "outer"],
);

// Default exports are out of scope on purpose: a default import can be renamed
// at the import site, so proving one unreferenced needs module resolution, and
// being wrong deletes an entry point.
check(
  "parseNamedExports: a default export is not reported",
  parseNamedExports(`export default function App() { return null }`),
  [],
);

check(
  "stripComments: a name in a comment is not code",
  identifierCount(stripComments(`// uses helper\nconst x = 1`), "helper"),
  0,
);

check(
  "stripComments: a URL inside a string survives",
  stripComments(`const u = "https://example.com/x"`).includes("https://example.com/x"),
  true,
);

// ── unused imports ───────────────────────────────────────────────────────────

check(
  "an import never mentioned again is unused",
  kinds({ "src/a.ts": `import { helper } from "./b"\nexport const x = 1` }),
  ["unused-import:src/a.ts:helper", "unreferenced-export:src/a.ts:x"],
);

check(
  "an import that IS used is not reported",
  kinds({ "src/a.ts": `import { helper } from "./b"\nexport const x = helper()` }).filter((k) =>
    k.startsWith("unused-import"),
  ),
  [],
);

// The import of a type used only in a type position is live. Counting
// identifiers rather than parsing value usage is what makes this work.
check(
  "a type import used only in an annotation is live",
  kinds({ "src/a.ts": `import type { Note } from "./types"\nexport const f = (n: Note) => n.id` })
    .filter((k) => k.startsWith("unused-import")),
  [],
);

check(
  "a component import used only in JSX is live",
  kinds({
    "src/a.tsx":
      `import { Preview } from "./Preview"\n` +
      `export function View() { return (<div><Preview note={n} /></div>) }`,
  }).filter((k) => k.startsWith("unused-import")),
  [],
);

// ── unreferenced exports, and what must NOT be reported ──────────────────────

const PROJECT = {
  // App is actually used here: an unused import in an entry file IS still an
  // unused import, so leaving it dangling would make the case below assert the
  // opposite of what it means to test.
  "src/index.tsx": `import App from "./App"\nexport const mount = () => <App />`,
  "src/App.tsx": `import { Sidebar } from "./Sidebar"\nexport default function App() { return <Sidebar /> }`,
  "src/Sidebar.tsx": `export function Sidebar() { return (<aside>x</aside>) }`,
  "src/OldSidebar.tsx": `export function OldSidebar() { return (<aside>old</aside>) }`,
  "src/lib/util.ts": `export const used = 1\nexport const orphan = 2`,
  "src/lib/other.ts": `import { used } from "./util"\nexport const z = used`,
};

check(
  "a component nobody renders is reported as never-rendered",
  kinds(PROJECT).filter((k) => k.includes("OldSidebar")),
  ["never-rendered:src/OldSidebar.tsx:OldSidebar"],
);

check(
  "a rendered component is not reported",
  kinds(PROJECT).filter((k) => k.includes("Sidebar.tsx:Sidebar")),
  [],
);

check(
  "an unused helper is an unreferenced export, not never-rendered",
  kinds(PROJECT).filter((k) => k.includes("orphan")),
  ["unreferenced-export:src/lib/util.ts:orphan"],
);

check(
  "an imported helper is not reported",
  kinds(PROJECT).filter((k) => k.includes("util.ts:used")),
  [],
);

// Entry files are consumed by the framework, so "nothing imports it" is normal
// there and reporting it would point the model at its own entry point.
check(
  "an export from an entry file is never reported",
  kinds(PROJECT).filter((k) => k.includes("index.tsx")),
  [],
);

// A capitalised CONSTANT is not a component, even in a file full of markup.
check(
  "a SCREAMING_CASE constant is not called a component",
  kinds({ "src/c.tsx": `export const MAX_ENTRIES = 200\nexport function V() { return (<p>x</p>) }` })
    .filter((k) => k.includes("MAX_ENTRIES")),
  ["unreferenced-export:src/c.tsx:MAX_ENTRIES"],
);

// Tests count as references. A symbol used only by its own test is arguably
// dead, but deleting it on that basis also deletes a passing test, so this
// under-reports deliberately.
check(
  "a symbol used only by its own test is left alone",
  kinds({
    "src/lib/sum.ts": `export function sum(a: number, b: number) { return a + b }`,
    "src/lib/sum.test.ts": `import { sum } from "./sum"\nit("adds", () => { sum(1, 2) })`,
  }),
  [],
);

// A test file's own exports are not findings either.
check(
  "a test file's exports are not reported",
  kinds({ "src/lib/x.test.ts": `export const fixture = 1` }),
  [],
);

check(
  "non-code files are ignored entirely",
  kinds({ "src/theme.css": `:root { --primary: red }`, "db/schema.sql": `CREATE TABLE t (id int)` }),
  [],
);

check("an empty project yields nothing", findDeadCode({}), []);

// ── tally and formatting ─────────────────────────────────────────────────────

check(
  "tallyDeadCode separates the three kinds",
  tallyDeadCode(findDeadCode(PROJECT)),
  // Two unreferenced exports: util.ts's `orphan`, and other.ts's `z`, which
  // nothing imports either. The second was not noticed when this fixture was
  // written and the analyser found it — which is the job.
  { unusedImports: 0, unreferencedExports: 2, neverRendered: 1 },
);

ok(
  "formatDeadCode says so plainly when there is nothing",
  formatDeadCode([]).includes("Nothing to clean up"),
);

const report = formatDeadCode(findDeadCode(PROJECT));
ok("formatDeadCode names the file and symbol", report.includes("src/OldSidebar.tsx") && report.includes("OldSidebar"));
// The analysis is textual, so the reply must tell the model to confirm before
// deleting. A bare list invites deleting things it has not looked at.
ok("formatDeadCode tells the model to confirm first", report.includes("read_file"));

console.log(failures === 0 ? "\nAll dead-code cases passed." : `\n${failures} case(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
