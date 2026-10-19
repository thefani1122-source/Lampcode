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

// ── 2b. checkRlsScoping ──────────────────────────────────────────────────────
//
// `checkRLS` below asks whether row-level security is ON and whether a policy
// exists. It never asks what the policy SAYS — so `USING (true)` passes it
// completely: RLS enabled, policy present, check green. An open door that looks
// locked, and the most dangerous shape this product can generate, because every
// gate agrees the app is fine.
//
// This is the last link in the chain the owner wrote out:
//
//   their Supabase → schema → Auth JWT → backend forwards it → RLS identifies
//   the user → *something proves the isolation actually holds*
//
// Driving two users through a real app (G3) is the complete answer and needs a
// build. This is the half that costs nothing and catches the same hole in the
// SQL, before anything runs.
//
// The line it draws, and why it is drawn there:
//
//   - A WRITE policy that is always true is never acceptable. `FOR INSERT`,
//     `UPDATE`, `DELETE` or `ALL` with `USING (true)` means any signed-in
//     stranger may change or delete anyone's rows. There is no app where that
//     is the intent.
//   - A READ policy that is always true is only wrong on a table that holds
//     somebody's data. A products catalogue or a published post SHOULD be world
//     readable — the prompt teaches exactly that as PATTERN 2 — so the test is
//     the table's shape, not the policy alone: does it carry an owner column?
//   - A table with an owner column and no policy mentioning `auth.uid()` is
//     unscoped whatever else it says.
//
// Anything short of that would either miss the hole or shout at a blog.

const OWNER_COLUMN_RE = /\b(user_id|owner_id|author_id|created_by|profile_id|account_id)\b/i;
/** `USING (true)`, `USING(1=1)`, `WITH CHECK (true)` — a predicate that is not one. */
const ALWAYS_TRUE_RE = /\b(?:using|with\s+check)\s*\(\s*(?:true|1\s*=\s*1)\s*\)/i;
const WRITE_ACTION_RE = /\bfor\s+(insert|update|delete|all)\b/i;

/** Each CREATE POLICY statement, with the table it is on and its body. */
function policyStatements(sql: string): Array<{ table: string; body: string }> {
  const out: Array<{ table: string; body: string }> = [];
  const re = /CREATE\s+POLICY\s+[^\s]+\s+ON\s+["'`]?(?:\w+\s*\.\s*)?["'`]?(\w+)["'`]?([\s\S]*?);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) out.push({ table: m[1].toLowerCase(), body: m[2] ?? "" });
  }
  return out;
}

/** The body of each CREATE TABLE, so a table's columns can be inspected. */
function tableBodies(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?(?:\w+\s*\.\s*)?["'`]?(\w+)["'`]?\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) out.set(m[1].toLowerCase(), m[2] ?? "");
  }
  return out;
}

export function checkRlsScoping(files: FileTree): SecurityCheck {
  const sqlFiles = [...files].filter(([p]) => p.endsWith(".sql"));
  if (sqlFiles.length === 0) {
    return {
      id: "rls-scoping",
      status: "skip",
      severity: "critical",
      message: "No SQL migration files found to check policy scoping",
    };
  }

  const allSql = sqlFiles.map(([, c]) => c).join("\n");
  const bodies = tableBodies(allSql);
  const policies = policyStatements(allSql);
  const problems: string[] = [];

  for (const { table, body } of policies) {
    if (!ALWAYS_TRUE_RE.test(body)) continue;
    if (WRITE_ACTION_RE.test(body)) {
      problems.push(`${table}: a write policy allows everyone (USING (true)) — anyone signed in can change or delete anyone's rows`);
      continue;
    }
    // A read policy that is always true, on a table that holds someone's data.
    if (OWNER_COLUMN_RE.test(bodies.get(table) ?? "")) {
      problems.push(`${table}: a read policy allows everyone (USING (true)) on a table with an owner column — every user can read every other user's rows`);
    }
  }

  // Owner-scoped tables whose policies never mention who is asking.
  const scopedByTable = new Map<string, boolean>();
  for (const { table, body } of policies) {
    scopedByTable.set(table, (scopedByTable.get(table) ?? false) || /auth\.uid\s*\(\s*\)/i.test(body));
  }
  for (const [table, cols] of bodies) {
    if (!OWNER_COLUMN_RE.test(cols)) continue;
    if (!scopedByTable.has(table)) continue; // no policy at all — checkRLS owns that
    if (scopedByTable.get(table) === true) continue;
    problems.push(`${table}: has an owner column but no policy refers to auth.uid(), so nothing ties a row to the user who owns it`);
  }

  if (problems.length > 0) {
    return {
      id: "rls-scoping",
      status: "fail",
      severity: "critical",
      file: sqlFiles[0]?.[0],
      message:
        `Row-level security is enabled but does not isolate users: ${problems.join("; ")}. ` +
        `Replace each one with a policy that compares the row to the caller, e.g. ` +
        `USING (auth.uid() = user_id). A table that is genuinely public may stay world-readable, ` +
        `but a write policy must never be USING (true).`,
    };
  }

  return {
    id: "rls-scoping",
    status: policies.length > 0 ? "pass" : "skip",
    severity: "critical",
    message:
      policies.length > 0
        ? `All ${policies.length} policy/policies scope access to the caller`
        : "No policies found to check scoping",
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

// ── Runner ────────────────────────────────────────────────────────────────────

export async function runSecurityChecks(
  projectId: string,
  reader: (id: string) => Promise<FileTree> = readWorkspaceFiles,
): Promise<SecurityReport> {
  const files = await reader(projectId);
  const checks: SecurityCheck[] = [
    checkRLS(files),
    checkRlsScoping(files),
    ...checkSecrets(files),
    ...checkPackages(files),
  ];
  return { passed: checks.every((c) => c.status !== "fail"), checks };
}
