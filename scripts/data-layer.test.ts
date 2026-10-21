/**
 * Cases for the data-layer verifier. Run by `npm test`.
 *
 * The property these protect is the one `wiring.ts` taught: a check that cries
 * wolf gets ignored, and a check nobody can trust gets deleted. So the false
 * positives are pinned harder than the true positives here — `Array.from` is
 * in every React file in the repo, and a verifier that reported it as a missing
 * database table would be switched off within a day and would deserve it.
 *
 * The one case that matters most is the last kind: an app that stores nothing
 * must produce ZERO findings. Most generated apps are not database apps, and
 * warning all of them about a database they never wanted is how a real signal
 * gets buried.
 */

import { readFileSync } from "node:fs";
import {
  declaredTables,
  findDataLayerGaps,
  formatDataLayerForUser,
  formatDataLayerGaps,
  queriedTables,
  schemaRepairInstruction,
  undeclaredTables,
  type DatabaseState,
} from "../src/verify/data-layer.js";

let failures = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (JSON.stringify(got) === JSON.stringify(want)) {
    console.log(`✔ ${name}`);
    return;
  }
  failures++;
  console.log(`✘ ${name}\n    got:  ${JSON.stringify(got)}\n    want: ${JSON.stringify(want)}`);
}
function ok(name: string, cond: boolean): void {
  check(name, cond, true);
}

const READY: DatabaseState = { configured: true, schemaApplied: true };
const SHARED: DatabaseState = { configured: true, schemaApplied: false };
const NONE: DatabaseState = { configured: false, schemaApplied: false };

const kinds = (fs: ReturnType<typeof findDataLayerGaps>): string[] => fs.map((f) => f.kind);

// ── what counts as asking a database for a table ─────────────────────────────

check(
  "a supabase query is a queried table",
  queriedTables({ "src/server/routes/api.ts": `const { data } = await db.from("riders").select("*")` }).map(
    (q) => q.table,
  ),
  ["riders"],
);

check(
  "the python client's .table() counts too",
  queriedTables({ "src/server/main.py": `supabase.table("riders").select("*").execute()` }).map((q) => q.table),
  ["riders"],
);

// The false positive that would have killed this check on day one. Both shapes
// are in the live frontend already.
check(
  "Array.from(files) is not a table",
  queriedTables({ "src/components/PromptComposer.tsx": `const next = Array.from(files).slice(0, 5)` }),
  [],
);

check(
  "Array.from({ length: 8 }) is not a table",
  queriedTables({ "src/routes/projects.tsx": `Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} />)` }),
  [],
);

// The one shape the string-literal rule alone would let through.
check(
  "Array.from with a string literal is still not a table",
  queriedTables({ "src/lib/x.ts": `const chars = Array.from("abc")` }),
  [],
);

check(
  "a test file's queries are ignored",
  queriedTables({ "src/server/api.test.ts": `db.from("riders").select("*")` }),
  [],
);

check(
  "a table used on six pages is one table",
  queriedTables({
    "src/pages/a.tsx": `db.from("riders").select("*")`,
    "src/pages/b.tsx": `db.from("riders").select("*")`,
    "src/pages/c.tsx": `db.from("riders").insert(x)`,
  }).length,
  1,
);

// ── what counts as declaring one ─────────────────────────────────────────────

check(
  "CREATE TABLE is a declaration",
  [...declaredTables({ "src/db/schema.sql": `CREATE TABLE riders (id uuid primary key);` })],
  ["riders"],
);

check(
  "IF NOT EXISTS and a schema qualifier do not hide it",
  [...declaredTables({ "src/db/schema.sql": `create table if not exists public."riders" (id uuid);` })],
  ["riders"],
);

// ── the findings ─────────────────────────────────────────────────────────────

