/**
 * Tests whose source cannot supply the evidence a passing suite promises.
 * No execution and no model calls. A false positive dispatches a repair against
 * a correct test, so unreadable shapes are deliberately left alone. This does
 * not prove coverage or that a directly imported module is wired into the app.
 */
import { stripComments } from "./dead-code.js";

export type HollowTestKind =
  | "no-assertions"
  | "literal-assertion"
  | "imports-nothing"
  | "skipped-test"
  | "empty-test";

export type HollowTestFinding = {
  kind: HollowTestKind;
  path: string;
  symbol: string;
  /** One line, written for the model that has to fix it. */
  detail: string;
};

const MAX_REPORTED = 30;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;
type Token = { text: string; quoted: boolean };

/** Comments have already been removed by the shared scanner. Strings become
 * opaque tokens: fixtures containing test source must never become findings.
 * This is a small lexical reader, not a JavaScript parser. */
function tokens(code: string): Token[] | undefined {
  const out: Token[] = [];
  for (let i = 0; i < code.length;) {
    const c = code[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const start = i++;
      while (i < code.length && code[i] !== c) {
        // Interpolation can nest backticks and contain assertions. Without a
        // parser, hiding it could turn a meaningful assertion into an absence.
        if (c === "`" && code.slice(i, i + 2) === "${") return undefined;
        if (code[i] === "\\") i++;
        i++;
      }
      if (i >= code.length) return undefined; // incomplete generated source
      out.push({ text: code.slice(start, ++i), quoted: true });
      continue;
    }
    // Slash may start a regex, and < may start JSX. Guessing either boundary
    // can expose fixture text as calls; division/comparisons are missed too.
    if (c === "/" || c === "<" || c === "\\") return undefined;
    const word = /^[\w$]+/.exec(code.slice(i))?.[0];
    const text = word ?? (code.slice(i, i + 2) === "=>" ? "=>" : c);
    out.push({ text, quoted: false });
    i += text.length;
  }
  return out;
}

/** Balanced delimiters let us read only complete calls and callback bodies. */
function pairs(ts: Token[]): Map<number, number> | undefined {
  const stack: number[] = [];
  const out = new Map<number, number>();
  for (let i = 0; i < ts.length; i++) {
    const t = ts[i]!;
    if (t.quoted) continue;
    if (["(", "[", "{"].includes(t.text)) stack.push(i);
    else if ([")", "]", "}"].includes(t.text)) {
      const start = stack.pop();
      const opening: Record<string, string> = { ")": "(", "]": "[", "}": "{" };
      if (start === undefined || ts[start]!.text !== opening[t.text]) return undefined;
      out.set(start, i);
    }
  }
  return stack.length === 0 ? out : undefined;
}

/** Only primitive literal tokens count. Objects, expressions, templates and
 * signed numbers are left alone rather than evaluating JavaScript. */
function literal(t: Token | undefined): boolean {
  if (!t) return false;
  return t.quoted ? t.text[0] !== "`" : /^(?:true|false|null|\d+)$/.test(t.text);
}

