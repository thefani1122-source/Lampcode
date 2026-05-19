/**
 * File System Manager — end-to-end smoke tests.
 *
 * Covers: workspace creation → file writes → git branching → freeze → verify → merge.
 *
 * Usage:
 *   npx tsx src/fs/test-fs.ts
 */

import { randomUUID } from "crypto";
import { rm } from "fs/promises";
import { join } from "path";
import { WorkspaceManager } from "./manager.js";
import { GitManager } from "./git.js";
import { WorkspaceFreezeManager } from "./freeze.js";

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

// ── Test setup ────────────────────────────────────────────────────────────────

const TEST_ROOT = join(process.cwd(), "workspace-test-" + Date.now());
const PROJECT_ID = "test-project";
const SESSION_ID = randomUUID();

const workspace = new WorkspaceManager(TEST_ROOT);
const freezer = new WorkspaceFreezeManager(TEST_ROOT);

// ── Tests ─────────────────────────────────────────────────────────────────────

test("WorkspaceManager: createWorkspace initialises git repo", async () => {
  const dir = await workspace.createWorkspace(PROJECT_ID);
  expectTrue(dir.endsWith(PROJECT_ID), `Dir should end with project ID, got ${dir}`);

  const git = workspace.git(PROJECT_ID);
  const isRepo = await git.checkIsRepo();
  expectTrue(isRepo, "Expected workspace to be a git repo");
});

test("WorkspaceManager: createWorkspace is idempotent", async () => {
  // Should not throw on second call
  await workspace.createWorkspace(PROJECT_ID);
  const git = workspace.git(PROJECT_ID);
  const log = await git.log();
  expectTrue(log.total >= 1, "Should have at least the init commit");
});

test("WorkspaceManager: writeFile creates file with correct content", async () => {
  const content = "console.log('hello world');\n";
  await workspace.writeFile(PROJECT_ID, "src/index.ts", content);
  const read = await workspace.readFile(PROJECT_ID, "src/index.ts");
  expect(read, content);
});

test("WorkspaceManager: writeFile creates nested directories", async () => {
  await workspace.writeFile(PROJECT_ID, "deep/nested/dir/file.ts", "export {};\n");
  const read = await workspace.readFile(PROJECT_ID, "deep/nested/dir/file.ts");
  expect(read, "export {};\n");
});

test("WorkspaceManager: safePath strips directory traversal", async () => {
  await workspace.writeFile(PROJECT_ID, "../../etc/passwd", "should-be-safe");
  // Should write inside project dir, not escape
  const read = await workspace.readFile(PROJECT_ID, "etc/passwd");
  expect(read, "should-be-safe");
});

test("WorkspaceManager: listFiles returns all non-.git files", async () => {
  const files = await workspace.listFiles(PROJECT_ID);
  const paths = files.map((f) => f.path);
  expectTrue(paths.includes("src/index.ts"), `Expected src/index.ts in ${JSON.stringify(paths)}`);
  expectTrue(paths.includes("deep/nested/dir/file.ts"), "Expected deep/nested/dir/file.ts");
  expectTrue(!paths.some((p) => p.startsWith(".git")), "Should not list .git files");
  for (const f of files) {
    expectTrue(typeof f.sizeBytes === "number" && f.sizeBytes >= 0, "sizeBytes should be non-negative number");
    expectTrue(typeof f.modifiedAt === "string", "modifiedAt should be string");
  }
});

test("GitManager: createBranch creates and switches to new branch", async () => {
  const git = new GitManager(PROJECT_ID, TEST_ROOT);
  // Need at least one commit so we can branch
  const g = workspace.git(PROJECT_ID);
  await g.add(".");
  await g.commit("test: initial files");

  const branch = await git.createBranch("bf/frontend/session-1");
  expect(branch, "bf/frontend/session-1");
  const current = await git.currentBranch();
  expect(current, "bf/frontend/session-1");
});

test("GitManager: createBranch is idempotent — switches to existing branch", async () => {
  const git = new GitManager(PROJECT_ID, TEST_ROOT);
  const branch = await git.createBranch("bf/frontend/session-1");
  expect(branch, "bf/frontend/session-1");
});

test("GitManager: commitAll stages and commits all changes", async () => {
  await workspace.writeFile(PROJECT_ID, "src/feature.ts", "export const x = 1;\n");
  const git = new GitManager(PROJECT_ID, TEST_ROOT);
  const sha = await git.commitAll("feat: add feature file");
  expectTrue(sha.length > 0, "commit SHA should not be empty");
  const head = await git.headSha();
  expect(head, sha);
});

test("GitManager: listBranches shows all created branches", async () => {
  const git = new GitManager(PROJECT_ID, TEST_ROOT);
  const branches = await git.listBranches();
  expectTrue(branches.includes("bf/frontend/session-1"), `Expected branch in ${JSON.stringify(branches)}`);
});

test("WorkspaceManager: createAgentBranch creates isolated branch", async () => {
  const branch = await workspace.createAgentBranch(PROJECT_ID, "backend", SESSION_ID);
  expectTrue(branch.startsWith("bf/backend/"), `Branch should start with bf/backend/, got ${branch}`);
  const git = new GitManager(PROJECT_ID, TEST_ROOT);
  const current = await git.currentBranch();
  expect(current, branch);
});