// The case the whole module exists for, in its happiest form: everything is
// declared and the database is real, so nothing is reported.
check(
  "a declared table on a real database is silent",
  findDataLayerGaps(
    {
      "src/server/routes/api.ts": `db.from("riders").select("*")`,
      "src/db/schema.sql": `CREATE TABLE riders (id uuid primary key);`,
    },
    READY,
  ),
  [],
);

check(
  "a queried table the app never declared is reported",
  kinds(
    findDataLayerGaps(
      {
        "src/server/routes/api.ts": `db.from("invoices").select("*")`,
        "src/db/schema.sql": `CREATE TABLE riders (id uuid primary key);`,
      },
      READY,
    ),
  ),
  ["table-never-declared"],
);

// G6 itself: the schema is written, the credentials are injected, and nothing
// will ever run the SQL.
check(
  "a schema nothing will apply is reported",
  kinds(
    findDataLayerGaps(
      {
        "src/server/routes/api.ts": `db.from("riders").select("*")`,
        "src/db/schema.sql": `CREATE TABLE riders (id uuid primary key);`,
      },
      SHARED,
    ),
  ),
  ["schema-never-applied"],
);

check(
  "no database at all outranks the schema finding",
  kinds(
    findDataLayerGaps(
      {
        "src/server/routes/api.ts": `db.from("riders").select("*")`,
        "src/db/schema.sql": `CREATE TABLE riders (id uuid primary key);`,
      },
      NONE,
    ),
  ),
  ["no-database"],
);

// The quiet majority. A landing page, a calculator, a game: no storage, so no
// finding, whatever the database state is.
ok(
  "an app that stores nothing is never warned",
  findDataLayerGaps({ "src/App.tsx": `export default () => <h1>Hello</h1>;` }, NONE).length === 0,
);

ok(
  "and neither is one whose only .from is Array.from",
  findDataLayerGaps(
    { "src/App.tsx": `const rows = Array.from({ length: 3 });` },
    NONE,
  ).length === 0,
);


// ── fake persistence: the 2026-10-17 failure ─────────────────────────────────
// The agent decided the backend was unavailable — having itself confirmed nine
// minutes earlier that it was running — and shipped localStorage in place of
// the API. Every gate passed, because every gate asks whether the app works,
// and a fake works beautifully.
//
// The false positives are pinned harder than the true ones, because ordinary
// localStorage is correct and common: a remembered theme, a collapsed panel,
// an unsent draft. A check that flagged those would be switched off in a day.

check(
  "a labelled demo mode standing in for the API is caught",
  kinds(
    findDataLayerGaps(
      {
        "src/lib/api.ts": `const DEMO_MODE = !import.meta.env.VITE_API_URL
          export async function getIssues() {
            if (DEMO_MODE) return JSON.parse(localStorage.getItem('issues') || '[]')
            return fetch(API_BASE + '/api/issues').then(r => r.json())
          }`,
      },
      READY,
    ),
  ),
  ["fake-persistence"],
);

check(
  "and so is the same thing without the word 'demo'",
  kinds(
    findDataLayerGaps(
      {
        "src/lib/api.ts": `export async function save(x) {
            if (!API_BASE) { localStorage.setItem('items', JSON.stringify(x)); return x }
            return fetch(API_BASE + '/api/items', { method: 'POST' })
          }`,
      },
      READY,
    ),
  ),
  ["fake-persistence"],
);

ok(
  "a remembered theme is NOT faked persistence",
  findDataLayerGaps(
    { "src/components/Theme.tsx": `localStorage.setItem('theme', next); const t = localStorage.getItem('theme')` },
    READY,
  ).length === 0,
);

ok(
  "an unsent draft kept in storage is NOT faked persistence",
  findDataLayerGaps(
    { "src/components/Composer.tsx": `useEffect(() => localStorage.setItem('draft', text), [text])` },
    READY,
  ).length === 0,
);

ok(
  "a real api client with no storage is NOT faked",
  findDataLayerGaps(
    { "src/lib/api.ts": `export const getAll = () => fetch(API_BASE + '/api/items').then(r => r.json())` },
    READY,
  ).length === 0,
);

