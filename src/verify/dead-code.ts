/**
 * What in this project is not reachable from anything else.
 *
 * This exists because of the shape of the edit tool. `edit_file(old → new)` is
 * additive by nature: the cheapest way to satisfy "add X" is to insert X, and
 * removing the path that X replaced requires knowing what just became
 * unreachable. The model cannot know that — reachability is a whole-program
 * property and an edit sees one file — so the old path stays, and after a few
 * edits one feature has two implementations and the next edit has to guess
 * which is live. It guesses wrong.
 *
 * So this is deliberately NOT a model pass. It is the one question in this area
 * that a program can answer exactly and a language model cannot answer at all,
 * and it costs nothing to ask.
 *
 * **It is advisory, never a gate.** The analysis is textual, not a real
 * TypeScript program, so it can be wrong — and the response to a dead-code
 * report is deleting code, which is the most expensive thing to be wrong
 * about. Every rule below is therefore written to under-report: anything
 * uncertain is left out rather than guessed at. A missed dead symbol costs a
 * few lines; a wrongly reported live one costs a working app.
 */

export type DeadCodeKind = "unused-import" | "unreferenced-export" | "never-rendered";

export type DeadCodeFinding = {
  kind: DeadCodeKind;
  path: string;
  symbol: string;
  /** One line, written for the model that has to act on it. */
  detail: string;
};

/** Cap, so a large project reports a readable list rather than a flood. The
 *  point is to start a cleanup, not to enumerate every last line. */
const MAX_FINDINGS = 40;

/** Files whose exports are consumed by the framework rather than by project
 *  code, so "nothing imports it" is the normal state and not a finding. */
const ENTRY_FILES = new Set([
  "src/index.tsx",
  "src/index.ts",
  "src/main.tsx",
  "src/main.ts",
  "src/App.tsx",
  "src/router.tsx",
  "vitest.setup.ts",
]);

const CODE_EXT_RE = /\.(tsx?|jsx?|mts|mjs)$/;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

function isCode(path: string): boolean {
  return CODE_EXT_RE.test(path);
}

function normalise(path: string): string {
  return path.replace(/^\.?\//, "");
}

/**
 * Remove comments so a name mentioned in a comment does not count as a use.
 *
 * Block comments first, then line comments — and the line-comment pattern
 * requires the `//` not to be preceded by `:`, so `https://…` inside a string
 * survives. Strings are deliberately NOT stripped: a symbol named inside a
 * string is rare, and leaving them in can only cause a missed finding, which
 * is the safe direction here.
 */
export function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:/])\/\/[^\n]*/g, "$1");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Whole-word occurrences of an identifier. Counting, not just testing, so the
 *  import line itself can be discounted. */
export function identifierCount(code: string, name: string): number {
  if (name === "") return 0;
  const re = new RegExp(`\\b${escapeRe(name)}\\b`, "g");
  return (code.match(re) ?? []).length;
}

export type ImportBinding = { local: string; source: string };

/**
 * The bindings an import statement brings into scope, and where from.
 *
 * Handles the four shapes that appear in generated code: named with and
 * without `as`, default, namespace, and `import type`. A side-effect import
 * (`import "./x.css"`) binds nothing and yields nothing, which is correct —
 * it is not dead merely because no identifier refers to it.
 */
export function parseImports(code: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const re = /import\s+(type\s+)?([^'";]+?)\s+from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    const clause = (m[2] ?? "").trim();
    const source = m[3] ?? "";
    // Named group: { a, b as c }
    const braced = /\{([^}]*)\}/.exec(clause);
    if (braced) {
      for (const part of (braced[1] ?? "").split(",")) {
        const piece = part.trim().replace(/^type\s+/, "");
        if (piece === "") continue;
        const asMatch = /\s+as\s+(\w+)$/.exec(piece);
        const local = asMatch ? (asMatch[1] ?? "") : piece;
        if (/^\w+$/.test(local)) out.push({ local, source });
      }
    }
    // Default and/or namespace, i.e. whatever sits outside the braces.
    const outside = clause.replace(/\{[^}]*\}/, "").replace(/^,|,$/g, "").trim();
    for (const part of outside.split(",")) {
      const piece = part.trim();
      if (piece === "") continue;
      const ns = /^\*\s+as\s+(\w+)$/.exec(piece);
      const local = ns ? (ns[1] ?? "") : piece;
      if (/^\w+$/.test(local)) out.push({ local, source });
    }
  }
  return out;
}

/**
 * Named exports declared in a file.
 *
 * DEFAULT exports are deliberately excluded. A default import can be given any
 * local name at the import site, so proving one is unreferenced means resolving
 * module paths — and getting that wrong deletes an entry point. Named exports
 * are checkable by name, which is the whole reason the rule is restricted to
 * them.
 */
export function parseNamedExports(code: string): string[] {
  const out = new Set<string>();

  // export (const|let|function|class|type|interface|enum) Name
  const decl = /export\s+(?:async\s+)?(?:const|let|var|function\*?|class|type|interface|enum)\s+(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(code)) !== null) if (m[1]) out.add(m[1]);

  // export { a, b as c } — the EXPORTED name is what another file imports.
  const braced = /export\s*\{([^}]*)\}/g;
  while ((m = braced.exec(code)) !== null) {
    for (const part of (m[1] ?? "").split(",")) {
      const piece = part.trim().replace(/^type\s+/, "");
      if (piece === "") continue;
      const asMatch = /\s+as\s+(\w+)$/.exec(piece);
      const name = asMatch ? (asMatch[1] ?? "") : piece;
      if (/^\w+$/.test(name) && name !== "default") out.add(name);
    }
  }
  return [...out];
}

