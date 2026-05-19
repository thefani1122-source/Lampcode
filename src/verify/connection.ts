/**
 * Connection Verifier — checks frontend/backend/DB consistency.
 * Pure module: no DB, no network, no config imports.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Relative-path → file content */
export type FileTree = Map<string, string>;

export interface ConnectionCheck {
  id: string;
  status: "pass" | "fail" | "warn" | "skip";
  detail: string;
}

export interface ConnectionReport {
  passed: boolean;
  checks: ConnectionCheck[];
}

// ── Workspace reader ──────────────────────────────────────────────────────────

const WORKSPACE_BASE = join(process.cwd(), "workspace");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".next", ".nuxt", "coverage"]);

async function collectFiles(base: string, dir: string, tree: FileTree): Promise<void> {
  let entries: string[];
  try { entries = await readdir(dir); }
  catch { return; }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const s = await stat(full).catch(() => null);
    if (!s) continue;
    if (s.isDirectory()) {
      await collectFiles(base, full, tree);
    } else {
      const rel = full.slice(base.length + 1);
      tree.set(rel, await readFile(full, "utf8").catch(() => ""));
    }
  }
}

async function readWorkspaceFiles(projectId: string): Promise<FileTree> {
  const root = join(WORKSPACE_BASE, projectId);
  const tree: FileTree = new Map();
  await collectFiles(root, root, tree);
  return tree;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRouteFile(path: string): boolean {
  return (path.includes("/routes/") || path.includes("/api/")) &&
    (path.endsWith(".ts") || path.endsWith(".js"));
}

function isFrontendFile(path: string): boolean {
  return (
    path.includes("/components/") ||
    path.includes("/pages/") ||
    path.includes("/app/") ||
    path.includes("/views/") ||
    path.endsWith(".tsx") ||
    path.endsWith(".jsx")
  );
}

// ── 1. checkApiContracts ──────────────────────────────────────────────────────

export function checkApiContracts(files: FileTree): ConnectionCheck {
  // Extract backend route definitions
  const backendPaths = new Set<string>();
  const routePattern = /\.(get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`\s]+)["'`]/g;

  for (const [path, content] of files) {
    if (!isRouteFile(path)) continue;
    let m: RegExpExecArray | null;
    while ((m = routePattern.exec(content)) !== null) {
      if (m[2]) backendPaths.add(m[2]);
    }
  }

  // Extract frontend fetch/axios calls
  interface FrontendCall { path: string; file: string; line: number; }
  const frontendCalls: FrontendCall[] = [];

  const fetchRe = /fetch\s*\(\s*["'`](\/api\/[^"'`\s]+)["'`]/g;
  const axiosRe = /axios\s*\.\s*(?:get|post|put|patch|delete)\s*\(\s*["'`](\/api\/[^"'`\s]+)["'`]/g;

  for (const [path, content] of files) {
    if (!isFrontendFile(path)) continue;
    const ls = content.split("\n");
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i] ?? "";
      for (const re of [fetchRe, axiosRe]) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          if (m[1]) frontendCalls.push({ path: m[1], file: path, line: i + 1 });
        }
      }
    }
  }

  if (backendPaths.size === 0 && frontendCalls.length === 0) {
    return { id: "api-contracts", status: "skip", detail: "No routes or frontend API calls found" };
  }

  // Normalize dynamic segments for matching (/api/users/123 → /api/users/:id)
  const normalize = (p: string) => p.replace(/\/[a-f0-9-]{8,}|\/\d+/g, "/:id");

  const unmatched = frontendCalls.filter(({ path }) => {
    const norm = normalize(path);
    return ![...backendPaths].some((bp) => bp === path || normalize(bp) === norm);
  });

  if (unmatched.length > 0) {
    const paths = [...new Set(unmatched.map((u) => u.path))];
    return {
      id: "api-contracts",
      status: "fail",
      detail: `Frontend calls have no matching backend route: ${paths.join(", ")}`,
    };
  }

  return {
    id: "api-contracts",
    status: "pass",
    detail: `${frontendCalls.length} frontend call(s) matched against ${backendPaths.size} backend route(s)`,
  };
}

// ── 2. checkSchemaMatch ───────────────────────────────────────────────────────

