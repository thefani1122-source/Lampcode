/**
 * Deterministic file manifest generator — no LLM, no AST library.
 * Extracts exports, route handlers, and infers purpose from path patterns.
 * Output is ~100-300 tokens and injected into the system prompt for edits.
 */

// ── Regex patterns ────────────────────────────────────────────────────────────

// export function/const/class/type/interface Foo
const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;

// export { Foo, Bar as Baz } — named export lists, including re-exports
// (`export { Foo } from "./other"`). The name importers see is what's after
// `as` when present, otherwise the bare name.
const EXPORT_LIST_RE = /export\s+(?:type\s+)?\{([^}]+)\}/g;

// export default Foo; — bare identifier re-export (requires the trailing
// semicolon so `export default function Foo`/`export default class Foo` —
// already caught by EXPORT_RE — don't double-match here).
const EXPORT_DEFAULT_BARE_RE = /export\s+default\s+([A-Za-z_$][\w$]*)\s*;/g;

// Hono: app.get('/path', ...) or api.post('/path', ...)
const HONO_ROUTE_RE = /(?:app|api|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Next.js App Router: export async function GET(
const NEXTJS_HANDLER_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;

// FastAPI: @app.get('/path')
const FASTAPI_ROUTE_RE = /@app\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// import { A, B as C } from "./x"  |  import X from "./x"  — relative specifiers only
// (bare-package imports like "react" are irrelevant to intra-project wiring).
const IMPORT_RE = /import\s+(?:\{([^}]+)\}|(\w+))\s+from\s+['"](\.[^'"]+)['"]/g;

// ── Path → purpose inference ──────────────────────────────────────────────────

function inferPurpose(relPath: string): string {
  const lower = relPath.toLowerCase();
  const base = relPath.split("/").pop() ?? relPath;
  const name = base.replace(/\.[^.]+$/, "");

  if (lower.includes("app.tsx") || lower.includes("app.jsx")) return "Main app layout & routing";
  if (lower.includes("main.tsx") || lower.includes("main.jsx")) return "React entry point";
  if (lower.includes("index.tsx") || lower.includes("index.jsx")) return "Root entry";
  if (lower.includes("layout")) return "Layout wrapper";
  if (lower.includes("page")) return `Page — ${name}`;
  if (lower.includes("route") || lower.includes("router")) return "Route definitions";
  if (lower.includes("middleware")) return "Middleware";
  if (lower.includes("auth")) return "Authentication";
  if (lower.includes("db") || lower.includes("database") || lower.includes("schema")) return "Database schema / client";
  if (lower.includes("store") || lower.includes("state")) return "State management";
  if (lower.includes("hook")) return "React hook";
  if (lower.includes("context")) return "React context";
  if (lower.includes("util") || lower.includes("helper")) return "Utilities";
  if (lower.includes("type") || lower.includes("interface")) return "Type definitions";
  if (lower.includes("config")) return "Configuration";
  if (lower.includes("component") || /\/components\//i.test(relPath)) return `UI component — ${name}`;
  if (lower.includes("service")) return `Service — ${name}`;
  if (lower.includes("api") || lower.includes("server")) return `API handler — ${name}`;
  if (lower.endsWith(".css") || lower.endsWith(".scss")) return "Styles";
  if (lower.endsWith(".sql")) return "SQL migration";
  return name;
}

// ── Per-file extraction ───────────────────────────────────────────────────────

function extractExports(content: string): string[] {
  const names: string[] = [];
  const add = (name: string | undefined) => {
    if (name && !names.includes(name)) names.push(name);
  };

  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content)) !== null) add(m[1]);

  EXPORT_LIST_RE.lastIndex = 0;
  while ((m = EXPORT_LIST_RE.exec(content)) !== null) {
    for (const part of (m[1] as string).split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const segments = trimmed.split(/\s+as\s+/);
      add(segments[segments.length - 1]?.trim());
    }
  }

  EXPORT_DEFAULT_BARE_RE.lastIndex = 0;
  while ((m = EXPORT_DEFAULT_BARE_RE.exec(content)) !== null) add(m[1]);

  return names.slice(0, 6); // cap per-file to keep manifest compact
}

function extractRoutes(content: string): string[] {
  const routes: string[] = [];
  let m: RegExpExecArray | null;

  HONO_ROUTE_RE.lastIndex = 0;
  while ((m = HONO_ROUTE_RE.exec(content)) !== null) {
    routes.push(`${(m[1] as string).toUpperCase()} ${m[2]}`);
  }

  NEXTJS_HANDLER_RE.lastIndex = 0;
  while ((m = NEXTJS_HANDLER_RE.exec(content)) !== null) {
    routes.push(m[1] as string);
  }

  FASTAPI_ROUTE_RE.lastIndex = 0;
  while ((m = FASTAPI_ROUTE_RE.exec(content)) !== null) {
    routes.push(`${(m[1] as string).toUpperCase()} ${m[2]}`);
  }

  return routes.slice(0, 4);
}

