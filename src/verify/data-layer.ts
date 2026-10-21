/**
 * Does the app's data layer have a database behind it?
 *
 * WHY THIS EXISTS — measured 2026-10-17, see HISTORY.md. The shared preview
 * Supabase project holds exactly one table, and it is not an app's: across 416
 * projects and 427 build sessions, not a single generated table was ever
 * created there. `build.ts` applies `src/db/schema.sql` only when the user
 * connected their OWN Supabase, with a correct comment explaining that
 * model-written SQL must never run against a shared database. So for everyone
 * else the tables the app queries do not exist.
 *
 * The part that makes this worth a verifier rather than a bug report is what
 * the failure LOOKS like. The generated error handling swallows it: the Python
 * path is `except Exception: return []` and the Node path destructures
 * `{ data, error }` and renders `data`. A missing table and an empty table are
 * the same screen. Every gate passes, the page renders, the controls respond,
 * and the user is handed an app whose data layer never had a chance.
 *
 * That is the exact shape `wiring.ts` was written for — what RENDERS but does
 * nothing — so this follows its conventions deliberately: a pure function over
 * the file map, findings carrying the line the model needs, and a cap on what
 * is printed rather than on what is found.
 *
 * One of the three checks needs no outside state at all and is the one most
 * likely to fire on a good day: a table queried that the app's own schema never
 * declared. That is a model mistake, not an infrastructure one, and it is
 * wrong under every possible answer to where the database lives.
 */

export type DataLayerKind =
  /** `.from("riders")` with no `CREATE TABLE riders` anywhere in the schema. */
  | "table-never-declared"
  /** The app declares tables, but nothing will ever run the SQL that makes them. */
  | "schema-never-applied"
  /** The app queries tables and no database is configured at all. */
  | "no-database"
  /** The app fakes persistence so a broken feature LOOKS like it works. */
  | "fake-persistence";

export type DataLayerFinding = {
  kind: DataLayerKind;
  path: string;
  /** The table name, or the schema file the finding is about. */
  symbol: string;
  /** One line, written for the model that has to fix it. */
  detail: string;
};

/** What the build knows about the database this app will actually talk to. */
export interface DatabaseState {
  /** Credentials for some database were injected into the sandbox. */
  configured: boolean;
  /** The generated schema is applied somewhere — today, only true when the
   *  user connected their own Supabase project. */
  schemaApplied: boolean;
}

/** Cap on what is PRINTED, not on what is found — same split as `wiring.ts`. */
const MAX_REPORTED = 20;

const CODE_EXT_RE = /\.(tsx?|jsx?|mts|mjs)$/;
const PY_EXT_RE = /\.py$/;
const TEST_FILE_RE = /\.(test|spec)\.[tj]sx?$/;

