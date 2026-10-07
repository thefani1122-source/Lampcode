import { buildImportGraph, type ImportGraph } from "./import-graph.js";
import { findDeadCode } from "./dead-code.js";


/**
 * Cutting a project into units a review can actually hold, and deciding the
 * order to spend money in.
 *
 * The reason a model skips things on a large review is not the context window —
 * a big project fits. It is that a model spends roughly fixed effort per
 * response, so per-file attention falls as the file count rises, and what comes
 * back is a plausible SUMMARY that reads like a review. Worse, the reviewer
 * chooses its own scope AND reports its own coverage, so "I reviewed it" is
 * unfalsifiable — the same structural problem as a builder declaring itself
 * done.
 *
 * Both halves are fixed here by moving the decision into code. The UNITS are
 * enumerated deterministically, so coverage is countable and a unit nobody
 * looked at is a recorded state rather than a silence. The ORDER is computed
 * from facts no amount of reading would reveal — how many files depend on this
 * one, and whether anything tests it.
 *
 * Everything in this file is free: no model call, no sandbox.
 */

export type ReviewUnit = {
  path: string;
  lines: number;
  /** Project files that import this one. The blast radius of changing it. */
  importedBy: string[];
  hasTest: boolean;
  /** Does it export anything that is not a component? Those are the exports
   *  whose correctness is not visible on screen. */
  hasLogic: boolean;
  /** Ordering only. Never shown as a score — a number nobody can explain gets
   *  argued with instead of used. */
  risk: number;
  /** The dominant term, in words. This is what gets read during triage. */
  riskReason: string;
};

/** Free findings, from the facts alone. These cost nothing and they also tell
 *  the model where to look, which is how a senior reviewer starts too: compile
 *  it, run the tests, see what is big. */
export type PrePassFinding = {
  path: string;
  kind: "broken-import" | "oversized-file" | "untested-logic" | "dead-code";
  detail: string;
};

const CODE_EXT_RE = /\.(tsx?|jsx?|mts|mjs)$/;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

/** Past this, a file is doing too much to review as one unit — and it is also
 *  the size at which an edit starts rewriting things it did not mean to. Chosen
 *  to match the eval's own `maxLinesPerFile` ceilings rather than invented. */
const OVERSIZED_LINES = 500;

function normalise(path: string): string {
  return path.replace(/^\.?\//, "");
}

function lineCount(text: string): number {
  return text === "" ? 0 : text.split("\n").length;
}

/** A capitalised export in a file that returns markup. Same test the dead-code
 *  analyser uses, kept consistent on purpose: two different definitions of
 *  "component" in one codebase is how reports start disagreeing. */
function looksLikeComponentExport(symbol: string, code: string): boolean {
  return /^[A-Z]/.test(symbol) && !/^[A-Z0-9_]+$/.test(symbol) && /return\s*\(?\s*</.test(code);
}

/**
 * Exports that exist at RUNTIME — not types, interfaces or enums.
 *
 * The distinction earns its place. Measured on two real projects: ranking by
 * fan-in put `src/types.ts` first in both, with seven and ten importers, and
 * the pre-pass called it "logic with no sibling test". Neither is useful.
 * Nobody writes a test for a type declaration, and fan-in measures the blast
 * radius of a BEHAVIOUR change — a module with no behaviour has none, however
 * many files import its shapes. Spending the first and most expensive dispatch
 * on it is spending it on the lowest-yield file in the project.
 */
function valueExports(code: string): string[] {
  const out = new Set<string>();
  const decl = /export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code)) !== null) if (m[1]) out.add(m[1]);
  return [...out];
}

/**
 * Exports that are CODE rather than data.
 *
 * A function or a class is logic; a const holding a literal is not. Measured on
 * a real project: LEDGER's `src/types.ts` exports
 * `export const CATEGORIES = [...]`, a list of category names, and the first
 * version of this rule called it "logic with no sibling test". Nobody writes a
 * test for a list of names, and a finding like that trains the reader to skim
 * the rest. A const counts only when it is initialised to a function.
 */
