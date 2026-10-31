/** Focused cases for the retained high-confidence security checks. */
import { readFileSync } from "node:fs";
import {
  checkPackages,
  checkRLS,
  checkRlsScoping,
  checkCallerIdentity,
  checkSecrets,
  checkServiceRole,
  blockingSecurityFindings,
  runSecurityChecksSafely,
  type FileTree,
} from "../src/verify/security.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log("✔ " + name);
    return;
  }
  failures++;
  console.log("✘ " + name + "\n    got:  " + JSON.stringify(got) + "\n    want: " + JSON.stringify(want));
}
function ok(name: string, condition: boolean): void { check(name, condition, true); }
const tree = (files: Record<string, string>): FileTree => new Map(Object.entries(files));

check(
  "packages flags an imported undeclared dependency",
  checkPackages(new Map([
    ["package.json", JSON.stringify({ dependencies: { hono: "^4" } })],
    ["src/App.tsx", 'import x from "hono";\nimport y from "request-promise";'],
  ])).some((result) => result.status === "fail" && result.id.includes("request-promise")),
  true,
);

check(
  "secrets flags a credential exposed in client code",
  checkSecrets(tree({ "src/components/Auth.tsx": 'const token = "Bearer abcdefghijklmnopqrstuvwxyz123456";' }))
    .some((result) => result.status === "fail"),
  true,
);

check(
  "RLS fails when a table has no RLS enabled",
  checkRLS(tree({ "src/db/schema.sql": "CREATE TABLE notes (id uuid primary key);" })).status,
  "fail",
);
check(
  "RLS fails when enabled RLS has no policy",
  checkRLS(tree({ "src/db/schema.sql": "CREATE TABLE notes (id uuid primary key);\nALTER TABLE notes ENABLE ROW LEVEL SECURITY;" })).status,
  "fail",
);
check(
  "RLS passes a table with RLS and a policy",
  checkRLS(tree({ "src/db/schema.sql": "CREATE TABLE notes (id uuid primary key);\nALTER TABLE notes ENABLE ROW LEVEL SECURITY;\nCREATE POLICY p ON notes FOR SELECT USING (true);" })).status,
  "pass",
);

check(
  "no SQL and no schema skips RLS rather than claiming verification",
  checkRLS(tree({ "src/App.tsx": "export default () => null;" })).status,
  "skip",
);
check(
  "a Drizzle schema without SQL warns that migrations were not verified",
  checkRLS(tree({ "src/db/schema.ts": "pgTable(\"notes\", {})" })).status,
  "warn",
);
check(
  "no SQL skips policy scoping rather than claiming verification",
  checkRlsScoping(tree({ "src/App.tsx": "x" })).status,
  "skip",
);
// ── G1: no service-role key for the SHARED preview project ───────────────────
// Decided 2026-10-17. The shared preview Supabase sits behind every user's
// preview at once, and a service-role key bypasses RLS entirely, so the code it
// was handed to — model-written, steered by whatever a stranger typed — could
// read and write every other user's preview rows.
//
// These read the files as TEXT on purpose. Importing e2b-service.ts outside the
// server process hangs (it pulls config, Redis and the E2B SDK), which is the
// same reason review-units.ts copies its baked-file list instead of importing
// it. Each assertion is written against the INTENT, not a line, so that a
// rename or a reformat does not fail it and a reintroduced key cannot pass it.
{
  const configSrc = readFileSync(new URL("../src/server/config.ts", import.meta.url), "utf8");
  const previewSrc = readFileSync(new URL("../src/preview/e2b-service.ts", import.meta.url), "utf8");

  ok(
    "config declares no shared preview service key",
    !/PREVIEW_SUPABASE_SERVICE_KEY\s*:\s*z\./.test(configSrc),
  );
  ok(
    "the .env writer cannot source one from config",
    !/config\.PREVIEW_SUPABASE_SERVICE_KEY/.test(previewSrc),
  );
  // The capability is narrowed, not deleted: a user's own connected project
  // still gets its key, because the schema is applied there and it is their
  // data. A change that removed this too would be over-correcting, and silently.
  ok(
    "a user's own project still passes its service key",
    /override\?\.serviceKey/.test(previewSrc),
  );
  // The original guard, still worth pinning: whatever else happens, a service
  // key must never reach the browser. Vite exposes exactly the VITE_ prefix.
  ok("no service key is ever VITE_-prefixed", !/VITE_SUPABASE_SERVICE/.test(previewSrc));
}



// ── RLS that is enabled, and isolates nobody ─────────────────────────────────
// checkRLS asks whether row-level security is ON and whether a policy exists.
// It never asks what the policy SAYS, so USING (true) passes it completely:
// enabled, present, green. An open door that looks locked — and the most
// dangerous thing this product can generate, because every gate agrees.