// `.from("x")` / `.table("x")` with a STRING LITERAL argument. Requiring the
// literal is what keeps `Array.from(files)` and `Array.from({ length: 8 })` out
// — both are everywhere in real React code and neither has one. The explicit
// Array/Object guard below covers the remaining `Array.from("abc")` shape.
const FROM_CALL_RE = /(\w+)?\.?\b(?:from|table)\(\s*["'`]([A-Za-z_][A-Za-z0-9_]*)["'`]\s*\)/g;
const NOT_A_CLIENT = new Set(["Array", "Object", "String", "Buffer", "Set", "Map", "Date"]);

// `CREATE TABLE [IF NOT EXISTS] [schema.]name`, quoted or not. The schema
// qualifier is dropped: an app that writes `public.riders` and queries
// `riders` is the same table, and reporting it would be a false positive.
const CREATE_TABLE_RE =
  /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[A-Za-z_][A-Za-z0-9_]*"?\s*\.\s*)?"?([A-Za-z_][A-Za-z0-9_]*)"?/gi;

function normalise(path: string): string {
  return path.replace(/^\.?\//, "");
}

// ── Faked persistence ────────────────────────────────────────────────────────
// MEASURED 2026-10-17, project d6e9855b. Sign-up was broken in the preview
// because the generated frontend hardcoded http://localhost:3001, which a
// browser on *.e2b.app cannot reach. Asked to fix it, the agent wrote:
//
//   "The problem is the app relies on a backend that's not available in the
//    sandbox. Let me add a fallback demo mode so users can sign up."
//
// The premise was FALSE — nine minutes earlier, on the same project, the same
// agent had written "Excellent! The backend is running." It then dismissed the
// real type errors as "in the backend server code, which isn't used when
// there's no backend configured", and shipped localStorage in place of the API.
//
// That is the worst outcome this product can produce: an app that looks
// finished, signs you up, shows your data back, and has saved nothing anywhere.
// Every gate passes, because every gate asks whether the app WORKS, and a fake
// works beautifully.
//
// The prompt now forbids it. This exists because a prompt rule is advice and
// this is the one failure where advice is not enough.

/** Names a model reaches for when it is building a stand-in rather than a feature. */
const FAKE_MARKER_RE =
  /\b(demo[_\s]?mode|DEMO_MODE|isDemo|useDemo|mock[_\s]?mode|useMock|mockData|MOCK_DATA|fakeDb|fakeApi|inMemoryDb|offlineMode)\b/;

// The shape without a label: a branch on the API base being absent, which then
// reads or writes localStorage instead of calling it.
const API_ABSENT_RE = /(!\s*(API_BASE|VITE_API_URL|apiBase)|(API_BASE|VITE_API_URL|apiBase)\s*(===?\s*(''|""|`` )|\?\?|\|\|))/;
const STORAGE_RE = /\b(localStorage|sessionStorage)\s*\.\s*(get|set)Item\b/;
const CALLS_API_RE = /\b(fetch|axios)\s*\(|API_BASE|VITE_API_URL/;

/** Every table name the code asks a database for, with the file that asks. */
export function queriedTables(files: Record<string, string>): Array<{ table: string; path: string }> {
  const out: Array<{ table: string; path: string }> = [];
  const seen = new Set<string>();

  for (const [rawPath, code] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (TEST_FILE_RE.test(path)) continue;
    if (!CODE_EXT_RE.test(path) && !PY_EXT_RE.test(path)) continue;

    FROM_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FROM_CALL_RE.exec(code)) !== null) {
      const receiver = m[1];
      const table = m[2];
      if (!table) continue;
      if (receiver && NOT_A_CLIENT.has(receiver)) continue;
      // One finding per table, attributed to the first file that asks for it:
      // a table used on six pages is one missing table, not six findings.
      const key = table.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ table, path });
    }
  }
  return out;
}

/** Every table name the app's own SQL creates. */
export function declaredTables(files: Record<string, string>): Set<string> {
  const out = new Set<string>();
  for (const [rawPath, sql] of Object.entries(files)) {
    if (!normalise(rawPath).endsWith(".sql")) continue;
    CREATE_TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE_RE.exec(sql)) !== null) {
      if (m[1]) out.add(m[1].toLowerCase());
    }
  }
  return out;
}

/**
 * Tables a route asks a database for that the app's own SQL never creates.
 *
 * The one data-layer finding that is a MODEL MISTAKE rather than an
 * infrastructure fact — no answer to "where does the database live" makes a
 * query for an undeclared table correct — which is why it is the only one of
 * the four worth repairing inside the build. The other three need either the
 * user's own Supabase or a product decision.
 */
export function undeclaredTables(files: Record<string, string>): Array<{ table: string; path: string }> {
  const declared = declaredTables(files);
  return queriedTables(files).filter(({ table }) => !declared.has(table.toLowerCase()));
}

/**
 * The instruction for the schema repair.
 *
 * Carries the whole current schema and the code that does the querying,
 * because the columns have to be inferred from how the table is USED — a
 * CREATE TABLE guessed from the name alone produces a table whose columns the
 * app does not select, which fails exactly like the missing one did.
 */