function logicExports(code: string): string[] {
  const out = new Set<string>();
  const fnDecl = /export\s+(?:async\s+)?(?:function\*?|class)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = fnDecl.exec(code)) !== null) if (m[1]) out.add(m[1]);
  // export const name = (…) => … | async (…) => … | function (…) { … }
  const fnConst = /export\s+(?:const|let|var)\s+(\w+)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)\s*(?::[^=]*)?=>|function\b|\w+\s*=>)/g;
  while ((m = fnConst.exec(code)) !== null) if (m[1]) out.add(m[1]);
  return [...out];
}

/** Does a sibling test exist? `src/lib/totals.ts` → `src/lib/totals.test.ts`,
 *  and the same with `.spec`. A test elsewhere in the project is not counted:
 *  the question is whether THIS module is covered, and a loose assertion in a
 *  component test is not that. Under-counts rather than over-counts. */
export function hasSiblingTest(path: string, files: Record<string, string>): boolean {
  const p = normalise(path);
  const base = p.replace(CODE_EXT_RE, "");
  for (const candidate of Object.keys(files).map(normalise)) {
    const cb = candidate.replace(CODE_EXT_RE, "");
    if (cb === `${base}.test` || cb === `${base}.spec`) return true;
  }
  return false;
}

/**
 * Enumerate the units, riskiest first.
 *
 * The score is deliberately a sum of three legible terms rather than anything
 * clever:
 *  - **size**, one point per 50 lines — a longer file hides more;
 *  - **fan-in**, one and a half points per importer — this is the term a reader
 *    of the file cannot see, and the reason the graph exists;
 *  - **untested logic**, three points — a module exporting non-component logic
 *    with no sibling test is the one place a bug is both likely and invisible.
 *
 * Test files are excluded as units. Reviewing the tests is a different job from
 * reviewing the code, and mixing them means the budget goes on assertions.
 */
export function enumerateUnits(
  files: Record<string, string>,
  graph?: ImportGraph,
): ReviewUnit[] {
  const g = graph ?? buildImportGraph(files);
  const units: ReviewUnit[] = [];

  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (!CODE_EXT_RE.test(path)) continue;
    if (TEST_FILE_RE.test(path)) continue;

    const lines = lineCount(content);
    const importedBy = g.importedBy[path] ?? [];
    const hasTest = hasSiblingTest(path, files);
    const values = valueExports(content);
    const hasLogic = logicExports(content).some((sym) => !looksLikeComponentExport(sym, content));
    // A module that exports only types has no runtime behaviour, so neither
    // fan-in nor "untested" means anything for it. Ranked by size alone.
    const typesOnly = values.length === 0 && /export\s+(?:type|interface|enum)\s/.test(content);

    const sizePoints = lines / 50;
    const fanInPoints = typesOnly ? 0 : importedBy.length * 1.5;
    const untestedPoints = hasLogic && !hasTest ? 3 : 0;
    const risk = sizePoints + fanInPoints + untestedPoints;

    const terms: Array<[number, string]> = [
      [fanInPoints, `${importedBy.length} file(s) import it`],
      [untestedPoints, "exports logic with no sibling test"],
      [sizePoints, typesOnly ? `${lines} lines of type declarations only` : `${lines} lines`],
    ];
    terms.sort((a, b) => b[0] - a[0]);
    const riskReason = terms[0]?.[0] === 0 ? "nothing notable" : (terms[0]?.[1] ?? "");

    units.push({ path, lines, importedBy, hasTest, hasLogic, risk, riskReason });
  }

  // Ties broken by path so two runs over the same project order identically —
  // a review whose order wanders cannot be diffed against a previous one.
  units.sort((a, b) => (b.risk - a.risk) || a.path.localeCompare(b.path));
  return units;
}

/** Assets are not code dependencies, and their presence cannot be judged from
 *  a set of source files. An `import "./styles.css"` is normal and correct. */
const ASSET_SPEC_RE = /\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|avif|woff2?|mp4|json)$/i;

/**
 * Could this specifier point at a real file that is simply not in the set we
 * were handed?
 *
 * Measured on two real projects, 2026-10-07: the first version of the
 * broken-import rule reported `./styles.css` and `./lib/utils` as unresolvable
 * in both. Both are REAL — the E2B template writes them into the sandbox, and
 * they are in `BAKED_FILES` precisely so the model cannot overwrite them. The
 * generated file set is therefore never the whole project, and a rule that
 * assumes otherwise accuses every single build of a broken import.
 */