export function checkSchemaMatch(files: FileTree): ConnectionCheck {
  const schemaFiles = [...files].filter(([p]) =>
    (p.includes("schema") || p.includes("migration")) &&
    (p.endsWith(".ts") || p.endsWith(".js") || p.endsWith(".sql")),
  );

  if (schemaFiles.length === 0) {
    return { id: "schema-match", status: "skip", detail: "No schema or migration files found" };
  }

  // Extract Drizzle table variable names
  const pgTableRe = /export\s+const\s+(\w+)\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g;
  const tableVars = new Map<string, string>(); // TS var → SQL table name
  const schemaContent = schemaFiles.map(([, c]) => c).join("\n");

  let m: RegExpExecArray | null;
  while ((m = pgTableRe.exec(schemaContent)) !== null) {
    if (m[1] && m[2]) tableVars.set(m[1], m[2]);
  }

  if (tableVars.size === 0) {
    return { id: "schema-match", status: "skip", detail: "No Drizzle pgTable definitions found" };
  }

  // Find all column names declared in schema (text("col_name"), integer("col_name"), etc.)
  const colRe = /(?:text|integer|boolean|timestamp|jsonb|doublePrecision|uuid|varchar|serial)\s*\(\s*["']([^"']+)["']/g;
  const schemaColumns = new Set<string>();
  while ((m = colRe.exec(schemaContent)) !== null) {
    if (m[1]) schemaColumns.add(m[1]);
  }

  // Check query files: look for tableVar.columnAccess that doesn't appear in schema columns
  const DRIZZLE_API = new Set([
    "where", "select", "from", "set", "limit", "offset", "orderBy",
    "groupBy", "having", "join", "leftJoin", "rightJoin", "fullJoin",
    "insert", "update", "delete", "values", "returning", "onConflict",
  ]);

  const mismatches: string[] = [];

  for (const [path, content] of files) {
    if (schemaFiles.some(([sp]) => sp === path)) continue;
    if (!path.endsWith(".ts") && !path.endsWith(".js")) continue;

    for (const [tableVar] of tableVars) {
      if (!content.includes(tableVar)) continue;
      const accessRe = new RegExp(`\\b${tableVar}\\.(\\w+)`, "g");
      while ((m = accessRe.exec(content)) !== null) {
        const col = m[1] ?? "";
        if (DRIZZLE_API.has(col)) continue;
        // Column should appear as a declared name in schema
        if (!schemaColumns.has(col) && !schemaContent.includes(col + ":") && !schemaContent.includes(`: ${col}`)) {
          const key = `${tableVar}.${col} (${path})`;
          if (!mismatches.includes(key)) mismatches.push(key);
        }
      }
    }
  }

  if (mismatches.length > 0) {
    return {
      id: "schema-match",
      status: "warn",
      detail: `Possible schema mismatches (verify manually): ${mismatches.slice(0, 3).join("; ")}`,
    };
  }

  return {
    id: "schema-match",
    status: "pass",
    detail: `Schema fields verified across ${tableVars.size} table(s)`,
  };
}

// ── 3. checkAuthFlow ──────────────────────────────────────────────────────────

export function checkAuthFlow(files: FileTree): ConnectionCheck {
  const allContent = [...files.values()].join("\n");

  const hasLogin =
    /\.(post|get)\s*\(\s*["'`][^"'`]*(?:login|signin|sign-in)[^"'`]*["'`]/.test(allContent) ||
    /auth\s*\.\s*(?:signIn|login)\s*\(/.test(allContent) ||
    /["'`]\/api\/auth["'`]/.test(allContent);

  const hasMiddleware =
    allContent.includes("requireAuth") ||
    allContent.includes("authenticate") ||
    /(?:jwt|token|session).*(?:verify|validate)/i.test(allContent);

  const hasProtected =
    hasMiddleware &&
    /\.(get|post|put|patch|delete)\s*\(/.test(allContent);

  const has401 = /(?:\b401\b|UNAUTHORIZED|Not authenticated|Unauthorized)/.test(allContent);

  if (!hasLogin) {
    return { id: "auth-flow", status: "warn", detail: "No login/signin endpoint detected" };
  }
  if (!hasMiddleware) {
    return { id: "auth-flow", status: "fail", detail: "Login endpoint found but no auth middleware (requireAuth/authenticate)" };
  }
  if (!hasProtected) {
    return { id: "auth-flow", status: "warn", detail: "Auth middleware present but no protected routes detected" };
  }
  if (!has401) {
    return { id: "auth-flow", status: "warn", detail: "Auth flow present but no 401 response for invalid tokens found" };
  }
  return { id: "auth-flow", status: "pass", detail: "Auth flow complete: login → token → protected routes → 401 on invalid" };
}

// ── 4. checkEnvVars ──────────────────────────────────────────────────────────

const ALWAYS_OK = new Set([
  "NODE_ENV", "PORT", "HOST", "DEBUG", "LOG_LEVEL", "TZ",
  "HOSTNAME", "PWD", "HOME", "USER", "PATH",
]);

export function checkEnvVars(files: FileTree): ConnectionCheck {
  const envRe = /process\.env\.([A-Z_][A-Z0-9_]*)|import\.meta\.env\.([A-Z_][A-Z0-9_]*)/g;
  const referenced = new Set<string>();

  for (const [path, content] of files) {
    if (![".ts", ".js", ".tsx", ".jsx"].some((e) => path.endsWith(e))) continue;
    let m: RegExpExecArray | null;
    envRe.lastIndex = 0;
    while ((m = envRe.exec(content)) !== null) {
      const v = m[1] ?? m[2] ?? "";
      if (v && !ALWAYS_OK.has(v)) referenced.add(v);
    }
  }

  if (referenced.size === 0) {
    return { id: "env-vars", status: "skip", detail: "No non-standard environment variables referenced" };
  }

  // Collect documented vars from .env.example / vercel.json
  const declared = new Set<string>();
  const envExample = files.get(".env.example") ?? files.get(".env.sample") ?? files.get(".env.template");
  if (envExample) {
    const lineRe = /^([A-Z_][A-Z0-9_]*)=/gm;
    let m: RegExpExecArray | null;
    while ((m = lineRe.exec(envExample)) !== null) { if (m[1]) declared.add(m[1]); }
  }
  const vercelJson = files.get("vercel.json");
  if (vercelJson) {
    try {
      const vj = JSON.parse(vercelJson) as { env?: Record<string, unknown> };
      for (const key of Object.keys(vj.env ?? {})) declared.add(key);
    } catch { /* ignore */ }
  }

  if (declared.size === 0) {
    return {
      id: "env-vars",
      status: "warn",
      detail: `No .env.example or vercel.json — ${referenced.size} var(s) undocumented: ${[...referenced].slice(0, 5).join(", ")}`,
    };
  }

  const missing = [...referenced].filter((v) => !declared.has(v));
  if (missing.length > 0) {
    return {
      id: "env-vars",
      status: "fail",
      detail: `Env vars in code but missing from deploy checklist: ${missing.join(", ")}`,
    };
  }

  return {
    id: "env-vars",
    status: "pass",
    detail: `All ${referenced.size} env var(s) documented in deploy checklist`,
  };
}

// ── 5. checkNoLocalhost ───────────────────────────────────────────────────────

export function checkNoLocalhost(files: FileTree): ConnectionCheck {
  const DEV_PATHS = [
    ".env.local", ".env.development", "test", "spec", "mock",
    "fixture", "README", "__tests__", ".storybook",
  ];

  const hits: Array<{ file: string; line: number }> = [];

  for (const [path, content] of files) {
    if (DEV_PATHS.some((d) => path.includes(d))) continue;
    if (![".ts", ".js", ".tsx", ".jsx", ".json", ".env"].some((e) => path.endsWith(e))) continue;

    const ls = content.split("\n");
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i] ?? "";
      if (/^\s*(?:\/\/|#|\*)/.test(line)) continue; // skip comments
      if (/localhost|127\.0\.0\.1/.test(line)) {
        hits.push({ file: path, line: i + 1 });
      }
    }
  }

  if (hits.length > 0) {
    const h = hits[0]!;
    return {
      id: "no-localhost",
      status: "fail",
      detail: `Hardcoded localhost at ${h.file}:${h.line} — use env vars for base URLs`,
    };
  }
  return { id: "no-localhost", status: "pass", detail: "No hardcoded localhost URLs in production files" };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runConnectionChecks(
  projectId: string,
  reader: (id: string) => Promise<FileTree> = readWorkspaceFiles,
): Promise<ConnectionReport> {
  const files = await reader(projectId);
  const checks: ConnectionCheck[] = [
    checkApiContracts(files),
    checkSchemaMatch(files),
    checkAuthFlow(files),
    checkEnvVars(files),
    checkNoLocalhost(files),
  ];
  return { passed: checks.every((c) => c.status !== "fail"), checks };
}
