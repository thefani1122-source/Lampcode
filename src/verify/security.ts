/**
 * Security Verifier — static analysis on generated project files.
 * Pure module: no DB, no network, no config imports.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

// ── Types ─────────────────────────────────────────────────────────────────────

/** Relative-path → file content */
export type FileTree = Map<string, string>;

export interface SecurityCheck {
  id: string;
  status: "pass" | "fail" | "warn" | "skip";
  severity: "critical" | "high" | "medium" | "low" | "info";
  file?: string | undefined;
  line?: number | undefined;
  message: string;
}

export interface SecurityReport {
  passed: boolean;
  checks: SecurityCheck[];
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
      const content = await readFile(full, "utf8").catch(() => "");
      tree.set(rel, content);
    }
  }
}

async function readWorkspaceFiles(projectId: string): Promise<FileTree> {
  const root = join(WORKSPACE_BASE, projectId);
  const tree: FileTree = new Map();
  await collectFiles(root, root, tree);
  return tree;
}

// ── Scan helpers ──────────────────────────────────────────────────────────────

interface ScanHit { file: string; line: number; match: string; }

function scanLines(
  files: FileTree,
  pattern: RegExp,
  opts: { extensions?: string[] | undefined; skipPaths?: string[] | undefined } = {},
): ScanHit[] {
  const hits: ScanHit[] = [];
  for (const [path, content] of files) {
    if (opts.extensions && !opts.extensions.some((e) => path.endsWith(e))) continue;
    if (opts.skipPaths?.some((s) => path.includes(s))) continue;
    const ls = content.split("\n");
    for (let i = 0; i < ls.length; i++) {
      const l = ls[i] ?? "";
      pattern.lastIndex = 0;
      if (pattern.test(l)) hits.push({ file: path, line: i + 1, match: l.trim() });
    }
  }
  return hits;
}

function anyMatch(files: FileTree, pattern: RegExp, extensions?: string[]): boolean {
  return scanLines(files, pattern, { extensions }).length > 0;
}

// ── 1. checkAuth ──────────────────────────────────────────────────────────────

/** Backend entry files that hold routes without having "route" in the name.
 *  Lampcode's own generated Hono backend is `src/server/index.ts`, so a
 *  selector keyed on "/routes/" or "route" skipped the single most common
 *  place a generated app declares its API — and then reported a clean pass
 *  over zero files scanned. Same drift class as prompt-vs-reality: the
 *  selector has to match what the generator actually emits. */
const BACKEND_ENTRY_RE = /(^|\/)(index|main|app|server)\.(ts|js)$/;

/** An auth route file, which is intentionally public. A substring test for
 *  "auth" also swallowed `author.ts`, `authorize-admin.ts` and anything else
 *  that merely contains the letters, exempting files nobody meant to exempt.
 *
 *  The name must be the WHOLE basename or be followed by a separator:
 *  `auth.ts`, `auth-routes.ts` and `oauth-callback.ts` are auth routes, while
 *  `author.ts` and `authorize-admin.ts` are not. Written this way because the
 *  first attempt at narrowing the old substring test reproduced its bug —
 *  `auth` plus "any characters" still swallows `author`. */
const AUTH_ROUTE_RE =
  /(^|\/)(auth|login|signin|sign-in|signup|sign-up|register|oauth|session)([-_.][^/]*)?\.(ts|js)$/;

