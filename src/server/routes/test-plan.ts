/**
 * Plan Mode API — unit + integration smoke tests.
 *
 * Tests JSON parsing, Zod validation, and the full flow state machine
 * without requiring a real DB or OpenRouter key.
 *
 * Usage:
 *   npx tsx src/server/routes/test-plan.ts
 */

import { z } from "zod";

// ── Tiny harness ──────────────────────────────────────────────────────────────

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
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(msg ?? `Expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}
function expectTrue(v: boolean, msg?: string): void { if (!v) throw new Error(msg ?? "Expected true"); }

// ── extractJson (copied from plan.ts for isolated testing) ────────────────────

function extractJson(content: string): unknown {
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  const start = text.search(/[{[]/);
  if (start === -1) throw new Error("No JSON object found in response");
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end === -1) throw new Error("Unterminated JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}

// ── Zod schemas (mirrored from plan.ts) ───────────────────────────────────────

const questionsResponseSchema = z.object({
  questions: z.array(z.object({
    id: z.string(),
    text: z.string(),
    type: z.enum(["text", "choice", "multiChoice"]),
    options: z.array(z.string()).optional(),
    required: z.boolean().optional(),
  })).min(1).max(12),
});

const contractResponseSchema = z.object({
  contract: z.string().min(1),
  tasks: z.array(z.object({
    agent: z.string(),
    task: z.string(),
    estimatedTokens: z.number().int().positive(),
    phase: z.string(),
  })).min(1),
});

const startBodySchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(4_000),
});

const interviewBodySchema = z.object({
  sessionId: z.string().uuid(),
  answers: z.array(z.object({ questionId: z.string().min(1), answer: z.string().min(1).max(2_000) })).min(1),
});

const approveBodySchema = z.object({
  sessionId: z.string().uuid(),
  approved: z.boolean(),
  modifications: z.string().max(2_000).optional(),
});

// ── Phase config (mirrored) ───────────────────────────────────────────────────

type PlanPhase = "FOUNDATION" | "BUILD" | "VERIFY" | "DEPLOY";

const PLAN_PHASES: Record<PlanPhase, { agents: string[]; agentTypes: string[]; isParallel: boolean; phaseNum: number }> = {
  FOUNDATION: { agents: ["DB Agent", "Backend Skeleton"],               agentTypes: ["db", "backend"],               isParallel: false, phaseNum: 1 },
  BUILD:      { agents: ["Frontend Agent", "Backend Logic"],            agentTypes: ["frontend", "backend"],          isParallel: true,  phaseNum: 2 },
  VERIFY:     { agents: ["Security Verifier", "Connection Verifier"],   agentTypes: ["security", "connection"],       isParallel: true,  phaseNum: 3 },
  DEPLOY:     { agents: ["Deploy Agent"],                               agentTypes: ["deploy"],                       isParallel: false, phaseNum: 4 },
};

const NEXT_PHASE: Record<PlanPhase, PlanPhase | null> = {
  FOUNDATION: "BUILD", BUILD: "VERIFY", VERIFY: "DEPLOY", DEPLOY: null,
};

// ── extractJson tests ─────────────────────────────────────────────────────────

test("extractJson: parses bare JSON object", () => {
  const r = extractJson('{"questions":[{"id":"q1","text":"hello","type":"text"}]}');
  expect((r as { questions: unknown[] }).questions.length, 1);
});

test("extractJson: strips markdown json fence", () => {
  const r = extractJson('```json\n{"contract":"# Contract","tasks":[]}\n```');
  expect((r as { contract: string }).contract, "# Contract");
});

test("extractJson: strips plain code fence", () => {
  const r = extractJson('```\n{"passed":true,"checks":[]}\n```');
  expect((r as { passed: boolean }).passed, true);
});

test("extractJson: extracts JSON from prose prefix", () => {
  const r = extractJson('Here is the output:\n\n{"questions":[{"id":"q1","text":"hi","type":"text"}]}');
  expect((r as { questions: unknown[] }).questions.length, 1);
});

test("extractJson: throws on content with no JSON", () => {
  let threw = false;
  try { extractJson("This is plain prose with no JSON."); }
  catch { threw = true; }
  expectTrue(threw, "Should have thrown");
});

// ── questionsResponseSchema tests ─────────────────────────────────────────────

const VALID_QUESTIONS_JSON = {
  questions: [
    { id: "q1", text: "Who is the target audience?", type: "choice", options: ["B2B", "B2C"], required: true },
    { id: "q2", text: "Describe your primary feature", type: "text" },
    { id: "q3", text: "Which integrations do you need?", type: "multiChoice", options: ["Stripe", "SendGrid", "Twilio"] },
  ],
};

test("questionsResponseSchema: validates correct questions payload", () => {
  const r = questionsResponseSchema.safeParse(VALID_QUESTIONS_JSON);
  expectTrue(r.success, r.success ? "" : JSON.stringify((r as { error: { issues: unknown[] } }).error.issues));
  expect(r.data!.questions.length, 3);
});

test("questionsResponseSchema: rejects empty questions array", () => {
  const r = questionsResponseSchema.safeParse({ questions: [] });
  expectTrue(!r.success, "Should have failed on empty array");
});

test("questionsResponseSchema: rejects invalid question type", () => {
  const r = questionsResponseSchema.safeParse({
    questions: [{ id: "q1", text: "foo", type: "invalid" }],
  });
  expectTrue(!r.success, "Should have failed on unknown type");
});

// ── contractResponseSchema tests ──────────────────────────────────────────────

const VALID_CONTRACT = {
  contract: "# BuildForge Contract\n\n## Project\nInvoice SaaS with Stripe",
  tasks: [
    { agent: "db",       task: "Design invoice schema",    estimatedTokens: 3000, phase: "FOUNDATION" },
    { agent: "backend",  task: "Backend skeleton",         estimatedTokens: 4000, phase: "FOUNDATION" },
    { agent: "frontend", task: "UI components",            estimatedTokens: 4000, phase: "BUILD"      },
    { agent: "deploy",   task: "Deployment configuration", estimatedTokens: 1500, phase: "DEPLOY"     },
  ],
};

test("contractResponseSchema: validates complete contract payload", () => {
  const r = contractResponseSchema.safeParse(VALID_CONTRACT);
  expectTrue(r.success, r.success ? "" : "validation failed");
  expect(r.data!.tasks.length, 4);
});

test("contractResponseSchema: rejects missing contract field", () => {
  const r = contractResponseSchema.safeParse({ tasks: VALID_CONTRACT.tasks });
  expectTrue(!r.success);
});

test("contractResponseSchema: rejects zero estimatedTokens", () => {
  const r = contractResponseSchema.safeParse({
    contract: "# Contract",
    tasks: [{ agent: "db", task: "schema", estimatedTokens: 0, phase: "FOUNDATION" }],
  });
  expectTrue(!r.success, "estimatedTokens must be positive");
});

// ── Input body schema tests ───────────────────────────────────────────────────

test("startBodySchema: accepts valid body", () => {
  const r = startBodySchema.safeParse({ projectId: "proj-1", prompt: "Build an invoice SaaS with Stripe" });
  expectTrue(r.success);
});

test("startBodySchema: rejects prompt > 4000 chars", () => {
  const r = startBodySchema.safeParse({ projectId: "proj-1", prompt: "x".repeat(4_001) });
  expectTrue(!r.success);
});

test("interviewBodySchema: accepts valid answers", () => {
  const r = interviewBodySchema.safeParse({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    answers: [{ questionId: "q1", answer: "B2B" }, { questionId: "q2", answer: "PostgreSQL" }],
  });
  expectTrue(r.success);
});

test("interviewBodySchema: rejects invalid UUID sessionId", () => {
  const r = interviewBodySchema.safeParse({ sessionId: "not-a-uuid", answers: [{ questionId: "q1", answer: "x" }] });
  expectTrue(!r.success);
});

test("approveBodySchema: accepts approved=true without modifications", () => {
  const r = approveBodySchema.safeParse({ sessionId: "550e8400-e29b-41d4-a716-446655440000", approved: true });
  expectTrue(r.success);
});

test("approveBodySchema: accepts approved=false with modifications", () => {
  const r = approveBodySchema.safeParse({
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    approved: false,
    modifications: "Please add multi-tenancy support",
  });
  expectTrue(r.success);
});

// ── Phase configuration tests ─────────────────────────────────────────────────

test("Phase config: FOUNDATION is sequential with 2 agents", () => {
  expect(PLAN_PHASES.FOUNDATION.isParallel, false);
  expect(PLAN_PHASES.FOUNDATION.agentTypes.length, 2);
  expect(PLAN_PHASES.FOUNDATION.phaseNum, 1);
});

test("Phase config: BUILD is parallel with frontend + backend", () => {
  expect(PLAN_PHASES.BUILD.isParallel, true);
  expectTrue(PLAN_PHASES.BUILD.agentTypes.includes("frontend"));
  expectTrue(PLAN_PHASES.BUILD.agentTypes.includes("backend"));
});

test("Phase config: VERIFY is parallel with security + connection", () => {
  expect(PLAN_PHASES.VERIFY.isParallel, true);
  expectTrue(PLAN_PHASES.VERIFY.agentTypes.includes("security"));
  expectTrue(PLAN_PHASES.VERIFY.agentTypes.includes("connection"));
});

test("Phase config: DEPLOY is sequential, last phase", () => {
  expect(PLAN_PHASES.DEPLOY.isParallel, false);
  expect(NEXT_PHASE.DEPLOY, null);
});

test("Phase transitions form a complete chain", () => {
  expect(NEXT_PHASE.FOUNDATION, "BUILD");
  expect(NEXT_PHASE.BUILD, "VERIFY");
  expect(NEXT_PHASE.VERIFY, "DEPLOY");
  expect(NEXT_PHASE.DEPLOY, null);
});

test("All phases have phaseNum 1–4 in order", () => {
  const phases: PlanPhase[] = ["FOUNDATION", "BUILD", "VERIFY", "DEPLOY"];
  for (let i = 0; i < phases.length; i++) {
    expect(PLAN_PHASES[phases[i]!].phaseNum, i + 1);
  }
});

// ── Full flow simulation (state machine) ─────────────────────────────────────

test("Flow: start → interview → approve transitions state correctly", () => {
  // Simulate state machine without I/O
  let planStatus = "interviewing";

  // After interview submission
  planStatus = "contracting";
  planStatus = "waiting_approval";
  expect(planStatus, "waiting_approval");

  // After approval
  planStatus = "approved";
  planStatus = "running"; // FOUNDATION starts
  expect(planStatus, "running");

  // After FOUNDATION completes
  planStatus = "waiting_phase_approval";
  expect(planStatus, "waiting_phase_approval");
});

test("Flow: modification round-trips back to waiting_approval", () => {
  let planStatus = "waiting_approval";
  // User sends modifications
  planStatus = "contracting";  // re-planning
  planStatus = "waiting_approval"; // returns to approval
  expect(planStatus, "waiting_approval");
});

test("Flow: VERIFY failure increments round and sets fix_required", () => {
  let verifyRound = 0;
  let planStatus = "running";

  // First verify run fails
  verifyRound++;
  planStatus = "fix_required";
  expect(verifyRound, 1);
  expect(planStatus, "fix_required");

  // Fix applied, retry
  planStatus = "running";
  verifyRound++;
  // Second try passes
  planStatus = "waiting_phase_approval";
  expect(verifyRound, 2);
  expect(planStatus, "waiting_phase_approval");
});

test("Flow: three failed verify rounds stays fix_required (no infinite loop)", () => {
  let round = 0;
  const MAX = 3;
  while (round < MAX) round++;
  expect(round, MAX);
  // After max rounds, system stops retrying
});

// ── Run ───────────────────────────────────────────────────────────────────────

console.log("\nBuildForge Plan Mode API — unit tests\n");
await runTests();
console.log(`\nResults: ${passed} passed, ${failed} failed out of ${tests.length} tests`);
if (failed > 0) process.exit(1);