const OWNED_TABLE = `
CREATE TABLE issues (
  id uuid primary key,
  user_id uuid not null,
  title text
);
ALTER TABLE issues ENABLE ROW LEVEL SECURITY;
`;

check(
  "a write policy open to everyone fails",
  checkRlsScoping(tree({ "src/db/schema.sql": OWNED_TABLE + `CREATE POLICY p ON issues FOR ALL USING (true);` })).status,
  "fail",
);

check(
  "a read policy open to everyone on owned data fails",
  checkRlsScoping(tree({ "src/db/schema.sql": OWNED_TABLE + `CREATE POLICY p ON issues FOR SELECT USING (true);` })).status,
  "fail",
);

// The line has to be drawn where a blog does not get shouted at. A products
// catalogue or a published post SHOULD be world readable — the prompt teaches
// exactly that — so a table with no owner column is not this check's business.
check(
  "a public catalogue stays world-readable without complaint",
  checkRlsScoping(
    tree({
      "src/db/schema.sql": `
CREATE TABLE products (
  id uuid primary key,
  name text
);
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
CREATE POLICY p ON products FOR SELECT USING (true);`,
    }),
  ).status,
  "pass",
);

// ...but writing to it must still be scoped.
check(
  "writing to that same public table is still refused",
  checkRlsScoping(
    tree({
      "src/db/schema.sql": `
CREATE TABLE products (
  id uuid primary key,
  name text
);
CREATE POLICY w ON products FOR INSERT WITH CHECK (true);`,
    }),
  ).status,
  "fail",
);

check(
  "the owner-scoped policy the prompt teaches passes",
  checkRlsScoping(
    tree({ "src/db/schema.sql": OWNED_TABLE + `CREATE POLICY p ON issues FOR SELECT USING (auth.uid() = user_id);` }),
  ).status,
  "pass",
);

check(
  "a policy that never mentions who is asking fails on owned data",
  checkRlsScoping(
    tree({ "src/db/schema.sql": OWNED_TABLE + `CREATE POLICY p ON issues FOR SELECT USING (title IS NOT NULL);` }),
  ).status,
  "fail",
);

// PATTERN 2 from the prompt: public read with a real predicate is not an open
// door, and must not be treated as one.
check(
  "a published-flag predicate is not an open door",
  checkRlsScoping(
    tree({
      "src/db/schema.sql": `
CREATE TABLE posts (
  id uuid primary key,
  author_id uuid,
  is_published boolean
);
CREATE POLICY r ON posts FOR SELECT USING (is_published = true);
CREATE POLICY w ON posts FOR INSERT WITH CHECK (auth.uid() = author_id);`,
    }),
  ).status,
  "pass",
);

check("no SQL at all is skipped, not passed", checkRlsScoping(tree({ "src/App.tsx": "x" })).status, "skip");

{
  const msg = checkRlsScoping(
    tree({ "src/db/schema.sql": OWNED_TABLE + `CREATE POLICY p ON issues FOR ALL USING (true);` }),
  ).message;
  ok("the message names the fix, not just the fault", msg.includes("auth.uid() = user_id"));
  ok("and says a public table may stay public", /genuinely public/i.test(msg));
}


// ── Two rules the prompt states, now with a check behind them ───────────────
// DB_INSTRUCTIONS forbids the service-role key and requires dbFor(c) per
// request. Nothing verified either until 2026-10-21, and an instruction with
// no check behind it is exactly the prompt-vs-reality drift this repo keeps
// finding. Both feed the existing two-attempt auto-fix loop.

const ROUTES = "src/server/routes/api.ts";

console.log("\n— the service-role key —");
{
  const bad = checkServiceRole(tree({
    [ROUTES]: "const key = process.env.SUPABASE_SERVICE_ROLE_KEY\nconst db = createClient(url, key)",
  }));
  ok("a service-role key in the backend fails", bad.status === "fail");
  ok("it is critical", bad.severity === "critical");
  ok("the message says the policies stop mattering", bad.message.includes("bypasses every row-level"));
  ok("and names the fix", bad.message.includes("SUPABASE_ANON_KEY") && bad.message.includes("Authorization"));
  // Must NOT be a hard block: it has a known correct fix, and aborting the
  // build would throw away everything that worked.
  ok("it is not id-prefixed as a build-aborting finding",
    !bad.id.startsWith("secret-") && !bad.id.startsWith("packages-undeclared-"));
}
ok("serviceRole in camelCase is caught too", checkServiceRole(tree({
  [ROUTES]: "const serviceRoleKey = cfg.key\nconst db = createClient(url, serviceRoleKey)",
})).status === "fail");
ok("a clean backend passes", checkServiceRole(tree({
  [ROUTES]: "const db = createClient(url, process.env.SUPABASE_ANON_KEY)",
})).status === "pass");
// schema.sql legitimately mentions service_role in GRANT statements, and a
// component is not the backend.
ok("service_role in SQL is not a backend finding", checkServiceRole(tree({
  "src/db/schema.sql": "GRANT ALL ON todos TO service_role;",
})).status === "pass");
ok("a .tsx component is not scanned as the backend", checkServiceRole(tree({
  "src/components/Admin.tsx": "// service_role is mentioned in this comment",
})).status === "pass");