export function checkAuth(files: FileTree): SecurityCheck {
  const routeFiles = [...files].filter(([p]) =>
    (p.includes("/routes/") || p.includes("route") || BACKEND_ENTRY_RE.test(p)) &&
    (p.endsWith(".ts") || p.endsWith(".js")),
  );

  const unprotected: string[] = [];
  let scanned = 0;

  for (const [path, content] of routeFiles) {
    if (AUTH_ROUTE_RE.test(path)) continue; // auth routes are intentionally public
    // Routes mounted under a prefix — `app.route("/api", users)` — declare
    // their own paths without "/api", so requiring that literal missed every
    // route in a file using the standard Hono composition pattern.
    const declaresRoutes =
      /\.(get|post|put|patch|delete)\s*\(\s*["'`]\/api\//.test(content) ||
      (/\.route\s*\(\s*["'`]\/api/.test(content) &&
        /\.(get|post|put|patch|delete)\s*\(\s*["'`]\//.test(content));
    if (!declaresRoutes) continue;
    scanned += 1;

    const hasAuthGuard =
      content.includes("requireAuth") ||
      content.includes("authenticate") ||
      content.includes("verifyToken") ||
      content.includes("isAuthenticated") ||
      /\.use\s*\([^)]*auth/i.test(content);

    if (!hasAuthGuard) unprotected.push(path);
  }

  if (unprotected.length > 0) {
    return {
      id: "auth-missing-middleware",
      status: "fail",
      severity: "critical",
      file: unprotected[0],
      line: 1,
      message: `${unprotected.length} route file(s) expose /api/ routes without auth middleware: ${unprotected.join(", ")}`,
    };
  }
  // "Nothing to check" is not "checked and fine". A browser-only build has no
  // API routes at all, and before this the check reported "All API route files
  // apply auth middleware" over zero files — the one reading that cannot tell a
  // verified backend from an unscanned one. Same pass/unavailable distinction
  // the build gates keep, and `skip` does not gate: only `fail` does.
  if (scanned === 0) {
    return {
      id: "auth-missing-middleware",
      status: "skip",
      severity: "critical",
      message: "No API route declarations found to check for auth middleware",
    };
  }
  return {
    id: "auth-missing-middleware",
    status: "pass",
    severity: "critical",
    message: `All ${scanned} API route file(s) apply auth middleware`,
  };
}

// ── 2. checkRLS ───────────────────────────────────────────────────────────────

export function checkRLS(files: FileTree): SecurityCheck {
  const sqlFiles = [...files].filter(([p]) => p.endsWith(".sql"));

  if (sqlFiles.length === 0) {
    const hasSchema = anyMatch(files, /pgTable\s*\(/, [".ts", ".js"]);
    return {
      id: "rls-enabled",
      status: hasSchema ? "warn" : "skip",
      severity: "high",
      message: hasSchema
        ? "Drizzle schema found — RLS must be configured separately in Supabase migrations"
        : "No SQL migration files found to verify RLS",
    };
  }

  const allSql = sqlFiles.map(([, c]) => c).join("\n");

  const tableRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(\w+)["'`]?/gi;
  const rlsRe   = /ALTER\s+TABLE\s+["'`]?(\w+)["'`]?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
  const polRe   = /CREATE\s+POLICY\s+\S+\s+ON\s+["'`]?(\w+)["'`]?/gi;

  const extractNames = (re: RegExp): string[] => {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(allSql)) !== null) { if (m[1]) out.push(m[1].toLowerCase()); }
    return out;
  };

  const tables  = extractNames(tableRe);
  const rlsOn   = extractNames(rlsRe);
  const polOn   = extractNames(polRe);

  const noRls = tables.filter((t) => !rlsOn.includes(t));
  if (noRls.length > 0) {
    return {
      id: "rls-enabled",
      status: "fail",
      severity: "high",
      file: sqlFiles[0]?.[0],
      message: `Tables missing RLS: ${noRls.join(", ")}`,
    };
  }

  const noPol = rlsOn.filter((t) => !polOn.includes(t));
  if (noPol.length > 0) {
    return {
      id: "rls-enabled",
      status: "fail",
      severity: "high",
      file: sqlFiles[0]?.[0],
      message: `Tables with RLS enabled but no policies: ${noPol.join(", ")}`,
    };
  }

  return {
    id: "rls-enabled",
    status: "pass",
    severity: "high",
    message: `RLS + policies verified on ${rlsOn.length} table(s)`,
  };
}

// ── 3. checkSecrets ───────────────────────────────────────────────────────────

const SECRET_PATTERNS: Array<{ re: RegExp; name: string }> = [
  { re: /sk-[a-zA-Z0-9]{20,}/,                              name: "OpenAI API key" },
  { re: /sk_live_[a-zA-Z0-9]{20,}/,                         name: "Stripe live key" },
  { re: /sk_test_[a-zA-Z0-9]{20,}/,                         name: "Stripe test key" },
  { re: /ghp_[a-zA-Z0-9]{36}/,                              name: "GitHub PAT" },
  { re: /AKIA[A-Z0-9]{16}/,                                 name: "AWS access key" },
  { re: /eyJ[a-zA-Z0-9_-]{20,}\.eyJ[a-zA-Z0-9_-]{20,}/,   name: "Hardcoded JWT" },
  { re: /["'](Bearer\s+[a-zA-Z0-9_\-.]{20,})["']/,         name: "Hardcoded Bearer token" },
  { re: /apiKey\s*[:=]\s*["'][a-zA-Z0-9_\-]{20,}["']/,     name: "Hardcoded API key" },
  { re: /password\s*[:=]\s*["'][^"']{6,}["']/,              name: "Hardcoded password" },
];

const CLIENT_INDICATORS = [
  ".client.", "/components/", "/pages/", "/app/", "/public/",
  "frontend/", "client/", ".tsx", ".jsx",
];

function isClientFile(path: string): boolean {
  return CLIENT_INDICATORS.some((i) => path.includes(i));
}

export function checkSecrets(files: FileTree): SecurityCheck[] {
  const checks: SecurityCheck[] = [];
  const clientFiles = [...files].filter(([p]) => isClientFile(p));

  for (const { re, name } of SECRET_PATTERNS) {
    for (const [path, content] of clientFiles) {
      const ls = content.split("\n");
      for (let i = 0; i < ls.length; i++) {
        re.lastIndex = 0;
        if (re.test(ls[i] ?? "")) {
          checks.push({
            id: `secret-${name.toLowerCase().replace(/\s+/g, "-")}`,
            status: "fail",
            severity: "critical",
            file: path,
            line: i + 1,
            message: `Possible ${name} exposed in client-side code`,
          });
        }
      }
    }
  }

  if (checks.length === 0) {
    checks.push({
      id: "secret-exposure",
      status: "pass",
      severity: "critical",
      message: "No secrets detected in client-side code",
    });
  }
  return checks;
}

// ── 4. checkOWASP ─────────────────────────────────────────────────────────────

export function checkOWASP(files: FileTree): SecurityCheck[] {
  const checks: SecurityCheck[] = [];
  const codeExts = [".ts", ".js", ".tsx", ".jsx"];
  const skipTest = ["test", "spec", ".test.", ".spec.", "__tests__"];

  // XSS
  const xssHits = scanLines(
    files,
    /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(/,
    { extensions: codeExts, skipPaths: skipTest },
  );
  if (xssHits.length > 0) {
    const h = xssHits[0]!;
    checks.push({
      id: "owasp-xss",
      status: "fail",
      severity: "high",
      file: h.file,
      line: h.line,
      message: `XSS risk: unsafe HTML injection found at ${h.file}:${h.line}`,
    });
  } else {
    checks.push({ id: "owasp-xss", status: "pass", severity: "high", message: "No XSS patterns detected" });
  }

  // SQL injection: raw template literals in query calls
  const sqliHits = scanLines(
    files,
    /(?:query|execute|sql|run)\s*\(\s*`[^`]*\$\{/,
    { extensions: [".ts", ".js"], skipPaths: skipTest },
  );
  if (sqliHits.length > 0) {
    const h = sqliHits[0]!;
    checks.push({
      id: "owasp-sqli",
      status: "fail",
      severity: "critical",
      file: h.file,
      line: h.line,
      message: `SQL injection risk: raw template literal in query at ${h.file}:${h.line}`,
    });
  } else {
    checks.push({ id: "owasp-sqli", status: "pass", severity: "critical", message: "No SQL injection patterns detected" });
  }

  // CSRF: form POST/PUT/DELETE without csrf token
  const csrfForms = scanLines(
    files,
    /<form[^>]+method\s*=\s*["'](?:post|put|delete|patch)["'][^>]*>/i,
    { extensions: [".tsx", ".jsx", ".html"] },
  );
  const hasCsrf = anyMatch(files, /csrf[_-]?token|csrfToken|_csrf/i);
  if (csrfForms.length > 0 && !hasCsrf) {
    const h = csrfForms[0]!;
    checks.push({
      id: "owasp-csrf",
      status: "fail",
      severity: "high",
      file: h.file,
      line: h.line,
      message: "CSRF risk: mutating form found without CSRF token protection",
    });
  } else {
    checks.push({ id: "owasp-csrf", status: "pass", severity: "high", message: "No CSRF vulnerabilities detected" });
  }

  return checks;
}

// ── 5. checkPackages ──────────────────────────────────────────────────────────

const NODE_BUILTINS = new Set([
  "fs", "path", "os", "crypto", "http", "https", "url", "util", "stream",
  "buffer", "events", "net", "dns", "child_process", "assert", "readline",
  "node:fs", "node:path", "node:os", "node:crypto", "node:http", "node:https",
  "node:url", "node:util", "node:stream", "node:buffer", "node:events",
  "node:net", "node:dns", "node:child_process", "node:assert",
]);

export function checkPackages(files: FileTree): SecurityCheck[] {
  const pkgRaw = files.get("package.json");
  if (!pkgRaw) {
    return [{ id: "packages-slopsquatting", status: "skip", severity: "high", message: "No package.json in workspace" }];
  }

  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try { pkg = JSON.parse(pkgRaw) as typeof pkg; }
  catch {
    return [{ id: "packages-slopsquatting", status: "warn", severity: "high", message: "Could not parse package.json" }];
  }

  const declared = new Set<string>([
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
  ]);

  const importRe = /(?:^|\s)(?:import|from)\s+["'](@?[a-zA-Z0-9][a-zA-Z0-9._-]*(?:\/[a-zA-Z0-9._-]+)?)["']/g;
  const undeclared = new Map<string, { file: string; line: number }>();

  for (const [path, content] of files) {
    if (![".ts", ".js", ".tsx", ".jsx"].some((e) => path.endsWith(e))) continue;
    const ls = content.split("\n");
    for (let i = 0; i < ls.length; i++) {
      const line = ls[i] ?? "";
      importRe.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = importRe.exec(line)) !== null) {
        const imp = m[1] ?? "";
        if (imp.startsWith(".") || imp.startsWith("/")) continue;
        const pkgName = imp.startsWith("@")
          ? imp.split("/").slice(0, 2).join("/")
          : (imp.split("/")[0] ?? imp);
        if (!NODE_BUILTINS.has(pkgName) && !declared.has(pkgName) && !undeclared.has(pkgName)) {
          undeclared.set(pkgName, { file: path, line: i + 1 });
        }
      }
    }
  }

  if (undeclared.size === 0) {
    return [{ id: "packages-slopsquatting", status: "pass", severity: "high", message: "All imports match declared dependencies" }];
  }

  return [...undeclared].map(([pkgName, loc]) => ({
    id: `packages-undeclared-${pkgName}`,
    status: "fail" as const,
    severity: "high" as const,
    file: loc.file,
    line: loc.line,
    message: `'${pkgName}' imported but missing from package.json — possible slopsquatting`,
  }));
}

// ── 6. checkCORS ─────────────────────────────────────────────────────────────

export function checkCORS(files: FileTree): SecurityCheck {
  const hits = scanLines(
    files,
    // The comma is in the class because Hono sets headers as a CALL —
    // `c.header("Access-Control-Allow-Origin", "*")` — not as the literal
    // `Access-Control-Allow-Origin: *` the original class assumed. A case
    // written for the bare-cors() work turned this up: the call form, which is
    // the one a generated Hono backend actually uses, was reported as a pass.
    /origin\s*:\s*["'`]\*["'`]|Access-Control-Allow-Origin['":,\s]+\*/,
    { extensions: [".ts", ".js"] },
  );
  if (hits.length > 0) {
    const h = hits[0]!;
    return {
      id: "cors-wildcard",
      status: "fail",
      severity: "high",
      file: h.file,
      line: h.line,
      message: `Wildcard CORS origin (*) found at ${h.file}:${h.line}`,
    };
  }
  // A bare `cors()` from hono/cors defaults to `origin: "*"`, so it is the same
  // hole as the literal above with none of the text to match on — and it is the
  // subject of hono's own advisory ("CORS Middleware reflects any Origin with
  // credentials when `origin` defaults to the wildcard"). Reported as `warn`,
  // not `fail`, on purpose: only `fail` drives build.ts's auto-fix loop, and
  // nobody has yet measured how many generated backends use a bare `cors()`,
  // so failing on it would spend a model dispatch per fullstack build to
  // enforce a threshold set before the measurement. Same reported-not-scored
  // stance as churn and the dead-code tally. The explicit-wildcard case above
  // still fails, because there the intent is unambiguous.
  const bare = scanLines(files, /\bcors\s*\(\s*\)/, { extensions: [".ts", ".js"] });
  if (bare.length > 0) {
    const h = bare[0]!;
    return {
      id: "cors-default-wildcard",
      status: "warn",
      severity: "high",
      file: h.file,
      line: h.line,
      message:
        `cors() with no options at ${h.file}:${h.line} defaults to allowing every origin — ` +
        `pass an explicit origin if this backend holds user data`,
    };
  }

  return { id: "cors-wildcard", status: "pass", severity: "high", message: "No wildcard CORS origins" };
}

// ── 7. checkStripe ────────────────────────────────────────────────────────────

export function checkStripe(files: FileTree): SecurityCheck {
  const hasStripe = anyMatch(files, /from\s+["']stripe["']|require\s*\(\s*["']stripe["']\s*\)/);
  if (!hasStripe) {
    return { id: "stripe-webhook-sig", status: "skip", severity: "medium", message: "Stripe not used" };
  }

  const hasVerify = anyMatch(files, /webhooks\.constructEvent|constructEventAsync/);
  if (!hasVerify) {
    const hits = scanLines(files, /from\s+["']stripe["']|require\s*\(\s*["']stripe["']\s*\)/);
    const h = hits[0];
    return {
      id: "stripe-webhook-sig",
      status: "fail",
      severity: "high",
      file: h?.file,
      line: h?.line,
      message: "Stripe used but webhook signature verification (constructEvent) not found",
    };
  }
  return { id: "stripe-webhook-sig", status: "pass", severity: "high", message: "Stripe webhook signature verification present" };
}

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runSecurityChecks(
  projectId: string,
  reader: (id: string) => Promise<FileTree> = readWorkspaceFiles,
): Promise<SecurityReport> {
  const files = await reader(projectId);
  const checks: SecurityCheck[] = [
    checkAuth(files),
    checkRLS(files),
    ...checkSecrets(files),
    ...checkOWASP(files),
    ...checkPackages(files),
    checkCORS(files),
    checkStripe(files),
  ];
  return { passed: checks.every((c) => c.status !== "fail"), checks };
}
