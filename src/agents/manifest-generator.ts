/**
 * Deterministic file manifest generator — no LLM, no AST library.
 * Extracts exports, route handlers, and infers purpose from path patterns.
 * Output is ~100-300 tokens and injected into the system prompt for edits.
 */

// ── Regex patterns ────────────────────────────────────────────────────────────

// export function/const/class/type/interface Foo
const EXPORT_RE = /export\s+(?:default\s+)?(?:async\s+)?(?:function|const|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;

// Hono: app.get('/path', ...) or api.post('/path', ...)
const HONO_ROUTE_RE = /(?:app|api|router)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

// Next.js App Router: export async function GET(
const NEXTJS_HANDLER_RE = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/g;

// FastAPI: @app.get('/path')
const FASTAPI_ROUTE_RE = /@app\s*\.\s*(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/g;

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
  let m: RegExpExecArray | null;
  EXPORT_RE.lastIndex = 0;
  while ((m = EXPORT_RE.exec(content)) !== null) {
    const name = m[1];
    if (name && !names.includes(name)) names.push(name);
  }
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
