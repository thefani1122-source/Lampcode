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

export interface SecurityRepairContext {
  files: Array<{ path: string; content: string }>;
  omittedPaths: string[];
  redactedPaths: string[];
}

/** Select the complete files named by findings; never send truncated source as a whole file. */
export function selectSecurityRepairContext(
  findings: readonly SecurityCheck[],
  files: Record<string, string>,
  maxFiles = 8,
  maxChars = 120_000,
): SecurityRepairContext {
  const paths = [...new Set(findings.map((finding) => finding.file).filter(
    (path): path is string => Boolean(path && files[path] !== undefined),
  ))];
  const selected: SecurityRepairContext["files"] = [];
  const omittedPaths: string[] = [];
  const redactedPaths: string[] = [];
  let remaining = maxChars;
  for (const path of paths) {
    const rawContent = files[path];
    if (rawContent === undefined) continue;

    // A real credential must never be copied into a second model prompt just
    // because the repair agent needs the surrounding file. Replace known
    // credential shapes in the handoff only; the source snapshot is unchanged.
    let content = rawContent;
    for (const { re } of SECRET_PATTERNS) {
      const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
      content = content.replace(global, "[REDACTED_SECRET]");
    }
    if (content !== rawContent) redactedPaths.push(path);

    if (selected.length >= maxFiles || content.length > remaining) {
      omittedPaths.push(path);
      continue;
    }
    selected.push({ path, content });
    remaining -= content.length;
  }
  return { files: selected, omittedPaths, redactedPaths };
}

/**
 * Findings that must stop a preview promotion or production deployment.
 *
 * A high/critical warning means the verifier could not establish the required
 * property; it is not evidence of safety. Informational/medium findings remain
 * visible to the user without turning every advisory into a release blocker.
 */
export function blockingSecurityFindings(checks: readonly SecurityCheck[]): SecurityCheck[] {
  return checks.filter((check) =>
    (check.status === "fail" || check.status === "warn") &&
    (check.severity === "critical" || check.severity === "high"),
  );
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

function normalizeSqlIdentifier(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1).replace(/""/g, '"').toLowerCase();
  if (value.startsWith("`") && value.endsWith("`")) return value.slice(1, -1).replace(/``/g, "`").toLowerCase();
  if (value.startsWith("[") && value.endsWith("]")) return value.slice(1, -1).toLowerCase();
  return value.toLowerCase();
}

function extractSqlNames(sql: string, re: RegExp): string[] {
  const names: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql)) !== null) if (match[1]) names.push(normalizeSqlIdentifier(match[1]));
  return names;
}

/** Each CREATE POLICY statement, including quoted names and schema-qualified tables. */
function policyStatements(sql: string): Array<{ table: string; body: string }> {
  const out: Array<{ table: string; body: string }> = [];
  const re = /CREATE\s+POLICY\s+(?:"(?:[^"]|"")*"|\S+)\s+ON\s+(?:(?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)([\s\S]*?);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) out.push({ table: normalizeSqlIdentifier(m[1]), body: m[2] ?? "" });
  }
  return out;
}