export function findHollowTests(files: Record<string, string>): HollowTestFinding[] {
  const findings: HollowTestFinding[] = [];
  for (const [rawPath, content] of Object.entries(files)) {
    const path = rawPath.replace(/\\/g, "/").replace(/^\.?\//, "");
    if (!TEST_FILE_RE.test(path)) continue; // helpers and application code are not tests
    if (typeof content !== "string") continue; // malformed advisory input must not fail a build
    const ts = tokens(stripComments(content));
    if (!ts) continue; // lexical ambiguity: absence is not evidence
    const ends = pairs(ts);
    if (!ends) continue; // incomplete syntax cannot establish a test's boundaries
    const at = (i: number) => ts[i]?.quoted ? "STRING" : ts[i]?.text;
    const bare = ts.map((t) => t.quoted ? "STRING" : t.text).join(" ");
    // An imported lookalike may be an application's own API. Only recognised
    // runners establish the meaning of imported test/expect names.
    let customRunner = false;
    for (let i = 0; i < ts.length; i++) {
      if (at(i) !== "import" || at(i + 1) === "(") continue;
      let end = i + 1;
      while (end < ts.length && !ts[end]?.quoted && at(end) !== ";") end++;
      const names = ts.slice(i + 1, end).map((t) => t.text);
      const source = ts[end]?.text.slice(1, -1);
      if (names.some((n) => ["it", "test", "describe", "xit", "xdescribe", "expect"].includes(n)) &&
          !["vitest", "@jest/globals", "node:test", "mocha"].includes(source ?? "")) customRunner = true;
    }
    if (customRunner) continue; // resolving the custom runner requires more than source text
    // Local bindings, parameters, aliases and assignments can redefine the
    // familiar APIs. Scope resolution is outside this textual analyser.
    if (/(?:const|let|var|function|class)\s+(?:it|test|describe|xit|xdescribe|expect)\b|\b(?:it|test|describe|xit|xdescribe|expect)\s*=|\bas\s+(?:it|test|describe|xit|xdescribe|expect)\b|(?:\(|,)\s*(?:it|test|describe|xit|xdescribe|expect)\s*[,):]/.test(bare)) continue;
    const add = (kind: HollowTestKind, symbol: string, detail: string) => findings.push({ kind, path, symbol, detail });
    let blocks = 0;
    for (let i = 0; i < ts.length; i++) {
      const name = at(i);
      if (!["it", "test", "describe", "xit", "xdescribe"].includes(name ?? "")) continue;
      // Only standalone statements; object methods and other expression forms
      // may use the same names without being test-runner APIs.
      if (i > 0 && ![";", "{", "}"].includes(at(i - 1) ?? "")) continue;
      const modifier = at(i + 1) === "." ? at(i + 2) : undefined;
      const open = i + (modifier ? 3 : 1);
      if (at(open) !== "(" || !ends.has(open) || !ts[open + 1]?.quoted) continue; // dynamic titles/chains are not resolved
      const end = ends.get(open)!;
      const skipped = name === "xit" || name === "xdescribe" || modifier === "skip" || ((name === "it" || name === "test") && modifier === "todo");
      if (skipped) add("skipped-test", `${name}${modifier ? `.${modifier}` : ""}`, "left disabled or unfinished — implement the intended check and enable it");
      if (modifier || (name !== "it" && name !== "test") || at(open + 2) !== ",") continue; // only direct active test callbacks
      let cb = open + 3;
      if (at(cb) === "async") cb++;
      if (at(cb) === "function") cb++;
      else if (at(cb) !== "(") continue; // named callbacks may assert elsewhere
      if (at(cb) !== "(" || ends.get(cb) !== cb + 1) continue; // parameters may inject assertion tools or run default expressions
      cb += 2;
      if (at(cb) === "=>") cb++;
      if (at(cb) !== "{" || ends.get(cb) !== end - 1) continue; // expression callbacks, options and timeouts are not guessed at
      blocks++;
      if (ends.get(cb) === cb + 1) add("empty-test", name, "callback has no statements — exercise the app and check its result");
    }
    if (blocks === 0) continue; // custom harnesses and fixture-only files are outside these file-wide rules
    // Import bindings name the assertion function but are not assertions.
    const imports = new Set<number>();
    for (let i = 0; i < ts.length; i++) {
      if (at(i) !== "import" || at(i + 1) === "(") continue;
      let end = i + 1;
      while (end < ts.length && !ts[end]?.quoted && at(end) !== ";") end++;
      for (let j = i; j <= end; j++) imports.add(j);
    }
    const expects = ts.flatMap((t, i) => !imports.has(i) && !t.quoted && t.text === "expect" ? [i] : []);
    // Other assertion APIs and helpers can throw on failure. No expect call
    // alone cannot prove such a test is hollow.
    const alternate = /\b(?:assert\w*|check|ok|should|fail|throws)\b/i.test(bare);
    if (expects.length === 0 && !alternate) add("no-assertions", "it/test", "test blocks contain no expectation — add a check of actual application behaviour");
    const allLiteral = expects.length > 0 && expects.every((i) =>
      at(i - 1) !== "." && at(i + 1) === "(" && literal(ts[i + 2]) && at(i + 3) === ")" &&
      at(i + 4) === "." && ["toBe", "toEqual", "toStrictEqual"].includes(at(i + 5) ?? "") &&
      at(i + 6) === "(" && literal(ts[i + 7]) && at(i + 8) === ")" &&
      [";", "}"].includes(at(i + 9) ?? ""));
    // One unknown expectation defeats the universal claim, including imported
    // expect bindings, custom matchers and computed values on either side.
    if (allLiteral && !alternate) add("literal-assertion", "expect", "every expectation compares two literals — assert a result produced by the app instead");
    // Any non-runner string might name a relative/aliased import, fixture,
    // URL or file read. Recognise imports conservatively, including require
    // and dynamic imports, rather than declaring an unknown source external.
    const possibleProject = ts.some((t) => t.quoted && /^(?:['"])(?:\.|@|~|#|\/)/.test(t.text)) ||
      /\b(?:require|fetch|readFile\w*|import\s*\(|page|browser|request)\b/.test(bare) ||
      ts.some((t, i) => t.quoted && (at(i - 1) === "from" || at(i - 1) === "import") && !["'vitest'", '"vitest"', "'@jest/globals'", '"@jest/globals"'].includes(t.text));
    if (!possibleProject) add("imports-nothing", "it/test", "no project import is present — exercise real application code instead of only local stand-ins");
  }
  return findings;
}

export type HollowTestTally = { noAssertions: number; literalAssertions: number; importsNothing: number; skippedTests: number; emptyTests: number; total: number };
const TALLY_FIELD: Record<HollowTestKind, keyof Omit<HollowTestTally, "total">> = {
  "no-assertions": "noAssertions", "literal-assertion": "literalAssertions", "imports-nothing": "importsNothing", "skipped-test": "skippedTests", "empty-test": "emptyTests",
};
export function tallyHollowTests(findings: HollowTestFinding[]): HollowTestTally {
  const t: HollowTestTally = { noAssertions: 0, literalAssertions: 0, importsNothing: 0, skippedTests: 0, emptyTests: 0, total: 0 };
  for (const f of findings) { t[TALLY_FIELD[f.kind]]++; t.total++; }
  return t;
}

export function formatHollowTests(findings: HollowTestFinding[]): string {
  if (findings.length === 0) return "Nothing hollow found in the test shapes this analysis understands.";
  const shown = findings.slice(0, MAX_REPORTED);
  return [
    `${findings.length} hollow test finding(s):`, "",
    ...shown.map((f) => `- ${f.path} — ${f.symbol}: ${f.detail}`),
    ...(findings.length > shown.length ? ["", `… and ${findings.length - shown.length} more, not listed.`] : []), "",
    "Read each file and confirm the finding before changing it. Exercise real application behaviour and assert its result. Do not satisfy a finding by deleting, disabling or weakening a test. Leave uncertain cases alone. A clean report does not prove coverage or that the app uses the tested module.",
  ].join("\n");
}

const HUMAN: Record<HollowTestKind, string> = {
  "no-assertions": "test groups that do not check a result",
  "literal-assertion": "test groups that only compare fixed values",
  "imports-nothing": "test groups that do not bring in application code",
  "skipped-test": "checks left disabled or unfinished",
  "empty-test": "checks with nothing inside them",
};
/** Only fixed prose and counts reach the user; source text stays in the repair prompt. */
export function formatHollowTestsForUser(findings: HollowTestFinding[]): string[] {
  if (findings.length === 0) return [];
  const counts = new Map<HollowTestKind, number>();
  for (const f of findings) counts.set(f.kind, (counts.get(f.kind) ?? 0) + 1);
  return ["Some checks still need work before they can give confidence in the app:", ...[...counts].map(([kind, n]) => `  • ${HUMAN[kind]} (${n})`)];
}
