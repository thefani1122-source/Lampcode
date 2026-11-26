/**
 * The Brain's write side, and above all the CONTRACT merge.
 *
 * `shared_brain_files` is read into every build prompt by
 * `build.ts:loadLatestBrainFiles()`, and until now nothing ever wrote one — so
 * that read returned an empty array for every project, on every build, since
 * the table was added. These cases cover the module that fills it.
 *
 * The property that matters most is the one in `mergeContractRows`: a
 * requirement the user asked for in an EARLIER build, which no build has
 * covered since, must survive into the next prompt. A build's audit only ever
 * rules on that build's own prompt, so overwriting would drop every earlier
 * requirement the moment the user asks for something new — and a dropped
 * `unverified` row is exactly the failure the completion audit exists to catch.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildBrainSnapshot,
  contentWithoutDate,
  detectProjectShape,
  extractCalledPaths,
  extractDeclaredTables,
  mergeContractRows,
  parseContractRows,
  type ContractRow,
} from "../src/brain/snapshot.js";
import type { BuildOutcome, CompletionAudit } from "../src/db/schema.js";

let failures = 0;
function check(name: string, run: () => void): void {
  try { run(); console.log("✔ " + name); }
  catch (err) { failures++; console.error("✘ " + name + "\n    " + (err instanceof Error ? err.message : String(err))); }
}

const OUTCOME: BuildOutcome = {
  rounds: 7,
  turnsExhausted: false,
  filesWritten: 9,
  toolCalls: { write_files: 3, check_page: 2 },
  checkPage: "pass",
  checkTypes: "pass",
  checkTests: "none",
  planned: true,
  plannedFiles: 9,
  costUsd: 0.04,
  durationMs: 61_000,
};

function audit(
  criteria: Array<{ id: string; text: string }>,
  verdicts: Array<{ id: string; status: "proven" | "contradicted" | "unverified" }>,
  extra: Partial<CompletionAudit> = {},
): CompletionAudit {
  return {
    criteria: criteria.map((c) => ({ ...c, kind: "behaviour" as const })),
    verdicts: verdicts.map((v) => ({ ...v, evidence: "", note: "" })),
    proven: verdicts.filter((v) => v.status === "proven").length,
    contradicted: verdicts.filter((v) => v.status === "contradicted").length,
    unverified: verdicts.filter((v) => v.status === "unverified").length,
    costUsd: 0,
    ...extra,
  };
}

const DAY_ONE = new Date("2026-01-10T00:00:00Z");
const DAY_TWO = new Date("2026-02-20T00:00:00Z");

// ── The merge ────────────────────────────────────────────────────────────────

check("a requirement the new audit never mentions keeps its verdict and its date", () => {
  const prior: ContractRow[] = [
    { text: "Tasks persist across reloads", status: "unverified", lastSeen: "2026-01-10" },
  ];
  const merged = mergeContractRows(prior, audit([{ id: "R1", text: "Add a dark mode toggle" }], [{ id: "R1", status: "proven" }]), DAY_TWO);
  const carried = merged.find((r) => r.text === "Tasks persist across reloads");
  assert.ok(carried, "the earlier requirement was dropped — this is the long-project bug");
  assert.equal(carried.status, "unverified");
  assert.equal(carried.lastSeen, "2026-01-10", "this build said nothing about it, so its date must not move");
  assert.equal(merged.length, 2);
});

check("a new verdict on the same requirement wins, matched on text not on id", () => {
  // Ids are renumbered R1, R2 … on every build, so the id a requirement had
  // last time says nothing about which one it is now.
  const prior = parseContractRows(
    buildBrainSnapshot({
      prompt: "p", files: {}, audit: audit([{ id: "R3", text: "Tasks persist across reloads" }], [{ id: "R3", status: "unverified" }]),
      outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
    }).CONTRACT,
  );
  assert.equal(prior.length, 1, "the row this test merges against did not round-trip");
  const merged = mergeContractRows(prior, audit([{ id: "R1", text: "Tasks persist across reloads" }], [{ id: "R1", status: "proven" }]), DAY_TWO);
  assert.equal(merged.length, 1, "the same requirement under a new id must not become a second row");
  assert.equal(merged[0]?.status, "proven");
  assert.equal(merged[0]?.lastSeen, "2026-02-20");
});

check("wording that differs only in case or punctuation is the same requirement", () => {
  const prior: ContractRow[] = [{ text: "Tasks persist across reloads.", status: "unverified", lastSeen: "2026-01-10" }];
  const merged = mergeContractRows(prior, audit([{ id: "R1", text: "tasks  persist across reloads" }], [{ id: "R1", status: "proven" }]), DAY_TWO);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.status, "proven");
});

check("an extracted criterion with no verdict is unverified, not silently absent", () => {
  const merged = mergeContractRows([], audit([{ id: "R1", text: "Export to CSV" }], []), DAY_TWO);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.status, "unverified");
});

check("open requirements sort ahead of settled ones, so the cap drops settled work", () => {
  const merged = mergeContractRows(
    [
      { text: "A proven thing", status: "proven", lastSeen: "2026-02-01" },
      { text: "An unverified thing", status: "unverified", lastSeen: "2026-01-01" },
      { text: "A contradicted thing", status: "contradicted", lastSeen: "2026-01-01" },
    ],
    null,
    DAY_TWO,
  );
  assert.deepEqual(merged.map((r) => r.status), ["contradicted", "unverified", "proven"]);
});

check("a null audit changes no verdict and says so in the record", () => {
  const prior: ContractRow[] = [{ text: "Tasks persist across reloads", status: "proven", lastSeen: "2026-01-10" }];
  const merged = mergeContractRows(prior, null, DAY_TWO);
  assert.deepEqual(merged, prior);
  const snap = buildBrainSnapshot({
    prompt: "p", files: {}, audit: null, outcome: OUTCOME, schemaApply: null,
    previous: { CONTRACT: `| proven | 2026-01-10 | Tasks persist across reloads |` }, at: DAY_TWO,
  });
  assert.match(snap.CONTRACT ?? "", /audit could not run/);
});

// ── Round-trip, which is what makes parsing our own output acceptable ────────

check("every written row parses back, including one containing a pipe", () => {
  const first = buildBrainSnapshot({
    prompt: "p", files: {},
    audit: audit(
      [
        { id: "R1", text: "Filter by status | priority" },
        { id: "R2", text: "Tasks persist across reloads" },
      ],
      [{ id: "R1", status: "unverified" }, { id: "R2", status: "proven" }],
    ),
    outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  const rows = parseContractRows(first.CONTRACT);
  assert.equal(rows.length, 2, "a row did not survive the write/read round-trip");
  assert.ok(rows.some((r) => r.text === "Filter by status | priority"), "the escaped pipe did not come back");
});

check("dropped criteria are reported rather than hidden by the tally", () => {
  const snap = buildBrainSnapshot({
    prompt: "p", files: {},
    audit: audit([{ id: "R1", text: "A thing" }], [{ id: "R1", status: "proven" }], { criteriaDropped: 4 }),
    outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  assert.match(snap.CONTRACT ?? "", /discarded 4 requirement/);
});

check("a project whose audit produced nothing gets no CONTRACT at all", () => {
  const snap = buildBrainSnapshot({
    prompt: "p", files: {}, audit: null, outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  assert.equal(snap.CONTRACT, undefined, "an empty table reads as 'nothing was asked for'");
  assert.ok(snap.CURRENT_STATE && snap.API_CONTRACTS && snap.DB_SCHEMA);
});

// ── Derived facts ────────────────────────────────────────────────────────────

check("project shape comes from the files, not from intent", () => {
  assert.deepEqual(
    detectProjectShape({ "src/App.tsx": "x", "src/server/index.ts": "import { Hono } from 'hono'", "src/lib/db.ts": "import { createClient } from '@supabase/supabase-js'" }),
    { framework: "react-vite", backend: "node-hono", database: "supabase" },
  );
  assert.deepEqual(
    detectProjectShape({ "src/App.tsx": "x", "src/server/main.py": "from fastapi import FastAPI" }),
    { framework: "react-vite", backend: "python-fastapi", database: "none" },
  );
  assert.deepEqual(
    detectProjectShape({ "app/page.tsx": "x", "app/layout.tsx": "y", "app/api/items/route.ts": "export async function GET() {}" }).framework,
    "nextjs",
  );
  assert.equal(detectProjectShape({ "src/App.tsx": "import mongoose from 'mongoose'" }).database, "mongodb");
  assert.deepEqual(detectProjectShape({ "src/App.tsx": "const x = 1" }), { framework: "react-vite", backend: "none", database: "none" });
});

check("declared tables and requested endpoints are both collected", () => {
  assert.deepEqual(
    extractDeclaredTables({ "src/db/schema.sql": "CREATE TABLE IF NOT EXISTS public.deals (id uuid);\ncreate table clients (id uuid);" }),
    ["clients", "deals"],
  );
  assert.deepEqual(
    extractCalledPaths({
      "src/lib/api.ts": "fetch(API_BASE + '/api/deals'); fetch(`/api/clients`);",
      "src/server/index.ts": "fetch('/api/should-be-ignored')",
    }),
    ["/api/clients", "/api/deals"],
  );
});

check("more than four routes in one file all reach the API record", () => {
  // extractAllRoutes exists because the manifest caps at four per file, and an
  // endpoint surface that stops at four invites inventing the fifth.
  const server = ["get", "post", "put", "patch", "delete"].map((v) => `app.${v}('/api/items')`).join("\n") + "\napp.get('/api/extra')";
  const snap = buildBrainSnapshot({
    prompt: "p", files: { "src/App.tsx": "x", "src/server/index.ts": server },
    audit: null, outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  assert.match(snap.API_CONTRACTS ?? "", /GET \/api\/extra/, "the sixth route was lost to the manifest's display cap");
});

// ── The honest statements ────────────────────────────────────────────────────

check("a schema that was never applied says so plainly", () => {
  const files = { "src/App.tsx": "x", "src/db/schema.sql": "create table notes (id uuid);", "src/lib/db.ts": "import { createClient } from '@supabase/supabase-js'" };
  const never = buildBrainSnapshot({ prompt: "p", files, audit: null, outcome: OUTCOME, schemaApply: { ran: false, ok: false }, previous: {}, at: DAY_ONE });
  assert.match(never.DB_SCHEMA ?? "", /have NOT been applied/);
  assert.match(never.CURRENT_STATE ?? "", /no database to apply it to/);

  const failed = buildBrainSnapshot({ prompt: "p", files, audit: null, outcome: OUTCOME, schemaApply: { ran: true, ok: false, error: "permission denied for schema public" }, previous: {}, at: DAY_ONE });
  assert.match(failed.DB_SCHEMA ?? "", /permission denied for schema public/);

  const ok = buildBrainSnapshot({ prompt: "p", files, audit: null, outcome: OUTCOME, schemaApply: { ran: true, ok: true }, previous: {}, at: DAY_ONE });
  assert.match(ok.DB_SCHEMA ?? "", /applied to a real database/);
});

check("a stale gate verdict is recorded as stale, not as a pass", () => {
  const snap = buildBrainSnapshot({
    prompt: "p", files: { "src/App.tsx": "x" }, audit: null,
    outcome: { ...OUTCOME, checkPage: "pass", staleCheckPage: 3, turnsExhausted: true },
    schemaApply: null, previous: {}, at: DAY_ONE,
  });
  assert.match(snap.CURRENT_STATE ?? "", /3 write\(s\) landed after it ran/);
  assert.match(snap.CURRENT_STATE ?? "", /hit the turn cap/);
});

check("a frontend-only project is told it has no endpoints rather than none found", () => {
  const snap = buildBrainSnapshot({
    prompt: "p", files: { "src/App.tsx": "const x = 1" }, audit: null, outcome: OUTCOME,
    schemaApply: null, previous: {}, at: DAY_ONE,
  });
  assert.match(snap.API_CONTRACTS ?? "", /no application server/);
  assert.match(snap.DB_SCHEMA ?? "", /No database is used by this code/);
});

// ── Budget ───────────────────────────────────────────────────────────────────

check("no record exceeds the 6,000 chars the read path will keep", () => {
  const manyRows: ContractRow[] = Array.from({ length: 200 }, (_, i) => ({
    text: `Requirement number ${i} with a deliberately long sentence so the cap is reached`,
    status: (i % 3 === 0 ? "unverified" : "proven") as ContractRow["status"],
    lastSeen: "2026-01-10",
  }));
  const files: Record<string, string> = { "src/App.tsx": "x", "src/server/index.ts": "" };
  for (let i = 0; i < 300; i++) files["src/server/index.ts"] += `app.get('/api/route-number-${i}')\n`;
  const snap = buildBrainSnapshot({
    prompt: "p", files,
    audit: audit(manyRows.map((r, i) => ({ id: `R${i}`, text: r.text })), manyRows.map((r, i) => ({ id: `R${i}`, status: r.status }))),
    outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  for (const [type, content] of Object.entries(snap)) {
    assert.ok(content.length <= 6_000, `${type} is ${content.length} chars — the read path would truncate it`);
  }
  // The cap must not spend itself on settled history. 200 requirements, every
  // third one unverified (67 of them) — so a table that sorts open work first
  // has no room left for a single proven row. The row count is deliberately NOT
  // asserted: the table is fitted by LENGTH, so how many rows fit depends on how
  // long their requirements are. What must hold is the ordering and the
  // accounting.
  const kept = parseContractRows(snap.CONTRACT);
  assert.ok(kept.length > 0 && kept.length <= 40, `kept ${kept.length} rows, outside both caps`);
  assert.deepEqual(
    [...new Set(kept.map((r) => r.status))],
    ["unverified"],
    "a settled requirement took a row that outstanding work needed",
  );
  const reported = Number(/\((\d+) requirement\(s\) dropped/.exec(snap.CONTRACT ?? "")?.[1] ?? 0);
  assert.equal(kept.length + reported, manyRows.length, "requirements went missing without being reported");
});

// ── The record must always round-trip ────────────────────────────────────────
// Found reviewing this file's first version: rows were capped by COUNT while
// requirement texts were uncapped, so `cap()` cut the rendered table mid-row at
// MAX_RECORD_CHARS. The merge can only carry forward what parseContractRows can
// read back, so every row lost that way was lost from the project for good —
// the exact failure this record exists to prevent. Measured then: 40
// requirements of ~400 chars came back as 11, with 29 gone and nothing saying so.

check("no requirement is ever half-written: every one is readable or counted", () => {
  for (const [count, len] of [[10, 60], [20, 300], [10, 600], [40, 400], [200, 500]] as Array<[number, number]>) {
    const criteria = Array.from({ length: count }, (_, i) => ({ id: `R${i}`, text: `Requirement ${i}: ${"x".repeat(len)}` }));
    const snap = buildBrainSnapshot({
      prompt: "p", files: {},
      audit: audit(criteria, criteria.map((c) => ({ id: c.id, status: "unverified" as const }))),
      outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
    });
    const record = snap.CONTRACT ?? "";
    const label = `${count} requirements of ${len} chars`;
    assert.ok(
      !record.includes("[record truncated at its write cap]"),
      `${label}: the write cap cut the record, so its last row is unreadable to the next merge`,
    );
    const readable = parseContractRows(record).length;
    const reported = Number(/\((\d+) requirement\(s\) dropped/.exec(record)?.[1] ?? 0);
    assert.equal(
      readable + reported, count,
      `${label}: ${count - readable - reported} requirement(s) vanished without being reported`,
    );
  }
});

check("a long requirement seen again updates in place instead of duplicating", () => {
  // The text is capped on the way IN as well as out, so requirementKey derives
  // the same key both times. Capping only on the way out would change the key
  // and the same requirement would come back as a second row every build.
  const long = `Tasks persist across reloads ${"y".repeat(800)}`;
  const first = buildBrainSnapshot({
    prompt: "p", files: {},
    audit: audit([{ id: "R7", text: long }], [{ id: "R7", status: "unverified" }]),
    outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  const merged = mergeContractRows(
    parseContractRows(first.CONTRACT),
    audit([{ id: "R1", text: long }], [{ id: "R1", status: "proven" }]),
    DAY_TWO,
  );
  assert.equal(merged.length, 1, "the same long requirement became a second row");
  assert.equal(merged[0]?.status, "proven");
});

check("open work dropped at the cap is reported as open, not as housekeeping", () => {
  const criteria = Array.from({ length: 60 }, (_, i) => ({ id: `R${i}`, text: `Requirement ${i}: ${"x".repeat(300)}` }));
  const snap = buildBrainSnapshot({
    prompt: "p", files: {},
    audit: audit(criteria, criteria.map((c) => ({ id: c.id, status: "unverified" as const }))),
    outcome: OUTCOME, schemaApply: null, previous: {}, at: DAY_ONE,
  });
  assert.match(
    snap.CONTRACT ?? "", /were still open/,
    "outstanding requirements fell off the cap and the record called them already proven",
  );
});

check("the same project on a different day is not a change", () => {
  // Three records state the day they were written. The caller writes only on
  // change, so without normalising that line an untouched project produced a
  // new version of each record every calendar day.
  const files = { "src/App.tsx": "x", "src/server/index.ts": "app.get('/api/a')" };
  const common = { prompt: "p", files, audit: null, outcome: OUTCOME, schemaApply: null, previous: {} };
  const dayOne = buildBrainSnapshot({ ...common, at: DAY_ONE });
  const dayTwo = buildBrainSnapshot({ ...common, at: DAY_TWO });
  for (const key of ["CURRENT_STATE", "API_CONTRACTS", "DB_SCHEMA"] as const) {
    assert.equal(
      contentWithoutDate(dayOne[key] ?? ""), contentWithoutDate(dayTwo[key] ?? ""),
      `${key}: an unchanged project still counts as changed, so a version is written every day`,
    );
  }
});

// ── The wiring ───────────────────────────────────────────────────────────────
// Asserted over build.ts's SOURCE, the same way e2b-template.test.ts covers the
// prewarm path: saveBrainSnapshot needs a database and a finished build, so the
// call site cannot be exercised here. What can be checked is that it exists, is
// placed where it was reasoned about, and is passed the delivered state — the
// read side was complete for weeks and still returned nothing because the write
// side was simply absent.
const buildSource = readFileSync(new URL("../src/server/routes/build.ts", import.meta.url), "utf8");

check("build.ts calls saveBrainSnapshot with the delivered files and this build's audit", () => {
  assert.match(buildSource, /await saveBrainSnapshot\(\{/, "nothing writes the Brain");
  for (const arg of ["files: allFiles,", "audit: completionAudit,", "outcome,", "schemaApply,"]) {
    assert.ok(buildSource.includes(arg), `saveBrainSnapshot is not passed ${arg}`);
  }
});

check("the snapshot is written after the final memory save, not before the repairs", () => {
  const memoryAt = buildSource.indexOf("Saved verified project memory and manifest");
  const brainAt = buildSource.indexOf("await saveBrainSnapshot({");
  assert.ok(memoryAt > 0 && brainAt > memoryAt, "the Brain must record the delivered state, after every repair loop");
});

check("a failed Brain write cannot fail the build", () => {
  const brainAt = buildSource.indexOf("await saveBrainSnapshot({");
  const after = buildSource.slice(brainAt, brainAt + 600);
  assert.match(after, /catch \(err\)[\s\S]*?logger\.warn/, "the write is not wrapped in a non-fatal catch");
});

check("records are written only when they change, ignoring the date they state", () => {
  assert.match(
    buildSource,
    /contentWithoutDate\(previous\[fileType\]\) === contentWithoutDate\(content\)/,
    "createVersion has no dedup of its own, and a raw comparison is defeated by the Recorded <date> line",
  );
});

check("the snapshot is written after the build is reported complete", () => {
  // It costs ~13 sequential queries; ahead of the completion events, every
  // build's "done" waited on a write whose failure is logged and ignored.
  const completeAt = buildSource.indexOf('"Fast build complete"');
  const brainAt = buildSource.indexOf("await saveBrainSnapshot({");
  assert.ok(completeAt > 0 && brainAt > completeAt, "the Brain write is back on the critical path");
});

check("the merge reads untruncated content, not the prompt-shaped copy", () => {
  assert.ok(buildSource.includes("loadBrainRecordsForMerge"), "the merge helper is gone");
  const helperAt = buildSource.indexOf("async function loadBrainRecordsForMerge");
  const helper = buildSource.slice(helperAt, helperAt + 900);
  assert.ok(!helper.includes("slice("), "merging against a truncated CONTRACT silently drops the oldest requirements");
});

if (failures > 0) { console.error(`\n${failures} brain snapshot case(s) failed.`); process.exit(1); }
console.log("Brain snapshot tests passed.");