ok(
  "a test file that mocks is NOT a finding",
  findDataLayerGaps(
    { "src/lib/api.test.ts": `const DEMO_MODE = true; localStorage.setItem('x','1'); fetch('/api/x')` },
    READY,
  ).length === 0,
);

// It outranks everything: a fake never queries a table, so without this check
// the same app reports as a clean app that simply stores nothing.
ok(
  "the user is warned in plain words, first",
  formatDataLayerForUser(
    findDataLayerGaps(
      { "src/lib/api.ts": `const useMock = !API_BASE; if (useMock) localStorage.getItem('x'); fetch(API_BASE+'/api/x')` },
      READY,
    ),
  )[0]?.includes("pretends to save") === true,
);


// ── the repair, and the one property a refactor could silently break ─────────
// Detection was not enough: it caught the fake both times and the user still
// met an app that saves nothing. So there is now a removal dispatch — and its
// POSITION is the whole point. Everything after the wiring loop shows files to
// someone: the storage sync, the backendReady emit, the preview sandbox. A
// removal that lands after those is a removal the user never sees.
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");
  const fakeAt = build.indexOf("Take the fake out before anyone sees it");
  const wiringAt = build.indexOf("Wire up what renders but does nothing");
  const syncAt = build.indexOf("server?.backendReady(");

  ok("the repair exists", fakeAt > 0);
  ok("the repair runs before the wiring loop", fakeAt > 0 && fakeAt < wiringAt);
  ok("and before anything shows the files to the user", fakeAt > 0 && fakeAt < syncAt);

  const block = build.slice(fakeAt, wiringAt);
  // The source wraps this sentence across concatenated strings, so match the
  // intent across the break rather than one literal line.
  ok("it refuses a fallback kept behind a flag", /fallback that can switch on/i.test(block));
  ok("it names the hardcoded-host cause", /localhost:3001/.test(block));
  ok("it keeps legitimate localStorage", /theme, a\n.*collapsed panel|collapsed panel/s.test(block));
  ok("it respects the cost ceiling", /MAX_BUILD_COST_USD/.test(block));
  ok("it cannot fail the build", !/throw |AppError/.test(block));
  // A repair that creates files has misunderstood the finding.
  ok("it only replaces files that already exist", /allFiles\[p\] !== undefined/.test(block));
}

// ── output ───────────────────────────────────────────────────────────────────

check("the model's format is silent on a clean app", formatDataLayerGaps([]), "No data-layer gaps found.");
check("the user's format is silent on a clean app", formatDataLayerForUser([]), []);

ok(
  "the user's format names the missing tables",
  formatDataLayerForUser(
    findDataLayerGaps({ "src/api.ts": `db.from("invoices").select("*")` }, READY),
  )[0]?.includes("invoices") === true,
);

// ── Repairing the one finding that is a model mistake ──────────────────────
// `table-never-declared` was detected from 2026-10-17 and nothing acted on it.
// It is the only one of the four that no answer to "where does the database
// live" can make correct, which is why it is the only one repaired.

