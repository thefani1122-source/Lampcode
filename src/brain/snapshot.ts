/**
 * What is true about this project, carried from one build to the next.
 *
 * WHY THIS EXISTS. `shared_brain_files` and `BrainManager` were built, and
 * `build.ts:loadLatestBrainFiles()` reads the latest version of each record
 * into every build prompt. Nothing ever wrote one: the only caller of
 * `createVersion()` was the `/api/brain` route, and the frontend never calls
 * it. So the project's own long-term memory returned an empty array on every
 * build, for every project, since it was added.
 *
 * This module is the missing write side. It is DELIBERATELY deterministic —
 * no model call, for the same reasons `memory-generator.ts` gives: a Haiku
 * dispatch that needs a credential fails quietly on Railway, degrades to the
 * previous value and nobody notices for weeks. Everything here is derived from
 * the delivered files and from measurements the build already has.
 *
 * WHAT IT IS FOR, which is not what memory or the manifest are for:
 *   - the file manifest answers WHERE  (files, exports, routes, per file)
 *   - project memory answers WHAT and WHY  (the user's own prompts, packages,
 *     design tokens, tables)
 *   - these records answer WHAT IS SETTLED AND WHAT IS STILL OPEN
 *
 * That third question is the one a long project needs and the only one that
 * cannot be re-derived from the current file tree, because it is about
 * HISTORY: a requirement the user asked for three builds ago and that no build
 * has covered since leaves no trace in the code — that is precisely what makes
 * it the thing worth remembering.
 *
 * CONTRACT therefore MERGES rather than overwrites. Each build's completion
 * audit only ever covers that build's own prompt, so overwriting would drop
 * every earlier requirement the moment the user asked for something new — the
 * exact failure this record exists to prevent. Merging is keyed on the
 * requirement TEXT, never on the criterion id: ids are renumbered R1, R2 … by
 * the parser on every build and are not stable across them.
 *
 * Parsing our own markdown back is circular, and that is a deliberate trade,
 * the same one `memory-generator.ts` makes: the alternative is another table,
 * and a failed parse degrades to "this build's requirements only", which is
 * still better than nothing.
 *
 * Nothing here may throw on odd input and nothing here is allowed to fail a
 * build; the caller treats a failure as a warning. These records are also
 * labelled untrusted where they are injected, and the audit agents are given
 * none of them on purpose — a record describing what the builder believes it
 * did is exactly the account the audit has to be independent of.
 */
import type {
  BrainFileType,
  BuildOutcome,
  CompletionAudit,
  CriterionStatus,
} from "../db/schema.js";
import { extractAllRoutes } from "../agents/manifest-generator.js";

/** The read path truncates each record at 6,000 chars; stay under that so what
 *  is written is what is later read, rather than a silently cut document. */
const MAX_RECORD_CHARS = 5_500;
/** Requirements kept in CONTRACT. Open ones are kept first, so the cap drops
 *  settled history rather than outstanding work. */
const MAX_CONTRACT_ROWS = 40;
/**
 * How much of one requirement's wording is stored.
 *
 * Applied on BOTH sides — to the audit's criteria here and therefore to what is
 * written — so `requirementKey` derives the same key from a stored row and from
 * the same criterion seen again in a later build. Capping only on the way out
 * would change the key and the same requirement would come back as a second
 * row every build.
 */
const MAX_REQUIREMENT_CHARS = 300;
/** Budget for the table itself, leaving room for the prose around it inside
 *  MAX_RECORD_CHARS. Rows are fitted to this rather than counted, because
 *  `cap()` cutting the table mid-row loses those requirements for good: the
 *  merge can only carry forward what `parseContractRows` can read back. */
const MAX_CONTRACT_TABLE_CHARS = 4_200;

/** Keep the opening words, which is where a requirement says what it is. */
function capRequirementText(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_REQUIREMENT_CHARS ? flat : `${flat.slice(0, MAX_REQUIREMENT_CHARS)}…`;
}

export type SchemaApplyResult = { ran: boolean; ok: boolean; error?: string } | null;