/** Strip import statements, so counting an identifier measures USES of it
 *  rather than the line that brought it in. */
function withoutImports(code: string): string {
  return code
    .replace(/import\s+(?:type\s+)?[^'"；;]*?\s+from\s*['"][^'"]+['"]\s*;?/g, " ")
    .replace(/import\s*['"][^'"]+['"]\s*;?/g, " ");
}

/**
 * Everything not reachable from anything else, as far as text can tell.
 *
 * Three rules, each chosen because it is hard to get wrong:
 *
 *  1. **unused-import** — the identifier appears nowhere in the file outside
 *     its own import. Highest precision of the three: it is local, so no module
 *     resolution is involved, and a binding that is never mentioned again
 *     cannot be in use.
 *  2. **unreferenced-export** — a NAMED export whose name appears in no other
 *     file in the project. Entry files are excluded (the framework consumes
 *     those), and test files count as references, which under-reports on
 *     purpose: a symbol used only by its own test is arguably dead, but
 *     deleting it on that basis also deletes a passing test.
 *  3. **never-rendered** — rule 2, where the symbol is a component. Reported
 *     under its own name because it is the one the model acts on differently:
 *     a component nobody renders is usually a view that an edit replaced and
 *     left behind.
 */
export function findDeadCode(files: Record<string, string>): DeadCodeFinding[] {
  const code: Record<string, string> = {};
  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (!isCode(path)) continue;
    code[path] = stripComments(content);
  }

  const findings: DeadCodeFinding[] = [];

  // ── 1. Imports that are never used ─────────────────────────────────────────
  for (const [path, stripped] of Object.entries(code)) {
    const body = withoutImports(stripped);
    const seen = new Set<string>();
    for (const { local, source } of parseImports(stripped)) {
      if (seen.has(local)) continue;
      seen.add(local);
      if (identifierCount(body, local) > 0) continue;
      findings.push({
        kind: "unused-import",
        path,
        symbol: local,
        detail: `imported from "${source}" and never used in this file — delete the import`,
      });
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }

  // ── 2 & 3. Exports nothing imports ─────────────────────────────────────────
  for (const [path, stripped] of Object.entries(code)) {
    if (ENTRY_FILES.has(path)) continue;
    if (TEST_FILE_RE.test(path)) continue;

    for (const symbol of parseNamedExports(stripped)) {
      let referenced = false;
      for (const [otherPath, otherCode] of Object.entries(code)) {
        if (otherPath === path) continue;
        if (identifierCount(otherCode, symbol) > 0) {
          referenced = true;
          break;
        }
      }
      if (referenced) continue;

      // A component is a capitalised export in a file that returns markup. The
      // JSX test keeps a plain capitalised constant (MAX_ENTRIES, API_URL) out
      // of the component bucket.
      const isComponent =
        /^[A-Z]/.test(symbol) &&
        !/^[A-Z0-9_]+$/.test(symbol) &&
        /return\s*\(?\s*</.test(stripped);

      findings.push(
        isComponent
          ? {
              kind: "never-rendered",
              path,
              symbol,
              detail:
                `exported but never rendered or imported anywhere — usually a view that an ` +
                `edit replaced and left behind`,
            }
          : {
              kind: "unreferenced-export",
              path,
              symbol,
              detail: "exported but no other file imports it",
            },
      );
      if (findings.length >= MAX_FINDINGS) return findings;
    }
  }

  return findings;
}

/** Counts for `build_outcome`, so "do edits leave dead code behind?" becomes a
 *  number instead of an impression. */
export function tallyDeadCode(findings: DeadCodeFinding[]): {
  unusedImports: number;
  unreferencedExports: number;
  neverRendered: number;
} {
  let unusedImports = 0;
  let unreferencedExports = 0;
  let neverRendered = 0;
  for (const f of findings) {
    if (f.kind === "unused-import") unusedImports += 1;
    else if (f.kind === "never-rendered") neverRendered += 1;
    else unreferencedExports += 1;
  }
  return { unusedImports, unreferencedExports, neverRendered };
}

/** The tool's reply. Phrased as a report with the reason attached, because a
 *  bare list invites the model to delete things it has not looked at — and the
 *  analysis is textual, so it has to look. */
export function formatDeadCode(findings: DeadCodeFinding[]): string {
  if (findings.length === 0) {
    return "No unused imports and no unreachable exports found. Nothing to clean up.";
  }
  const lines = [
    `${findings.length} thing(s) in this project are not reachable from anything else:`,
    "",
    ...findings.map((f) => `- ${f.path} — ${f.symbol}: ${f.detail}`),
    "",
    "This analysis is textual, not a compiler, so confirm each one with read_file before " +
    "deleting it. An unused import is almost always safe to remove. An unreferenced export " +
    "may be reachable in a way this cannot see — if you are not sure, leave it.",
  ];
  return lines.join("\n");
}
