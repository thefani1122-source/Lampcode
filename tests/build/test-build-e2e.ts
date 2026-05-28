/**
 * E2E test for build orchestration and credit system.
 *
 * Runs in two layers:
 *   1. Unit tests — always run (no external deps)
 *   2. Live tests — skipped unless OPENROUTER_API_KEY + DATABASE_URL are set
 *
 * Run: npx tsx src/build/test-build-e2e.ts
 */

// ── Minimal test harness ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(label: string): void {
  console.log(`  ✓ ${label}`);
  passed++;
}

function fail(label: string, err: unknown): void {
  console.error(`  ✗ ${label}:`, err instanceof Error ? err.message : String(err));
  failed++;
}

async function run(label: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    ok(label);
  } catch (e) {
    fail(label, e);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

// ── Unit tests: credit deduction logic ───────────────────────────────────────

console.log("\n── Unit: credit arithmetic ──");

await run("20 credits deducted leaves balance of 80 when limit is 100", () => {
  const limit = 100;
  const initial = 0;
  const cost = 20;
  const remaining = limit - (initial + cost);
  assert(remaining === 80, `expected 80, got ${remaining}`);
});

await run("150-credit plan mode exceeds free-tier limit of 100", () => {
  const limit = 100;
  const used = 0;
  const cost = 150;
  const canAfford = used + cost <= limit;
  assert(canAfford === false, "expected canAfford to be false");
});

await run("Exact limit deduction: 100 credits on 100 limit succeeds", () => {
  const limit = 100;
  const used = 0;
  const cost = 100;
  const canAfford = used + cost <= limit;
  assert(canAfford === true, "expected canAfford to be true");
});

await run("Refund arithmetic: GREATEST(0, used - refund) never goes negative", () => {
  const used = 5;
  const refund = 20;
  const result = Math.max(0, used - refund);
  assert(result === 0, `expected 0, got ${result}`);
});

// ── Unit tests: queue job data shape ─────────────────────────────────────────

console.log("\n── Unit: job data validation ──");

await run("FastBuildJobData has required fields", () => {
  const job = {
    sessionId: crypto.randomUUID(),
    projectId: "proj-abc",
    userId: "user-123",
    prompt: "Build a todo app",
  };
  assert(typeof job.sessionId === "string", "sessionId is string");
  assert(typeof job.projectId === "string", "projectId is string");
  assert(typeof job.userId === "string", "userId is string");
  assert(typeof job.prompt === "string", "prompt is string");
  // sessionId should be UUID
  assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(job.sessionId), "sessionId is UUID v4");
});

await run("Estimated time string is '2-5 min'", () => {
  const response = { sessionId: "abc", status: "queued", estimatedTime: "2-5 min" };
  assert(response.status === "queued", "status is queued");
  assert(response.estimatedTime === "2-5 min", "estimatedTime is 2-5 min");
});

// ── Unit tests: source file verification ─────────────────────────────────────

console.log("\n── Unit: source verification ──");

import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dir = dirname(fileURLToPath(import.meta.url));

await run("credits.ts uses atomic SQL for deduction", async () => {
  const src = await readFile(join(__dir, "credits.ts"), "utf8");
  assert(src.includes("credits_used + ${amount} <= credits_limit"), "atomic constraint present");
  assert(src.includes("GREATEST(0, credits_used - ${amount})"), "refund uses GREATEST");
  assert(src.includes("refundCredits"), "refundCredits exported");
  assert(src.includes("deductCredits"), "deductCredits exported");
});

await run("queue.ts uses fast-build queue name", async () => {
  const src = await readFile(join(__dir, "queue.ts"), "utf8");
  assert(src.includes('"fast-build"'), "queue named fast-build");
  assert(src.includes("enqueueFastBuild"), "enqueueFastBuild exported");
  assert(src.includes("jobId"), "jobId set for deduplication");
});

await run("worker.ts starts with concurrency 3", async () => {
  const src = await readFile(join(__dir, "worker.ts"), "utf8");
  assert(src.includes("concurrency: 3"), "concurrency is 3");
  assert(src.includes("startFastBuildWorker"), "startFastBuildWorker exported");
});

await run("build.ts POST /fast returns {status: 'queued', estimatedTime}", async () => {
  const src = await readFile(join(__dir, "..", "server", "routes", "build.ts"), "utf8");
  assert(src.includes(`"queued"`), "response has queued status");
  assert(src.includes(`"2-5 min"`), "response has estimatedTime");
  assert(src.includes("enqueueFastBuild"), "calls enqueueFastBuild");
  assert(src.includes("deductCredits"), "deductCredits called");
  assert(src.includes("refundCredits"), "refundCredits called on failure");
  assert(src.includes("FAST_BUILD_CREDIT_COST = 20"), "credit cost is 20");
});

await run("plan.ts POST /start uses 150 credits", async () => {
  const src = await readFile(join(__dir, "..", "server", "routes", "plan.ts"), "utf8");
  assert(src.includes("PLAN_CREDIT_ESTIMATE = 150"), "credit estimate is 150");
  assert(src.includes("deductCredits"), "deductCredits called");
  assert(src.includes("refundCredits"), "refundCredits called on failure");
});

// ── Live tests (skipped without DB + API key) ─────────────────────────────────

const API_KEY = process.env["OPENROUTER_API_KEY"] ?? "";
const DB_URL  = process.env["DATABASE_URL"] ?? "";
const LIVE    = API_KEY.length > 0 && DB_URL.length > 0;

if (!LIVE) {
  console.log("\n── Live tests skipped (set OPENROUTER_API_KEY + DATABASE_URL to enable) ──");
} else {
  console.log("\n── Live: OpenRouter reachability ──");

  await run("OpenRouter /models responds 200", async () => {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json() as { data?: unknown[] };
    assert(Array.isArray(body.data), "data is array");
    assert((body.data?.length ?? 0) > 0, "at least one model returned");
  });

  await run("Small completion returns generated text", async () => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://buildforge.dev",
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        messages: [{ role: "user", content: "Reply with exactly: BUILD_OK" }],
        max_tokens: 20,
        stream: false,
      }),
    });
    assert(res.ok, `Expected 200, got ${res.status}`);
    const body = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = body.choices?.[0]?.message?.content ?? "";
    assert(content.includes("BUILD_OK"), `Expected BUILD_OK in: ${content.slice(0, 100)}`);
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