export type BrainSnapshotInput = {
  /** This build's request, in the user's own words. */
  prompt: string;
  /** The files as delivered, after every repair loop. */
  files: Record<string, string>;
  /** Null when the audit could not run — which is a different fact from an
   *  audit that ran and found nothing, and is recorded as such. */
  audit: CompletionAudit | null;
  outcome: BuildOutcome;
  schemaApply: SchemaApplyResult;
  /** Latest stored content per record, for the merge. Missing keys are a
   *  project with no history yet. */
  previous: Partial<Record<BrainFileType, string>>;
  at: Date;
};

export type BrainSnapshot = Partial<Record<BrainFileType, string>>;

// ── Contract rows ────────────────────────────────────────────────────────────

export type ContractRow = {
  text: string;
  status: CriterionStatus;
  /** ISO date of the build whose audit last ruled on this requirement. */
  lastSeen: string;
};

const STATUS_ORDER: Record<CriterionStatus, number> = {
  contradicted: 0,
  unverified: 1,
  proven: 2,
};

/** Merge key. Case, punctuation and whitespace vary between runs of the
 *  extraction pass over the same sentence; the wording does not. */
function requirementKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isCriterionStatus(value: string): value is CriterionStatus {
  return value === "proven" || value === "contradicted" || value === "unverified";
}

const CONTRACT_HEADING = "# Project contract — requirements and their last verdict";
const CONTRACT_ROW_RE = /^\|\s*(proven|contradicted|unverified)\s*\|\s*([0-9]{4}-[0-9]{2}-[0-9]{2})\s*\|\s*(.+?)\s*\|$/;

/** Read back the rows this module wrote last time. A row that does not parse is
 *  skipped rather than guessed at; the result degrades toward "this build
 *  only". */
export function parseContractRows(markdown: string | undefined): ContractRow[] {
  if (!markdown) return [];
  const rows: ContractRow[] = [];
  for (const line of markdown.split(/\r?\n/)) {
    const m = CONTRACT_ROW_RE.exec(line.trim());
    if (!m) continue;
    const [, status, lastSeen, text] = m;
    if (!status || !lastSeen || !text || !isCriterionStatus(status)) continue;
    rows.push({ text: text.replace(/\\\|/g, "|"), status, lastSeen });
  }
  return rows;
}

/**
 * Prior rows plus this build's verdicts.
 *
 * A requirement the current audit ruled on takes the new verdict and the new
 * date. One it did not mention keeps the verdict and date it already had —
 * this build said nothing about it, which is not evidence that it changed.
 */