// ── Orphan-export detection ─────────────────────────────────────────────────────
// "Component added but never wired in": a UI component file exports a name
// that no other file in the project ever imports. Deterministic, regex-based —
// no AST, consistent with the rest of this module.

interface ImportedNames {
  names: string[];
  specifier: string;
}

/** Every `import ... from "./relative/specifier"` in a file, with the imported names. */
function extractImportedNames(content: string): ImportedNames[] {
  const results: ImportedNames[] = [];
  let m: RegExpExecArray | null;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content)) !== null) {
    const named = m[1];
    const defaultName = m[2];
    const specifier = m[3];
    if (!specifier) continue;

    const names: string[] = [];
    if (named) {
      // "Foo, Bar as Baz" -> use the ORIGINAL exported name (Foo, Bar), not the local alias.
      for (const part of named.split(",")) {
        const trimmed = part.trim();
        if (!trimmed) continue;
        const original = trimmed.split(/\s+as\s+/)[0]?.trim();
        if (original) names.push(original);
      }
    }
    if (defaultName) names.push(defaultName);
    if (names.length > 0) results.push({ names, specifier });
  }
  return results;
}

/**
 * Resolve a relative import specifier to a known project file path.
 * "src/App.tsx" importing "./components/Header" -> tries
 * "src/components/Header", "src/components/Header.tsx", ".../Header/index.tsx", etc.
 */
function resolveImportSpecifier(
  fromPath: string,
  specifier: string,
  knownPaths: Set<string>,
): string | null {
  const fromDir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";
  const stack = fromDir ? fromDir.split("/") : [];
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  const base = stack.join("/");

  const candidates = [
    base,
    `${base}.tsx`,
    `${base}.ts`,
    `${base}.jsx`,
    `${base}.js`,
    `${base}/index.tsx`,
    `${base}/index.ts`,
  ];
  for (const c of candidates) {
    if (knownPaths.has(c)) return c;
  }
  return null;
}

export interface OrphanExport {
  path: string;
  name: string;
}

/**
 * Exported names from UI-component files that no other file in the project
 * imports. Scoped to files inferPurpose() classifies as "UI component —" —
 * entry points (App.tsx/main.tsx), backend handlers (registered via routes,
 * not imports), and utility/type files (legitimately different consumption
 * patterns) are excluded to keep false positives cheap.
 */
export function findOrphanExports(files: Record<string, string>): OrphanExport[] {
  const paths = Object.keys(files);
  const knownPaths = new Set(paths);

  // Every imported name, keyed by the file it resolves to.
  const importedByFile = new Map<string, Set<string>>();
  for (const p of paths) {
    for (const { names, specifier } of extractImportedNames(files[p] ?? "")) {
      const resolved = resolveImportSpecifier(p, specifier, knownPaths);
      if (!resolved) continue;
      let set = importedByFile.get(resolved);
      if (!set) importedByFile.set(resolved, (set = new Set()));
      for (const n of names) set.add(n);
    }
  }

  const orphans: OrphanExport[] = [];
  for (const p of paths) {
    if (!inferPurpose(p).startsWith("UI component")) continue;
    const exported = extractExports(files[p] ?? "");
    const imported = importedByFile.get(p) ?? new Set<string>();
    for (const name of exported) {
      if (!imported.has(name)) orphans.push({ path: p, name });
    }
  }
  return orphans;
}

// ── Public API ────────────────────────────────────────────────────────────────

const MANIFEST_HEADER = "FILE MANIFEST (auto-generated, current state):";

// Files to skip — build artifacts or large lock files
const SKIP_EXTENSIONS = new Set([".lock", ".log", ".map"]);
const SKIP_NAMES = new Set(["package-lock.json", "yarn.lock", "pnpm-lock.yaml"]);

/**
 * Generate a compact file manifest from project files.
 * Format: one line per file — path — purpose | exports: X, Y | routes: GET /x
 */
export function generateFileManifest(files: Record<string, string>): string {
  const lines: string[] = [MANIFEST_HEADER];

  const sorted = Object.keys(files).sort();

  for (const relPath of sorted) {
    const base = relPath.split("/").pop() ?? relPath;
    const ext = base.includes(".") ? `.${base.split(".").pop()}` : "";

    if (SKIP_EXTENSIONS.has(ext) || SKIP_NAMES.has(base)) continue;

    const content = files[relPath] ?? "";
    const purpose = inferPurpose(relPath);
    const exports = extractExports(content);
    const routes = extractRoutes(content);

    const parts: string[] = [`${relPath} — ${purpose}`];
    if (exports.length > 0) parts.push(`exports: ${exports.join(", ")}`);
    if (routes.length > 0) parts.push(`routes: ${routes.join(", ")}`);

    lines.push(parts.join(" | "));
  }

  return lines.join("\n");
}
