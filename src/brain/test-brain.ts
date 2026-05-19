/**
 * Shared Brain API — unit tests.
 *
 * Tests the LCS diff algorithm and an in-memory BrainManager stub covering:
 * createVersion, getLatest, getHistory, compareVersions.
 *
 * Imports only from brain/diff.ts (no DB/config chain).
 *
 * Usage:
 *   npx tsx src/brain/test-brain.ts
 */

import { lcsLineDiff, type DiffLine } from "./diff.js";

// ── Harness ───────────────────────────────────────────────────────────────────

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
let passed = 0;
let failed = 0;

function test(name: string, fn: TestFn): void { tests.push({ name, fn }); }

async function runTests(): Promise<void> {
  for (const { name, fn } of tests) {
    process.stdout.write(`  ${name.padEnd(68)} ... `);
    try { await fn(); console.log("OK"); passed++; }
    catch (e) { console.log(`FAIL: ${e instanceof Error ? e.message : String(e)}`); failed++; }
  }
}

function expect<T>(a: T, b: T, msg?: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function expectTrue(v: boolean, msg?: string): void { if (!v) throw new Error(msg ?? "Expected true"); }

// ── In-memory BrainManager stub (no DB imports) ───────────────────────────────

type BrainFileType = "CONTRACT" | "DB_SCHEMA" | "API_CONTRACTS" | "CURRENT_STATE";

interface BrainRecord {
  id: string;
  projectId: string;
  sessionId: string | null;
  fileType: BrainFileType;
  version: number;
  content: string;
  agentType: string | null;
  modelUsed: string | null;
  createdAt: Date;
}

interface VersionCompare {
  fileType: BrainFileType;
  fromVersion: number;
  toVersion: number;
  diff: DiffLine[];
  insertions: number;
  deletions: number;
}

class InMemoryBrainManager {
  private readonly store: BrainRecord[] = [];

  getLatest(projectId: string, fileType: BrainFileType): BrainRecord | null {
    const rows = this.store
      .filter((r) => r.projectId === projectId && r.fileType === fileType)
      .sort((a, b) => b.version - a.version);
    return rows[0] ?? null;
  }

  createVersion(
    projectId: string,
    fileType: BrainFileType,
    content: string,
    opts: { agentType?: string; modelUsed?: string; sessionId?: string } = {},
  ): BrainRecord {
    const existing = this.store.filter(
      (r) => r.projectId === projectId && r.fileType === fileType,
    );
    const version = existing.reduce((m, r) => Math.max(m, r.version), 0) + 1;
    const record: BrainRecord = {
      id: `${projectId}-${fileType}-v${version}`,
      projectId,
      sessionId: opts.sessionId ?? null,
      fileType,
      version,
      content,
      agentType: opts.agentType ?? null,
      modelUsed: opts.modelUsed ?? null,
      createdAt: new Date(),
    };
    this.store.push(record);
    return record;
  }

  getHistory(projectId: string, fileType: BrainFileType): BrainRecord[] {
    return this.store
      .filter((r) => r.projectId === projectId && r.fileType === fileType)
      .sort((a, b) => b.version - a.version);
  }

  compareVersions(
    projectId: string,
    fileType: BrainFileType,
    v1: number,
    v2: number,
  ): VersionCompare {
    const fromRow = this.store.find(
      (r) => r.projectId === projectId && r.fileType === fileType && r.version === v1,
    );
    const toRow = this.store.find(
      (r) => r.projectId === projectId && r.fileType === fileType && r.version === v2,
    );
    if (!fromRow) throw new Error(`Version ${v1} of ${fileType} not found`);
    if (!toRow)   throw new Error(`Version ${v2} of ${fileType} not found`);
    const diff = lcsLineDiff(fromRow.content, toRow.content);
    const insertions = diff.filter((l) => l.type === "added").length;
    const deletions  = diff.filter((l) => l.type === "removed").length;
    return { fileType, fromVersion: v1, toVersion: v2, diff, insertions, deletions };
  }
}

const brain = new InMemoryBrainManager();
const PROJECT = "proj-abc";

// ── BrainManager tests ────────────────────────────────────────────────────────

test("getLatest: returns null when no versions exist", () => {
  const r = brain.getLatest("unknown-project", "CONTRACT");
  expect(r, null);
});

test("createVersion: creates version 1 for new file type", () => {
  const r = brain.createVersion(PROJECT, "CONTRACT", "# Contract v1\n\nInitial draft.", {
    agentType: "planning",
    modelUsed: "claude-3-5-sonnet",
  });
  expect(r.version, 1);
  expect(r.fileType, "CONTRACT");
  expect(r.agentType, "planning");
  expect(r.modelUsed, "claude-3-5-sonnet");
  expectTrue(r.content.includes("Initial draft"));
});

test("createVersion: increments version for same project+type", () => {
  const r2 = brain.createVersion(PROJECT, "CONTRACT", "# Contract v2\n\nUpdated draft.", {
    agentType: "planning",
  });
  expect(r2.version, 2);
});

test("createVersion: independent version counter per file type", () => {
  const r = brain.createVersion(PROJECT, "DB_SCHEMA", "## Users table\n\nid uuid primary key", {
    agentType: "db",
  });
  expect(r.version, 1, "DB_SCHEMA should start at version 1 independently");
  expect(r.fileType, "DB_SCHEMA");
});

test("createVersion: independent version counter per project", () => {
  const r = brain.createVersion("other-project", "CONTRACT", "# Other contract", {
    agentType: "planning",
  });
  expect(r.version, 1, "Other project should have its own version counter");
  expect(r.projectId, "other-project");
});

test("getLatest: returns highest version", () => {
  const latest = brain.getLatest(PROJECT, "CONTRACT");
  expectTrue(latest !== null, "Should have a latest version");
  expect(latest!.version, 2);
  expectTrue(latest!.content.includes("Updated draft"));
});

test("getLatest: returns version 1 for DB_SCHEMA", () => {
  const latest = brain.getLatest(PROJECT, "DB_SCHEMA");
  expectTrue(latest !== null);
  expect(latest!.version, 1);
  expect(latest!.fileType, "DB_SCHEMA");
});

test("getHistory: returns all versions newest first", () => {
  const history = brain.getHistory(PROJECT, "CONTRACT");
  expect(history.length, 2);
  expect(history[0]!.version, 2);
  expect(history[1]!.version, 1);
});

test("getHistory: returns empty array when no versions", () => {
  const history = brain.getHistory(PROJECT, "API_CONTRACTS");
  expect(history.length, 0);
});

test("compareVersions: detects added lines (v1 → v2)", () => {
  const result = brain.compareVersions(PROJECT, "CONTRACT", 1, 2);
  expect(result.fromVersion, 1);
  expect(result.toVersion, 2);
  expectTrue(result.insertions >= 1, `Expected insertions >= 1, got ${result.insertions}`);
  const addedLines = result.diff.filter((l) => l.type === "added");
  expectTrue(addedLines.length >= 1, "Should have at least one added line");
});

test("compareVersions: flipping from/to swaps insertions and deletions", () => {
  const fwd = brain.compareVersions(PROJECT, "CONTRACT", 1, 2);
  const rev = brain.compareVersions(PROJECT, "CONTRACT", 2, 1);
  expect(fwd.insertions, rev.deletions);
  expect(fwd.deletions, rev.insertions);
});

test("compareVersions: throws when version not found", () => {
  let threw = false;
  try { brain.compareVersions(PROJECT, "CONTRACT", 99, 1); }
  catch { threw = true; }
  expectTrue(threw, "Should throw for non-existent version");
});

test("createVersion: stores sessionId when provided", () => {
  const sid = "550e8400-e29b-41d4-a716-446655440000";
  const r = brain.createVersion(PROJECT, "CURRENT_STATE", "Current build state", {
    agentType: "backend",
    sessionId: sid,
  });
  expect(r.sessionId, sid);
  expect(r.fileType, "CURRENT_STATE");
});

// ── LCS diff algorithm tests ──────────────────────────────────────────────────

test("Diff: identical content produces only equal lines", () => {
  const content = "line 1\nline 2\nline 3";
  const diff = lcsLineDiff(content, content);
  expectTrue(diff.every((l) => l.type === "equal"), "All lines should be equal");
  expect(diff.length, 3);
});

test("Diff: completely different content has no equal lines", () => {
  const diff = lcsLineDiff("aaa\nbbb", "ccc\nddd");
  expectTrue(!diff.some((l) => l.type === "equal"), "No equal lines expected");
  expectTrue(diff.filter((l) => l.type === "added").length === 2);
  expectTrue(diff.filter((l) => l.type === "removed").length === 2);
});

test("Diff: line insertion at start is detected", () => {
  const diff = lcsLineDiff("b\nc", "a\nb\nc");
  const added = diff.filter((l) => l.type === "added");
  expectTrue(added.length === 1 && added[0]!.content === "a", "Expected 'a' to be added");
});

test("Diff: line deletion at end is detected", () => {
  const diff = lcsLineDiff("a\nb\nc", "a\nb");
  const removed = diff.filter((l) => l.type === "removed");
  expectTrue(removed.length === 1 && removed[0]!.content === "c", "Expected 'c' to be removed");
});

test("Diff: single character change is detected as add+remove", () => {
  const diff = lcsLineDiff("hello world", "hello WORLD");
  const added   = diff.filter((l) => l.type === "added");
  const removed = diff.filter((l) => l.type === "removed");
  expectTrue(added.length === 1, "Should have 1 added line");
  expectTrue(removed.length === 1, "Should have 1 removed line");
  expect(added[0]!.content, "hello WORLD");
  expect(removed[0]!.content, "hello world");
});

test("Diff: empty string to content produces all additions", () => {
  const diff = lcsLineDiff("", "a\nb\nc");
  const added   = diff.filter((l) => l.type === "added");
  const removed = diff.filter((l) => l.type === "removed");
  expect(removed.length, 0);
  expect(added.length, 3);
});

test("Diff: content to empty string produces all removals", () => {
  const diff = lcsLineDiff("x\ny", "");
  const removed = diff.filter((l) => l.type === "removed");
  const added   = diff.filter((l) => l.type === "added");
  expect(added.length, 0);
  expect(removed.length, 2);
});

test("Diff: middle line change preserves surrounding context", () => {
  const diff = lcsLineDiff("a\nb\nc", "a\nB\nc");
  const equal   = diff.filter((l) => l.type === "equal").map((l) => l.content);
  const added   = diff.filter((l) => l.type === "added").map((l) => l.content);
  const removed = diff.filter((l) => l.type === "removed").map((l) => l.content);
  expectTrue(equal.includes("a") && equal.includes("c"), "a and c should be preserved");
  expect(added, ["B"]);
  expect(removed, ["b"]);
});

// ── Full flow test ─────────────────────────────────────────────────────────────

test("Full flow: contract → v2 → compare → history", () => {
  const pid = "flow-project";

  const v1 = brain.createVersion(pid, "CONTRACT", "# Contract\n\nFeature A\nFeature B\n", {
    agentType: "planning",
  });
  expect(v1.version, 1);

  const v2 = brain.createVersion(pid, "CONTRACT", "# Contract\n\nFeature A\nFeature B\nFeature C\n", {
    agentType: "planning",
  });
  expect(v2.version, 2);

  const cmp = brain.compareVersions(pid, "CONTRACT", 1, 2);
  expect(cmp.fromVersion, 1);
  expect(cmp.toVersion, 2);
  expectTrue(cmp.insertions >= 1, "Feature C should be an insertion");
  expect(cmp.deletions, 0);

  const history = brain.getHistory(pid, "CONTRACT");
  expect(history.length, 2);
  expect(history[0]!.version, 2);
  expect(history[1]!.version, 1);

  const latest = brain.getLatest(pid, "CONTRACT");
  expect(latest!.version, 2);
  expectTrue(latest!.content.includes("Feature C"));
});

test("Phase brain docs: DB_SCHEMA and API_CONTRACTS track separately", () => {
  const pid = "phase-project";

  const dbV1 = brain.createVersion(pid, "DB_SCHEMA", "CREATE TABLE users (id uuid PK);", {
    agentType: "db",
  });
  const apiV1 = brain.createVersion(pid, "API_CONTRACTS", "POST /auth/login\nGET /users/:id", {
    agentType: "backend",
  });

  expect(dbV1.version, 1);
  expect(apiV1.version, 1);
  expect(dbV1.fileType, "DB_SCHEMA");
  expect(apiV1.fileType, "API_CONTRACTS");

  // Create v2 for DB_SCHEMA (add table)
  const dbV2 = brain.createVersion(pid, "DB_SCHEMA", "CREATE TABLE users (id uuid PK);\nCREATE TABLE posts (id uuid PK, user_id uuid);", {
    agentType: "db",
  });
  expect(dbV2.version, 2);

  // API_CONTRACTS still on v1
  const apiLatest = brain.getLatest(pid, "API_CONTRACTS");
  expect(apiLatest!.version, 1);

  // Diff DB_SCHEMA v1 vs v2
  const dbDiff = brain.compareVersions(pid, "DB_SCHEMA", 1, 2);
  expectTrue(dbDiff.insertions === 1, "One line (posts table) should be added");
  expect(dbDiff.deletions, 0);
});

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("\nBuildForge Shared Brain API — unit tests\n");
await runTests();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
if (failed > 0) process.exit(1);