export function mergeContractRows(
  previous: ContractRow[],
  audit: CompletionAudit | null,
  at: Date,
): ContractRow[] {
  const day = at.toISOString().slice(0, 10);
  const byKey = new Map<string, ContractRow>();
  for (const row of previous) {
    const key = requirementKey(row.text);
    if (key) byKey.set(key, row);
  }

  if (audit) {
    const statusById = new Map<string, CriterionStatus>();
    for (const verdict of audit.verdicts) statusById.set(verdict.id, verdict.status);
    for (const criterion of audit.criteria) {
      const text = capRequirementText(criterion.text);
      const key = requirementKey(text);
      if (!key) continue;
      // A criterion the audit extracted but returned no verdict for is not
      // covered by anything that ran, which is what unverified means.
      byKey.set(key, {
        text,
        status: statusById.get(criterion.id) ?? "unverified",
        lastSeen: day,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => {
    const byStatus = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    // Newest first within a status, so the cap drops the oldest settled work.
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function renderContract(rows: ContractRow[], audit: CompletionAudit | null): string {
  const open = rows.filter((r) => r.status !== "proven").length;
  // Take rows in the order they were sorted — open work first — until either
  // cap is reached. Fitting by LENGTH is the point: a row that does not fit is
  // dropped whole and counted, where a row cut in half by `cap()` below would
  // be unreadable to the next build's merge and the requirement would vanish.
  const kept: ContractRow[] = [];
  let tableChars = 0;
  for (const row of rows) {
    if (kept.length >= MAX_CONTRACT_ROWS) break;
    const line = `| ${row.status} | ${row.lastSeen} | ${escapeCell(row.text)} |`;
    if (tableChars + line.length + 1 > MAX_CONTRACT_TABLE_CHARS) break;
    kept.push(row);
    tableChars += line.length + 1;
  }
  const lines = [
    CONTRACT_HEADING,
    "",
    "Requirements in the user's own words, carried across builds. A build's audit",
    "only rules on what that build was asked for, so a row keeps its last verdict",
    "until some later audit rules on it again.",
    "",
    "`unverified` is NOT a soft pass: nothing in the build covered the requirement.",
    `Open (contradicted or unverified): ${open} of ${rows.length}.`,
    "",
    "| status | last ruled | requirement |",
    "|---|---|---|",
    ...kept.map((r) => `| ${r.status} | ${r.lastSeen} | ${escapeCell(r.text)} |`),
  ];
  if (rows.length > kept.length) {
    const dropped = rows.length - kept.length;
    const openDropped = rows.slice(kept.length).filter((r) => r.status !== "proven").length;
    lines.push(
      "",
      `(${dropped} requirement(s) dropped at the record cap` +
        (openDropped > 0
          // Open work falling off the cap is a real loss, not housekeeping, and
          // saying so is the only way anyone finds out.
          ? `, and ${openDropped} of them were still open — this project has more outstanding requirements than one record can carry.)`
          : ", all of them already proven.)"),
    );
  }
  if (audit?.criteriaDropped) {
    lines.push(
      "",
      `The extraction cap discarded ${audit.criteriaDropped} requirement(s) from this build before the audit ran,`,
      "so the tally above describes only part of what was asked for.",
    );
  }
  if (!audit) {
    lines.push("", "This build's audit could not run, so no row below was ruled on by it.");
  }
  return lines.join("\n");
}

// ── Project shape, derived only from the delivered files ─────────────────────

function has(files: Record<string, string>, predicate: (path: string) => boolean): boolean {
  return Object.keys(files).some(predicate);
}

function sourceOf(files: Record<string, string>): string {
  return Object.values(files).join("\n");
}

export type ProjectShape = {
  framework: "nextjs" | "react-vite" | "unknown";
  backend: "node-hono" | "python-fastapi" | "none";
  database: "supabase" | "mongodb" | "none";
};

/**
 * What the files themselves prove, not what the build intended.
 *
 * Deliberately self-contained: the equivalent helpers live in `build-planner.ts`
 * and `build.ts`, both of which reach `e2b-service.ts`, which hangs when it is
 * imported outside the server process (CLAUDE.md trap 9). A record that cannot
 * be tested is a record nobody will change later with any confidence.
 */
export function detectProjectShape(files: Record<string, string>): ProjectShape {
  const source = sourceOf(files);
  const framework = has(files, (p) => p.startsWith("app/") && /\/(page|layout)\.tsx?$/.test(p))
    ? "nextjs"
    : has(files, (p) => p === "src/App.tsx" || p.startsWith("src/"))
      ? "react-vite"
      : "unknown";
  const backend = has(files, (p) => p === "src/server/main.py" || p.endsWith("/main.py"))
    ? "python-fastapi"
    : has(files, (p) => p.startsWith("src/server/") || p === "server/index.ts")
      ? "node-hono"
      : framework === "nextjs" && has(files, (p) => /^app\/api\//.test(p))
        ? "node-hono"
        : "none";
  const database = /MONGODB_URI|mongodb(?:\+srv)?:\/\/|from\s+["']mongoose["']/i.test(source)
    ? "mongodb"
    : /@supabase\/supabase-js|SUPABASE_URL|supabase\.from\(/i.test(source)
      ? "supabase"
      : "none";
  return { framework, backend, database };
}

// ── Records ──────────────────────────────────────────────────────────────────

function gateLine(name: string, verdict: string, stale: number | undefined): string {
  const staleNote = stale && stale > 0
    ? ` — but ${stale} write(s) landed after it ran, so this verdict is about code the build no longer has`
    : "";
  return `- ${name}: ${verdict}${staleNote}`;
}

function renderCurrentState(input: BrainSnapshotInput, shape: ProjectShape): string {
  const { outcome, schemaApply, files, at } = input;
  const lines = [
    "# Current state — what this project is, and what was last proven about it",
    "",
    `Recorded ${at.toISOString().slice(0, 10)} from the files as delivered.`,
    "Verify against the current files before relying on any of it.",
    "",
    "## Architecture, as the files show it",
    `- Framework: ${shape.framework}`,
    `- Application server: ${shape.backend}`,
    `- Database in the code: ${shape.database}`,
    `- Source files delivered: ${Object.keys(files).length}`,
    "",
    "## What the gates said on the last build",
    gateLine("Page renders (check_page)", outcome.checkPage, outcome.staleCheckPage),
    gateLine("Types (check_types)", outcome.checkTypes, outcome.staleCheckTypes),
    gateLine("Tests (run_tests)", outcome.checkTests, outcome.staleCheckTests),
    `- Rounds used: ${outcome.rounds}${outcome.turnsExhausted ? " (hit the turn cap — the build stopped before the model said it was finished)" : ""}`,
  ];
  if (outcome.budgetExhausted) {
    lines.push("- The spend ceiling stopped a round that still wanted more work.");
  }
  lines.push(
    "",
    "`never` above means the model did not call that gate at all, which is a",
    "different and worse thing than calling it and failing.",
    "",
    "## Persistence",
  );
  if (!schemaApply) {
    lines.push(
      shape.database === "none"
        ? "- No schema was generated and no database is used by this code."
        : "- No schema was applied on the last build.",
    );
  } else if (schemaApply.ran && schemaApply.ok) {
    lines.push("- The generated schema was applied to a real database successfully.");
  } else if (schemaApply.ran) {
    lines.push(`- Applying the generated schema FAILED: ${(schemaApply.error ?? "unknown error").slice(0, 300)}`);
  } else {
    lines.push(
      "- A schema was generated but there was no database to apply it to, so nothing",
      "  this app writes is being stored. This is the most common reason a",
      "  \"fullstack\" app saves nothing.",
    );
  }
  return lines.join("\n");
}

const FETCH_CALL_RE = /(?:fetch|axios\s*\.\s*(?:get|post|put|patch|delete))\s*\(\s*(?:`|'|")?(?:\$\{[^}]*\}|API_BASE\s*\+\s*(?:'|"|`))?([/][a-zA-Z0-9_\-/{}:.$]*)/g;

/** Endpoint paths the frontend asks for, however it spells the base. */
export function extractCalledPaths(files: Record<string, string>): string[] {
  const called = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith(".py") || path.startsWith("src/server/")) continue;
    FETCH_CALL_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = FETCH_CALL_RE.exec(content)) !== null) {
      const target = m[1];
      if (target && target.startsWith("/api")) called.add(target);
    }
  }
  return [...called].sort();
}

function renderApiContracts(input: BrainSnapshotInput, shape: ProjectShape): string {
  const declared = new Map<string, string[]>();
  for (const [path, content] of Object.entries(input.files)) {
    const routes = extractAllRoutes(content);
    if (routes.length) declared.set(path, routes);
  }
  const called = extractCalledPaths(input.files);
  const lines = [
    "# API contracts — the endpoint surface as the code declares it",
    "",
    `Recorded ${input.at.toISOString().slice(0, 10)}. Do not invent an endpoint that is not`,
    "here; add it to the server and to the frontend's api module together.",
    "",
  ];
  if (shape.backend === "none") {
    lines.push("This project has no application server. There are no endpoints to call.");
    return lines.join("\n");
  }
  lines.push("## Declared by the server");
  if (declared.size === 0) {
    lines.push("- none found, although the project has server files — check before adding more.");
  } else {
    for (const [path, routes] of [...declared].sort()) {
      lines.push(`- ${path}: ${[...new Set(routes)].join(", ")}`);
    }
  }
  lines.push("", "## Requested by the frontend");
  lines.push(called.length ? called.map((p) => `- ${p}`).join("\n") : "- no /api calls found in frontend code.");
  return lines.join("\n");
}

const CREATE_TABLE_RE = /create\s+table(?:\s+if\s+not\s+exists)?\s+(?:public\.)?["`]?([a-zA-Z0-9_]+)["`]?/gi;

/** Table names the generated SQL declares. */
export function extractDeclaredTables(files: Record<string, string>): string[] {
  const tables = new Set<string>();
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".sql")) continue;
    CREATE_TABLE_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CREATE_TABLE_RE.exec(content)) !== null) {
      if (m[1]) tables.add(m[1]);
    }
  }
  return [...tables].sort();
}

function renderDbSchema(input: BrainSnapshotInput, shape: ProjectShape): string {
  const tables = extractDeclaredTables(input.files);
  const lines = [
    "# Database — what this project declares, and whether it exists",
    "",
    `Recorded ${input.at.toISOString().slice(0, 10)}.`,
    "",
  ];
  if (shape.database === "none" && tables.length === 0) {
    lines.push(
      "No database is used by this code and no schema is declared. Do not add a",
      "Supabase or MongoDB client, a schema or credentials unless the user asks.",
    );
    return lines.join("\n");
  }
  lines.push(`- Provider in the code: ${shape.database}`);
  lines.push(
    tables.length
      ? `- Tables declared in SQL: ${tables.join(", ")}`
      : "- No CREATE TABLE statements found in the delivered .sql files.",
  );
  if (input.schemaApply?.ran && input.schemaApply.ok) {
    lines.push("- These tables were applied to a real database on the last build.");
  } else if (input.schemaApply?.ran) {
    lines.push(`- Applying them FAILED: ${(input.schemaApply.error ?? "unknown error").slice(0, 300)}`);
  } else {
    lines.push(
      "- They have NOT been applied to any database. Anything the app writes is not",
      "  being stored, whatever the UI shows.",
    );
  }
  return lines.join("\n");
}

/**
 * The record's content with its `Recorded <date>` line removed.
 *
 * The caller writes a new version only when content changed, and three of these
 * records state the day they were written — so without this, an unchanged
 * project still produced a new version of each one every calendar day. The date
 * is kept in the record because it tells the model how stale the record is;
 * it just must not count as a change.
 */
export function contentWithoutDate(content: string): string {
  return content.replace(/^Recorded \d{4}-\d{2}-\d{2}[^\n]*$/gm, "Recorded <date>");
}

function cap(text: string): string {
  return text.length <= MAX_RECORD_CHARS
    ? text
    : `${text.slice(0, MAX_RECORD_CHARS)}\n[record truncated at its write cap]`;
}

/**
 * The four records this build can state deterministically.
 *
 * The other four record types in the enum — DEPLOY_CHECKLIST,
 * SECURITY_CHECKLIST, CONNECTION_CHECKLIST, PROVENANCE_LOG — are left alone:
 * there is no deploy today, and writing a checklist for a subsystem that does
 * not exist is the kind of confident, empty record this product already has
 * too many of. These four are exactly the set `prompt-builder.relevantFiles()`
 * gives the planning agent.
 */
export function buildBrainSnapshot(input: BrainSnapshotInput): BrainSnapshot {
  const shape = detectProjectShape(input.files);
  const rows = mergeContractRows(parseContractRows(input.previous.CONTRACT), input.audit, input.at);
  const snapshot: BrainSnapshot = {
    CURRENT_STATE: cap(renderCurrentState(input, shape)),
    API_CONTRACTS: cap(renderApiContracts(input, shape)),
    DB_SCHEMA: cap(renderDbSchema(input, shape)),
  };
  // A project whose audit has never produced a requirement gets no CONTRACT
  // rather than an empty table that reads as "nothing was asked for".
  if (rows.length > 0) snapshot.CONTRACT = cap(renderContract(rows, input.audit));
  return snapshot;
}