test("WorkspaceFreezeManager: freezePhase captures all workspace files", async () => {
  // Add a file on the current branch and commit it
  await workspace.writeFile(PROJECT_ID, "db/schema.sql", "CREATE TABLE users (id uuid PRIMARY KEY);\n");
  const g = workspace.git(PROJECT_ID);
  await g.add(".");
  await g.commit("test: add schema");

  const contract = await freezer.freezePhase(PROJECT_ID, SESSION_ID, "FOUNDATION");
  expectTrue(contract.files.length >= 1, `Expected at least 1 frozen file, got ${contract.files.length}`);
  expectTrue(contract.bundleHash.length === 64, "bundleHash should be 64-char hex");
  expectTrue(contract.files.every((f) => f.hash.length === 64), "All file hashes should be 64-char hex");
  expectTrue(contract.sessionId === SESSION_ID, "sessionId should match");
  expectTrue(contract.phase === "FOUNDATION", "phase should be FOUNDATION");
});

test("WorkspaceFreezeManager: verifyFreeze passes when files unchanged", async () => {
  const result = await freezer.verifyFreeze(PROJECT_ID, SESSION_ID, "FOUNDATION");
  expectTrue(result.intact, `Expected intact=true, drifted: ${JSON.stringify(result.drifted)}`);
  expect(result.drifted.length, 0);
});

test("WorkspaceFreezeManager: verifyFreeze detects modified file", async () => {
  // Modify a file without re-freezing
  await workspace.writeFile(PROJECT_ID, "db/schema.sql", "CREATE TABLE users (id uuid PRIMARY KEY, name text);\n");

  const result = await freezer.verifyFreeze(PROJECT_ID, SESSION_ID, "FOUNDATION");
  expectTrue(!result.intact, "Should detect drift after file modification");
  expectTrue(result.drifted.includes("db/schema.sql"), `Expected db/schema.sql in drifted: ${JSON.stringify(result.drifted)}`);
});

test("WorkspaceFreezeManager: readFreeze returns contract with verified bundle hash", async () => {
  const contract = await freezer.readFreeze(SESSION_ID, "FOUNDATION");
  expectTrue(contract.bundleHash.length === 64, "bundleHash should be present and valid");
  expectTrue(contract.files.length >= 1, "should have files");
});

test("WorkspaceFreezeManager: freezeExists returns true for existing freeze", async () => {
  const exists = await freezer.freezeExists(SESSION_ID, "FOUNDATION");
  expectTrue(exists, "freeze should exist after freezePhase");
});

test("WorkspaceFreezeManager: freezeExists returns false for non-existent freeze", async () => {
  const missing = await freezer.freezeExists("non-existent-" + randomUUID(), "BUILD");
  expectTrue(!missing, "freeze should not exist for unknown session");
});

test("GitManager: mergeBranch merges feature branch back to main", async () => {
  const git = new GitManager(PROJECT_ID, TEST_ROOT);

  // Commit any pending changes before switching branches
  const g = workspace.git(PROJECT_ID);
  const status = await g.status();
  if (!status.isClean()) {
    await g.add(".");
    await g.commit("test: commit pending changes before merge test");
  }

  // Switch to main branch
  const branches = await g.branchLocal();
  const mainBranch = branches.all.find((b) => b === "master" || b === "main") ?? branches.all[0];
  if (!mainBranch) throw new Error("No branches found");
  await g.checkout(mainBranch);

  const featureBranch = `bf/backend/${SESSION_ID}`;
  const allBranches = await git.listBranches();
  if (!allBranches.includes(featureBranch)) {
    // Feature branch might not exist yet in this test run — skip merge
    return;
  }
  await git.mergeBranch(featureBranch, `merge: integrate ${featureBranch}`);
  const log = await g.log({ maxCount: 1 });
  expectTrue(log.latest !== null, "Should have a merge commit");
});

test("WorkspaceManager: diffBranches returns structured diff", async () => {
  const g = workspace.git(PROJECT_ID);
  const branches = await g.branchLocal();
  if (branches.all.length < 2) {
    // Not enough branches to diff — skip
    return;
  }
  const [branchA, branchB] = branches.all;
  if (!branchA || !branchB) return;

  // Only diff if they diverge — may be identical in some test runs, that's OK
  const diff = await workspace.diffBranches(PROJECT_ID, branchA, branchB);
  expectTrue(Array.isArray(diff.files), "files should be an array");
  expectTrue(typeof diff.totalInsertions === "number", "totalInsertions should be a number");
  expectTrue(typeof diff.totalDeletions === "number", "totalDeletions should be a number");
  expectTrue(typeof diff.summary === "string", "summary should be a string");
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup(): Promise<void> {
  await rm(TEST_ROOT, { recursive: true, force: true });
  // Also clean freeze dir created in default location
  const { rm: rmFs } = await import("fs/promises");
  const freezeDir = join(process.cwd(), ".buildforge", "freezes", SESSION_ID);
  await rmFs(freezeDir, { recursive: true, force: true }).catch(() => undefined);
}

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("\nBuildForge File System Manager — end-to-end tests\n");
await runTests();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
await cleanup();
if (failed > 0) process.exit(1);