console.log("\n— does the caller's identity reach the query —");
{
  // The anonymous client. Compiles, renders, responds to every control, and
  // returns an empty list forever, because auth.uid() is NULL and every
  // owner-scoped policy denies it.
  const anon = checkCallerIdentity(tree({
    [ROUTES]: "const db = createClient(URL, ANON)\napi.get('/todos', async (c) => c.json(await db.from('todos').select('*')))",
  }));
  ok("a client built with no token fails", anon.status === "fail");
  ok("the message says what the user would SEE", anon.message.includes("empty lists forever"));
  ok("and names dbFor(c) as the fix", anon.message.includes("dbFor(c)"));
}
{
  // The shared client: it forwards a token, but builds the client once, so
  // every request gets whichever token arrived first.
  const shared = checkCallerIdentity(tree({
    [ROUTES]:
      "const token = c.req.header('Authorization')\n" +
      "const db = createClient(URL, ANON, { global: { headers: { Authorization: token } } })\n" +
      "api.get('/todos', async (c) => c.json(await db.from('todos').select('*')))",
  }));
  ok("a module-level client fails even when a token is forwarded", shared.status === "fail");
  ok("and says why", shared.message.includes("arrived first"));
}
{
  // The documented shape.
  const good = checkCallerIdentity(tree({
    [ROUTES]:
      "function dbFor(c) {\n" +
      "  const token = c.req.header('Authorization') || ''\n" +
      "  return createClient(URL, ANON, { global: { headers: { Authorization: token } } })\n" +
      "}\n" +
      "api.get('/todos', async (c) => { const db = dbFor(c); return c.json(await db.from('todos').select('*')) })",
  }));
  ok("dbFor(c) per request passes", good.status === "pass");
  ok("and says how many files it checked", good.message.includes("1 backend file"));
}
{
  // A backend that verifies the token itself and filters by the id is a
  // different design, not a bug. Flagging it would dispatch a fix at working
  // code and charge the user for it.
  const explicit = checkCallerIdentity(tree({
    [ROUTES]:
      "const { data: { user } } = await supabase.auth.getUser(jwt)\n" +
      "const db = createClient(URL, SERVICE)\n" +
      "await db.from('todos').select('*').eq('user_id', user.id)",
  }));
  ok("explicit owner filtering is not reported as missing identity", explicit.status !== "fail");
}
ok("a frontend file is not checked", checkCallerIdentity(tree({
  "src/lib/supabase.ts": "export const supabase = createClient(URL, ANON)",
})).status === "skip");
ok("a backend with no database access is skipped", checkCallerIdentity(tree({
  [ROUTES]: "api.get('/health', (c) => c.json({ ok: true }))",
})).status === "skip");

console.log("\n— both run in the build —");
{
  const sec = readFileSync(new URL("../src/verify/security.ts", import.meta.url), "utf8");
  ok("both are in runSecurityChecks", sec.includes("checkServiceRole(files)") && sec.includes("checkCallerIdentity(files)"));
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");
  ok("and the safe security runner is what the build calls", build.includes("runSecurityChecksSafely(projectId"));
  ok("neither can abort the build", build.includes('c.id.startsWith("secret-") || c.id.startsWith("packages-undeclared-")'));

  const scanCall = "runSecurityChecksSafely(projectId, async () => fileTree)";
  const scanStart = build.indexOf(scanCall);
  const normalVerdict = build.indexOf("const failing = report.checks.filter", scanStart);
  const scanFailureHandling =
    scanStart >= 0 && normalVerdict > scanStart
      ? build.slice(scanStart, normalVerdict)
      : "";

  ok(
    "a scanner exception is not converted into an empty passing report",
    scanFailureHandling.length > 0 &&
      scanFailureHandling.includes("if (!scanResult.ok)") &&
      !scanFailureHandling.includes("passed: true") &&
      !scanFailureHandling.includes("checks: []"),
  );
  ok(
    "a scanner exception emits a failed build event",
    scanFailureHandling.includes("server?.buildFailed(sessionId") &&
      scanFailureHandling.includes("Security verification could not complete"),
  );
  ok(
    "a scanner exception persists failed session and project states",
    scanFailureHandling.includes('.set({ status: "failed", error: reason, completedAt: new Date() })') &&
      scanFailureHandling.includes('db.update(projects).set({ status: "failed" })'),
  );
  ok(
    "the build returns before normal security findings or preview work continue",
    scanFailureHandling.includes("return;"),
  );
}

