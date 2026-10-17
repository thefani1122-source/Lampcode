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

import {
  declaredTables,
  findDataLayerGaps,
  formatDataLayerForUser,
  formatDataLayerGaps,
  queriedTables,
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

// ── output ───────────────────────────────────────────────────────────────────

check("the model's format is silent on a clean app", formatDataLayerGaps([]), "No data-layer gaps found.");
check("the user's format is silent on a clean app", formatDataLayerForUser([]), []);

ok(
  "the user's format names the missing tables",
  formatDataLayerForUser(
    findDataLayerGaps({ "src/api.ts": `db.from("invoices").select("*")` }, READY),
  )[0]?.includes("invoices") === true,
);

console.log(
  failures === 0 ? "\nAll data-layer cases passed." : `\n${failures} data-layer case(s) FAILED`,
);
process.exit(failures === 0 ? 0 : 1);
