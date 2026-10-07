/**
 * Who imports whom, resolved to real paths.
 *
 * This is what makes a review of a large project affordable. The naive way to
 * review N files is to send all N with every question, which is quadratic and
 * spends most of its budget on code that has nothing to do with the file being
 * looked at. But a file cannot be judged alone either: whether a change to it
 * is safe depends on who calls it. The graph is the difference between those
 * two — it says exactly which other files are relevant to this one, so a review
 * unit can carry its own blast radius and nothing else.
 *
 * It is also the only honest basis for RANKING. A 300-line file nobody imports
 * is less dangerous than a 40-line one that eleven files depend on, and no
 * amount of reading either file tells you that.
 *
 * Textual, like the dead-code analyser, and for the same reason: a real module
 * resolver would mean a TypeScript program, and the cost of that is not worth
 * it for a fan-in count. What it does NOT do is guess — a specifier that does
 * not resolve to a file in the set is dropped rather than approximated, so the
 * counts are a floor, never an invention.
 */

const CODE_EXT = [".tsx", ".ts", ".jsx", ".js", ".mts", ".mjs"] as const;

export type ImportGraph = {
  /** path → the project files it imports. */
  imports: Record<string, string[]>;
  /** path → the project files that import it. The number that matters. */
  importedBy: Record<string, string[]>;
  /** Specifiers that are not project files: bare packages, plus anything
   *  relative that did not resolve. Kept so a caller can tell "no importers"
   *  apart from "we could not follow its imports". */
  unresolved: Record<string, string[]>;
};

function normalise(path: string): string {
  return path.replace(/^\.?\//, "");
}

/** Join a directory and a relative specifier, collapsing `.` and `..`. */
function joinPath(fromDir: string, spec: string): string {
  const parts = fromDir === "" ? [] : fromDir.split("/");
  for (const piece of spec.split("/")) {
    if (piece === "" || piece === ".") continue;
    if (piece === "..") parts.pop();
    else parts.push(piece);
  }
  return parts.join("/");
}

/**
 * Turn one import specifier into a path in the file set, or null.
 *
 * Handles what generated apps actually write: a relative path with or without
 * an extension, a directory with an `index.*` inside it, and the `@/` alias
 * that the template's tsconfig maps to `src/`. A bare package name resolves to
 * nothing, which is correct — `react` is not a file under review.
 */
export function resolveSpecifier(
  fromPath: string,
  spec: string,
  files: Set<string>,
): string | null {
  let base: string;
  if (spec.startsWith("@/")) {
    base = `src/${spec.slice(2)}`;
  } else if (spec.startsWith("./") || spec.startsWith("../")) {
    const dir = normalise(fromPath).split("/").slice(0, -1).join("/");
    base = joinPath(dir, spec);
  } else if (spec.startsWith("/")) {
    base = normalise(spec);
  } else {
    return null; // a bare package: not part of this project
  }

  if (files.has(base)) return base;
  for (const ext of CODE_EXT) {
    if (files.has(base + ext)) return base + ext;
  }
  for (const ext of CODE_EXT) {
    if (files.has(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  // An extensioned specifier that points at a .js file written as .ts on disk —
  // the ESM convention this repo itself uses.
  const swapped = base.replace(/\.js$/, "");
  if (swapped !== base) {
    for (const ext of CODE_EXT) {
      if (files.has(swapped + ext)) return swapped + ext;
    }
  }
  return null;
}

/** Every import specifier in a file, including side-effect imports and
 *  `export … from`, which creates a dependency just as an import does. */
export function importSpecifiers(code: string): string[] {
  const out: string[] = [];
  const patterns = [
    /(?:^|[\s;])import\s+(?:type\s+)?[^'";]*?\s+from\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;])import\s*['"]([^'"]+)['"]/g,
    /(?:^|[\s;])export\s+(?:type\s+)?(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(code)) !== null) if (m[1]) out.push(m[1]);
  }
  return out;
}

export function buildImportGraph(files: Record<string, string>): ImportGraph {
  const known = new Set(Object.keys(files).map(normalise));
  const imports: Record<string, string[]> = {};
  const importedBy: Record<string, string[]> = {};
  const unresolved: Record<string, string[]> = {};

  for (const key of known) {
    imports[key] = [];
    importedBy[key] = [];
    unresolved[key] = [];
  }

  for (const [rawPath, content] of Object.entries(files)) {
    const path = normalise(rawPath);
    const seen = new Set<string>();
    for (const spec of importSpecifiers(content)) {
      const target = resolveSpecifier(path, spec, known);
      if (target === null) {
        (unresolved[path] ??= []).push(spec);
        continue;
      }
      if (target === path || seen.has(target)) continue;
      seen.add(target);
      (imports[path] ??= []).push(target);
      (importedBy[target] ??= []).push(path);
    }
  }

  return { imports, importedBy, unresolved };
}
