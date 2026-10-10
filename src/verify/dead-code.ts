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

export type DeadCodeKind =
  | "unused-import"
  | "unreferenced-export"
  | "never-rendered"
  | "orphan-stylesheet";

export type DeadCodeFinding = {
  kind: DeadCodeKind;
  path: string;
  symbol: string;
  /** One line, written for the model that has to act on it. */
  detail: string;
};

/** Cap on what the TOOL PRINTS, not on what is found. The point of the cap is a
 *  readable list, and it used to truncate the scan itself — which silently
 *  truncated the recorded tally with it, so a large project's numbers came out
 *  lower than the truth. Measured: 91 files of this repo reported 12 unused
 *  imports under the old cap and 31 once the scan ran to completion. Counting
 *  and reporting are now separate. */
const MAX_REPORTED = 40;

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
 * This is a character scanner rather than a pair of regexes, and the reason is
 * a measured failure rather than tidiness. The regex version matched block
 * comments non-greedily across the whole file, and run over this repo's own
 * `build.ts` it deleted **45% of the file** — 154,668 characters down to
 * 85,224 — then reported `findDeadCode`, `CompletionAudit` and `requireAuth`
 * as unused imports while all three were plainly in use.
 *
 * The cause: a glob inside a STRING, such as a double-star followed by a slash
 * and a star, contains a block-comment opener. The regex treated it as one and
 * closed it at the next genuine comment terminator, swallowing every line in
 * between. Nothing in a 36-file sample of generated app code happened to
 * contain such a string, so the bug stayed invisible until the analyser was
 * pointed at a real backend.
 *
 * So the scanner tracks string state. It handles `'`, `"` and backticks with
 * backslash escapes, line comments and block comments. It deliberately does
 * NOT try to recognise regex literals: outside a string, `/*` can only be a
 * comment, because `a / *b` is not valid JavaScript — and a regex literal
 * cannot contain an unescaped `//` or `/*` either, since the first `/` would
 * end it. Template-literal interpolations are treated as part of the string, so
 * an identifier used only inside `${…}` is not counted — a missed finding,
 * which is the safe direction.
 */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i] as string;
    const next = i + 1 < n ? code[i + 1] : "";

    if (c === "/" && next === "/") {
      while (i < n && code[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i += 2;
      out += " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      // Kept verbatim: a name inside a string can only cause a missed finding,
      // and the point of tracking strings here is to stop their contents being
      // mistaken for comment delimiters.
      out += c;
      i++;
      while (i < n) {
        const ch = code[i] as string;
        out += ch;
        i++;
        if (ch === "\\") {
          if (i < n) { out += code[i]; i++; }
          continue;
        }
        if (ch === c) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
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
    // Guard against a malformed entry rather than trusting the type. This is
    // advisory analysis that runs at the end of EVERY build — throwing here
    // would turn a cosmetic report into a failed build, which is the one thing
    // it must never do.
    if (typeof content !== "string") continue;
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
    }
  }

  // ── 4. A stylesheet nothing imports ────────────────────────────────────────
  // Measured on the ASTERISK build, 2026-10-10. The model wrote a correct
  // `src/theme.css` — real oklch values, hue 264, a full .dark block — and then
  // never imported it, while ELEVEN of its files rendered through `bg-primary`
  // and `text-muted-foreground`. Those classes resolve through the template's
  // baked tokens, which are `oklch(L 0 0)`, i.e. greyscale. So the palette was
  // written, paid for, and did nothing: the app shipped black and white with
  // colour only where a Tailwind colour class was used directly.
  //
  // None of the three gates can see this. The page renders, CSS is not typed so
  // `check_types` passes, the tests pass, and the completion audit called the
  // build 18/18 proven because a palette nobody asked for in words is not an
  // extracted requirement. It is exactly the 2026-10-04 black-and-white bug
  // arriving through a different door — the prompt fix told the model to write
  // the file AND wire it, and it did half.
  //
  // A program answers this exactly, which is the test for belonging in this
  // module: either some file names the stylesheet or none does. Rules are
  // narrow for the usual reason — the response to a finding is editing code:
  // only generated stylesheets are considered (the template's own `styles.css`
  // is baked and imported by the template, and is not in this file set), and a
  // mention anywhere in any file counts as wiring, so a non-standard import
  // cannot be reported as dead.
  // Only a file that can actually IMPORT counts as wiring. "Any mention in any
  // file" was the first version of this rule and it was wrong within the hour:
  // the next build wrote its review report to `output.md`, that report named
  // `theme.css`, and the finding went quiet while the palette was still
  // unwired. A markdown file cannot import anything, and neither can JSON or a
  // lockfile — so prose that happens to contain the filename must not silence
  // the one check that catches a dead palette.
  const STYLESHEET_RE = /\.(css|scss|sass|less)$/;
  const CAN_IMPORT_RE = /\.(tsx?|jsx?|mts|mjs|cjs|css|scss|sass|less|html?|vue|svelte|astro)$/;
  for (const path of Object.keys(files)) {
    if (!STYLESHEET_RE.test(path)) continue;
    const base = path.split("/").pop() ?? path;
    const referenced = Object.entries(files).some(
      ([p, content]) => p !== path && CAN_IMPORT_RE.test(p) && content.includes(base),
    );
    if (referenced) continue;
    findings.push({
      kind: "orphan-stylesheet",
      path,
      symbol: base,
      detail:
        `written but no file imports it, so none of its rules apply — if it redefines design ` +
        `tokens, import it in src/index.tsx AFTER "./styles.css" or the app keeps the ` +
        `template's greyscale defaults`,
    });
  }

  return findings;
}

/** Counts for `build_outcome`, so "do edits leave dead code behind?" becomes a
 *  number instead of an impression. */
export function tallyDeadCode(findings: DeadCodeFinding[]): {
  unusedImports: number;
  unreferencedExports: number;
  neverRendered: number;
  orphanStylesheets: number;
} {
  let unusedImports = 0;
  let unreferencedExports = 0;
  let neverRendered = 0;
  let orphanStylesheets = 0;
  for (const f of findings) {
    if (f.kind === "unused-import") unusedImports += 1;
    else if (f.kind === "never-rendered") neverRendered += 1;
    else if (f.kind === "orphan-stylesheet") orphanStylesheets += 1;
    else unreferencedExports += 1;
  }
  return { unusedImports, unreferencedExports, neverRendered, orphanStylesheets };
}

/** The tool's reply. Phrased as a report with the reason attached, because a
 *  bare list invites the model to delete things it has not looked at — and the
 *  analysis is textual, so it has to look. */
export function formatDeadCode(findings: DeadCodeFinding[]): string {
  if (findings.length === 0) {
    return "No unused imports and no unreachable exports found. Nothing to clean up.";
  }
  const shown = findings.slice(0, MAX_REPORTED);
  const lines = [
    `${findings.length} thing(s) in this project are not reachable from anything else:`,
    "",
    ...shown.map((f) => `- ${f.path} — ${f.symbol}: ${f.detail}`),
    ...(findings.length > shown.length
      ? ["", `… and ${findings.length - shown.length} more, not listed.`]
      : []),
    "",
    "This analysis is textual, not a compiler, so confirm each one with read_file before " +
    "deleting it. An unused import is almost always safe to remove. An unreferenced export " +
    "may be reachable in a way this cannot see — if you are not sure, leave it.",
  ];
  return lines.join("\n");
}