console.log("\n— undeclared tables —");
{
  const files = {
    "src/server/routes/api.ts":
      "const { data } = await db.from('expenses').select('*')\n" +
      "await db.from('categories').insert(body)\n",
    "src/db/schema.sql": "CREATE TABLE categories (id uuid primary key, user_id uuid);\n",
  };
  const missing = undeclaredTables(files);
  check("only the undeclared table is returned", missing.map((m) => m.table), ["expenses"]);
  check("with the file that queries it", missing[0]?.path, "src/server/routes/api.ts");
}
ok("a declared table is not reported", undeclaredTables({
  "a.ts": "db.from('todos').select('*')",
  "src/db/schema.sql": "CREATE TABLE todos (id uuid);",
}).length === 0);
ok("case does not matter", undeclaredTables({
  "a.ts": "db.from('Todos').select('*')",
  "src/db/schema.sql": "CREATE TABLE todos (id uuid);",
}).length === 0);
ok("no schema at all means every queried table is missing", undeclaredTables({
  "a.ts": "db.from('todos').select('*'); db.from('users').select('*')",
}).length === 2);
ok("a frontend-only app reports nothing", undeclaredTables({
  "src/App.tsx": "export default function App() { return <div/> }",
}).length === 0);
ok("the finding and the repair agree on what is missing", (() => {
  const files = { "a.ts": "db.from('expenses').select('*')" };
  const findings = findDataLayerGaps(files, READY).filter((f) => f.kind === "table-never-declared");
  return findings.length === undeclaredTables(files).length && findings[0]?.symbol === "expenses";
})());

console.log("\n— the schema repair instruction —");
{
  const files = {
    "src/server/routes/api.ts": "await db.from('expenses').select('amount, note').order('created_at')",
    "src/db/schema.sql": "CREATE TABLE categories (id uuid primary key);\n",
  };
  const text = schemaRepairInstruction(undeclaredTables(files), files);
  ok("it names the missing table and where it is queried",
    text.includes("expenses") && text.includes("src/server/routes/api.ts"));
  ok("it carries the querying code, so columns come from USE not from the name",
    text.includes("amount, note") && text.includes("created_at"));
  ok("it carries the whole existing schema", text.includes("CREATE TABLE categories"));

  // The one way this repair can do harm: a schema.sql holding only the new
  // tables, which deletes the rest.
  ok("it demands the COMPLETE file", text.includes("COMPLETE src/db/schema.sql"));
  ok("and says what a partial file would do", text.includes("DELETES the rest"));

  // A CREATE TABLE with no policy is a table every signed-in user can read.
  ok("RLS is required on every new table", text.includes("ENABLE ROW LEVEL SECURITY"));
  ok("with an owner-scoped policy", text.includes("auth.uid() = user_id"));
  ok("and USING (true) is called out", text.includes("USING (true)"));
  ok("it explains why the failure is invisible", text.includes("empty list"));
}
ok("no schema file is said plainly, not faked", schemaRepairInstruction(
  [{ table: "todos", path: "a.ts" }], { "a.ts": "db.from('todos')" },
).includes("no src/db/schema.sql yet"));

console.log("\n— how the repair is wired into the build —");
{
  const build = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");
  ok("the repair runs in the build", build.includes("schemaRepairInstruction(missing, allFiles)"));

  // Order matters: the RLS checks have to see the tables this added, or a new
  // table ships with no policy at all.
  ok("it runs BEFORE the security loop, so RLS is checked on the new tables",
    build.indexOf("dispatching schema repair") < build.indexOf("Security validation + auto-fix"));

  ok("only the schema and types files may be written",
    build.includes('new Set(["src/db/schema.sql", "src/db/types.ts"])'));
  ok("it uses the tested apply path", /schemaRepairInstruction[\s\S]{0,2600}applyParsedFiles/.test(build));
  ok("a schema that lost a table is reverted", build.includes("Schema repair dropped existing table(s) — reverting"));
  ok("the repair respects the cost ceiling", build.includes("missing.length > 0 && cumulativeCostUsd < MAX_BUILD_COST_USD"));
  ok("a skip from the ceiling is logged, not silent", build.includes("skipped=cost-ceiling"));
  ok("the write is recorded so the gates above it are re-validated",
    build.includes('kind: "undeclared-tables"'));
  ok("a dispatch failure does not fail the build", build.includes("Schema repair dispatch failed"));
  ok("still-missing tables are said out loud", build.includes("still undeclared"));
  ok("the user is told the tables were added", build.includes("I added it to the schema"));
}

console.log(
  failures === 0 ? "\nAll data-layer cases passed." : `\n${failures} data-layer case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
