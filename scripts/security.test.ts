/** Focused cases for the retained high-confidence security checks. */
import { readFileSync } from "node:fs";
import {
  checkPackages,
  checkRLS,
  checkRlsScoping,
  checkSecrets,
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


if (failures > 0) {
  console.error("\n" + failures + " security case(s) FAILED");
  process.exit(1);
}
console.log("\nAll security cases passed.");