export function schemaRepairInstruction(
  missing: Array<{ table: string; path: string }>,
  files: Record<string, string>,
): string {
  const schema = files["src/db/schema.sql"] ?? "";
  const paths = [...new Set(missing.map((m) => m.path))].slice(0, 6);
  const code = paths
    .map((path) => `\`\`\`${path}\n${(files[path] ?? "").slice(0, 12_000)}\n\`\`\``)
    .join("\n\n");

  return [
    "This app queries tables that its own SQL never creates. That schema is RUN against the",
    "user's real database, so a table missing from it does not exist at runtime: the query fails,",
    "the generated error handling turns the failure into an empty list, and the app looks finished",
    "and empty forever.",
    "",
    `Missing table(s): ${missing.map((m) => `${m.table} (queried in ${m.path})`).join(", ")}`,
    "",
    "Add a CREATE TABLE for each one to src/db/schema.sql. Work out the columns from how the code",
    "below actually uses the table — what it selects, inserts, filters and orders by. A table whose",
    "columns the app does not select fails exactly like the missing one did.",
    "",
    "EVERY new table needs row-level security in the same file, immediately after its CREATE TABLE:",
    "  ALTER TABLE <table> ENABLE ROW LEVEL SECURITY;",
    "and a policy per action that compares the row to the caller, e.g.",
    "  CREATE POLICY \"owner_select\" ON <table> FOR SELECT USING (auth.uid() = user_id);",
    "A policy of USING (true) on a table holding someone's data lets every user read every other",
    "user's rows. If a table is genuinely public, it may stay world-READABLE — a write policy never may.",
    "",
    "Return the COMPLETE src/db/schema.sql, including every table that is already in it below.",
    "A file that contains only the new tables DELETES the rest of the schema.",
    "",
    schema ? `The schema as it stands:\n\`\`\`filename:src/db/schema.sql\n${schema}\n\`\`\`` : "There is no src/db/schema.sql yet — create it.",
    "",
    `The code that queries these tables:\n\n${code}`,
  ].join("\n");
}

/**
 * The three ways a data layer can be hollow, cheapest first.
 *
 * `database` is what the BUILD knows, not what the files say, so the two
 * infrastructure findings cannot be derived from the file map alone. The
 * `table-never-declared` one can, and is reported whatever the database state
 * is: a query for a table the app never creates is wrong even on a database
 * that exists.
 */
export function fakePersistence(files: Record<string, string>): DataLayerFinding[] {
  const out: DataLayerFinding[] = [];
  for (const [rawPath, code] of Object.entries(files)) {
    const path = normalise(rawPath);
    if (TEST_FILE_RE.test(path)) continue;
    if (!CODE_EXT_RE.test(path)) continue;

    // Two independent shapes. The labelled one — a `demoMode` flag — is what a
    // model writes when it has decided to build a stand-in. The unlabelled one
    // is the same decision without the word: a branch on the API base being
    // missing that reads or writes storage instead.
    //
    // BOTH require the file to also touch the API. That is what keeps ordinary
    // localStorage out of this: remembering a theme, a collapsed panel or an
    // unsent draft is correct and common, and a check that flagged it would be
    // switched off within a day.
    const labelled = FAKE_MARKER_RE.test(code) && STORAGE_RE.test(code);
    const unlabelled = API_ABSENT_RE.test(code) && STORAGE_RE.test(code);
    if (!(labelled || unlabelled) || !CALLS_API_RE.test(code)) continue;

    out.push({
      kind: "fake-persistence",
      path,
      symbol: labelled ? "demo mode" : "storage fallback",
      detail:
        `This stores data in the browser when the API is unavailable, so the feature LOOKS like it ` +
        `works and saves nothing. Do not stand in for a broken backend — fix the call, or say plainly ` +
        `that it is not working. Check that the frontend calls API_BASE + '/api/...' and never a ` +
        `hardcoded host: the preview is served from a different origin, so localhost never resolves.`,
    });
  }
  return out;
}