/**
 * The files the E2B template writes into every sandbox.
 *
 * Copied rather than imported, and that is deliberate. The authority is
 * `BAKED_FILES` in `src/preview/e2b-service.ts`, but importing that module here
 * pulls the server's whole graph — config, Redis, the E2B SDK — into what has
 * to stay a pure function: measured, that import made this module hang when it
 * was loaded outside the server process. The drift risk it creates is covered
 * by a case in `scripts/review.test.ts` that reads that file as TEXT and
 * asserts every path in its list appears below, so the two cannot diverge
 * quietly.
 */
const TEMPLATE_OWNED = new Set([
  "package.json",
  "package-lock.json",
  "bun.lockb",
  "vite.config.ts",
  "vite.config.js",
  "tsconfig.json",
  "tsconfig.node.json",
  "index.html",
  "vitest.config.ts",
  "vitest.config.js",
  "vitest.setup.ts",
  "next.config.ts",
  "next.config.js",
  "next.config.mjs",
  "app.config.ts",
  ".env",
  ".env.example",
  "src/lib/utils.ts",
  "src/lib/queryClient.ts",
  "src/styles.css",
  // The Next.js variants, root-level with no src/ prefix. These two were
  // missed when the list was first copied, and the drift-guard case caught
  // them on its first run — which is the whole reason it exists.
  "lib/utils.ts",
  "lib/queryClient.ts",
]);

/** Exported for the drift-guard case in `scripts/review.test.ts`. */
export function templateOwnsFile(path: string): boolean {
  return TEMPLATE_OWNED.has(path);
}
const isTemplateOwnedFile = templateOwnsFile;

function existsOutsideTheSet(spec: string, fromPath: string): boolean {
  if (ASSET_SPEC_RE.test(spec)) return true;
  const dir = normalise(fromPath).split("/").slice(0, -1).join("/");
  const base = spec.startsWith("@/")
    ? `src/${spec.slice(2)}`
    : [...dir.split("/").filter(Boolean), ...spec.split("/")]
        .reduce<string[]>((acc, piece) => {
          if (piece === "" || piece === ".") return acc;
          if (piece === "..") { acc.pop(); return acc; }
          acc.push(piece);
          return acc;
        }, [])
        .join("/");
  if (isTemplateOwnedFile(base)) return true;
  for (const ext of [".ts", ".tsx", ".js", ".jsx", ".css"]) {
    if (isTemplateOwnedFile(base + ext)) return true;
  }
  return false;
}

/**
 * Everything worth saying that needs no model at all.
 *
 * A broken relative import is the sharpest of these: a specifier starting with
 * `.` or `@/` that resolves to no file anywhere cannot work, and that is a fact
 * rather than an opinion. Two exclusions keep it sound, both learned by running
 * it on real output: bare package specifiers are not flagged (`react` resolves
 * to no project file either, and flagging it would bury the real finding under
 * every dependency in the app), and neither is anything the TEMPLATE owns or
 * any non-code asset, because the generated file set is not the whole project.
 */
export function prePass(
  files: Record<string, string>,
  graph?: ImportGraph,
): PrePassFinding[] {
  const g = graph ?? buildImportGraph(files);
  const out: PrePassFinding[] = [];

  for (const [path, specs] of Object.entries(g.unresolved)) {
    for (const spec of specs) {
      if (!spec.startsWith(".") && !spec.startsWith("@/")) continue;
      if (existsOutsideTheSet(spec, path)) continue;
      out.push({
        path,
        kind: "broken-import",
        detail: `imports "${spec}", which is not a file in this project — this cannot resolve at runtime`,
      });
    }
  }

  for (const unit of enumerateUnits(files, g)) {
    if (unit.lines > OVERSIZED_LINES) {
      out.push({
        path: unit.path,
        kind: "oversized-file",
        detail: `${unit.lines} lines — too much for one file, and an edit to it risks the parts it did not mean to touch`,
      });
    }
    if (unit.hasLogic && !unit.hasTest && unit.importedBy.length > 0) {
      out.push({
        path: unit.path,
        kind: "untested-logic",
        detail: `exports logic that ${unit.importedBy.length} file(s) depend on, with no sibling test`,
      });
    }
  }

  for (const d of findDeadCode(files)) {
    out.push({ path: d.path, kind: "dead-code", detail: `${d.symbol}: ${d.detail}` });
  }

  return out;
}