// ── An INSERT that does not bind the owner column ───────────────────────────
// This is the schema a REAL build shipped on 2026-10-23, verified against the
// live project: inserting a task failed with "null value in column created_by
// violates not-null constraint", and had it succeeded, any signed-in user
// could have written someone else's id into that column. Mentioning auth.uid()
// is not scoping — `auth.uid() IS NOT NULL` means "anybody who is logged in".

console.log("\n— an INSERT policy that does not bind the owner —");
const SHIPPED = `CREATE TABLE tasks (
  id uuid primary key,
  title text,
  created_by uuid NOT NULL
);
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "team_insert_tasks" ON tasks FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);
CREATE POLICY "team_read_tasks" ON tasks FOR SELECT USING (auth.uid() IS NOT NULL);
`;
{
  const got = checkRlsScoping(tree({ "src/db/schema.sql": SHIPPED }));
  ok("the schema a real build shipped is caught", got.status === "fail");
  ok("and the message names the column", got.message.includes("created_by"));
  ok("and says what a user could do with it", got.message.includes("attributed to someone else"));
  ok("and gives the fix, including the default", got.message.includes("DEFAULT auth.uid()"));
}
{
  const bound = SHIPPED.replace("WITH CHECK (auth.uid() IS NOT NULL)", "WITH CHECK (auth.uid() = created_by)");
  ok("binding it passes", checkRlsScoping(tree({ "src/db/schema.sql": bound })).status === "pass");
}
{
  // A shared SELECT is a legitimate design and must not be dragged in.
  const readOnly = `CREATE TABLE posts (id uuid primary key, body text);
ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read_all" ON posts FOR SELECT USING (auth.uid() IS NOT NULL);
`;
  ok("a shared read on a table with no owner column is left alone",
    checkRlsScoping(tree({ "src/db/schema.sql": readOnly })).status !== "fail");
}
{
  // And the prompt has to teach it, or the check just fails every build.
  const prompt = readFileSync(new URL("../src/agents/prompt-builder.ts", import.meta.url), "utf8");
  ok("the prompt requires DEFAULT auth.uid() on owner columns", prompt.includes("DEFAULT auth.uid() REFERENCES auth.users(id)"));
  ok("and binding the owner in the INSERT policy", prompt.includes("WITH CHECK (auth.uid() = created_by)"));
  ok("and says a shared table still scopes its writes", prompt.includes("A shared table still"));
}


// The safe runner must preserve scanner failure as an unavailable result.
{
  const expectedError = new Error("simulated scanner failure");
  const result = await runSecurityChecksSafely("project-test", async () => {
    throw expectedError;
  });
  ok("scanner errors are returned as unavailable, not thrown or passed", !result.ok);
  ok(
    "the original scanner error is retained for diagnostics",
    !result.ok && result.error === expectedError,
  );
}


{
  const findings = [
    { id: "critical-fail", status: "fail", severity: "critical", message: "critical fail" },
    { id: "high-warn", status: "warn", severity: "high", message: "high warning" },
    { id: "high-skip", status: "skip", severity: "high", message: "not applicable" },
    { id: "medium-fail", status: "fail", severity: "medium", message: "medium finding" },
    { id: "high-pass", status: "pass", severity: "high", message: "passed" },
  ] as const;
  check(
    "only unresolved high/critical fail or warning findings block release",
    blockingSecurityFindings([...findings]).map((finding) => finding.id),
    ["critical-fail", "high-warn"],
  );
}
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");
  ok(
    "the build performs a fresh final security scan after the repair loop",
    build.includes("const finalSecurityScan = await runSecurityChecksSafely") &&
      build.includes("blockingSecurityFindings(finalSecurityScan.report.checks)"),
  );
  const deploy = readFileSync(new URL("../src/agents/tools/deploy-app.ts", import.meta.url), "utf8");
  ok(
    "deploy_app re-scans the exact deployment file snapshot",
    deploy.includes("runSecurityChecksSafely(") &&
      deploy.includes("new Map(Object.entries(files))") &&
      deploy.includes("blockingSecurityFindings(securityScan.report.checks)"),
  );
  ok(
    "deploy_app refuses to call Vercel when verification is unavailable",
    deploy.indexOf("if (!securityScan.ok)") < deploy.indexOf("deployToVercel({"),
  );
}

if (failures > 0) {
  console.error("\n" + failures + " security case(s) FAILED");
  process.exit(1);
}
console.log("\nAll security cases passed.");