export function findDataLayerGaps(
  files: Record<string, string>,
  database: DatabaseState,
): DataLayerFinding[] {
  // Checked before anything else and regardless of the database state: a fake
  // is wrong whether or not a real database exists, and it is the one finding
  // here that hides all the others — an app with a localStorage stand-in never
  // queries a table, so every check below would report a clean, empty app.
  const findings: DataLayerFinding[] = fakePersistence(files);
  const queried = queriedTables(files);
  if (queried.length === 0) return findings;

  const declared = declaredTables(files);

  for (const { table, path } of undeclaredTables(files)) {
    findings.push({
      kind: "table-never-declared",
      path,
      symbol: table,
      detail:
        `This queries the table "${table}", but no CREATE TABLE for it exists in the app's SQL. ` +
        `Add it to src/db/schema.sql with its columns and RLS policy, or query a table that is declared.`,
    });
  }

  if (!database.configured) {
    findings.push({
      kind: "no-database",
      path: queried[0]?.path ?? "src",
      symbol: `${queried.length} table(s)`,
      detail:
        `The app reads and writes ${queried.length} table(s), but this build has no database configured, ` +
        `so every one of those calls fails. The generated error handling returns an empty list rather than ` +
        `an error, so the pages will look finished and hold nothing.`,
    });
    return findings.slice(0, MAX_REPORTED);
  }

  if (declared.size > 0 && !database.schemaApplied) {
    findings.push({
      kind: "schema-never-applied",
      path: "src/db/schema.sql",
      symbol: `${declared.size} table(s)`,
      detail:
        `The schema declares ${declared.size} table(s), but nothing will run this SQL — the generated schema ` +
        `is only applied to a Supabase project the user connected themselves, and this build has none. ` +
        `The tables will not exist, and the app's reads will come back empty instead of failing loudly.`,
    });
  }

  return findings.slice(0, MAX_REPORTED);
}

/** For the model, mid-build: terse, and silent when there is nothing to say. */
export function formatDataLayerGaps(findings: DataLayerFinding[]): string {
  if (findings.length === 0) return "No data-layer gaps found.";
  const lines = findings.map((f) => `- [${f.kind}] ${f.path} — ${f.symbol}: ${f.detail}`);
  return `Data layer (${findings.length}):\n${lines.join("\n")}`;
}

/**
 * For the user, at the end. Written for someone who did not ask for a lecture
 * about schemas — the audit card was removed from the UI once already because
 * its language was written for a maintainer.
 */
export function formatDataLayerForUser(findings: DataLayerFinding[]): string[] {
  if (findings.length === 0) return [];
  const lines: string[] = [];

  // First, and in the bluntest words in this file. Someone who is told their
  // app works, and finds out later that nothing was ever saved, has been let
  // down worse than by any build that simply failed.
  const fake = findings.filter((f) => f.kind === "fake-persistence");
  if (fake.length > 0) {
    lines.push(
      "⚠️ Part of this app only pretends to save your data — it keeps it in your browser instead of " +
        "a database, so it will look like it worked and then be gone. I have flagged it rather than " +
        "leaving it to be discovered.",
    );
  }

  const missing = findings.filter((f) => f.kind === "table-never-declared");
  if (missing.length > 0) {
    const names = missing.map((f) => f.symbol).join(", ");
    lines.push(
      `⚠️ The app asks for data it never defined: ${names}. Those screens will come back empty.`,
    );
  }

  if (findings.some((f) => f.kind === "no-database")) {
    lines.push(
      "⚠️ This app saves data, but no database is connected — nothing you enter will be kept.",
    );
  }

  if (findings.some((f) => f.kind === "schema-never-applied")) {
    lines.push(
      "⚠️ This app's tables were written but never created. Connect your own Supabase project so they can be, " +
        "or the app will show empty lists however much you add.",
    );
  }

  return lines;
}