/** The body of each CREATE TABLE, so a table's columns can be inspected. */
function tableBodies(sql: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)\s*\(([\s\S]*?)\n\s*\)\s*;/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (m[1]) out.set(normalizeSqlIdentifier(m[1]), m[2] ?? "");
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

  // ── An INSERT that does not bind the owner column ────────────────────────
  // MEASURED on a real build, 2026-10-23: a "shared team board" shipped
  // `created_by uuid NOT NULL` with no default and
  // WITH CHECK (auth.uid() IS NOT NULL). Two separate failures from one
  // mistake. Creating a task failed outright — "null value in column
  // created_by violates not-null constraint" — and had it succeeded, any
  // signed-in user could have written someone else's id into that column.
  //
  // Mentioning auth.uid() is not scoping. `auth.uid() IS NOT NULL` means
  // "anybody who is logged in", which is a fine rule for SELECT on a shared
  // table and never a sufficient one for INSERT on a table that records who
  // did something.
  for (const { table, body } of policies) {
    if (!/\bfor\s+(insert|all)\b/i.test(body)) continue;
    const cols = bodies.get(table) ?? "";
    const owner = cols.match(OWNER_COLUMN_RE)?.[0];
    if (!owner) continue;
    const check = body.match(/with\s+check\s*\(([\s\S]*)\)/i)?.[1] ?? "";
    const binds = new RegExp(
      `auth\\.uid\\s*\\(\\s*\\)\\s*=\\s*${owner}|${owner}\\s*=\\s*auth\\.uid\\s*\\(\\s*\\)`,
      "i",
    ).test(check);
    if (!binds) {
      problems.push(
        `${table}: its INSERT policy never ties ${owner} to auth.uid(), so a signed-in user can ` +
        `create a row attributed to someone else. Use WITH CHECK (auth.uid() = ${owner}), and give ` +
        `the column DEFAULT auth.uid() so the caller never has to send it`,
      );
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

/**
 * Catch self-service profile policies that allow a user to change role or tenant fields.
 * Row ownership alone does not protect authorization attributes from self-promotion.
 */
export function checkProfilePrivilegeUpdates(files: FileTree): SecurityCheck {
  const sqlFiles = [...files].filter(([path]) => path.endsWith(".sql"));
  if (sqlFiles.length === 0) return { id: "profile-privilege-update", status: "skip", severity: "high", message: "No SQL migration files available to inspect profile privilege updates" };
  const allSql = sqlFiles.map(([, content]) => content).join("\n");
  const bodies = tableBodies(allSql);
  const policies = policyStatements(allSql);
  const sensitive = /\b(role|organization_id|tenant_id|is_admin|is_owner|permissions|permission_level)\b/i;
  const problems: string[] = [];
  for (const [table, columns] of bodies) {
    if (!/^(profiles?|user_profiles?|memberships?)$/i.test(table) || !sensitive.test(columns)) continue;
    for (const policy of policies.filter((candidate) => candidate.table === table && /\bfor\s+(update|all)\b/i.test(candidate.body))) {
      const body = policy.body;
      const hasPrivilegeGuard = /\b(role|organization_id|tenant_id|is_admin|is_owner|permissions|permission_level)\b/i.test(body) && /\b(owner|admin|superuser|service_role|is_admin|has_role|can_manage)\b/i.test(body);
      if (!hasPrivilegeGuard) problems.push(table + ": an UPDATE policy scopes the row to a user but does not protect role/tenant/permission fields from self-modification");
    }
  }
  if (problems.length > 0) return {
    id: "profile-privilege-update", status: "fail", severity: "high", file: sqlFiles[0]?.[0],
    message: problems.join("; ") + ". Prevent self-service changes to privileged columns using column-level privileges, a guarded trigger, or a narrowly scoped server-side admin operation; then test role escalation with two users.",
  };
  return { id: "profile-privilege-update", status: "pass", severity: "high", message: "No unguarded self-service UPDATE policy found on profile or membership privilege fields" };
}

/** Detect policies that query their own protected table and can recurse. */
export function checkRecursiveRlsPolicies(files: FileTree): SecurityCheck {
  const sqlFiles = [...files].filter(([path]) => path.endsWith(".sql"));
  if (sqlFiles.length === 0) return { id: "rls-policy-recursion", status: "skip", severity: "critical", message: "No SQL migration files available to inspect RLS policy recursion" };
  const allSql = sqlFiles.map(([, content]) => content).join("\n");
  const recursive = policyStatements(allSql).filter(({ table, body }) => {
    const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\// ── 2. checkRLS ───────────────────────────────────────────────────────────────");
    const fromRe = new RegExp("\\bfrom\\s+(?:(?:[a-z_][a-z0-9_$]*)\\s*\\.\\s*)?[\\"`]?"+escaped+"[\\"`]?\\b", "i");
    return fromRe.test(body);
  });
  if (recursive.length > 0) return {
    id: "rls-policy-recursion", status: "fail", severity: "critical", file: sqlFiles[0]?.[0],
    message: "RLS policy queries its own protected table (" + [...new Set(recursive.map((item) => item.table))].join(", ") + "), which can cause infinite recursion. Move membership lookups into a narrowly scoped SECURITY DEFINER helper with a fixed search_path and restricted EXECUTE grants, or use a non-recursive policy design.",
  };
  return { id: "rls-policy-recursion", status: "pass", severity: "critical", message: "No direct self-referencing RLS policy query detected" };
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

  const tables = extractSqlNames(allSql, /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)/gi);
  const rlsOn = extractSqlNames(allSql, /ALTER\s+TABLE\s+(?:ONLY\s+)?(?:(?:"[^"]+"|\w+)\s*\.\s*)?("[^"]+"|\w+)\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi);
  const polOn = policyStatements(allSql).map((policy) => policy.table);

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

// ── 3. checkServiceRole + checkCallerIdentity ─────────────────────────────────
//
// Two rules the prompt states and nothing verified. DB_INSTRUCTIONS says, in
// the generated app's own words: "Do NOT reach for a service-role key: it
// bypasses every policy above, which turns all of this into decoration and
// lets any signed-in user read everyone's rows", and "Call dbFor(c) INSIDE
// each route handler, never once at module level — a module-level client would
// serve every user with whichever token happened to arrive first."
//
// Prompt-vs-reality drift is the #1 bug class in this repo, and an instruction
// with no check behind it is exactly that. Both of these are free, pure string
// scans, and both slot into the existing two-attempt auto-fix loop, so a
// finding is repaired rather than reported.
//
// Neither is id-prefixed `secret-` or `packages-undeclared-`: those abort the
// build, and both of these have a known correct fix.

/** A component is not the backend. The frontend MAY hold a module-level client
 *  with the anon key — that is the documented shape of src/lib/supabase.ts. */
function isServerFile(path: string): boolean {
  const p = path.toLowerCase();
  if (/\.(tsx|jsx|css|html|md|sql|json)$/.test(p)) return false;
  if (p.endsWith(".py")) return true;
  return /(^|\/)(server|api)\//.test(p) || p.endsWith("src/lib/db.ts");
}

const SERVICE_ROLE_RE = /service[_-]?role/i;

/**
 * The service-role key bypasses row-level security entirely.
 *
 * Worth its own check rather than folding into checkSecrets, because the
 * danger is not an exposed string — it is a correctly-stored key used in the
 * wrong place. Every policy the other two checks just verified becomes
 * decoration, and the app leaks every user's rows to every signed-in user
 * while looking completely healthy.
 */
export function checkServiceRole(files: FileTree): SecurityCheck {
  const offenders = [...files]
    .filter(([path]) => isServerFile(path))
    .filter(([, code]) => SERVICE_ROLE_RE.test(code))
    .map(([path]) => path);

  if (offenders.length > 0) {
    return {
      id: "service-role-key",
      status: "fail",
      severity: "critical",
      file: offenders[0],
      message:
        `Backend uses a service-role key (${offenders.join(", ")}). It bypasses every row-level ` +
        `security policy, so any signed-in user can read and change every other user's rows. ` +
        `Use SUPABASE_ANON_KEY and forward the caller's Authorization header instead, so ` +
        `auth.uid() resolves to the signed-in user and the policies do the filtering.`,
    };
  }
  return {
    id: "service-role-key",
    status: "pass",
    severity: "critical",
    message: "No service-role key in the backend",
  };
}

/** `const db = createClient(…)` at top level — shared by every request. */
const MODULE_LEVEL_CLIENT_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?createClient\s*\(/m;
// Two different things, and conflating them produced a false positive: a
// token going INTO the client's headers, versus the backend verifying the
// caller itself. Only the first makes a module-level client dangerous.
const TOKEN_IN_CLIENT_RE = /authorization|bearer/i;
const VERIFIES_CALLER_RE = /getuser\s*\(/i;
const OWNER_FILTER_RE = /\.eq\s*\(\s*['"`](user_id|owner_id|author_id|created_by|profile_id)['"`]/i;
const QUERIES_RE = /\.from\s*\(/;

/**
 * Does the caller's identity reach the query at all?
 *
 * Both failures look identical from outside and neither trips any other gate:
 *
 *  - A client built with no token is ANONYMOUS, so `auth.uid()` is NULL and
 *    every owner-scoped policy DENIES it. The app compiles, renders, responds
 *    to every control, and returns an empty list forever.
 *  - A client built ONCE at module level, HOLDING a caller's token, serves
 *    every request with whichever token arrived first — one user reading
 *    another user's data. A shared client with no per-caller credential is a
 *    different and legitimate design, so it is not reported.
 *
 * Reported only when NOTHING in the file refers to the caller — no
 * Authorization header, no getUser(), and no explicit owner-column filter.
 * A backend that verifies the token itself and filters by the id is a
 * different design, not a bug, so it is left alone.
 */
export function checkCallerIdentity(files: FileTree): SecurityCheck {
  const problems: string[] = [];
  let checked = 0;

  for (const [path, code] of files) {
    if (!isServerFile(path)) continue;
    if (!QUERIES_RE.test(code)) continue;
    if (!/createClient\s*\(/.test(code)) continue;
    checked++;

    const tokenInClient = TOKEN_IN_CLIENT_RE.test(code);
    const carriesIdentity = tokenInClient || VERIFIES_CALLER_RE.test(code) || OWNER_FILTER_RE.test(code);
    if (!carriesIdentity) {
      problems.push(
        `${path}: builds its database client without the caller's token and never filters by an ` +
        `owner column, so auth.uid() is NULL and every owner-scoped policy denies the query — ` +
        `the app will return empty lists forever`,
      );
      continue;
    }
    // Only when the client CARRIES a caller's token. A shared client holding
    // no per-caller credential is the normal shape for a backend that verifies
    // the caller itself and filters by the owner column — flagging that would
    // dispatch a paid fix at working code.
    if (tokenInClient && MODULE_LEVEL_CLIENT_RE.test(code)) {
      problems.push(
        `${path}: creates the database client once at module level, so every request shares ` +
        `whichever caller's token arrived first — one user reading another user's data`,
      );
    }
  }

  if (problems.length > 0) {
    return {
      id: "caller-identity",
      status: "fail",
      severity: "high",
      file: problems[0]?.split(":")[0],
      message:
        `The caller's identity does not reach the database: ${problems.join("; ")}. ` +
        `Build the client INSIDE each route handler from the request, e.g. ` +
        `function dbFor(c) { return createClient(URL, ANON_KEY, { global: { headers: ` +
        `{ Authorization: c.req.header('Authorization') ?? '' } } }) }, and call dbFor(c) in ` +
        `every handler.`,
    };
  }

  return {
    id: "caller-identity",
    status: checked > 0 ? "pass" : "skip",
    severity: "high",
    message: checked > 0
      ? `The caller's identity reaches the query in ${checked} backend file(s)`
      : "No backend database access to check",
  };
}

// ── 4. checkSecrets ───────────────────────────────────────────────────────────

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
    checkRecursiveRlsPolicies(files),
    checkProfilePrivilegeUpdates(files),
    checkServiceRole(files),
    checkCallerIdentity(files),
    ...checkSecrets(files),
    ...checkPackages(files),
  ];
  return { passed: checks.every((c) => c.status !== "fail"), checks };
}

/** Result of attempting a security scan. A failed scan is not a clean scan. */
export type SecurityScanResult =
  | { ok: true; report: SecurityReport }
  | { ok: false; error: unknown };

/**
 * Run the verifier while preserving the distinction between a completed scan
 * and one that could not complete. Callers must treat `ok: false` as unknown,
 * never as an empty passing report.
 */
export async function runSecurityChecksSafely(
  projectId: string,
  reader?: (id: string) => Promise<FileTree>,
): Promise<SecurityScanResult> {
  try {
    return { ok: true, report: await runSecurityChecks(projectId, reader) };
  } catch (error) {
    return { ok: false, error };
  }
}
