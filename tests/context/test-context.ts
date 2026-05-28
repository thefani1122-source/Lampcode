/**
 * ContextManager unit tests — no running server required.
 *
 * Creates a temporary project workspace with 10 synthetic files,
 * runs relevance queries, and asserts correct file selection.
 *
 * Run: npx tsx src/context/test-context.ts
 */

import { mkdir, writeFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { ContextManager, scoreFile, type IndexedFile } from "./manager.js";

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function run(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`  ✓ ${label}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${label}:`, e instanceof Error ? e.message : String(e));
    failed++;
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFile(overrides: Partial<IndexedFile> = {}): IndexedFile {
  return {
    path: "src/app.ts",
    content: "export function app() {}",
    contentPreview: "export function app() {}",
    exports: ["app"],
    imports: [],
    tokens: 10,
    lastModified: Date.now(),
    ...overrides,
  };
}

// ── Unit: scoreFile ───────────────────────────────────────────────────────────

console.log("\n── Unit: scoreFile ──");

await run("keyword in path scores +10", () => {
  const file = makeFile({ path: "src/components/Button.tsx", content: "export function Button() {}" });
  const score = scoreFile(file, ["button"]);
  assert(score >= 10, `expected ≥10, got ${score}`);
});

await run("keyword in content scores +5", () => {
  const file = makeFile({ path: "src/utils.ts", content: "const primaryColor = '#fff';" });
  const score = scoreFile(file, ["color"]);
  assert(score >= 5, `expected ≥5, got ${score}`);
});

await run("keyword in imports scores +3", () => {
  const file = makeFile({ path: "src/page.tsx", imports: ["../theme/colors"] });
  const score = scoreFile(file, ["colors"]);
  assert(score >= 3, `expected ≥3, got ${score}`);
});

await run("unrelated file scores 0", () => {
  const file = makeFile({ path: "src/utils/date.ts", content: "export function formatDate() {}", exports: ["formatDate"], imports: [] });
  const score = scoreFile(file, ["button", "color", "theme"]);
  assert(score === 0, `expected 0, got ${score}`);
});

await run("multiple keywords accumulate score", () => {
  const file = makeFile({
    path: "src/components/NavBar.tsx",
    content: "const navbarColor = theme.primary; export function NavBar() {}",
    exports: ["NavBar"],
    imports: ["../theme"],
  });
  const score = scoreFile(file, ["navbar", "color", "theme"]);
  // navbar in path (+10), navbar in content (+5), color in content (+5), theme in imports (+3)
  assert(score >= 20, `expected ≥20, got ${score}`);
});

await run("empty keywords returns 0", () => {
  const file = makeFile({ path: "src/Button.tsx", content: "button color theme" });
  const score = scoreFile(file, []);
  assert(score === 0, `expected 0, got ${score}`);
});

// ── Integration: ContextManager with temp filesystem ─────────────────────────

console.log("\n── Integration: ContextManager file selection ──");

const WORKSPACE = join(tmpdir(), `bftest-ctx-${Date.now()}`);
const PROJECT_ID = "proj-test";

const PROJECT_FILES: Record<string, string> = {
  "CONTRACT.md": "# Contract\nBuild a dashboard app with buttons and theme support.",
  "CURRENT_STATE.md": "Phase: BUILD\nLast update: foundation complete.",
  "src/components/Button.tsx": `
import { theme } from '../theme/colors';
export function Button({ label, color }: { label: string; color?: string }) {
  return <button style={{ backgroundColor: color ?? theme.primary }}>{label}</button>;
}
`.trim(),
  "src/components/NavBar.tsx": `
import { Button } from './Button';
export function NavBar() {
  return <nav><Button label="Home" /></nav>;
}
`.trim(),
  "src/theme/colors.ts": `
export const theme = { primary: '#4f46e5', secondary: '#7c3aed', danger: '#dc2626' };
export type ColorKey = keyof typeof theme;
`.trim(),
  "src/api/users.ts": `
import { db } from '../db/client';
export async function getUsers() { return db.select().from(users); }
`.trim(),
  "src/api/auth.ts": `
export async function login(email: string, password: string) { /* ... */ }
export async function logout() { /* ... */ }
`.trim(),
  "src/utils/date.ts": `
export function formatDate(d: Date): string { return d.toLocaleDateString(); }
export function parseDate(s: string): Date { return new Date(s); }
`.trim(),
  "src/utils/string.ts": `
export function truncate(s: string, max: number): string { return s.length > max ? s.slice(0, max) + '…' : s; }
`.trim(),
  "src/db/schema.ts": `
import { pgTable, text } from 'drizzle-orm/pg-core';
export const users = pgTable('users', { id: text('id').primaryKey(), email: text('email').notNull() });
`.trim(),
};

// Create temp workspace
await mkdir(join(WORKSPACE, PROJECT_ID, "src/components"), { recursive: true });
await mkdir(join(WORKSPACE, PROJECT_ID, "src/theme"), { recursive: true });
await mkdir(join(WORKSPACE, PROJECT_ID, "src/api"), { recursive: true });
await mkdir(join(WORKSPACE, PROJECT_ID, "src/utils"), { recursive: true });
await mkdir(join(WORKSPACE, PROJECT_ID, "src/db"), { recursive: true });

for (const [relPath, content] of Object.entries(PROJECT_FILES)) {
  await writeFile(join(WORKSPACE, PROJECT_ID, relPath), content, "utf8");
}

const ctx = new ContextManager();

await run("index scans all 10 project files", async () => {
  const files = await ctx.index(PROJECT_ID, WORKSPACE);
  assert(files.length === 10, `expected 10 files, got ${files.length}`);
});

await run('"change button color" returns Button.tsx and colors.ts', async () => {
  const result = await ctx.select({
    projectId: PROJECT_ID,
    prompt: "change button color",
    workspaceBase: WORKSPACE,
    maxTokens: 8_000,
  });
  const paths = result.relevantFiles.map((f) => f.path);
  assert(
    paths.some((p) => p.includes("Button")),
    `Button.tsx missing. Got: ${paths.join(", ")}`,
  );
  assert(
    paths.some((p) => p.includes("colors") || p.includes("theme")),
    `theme/colors.ts missing. Got: ${paths.join(", ")}`,
  );
});

await run('"change button color" does NOT return date or string utils', async () => {
  const result = await ctx.select({
    projectId: PROJECT_ID,
    prompt: "change button color",
    workspaceBase: WORKSPACE,
    maxTokens: 8_000,
  });
  const paths = result.relevantFiles.map((f) => f.path);
  assert(!paths.some((p) => p.includes("date")),   `date.ts should not be selected. Got: ${paths.join(", ")}`);
  assert(!paths.some((p) => p.includes("string")), `string.ts should not be selected. Got: ${paths.join(", ")}`);
});

await run("CONTRACT.md and CURRENT_STATE.md are always included", async () => {
  const result = await ctx.select({
    projectId: PROJECT_ID,
    prompt: "completely unrelated xyzzy nonsense query",
    workspaceBase: WORKSPACE,
    maxTokens: 8_000,
  });
  const paths = result.relevantFiles.map((f) => f.path);
  assert(paths.includes("CONTRACT.md"),     "CONTRACT.md must be pinned");
  assert(paths.includes("CURRENT_STATE.md"), "CURRENT_STATE.md must be pinned");
});

await run("tokenEstimate is within maxTokens budget", async () => {
  const maxTokens = 300;
  const result = await ctx.select({
    projectId: PROJECT_ID,
    prompt: "navbar styling",
    workspaceBase: WORKSPACE,
    maxTokens,
  });
  assert(
    result.tokenEstimate <= maxTokens,
    `tokenEstimate ${result.tokenEstimate} exceeds maxTokens ${maxTokens}`,
  );
});

await run("navbar query returns NavBar.tsx", async () => {
  const result = await ctx.select({
    projectId: PROJECT_ID,
    prompt: "update navbar styling",
    workspaceBase: WORKSPACE,
    maxTokens: 8_000,
  });
  const paths = result.relevantFiles.map((f) => f.path);
  assert(paths.some((p) => p.includes("NavBar")), `NavBar.tsx missing. Got: ${paths.join(", ")}`);
});

await run("auth query does not return Button or theme files", async () => {
  const result = await ctx.select({
    projectId: PROJECT_ID,
    prompt: "fix login authentication",
    workspaceBase: WORKSPACE,
    maxTokens: 8_000,
  });
  const paths = result.relevantFiles.map((f) => f.path);
  assert(
    paths.some((p) => p.includes("auth")),
    `auth.ts missing. Got: ${paths.join(", ")}`,
  );
  assert(!paths.some((p) => p.includes("Button")), `Button.tsx should not appear. Got: ${paths.join(", ")}`);
});

await run("invalidate clears cache and triggers reindex", async () => {
  // First call to warm cache
  const before = await ctx.index(PROJECT_ID, WORKSPACE);
  ctx.invalidate(PROJECT_ID);
  // Second call must reindex (no error expected — just check it runs)
  const after = await ctx.index(PROJECT_ID, WORKSPACE);
  assert(after.length === before.length, `file count changed: ${before.length} → ${after.length}`);
});

await run("missing workspace directory returns empty index", async () => {
  const result = await ctx.select({
    projectId: "nonexistent-project",
    prompt: "change button color",
    workspaceBase: WORKSPACE,
    maxTokens: 4_000,
  });
  assert(result.relevantFiles.length === 0, `expected empty, got ${result.relevantFiles.length} files`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

await rm(WORKSPACE, { recursive: true, force: true });

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
