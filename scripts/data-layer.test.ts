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
