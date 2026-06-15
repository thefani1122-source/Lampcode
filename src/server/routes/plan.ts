import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { mkdir, writeFile, readFile, readdir, stat } from "fs/promises";
import { join, dirname, relative } from "path";
import { db } from "../../db/client.js";
import {
  projects,
  buildSessions,
  agentTasks,
  type PlanQuestion,
  type PlanAnswer,
  type InterviewData,
  type PlanTask,
  type VerifyCheck,
  type VerifyReport,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { parseFilesFromContent, type ParsedFile } from "../../agents/file-parser.js";
import { getDispatcher } from "../../agents/dispatcher.js";
import { FreezeManager } from "../../lib/freeze-contract.js";
import { deductCredits, refundCredits } from "../../build/credits.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { getBrainManager } from "../../brain/manager.js";
import { logger } from "../logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKSPACE_BASE = join(process.cwd(), "workspace");
const FREEZE_BASE = join(process.cwd(), ".buildforge", "freezes");
const MAX_VERIFY_ROUNDS = 3;
const PLAN_CREDIT_ESTIMATE = 150;

// ── Phase configuration ───────────────────────────────────────────────────────

type PlanPhase = "FOUNDATION" | "BUILD" | "VERIFY" | "DEPLOY";

interface PhaseConfig {
  agents: string[];
  agentTypes: string[];
  isParallel: boolean;
  phaseNum: number;
}

const PLAN_PHASES: Record<PlanPhase, PhaseConfig> = {
  FOUNDATION: { agents: ["DB Agent", "Backend Skeleton"],    agentTypes: ["db", "backend"],               isParallel: false, phaseNum: 1 },
  BUILD:      { agents: ["Frontend Agent", "Backend Logic"], agentTypes: ["frontend", "backend"],          isParallel: true,  phaseNum: 2 },
  VERIFY:     { agents: ["Security Verifier", "Connection Verifier"], agentTypes: ["security", "connection"], isParallel: true, phaseNum: 3 },
  DEPLOY:     { agents: ["Deploy Agent"],                    agentTypes: ["deploy"],                      isParallel: false, phaseNum: 4 },
};

const NEXT_PHASE: Record<PlanPhase, PlanPhase | null> = {
  FOUNDATION: "BUILD",
  BUILD:      "VERIFY",
  VERIFY:     "DEPLOY",
  DEPLOY:     null,
};

// ── Input schemas ─────────────────────────────────────────────────────────────

const startBodySchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(4_000),
});

const interviewBodySchema = z.object({
  sessionId: z.string().uuid(),
  answers: z.array(z.object({
    questionId: z.string().min(1),
    answer: z.string().min(1).max(2_000),
  })).min(1),
});

const approveBodySchema = z.object({
  sessionId: z.string().uuid(),
  approved: z.boolean(),
  modifications: z.string().max(2_000).optional(),
});

const phaseApproveBodySchema = z.object({
  approved: z.literal(true),
});

// ── Parsed response schemas ───────────────────────────────────────────────────

const planQuestionSchema = z.object({
  id: z.string(),
  text: z.string(),
  type: z.enum(["text", "choice", "multiChoice"]),
  options: z.array(z.string()).optional(),
  required: z.boolean().optional(),
});

const questionsResponseSchema = z.object({
  questions: z.array(planQuestionSchema).min(1).max(12),
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

const verifyResponseSchema = z.object({
  passed: z.boolean(),
  checks: z.array(z.object({
    name: z.string(),
    passed: z.boolean(),
    severity: z.string().optional(),
    detail: z.string(),
  })),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function ws() {
  try { return getWebSocketServer(); }
  catch { return null; }
}

function now(): string {
  return new Date().toISOString();
}

function extractJson(content: string): unknown {
  // Strip leading/trailing markdown fences
  let text = content.trim();
  text = text.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "");
  // Find first { or [
  const start = text.search(/[{[]/);
  if (start === -1) throw new Error("No JSON object found in response");
  const end = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
  if (end === -1) throw new Error("Unterminated JSON in response");
  return JSON.parse(text.slice(start, end + 1));
}


async function getOwnedSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(buildSessions)
    .where(and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, userId)))
    .limit(1);
  const s = rows[0];
  if (!s) throw new AppError(404, "Build session not found", "NOT_FOUND");
  return s;
}

// ── Single-agent dispatcher wrapper (emits WS start/complete) ─────────────────

async function runAgent(opts: {
  sessionId: string;
  userId: string;
  projectId: string;
  agentType: string;
  taskDescription: string;
  contextFiles?: string[];
  phase: string;
}): Promise<{ content: string; costUsd: number; taskId: string; durationMs: number; modelUsed: string }> {
  const { sessionId, userId, projectId, agentType, taskDescription, phase } = opts;
  const server = ws();
  const taskId = randomUUID();

  server?.agentStart(sessionId, {
    taskId,
    sessionId,
    agentType: agentType as Parameters<typeof server.agentStart>[1]["agentType"],
    taskName: `${phase} — ${agentType}`,
    model: "(tier-1)",
    tier: 1,
    timestamp: now(),
  });

  try {
    const dispatcher = getDispatcher();
    const result = await dispatcher.dispatch({
      agentType: agentType as Parameters<typeof dispatcher.dispatch>[0]["agentType"],
      task: {
        description: taskDescription,
        outputFormat: "code",
        requirements: opts.contextFiles?.length
          ? [`Context files: ${opts.contextFiles.join(", ")}`]
          : undefined,
      },
      sessionId,
      userId,
      projectId,
    });

    server?.agentComplete(sessionId, {
      taskId,
      sessionId,
      agentType: agentType as Parameters<typeof server.agentComplete>[1]["agentType"],
      taskName: `${phase} — ${agentType}`,
      outputPath: result.outputPath,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      costUsd: result.costUsd,
      timestamp: now(),
    });

    return { content: result.content, costUsd: result.costUsd, taskId, durationMs: result.durationMs, modelUsed: result.modelUsed };
  } catch (err) {
    server?.agentError(sessionId, {
      taskId,
      sessionId,
      agentType: agentType as Parameters<typeof server.agentError>[1]["agentType"],
      error: err instanceof Error ? err.message : String(err),
      timestamp: now(),
    });
    throw err;
  }
}

// ── Write output files for a phase ───────────────────────────────────────────

async function writePhaseFiles(
  sessionId: string,
  projectId: string,
  phase: string,
  content: string,
  agentType: string,
): Promise<string[]> {
  const server = ws();
  const outputDir = join(WORKSPACE_BASE, projectId, sessionId, phase.toLowerCase());
  await mkdir(outputDir, { recursive: true });

  const parsed = parseFilesFromContent(content);
  const toWrite: ParsedFile[] =
    parsed.length > 0 ? parsed : [{ path: `${agentType}-output.md`, code: content }];

  const written: string[] = [];
  for (const { path: p, code } of toWrite) {
    const safe = p.replace(/^[\\/]+/, "").replace(/\.\.\//g, "");
    const full = join(outputDir, safe);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, code, "utf8");
    written.push(safe);
    server?.fileUpdate(sessionId, {
      sessionId,
      path: join(phase.toLowerCase(), safe),
      content: code,
      linesChanged: code.split("\n").length,
      timestamp: now(),
    });
  }
  return written;
}

// ── Background phase runner ───────────────────────────────────────────────────

async function runPlanPhase(
  sessionId: string,
  userId: string,
  projectId: string,
  phase: PlanPhase,
  contractContent: string,
  verifyRound = 0,
): Promise<void> {
  const server = ws();
  const config = PLAN_PHASES[phase];
  const freezer = new FreezeManager(FREEZE_BASE);

  server?.planPhaseStart(sessionId, {
    sessionId,
    phase,
    agents: config.agents,
    isParallel: config.isParallel,
    timestamp: now(),
  });
  server?.progress(sessionId, { sessionId, percent: 0, message: `Starting ${phase} phase`, timestamp: now() });

  await db.update(buildSessions).set({
    currentPlanPhase: phase,
    planStatus: "running",
    phase: config.phaseNum,
    startedAt: new Date(),
  }).where(eq(buildSessions.id, sessionId));

  const baseTask = `Contract:\n${contractContent}\n\n`;
  const phaseTask: Record<PlanPhase, Record<string, string>> = {
    FOUNDATION: {
      db:      `${baseTask}Design and implement the database schema. Produce Drizzle ORM schema files.`,
      backend: `${baseTask}Implement the backend skeleton: project structure, core routes, middleware, config.`,
    },
    BUILD: {
      frontend: `${baseTask}Implement the complete frontend UI as specified in the contract.`,
      backend:  `${baseTask}Implement all backend business logic, API handlers, and service layer.`,
    },
    VERIFY: {
      security:   `${baseTask}Perform a security audit. Check for OWASP Top 10, auth flaws, and data exposure. Return JSON with a "passed" boolean and "checks" array.`,
      connection: `${baseTask}Verify all service integrations, API contracts, and inter-module dependencies. Return JSON with a "passed" boolean and "checks" array.`,
    },
    DEPLOY: {
      deploy: `${baseTask}Generate Dockerfile, docker-compose.yml, and GitHub Actions CI/CD workflow for production deployment.`,
    },
  };

  try {
    let allFiles: string[] = [];
    let allContents: string[] = [];
    let totalCost = 0;
    const brain = getBrainManager();

    if (config.isParallel) {
      const results = await Promise.all(
        config.agentTypes.map((agentType) =>
          runAgent({
            sessionId, userId, projectId,
            agentType,
            taskDescription: phaseTask[phase]?.[agentType] ?? baseTask,
            phase,
          })
        ),
      );
      for (let idx = 0; idx < config.agentTypes.length; idx++) {
        const agentType = config.agentTypes[idx];
        const result = results[idx];
        if (!agentType || !result) continue;
        totalCost += result.costUsd;
        allContents.push(result.content);
        const written = await writePhaseFiles(sessionId, projectId, phase, result.content, agentType);
        allFiles = allFiles.concat(written);
        // Auto-save CURRENT_STATE after every agent
        void brain.createVersion(projectId, "current_state", result.content, {
          agentType, modelUsed: result.modelUsed, sessionId,
        });
      }
    } else {
      for (const agentType of config.agentTypes) {
        const result = await runAgent({
          sessionId, userId, projectId,
          agentType,
          taskDescription: phaseTask[phase]?.[agentType] ?? baseTask,
          phase,
          // Second sequential agent can see first agent's output
          ...(allFiles.length > 0 ? { contextFiles: allFiles } : {}),
        });
        totalCost += result.costUsd;
        allContents.push(result.content);
        const written = await writePhaseFiles(sessionId, projectId, phase, result.content, agentType);
        allFiles = allFiles.concat(written);

        // Auto-save phase-specific brain documents
        if (phase === "FOUNDATION") {
          if (agentType === "db") {
            void brain.createVersion(projectId, "db_schema", result.content, {
              agentType, modelUsed: result.modelUsed, sessionId,
            });
          } else if (agentType === "backend") {
            void brain.createVersion(projectId, "api_contracts", result.content, {
              agentType, modelUsed: result.modelUsed, sessionId,
            });
          }
        }
        // Auto-save CURRENT_STATE after every agent
        void brain.createVersion(projectId, "current_state", result.content, {
          agentType, modelUsed: result.modelUsed, sessionId,
        });
      }
    }

    // ── Verification loop ───────────────────────────────────────────────────
    if (phase === "VERIFY") {
      const report = await handleVerification(
        sessionId, userId, projectId,
        allContents, allFiles, contractContent, verifyRound,
      );
      if (!report.passed) {
        // Mark waiting for manual intervention after max rounds
        await db.update(buildSessions).set({
          planStatus: "fix_required",
          verifyRound: report.round,
          verifyReport: report,
        }).where(eq(buildSessions.id, sessionId));
        return;
      }
    }

    // ── Deploy phase: emit extra events ────────────────────────────────────
    if (phase === "DEPLOY") {
      server?.deployStart(sessionId, { sessionId, target: "vercel", timestamp: now() });
    }

    // ── Create freeze contract ──────────────────────────────────────────────
    const fileInputs = await Promise.all(
      allFiles.map(async (p) => {
        const fullPath = join(WORKSPACE_BASE, projectId, sessionId, phase.toLowerCase(), p);
        let content = "";
        try { content = await readFile(fullPath, "utf8"); } catch { /* skip */ }
        return { path: p, content };
      }),
    );
    await freezer.createFreeze(
      sessionId,
      phase as Parameters<typeof freezer.createFreeze>[1],
      fileInputs,
      config.agentTypes.map((a) => ({ agentType: a, outputHash: randomUUID() })),
    );

    const creditsUsed = Math.ceil(totalCost * 1_000);
    await db.update(buildSessions).set({
      planStatus: phase === "DEPLOY" ? "complete" : "waiting_phase_approval",
      status: phase === "DEPLOY" ? "success" : "running",
      creditsUsed,
      completedAt: phase === "DEPLOY" ? new Date() : undefined,
    }).where(eq(buildSessions.id, sessionId));

    try {
      await deductCredits(userId, creditsUsed);
    } catch (err) {
      logger.error({ err, userId, phase, sessionId }, "Failed to deduct credits for plan phase");
    }

    if (phase === "DEPLOY") {
      await db.update(projects).set({ status: "live" }).where(eq(projects.id, projectId));
      const previewUrl = `/preview/${projectId}/${sessionId}`;
      await db.update(buildSessions).set({ previewUrl }).where(eq(buildSessions.id, sessionId));
      server?.deployComplete(sessionId, { sessionId, url: previewUrl, timestamp: now() });
    }

    server?.phaseComplete(sessionId, {
      sessionId,
      phase: phase as Parameters<typeof server.phaseComplete>[1]["phase"],
      nextPhase: (NEXT_PHASE[phase] ?? null) as Parameters<typeof server.phaseComplete>[1]["nextPhase"],
      creditsUsed,
      timestamp: now(),
    });
    server?.progress(sessionId, { sessionId, percent: 100, message: `${phase} complete`, timestamp: now() });

    logger.info({ sessionId, phase, creditsUsed, files: allFiles.length }, "Plan phase complete");
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ sessionId, phase, err: errorMsg }, "Plan phase failed");
    await db.update(buildSessions).set({
      status: "failed",
      planStatus: "failed",
      error: errorMsg,
      completedAt: new Date(),
    }).where(eq(buildSessions.id, sessionId));
    await db.update(projects).set({ status: "failed" }).where(eq(projects.id, projectId));
    server?.buildFailed(sessionId, {
      sessionId,
      phase: phase as Parameters<typeof server.buildFailed>[1]["phase"],
      reason: errorMsg,
      logs: "",
      timestamp: now(),
    });
  }
}

// ── Verification handler (up to MAX_VERIFY_ROUNDS fix cycles) ─────────────────

async function handleVerification(
  sessionId: string,
  userId: string,
  projectId: string,
  verifyContents: string[],
  fileList: string[],
  contractContent: string,
  round: number,
): Promise<VerifyReport> {
  const server = ws();
  const currentRound = round + 1;

  // Parse combined verification output
  const combined = verifyContents.join("\n\n");
  let checks: VerifyCheck[] = [];
  let passed = true;

  try {
    const raw = extractJson(combined);
    const parsed = verifyResponseSchema.safeParse(raw);
    if (parsed.success) {
      checks = parsed.data.checks as VerifyCheck[];
      passed = parsed.data.passed && checks.every((c) => c.passed);
    }
  } catch {
    passed = false;
    checks = [{
      name: "parse_error",
      passed: false,
      detail: "Verifier output could not be parsed as JSON — treated as fail to trigger fix-agent",
    }];
  }

  const report: VerifyReport = { passed, round: currentRound, checks };

  server?.verifyResult(sessionId, {
    sessionId,
    passed,
    round: currentRound,
    report: { checks },
    timestamp: now(),
  });

  if (!passed && currentRound < MAX_VERIFY_ROUNDS) {
    const failedChecks = checks.filter((c) => !c.passed).map((c) => c.name);
    server?.fixRequired(sessionId, {
      sessionId,
      failedChecks,
      round: currentRound,
      maxRounds: MAX_VERIFY_ROUNDS,
      timestamp: now(),
    });

    // Run fix agent
    const fixDesc = `${contractContent}\n\nFailed checks:\n${failedChecks.map((c) => `- ${c}`).join("\n")}\n\nFix all identified issues in the codebase.`;
    const fixResult = await runAgent({
      sessionId, userId, projectId,
      agentType: "fix",
      taskDescription: fixDesc,
      phase: "VERIFY",
    });
    await writePhaseFiles(sessionId, projectId, "VERIFY", fixResult.content, "fix");

    // Re-run verification after fix
    return handleVerification(
      sessionId, userId, projectId,
      [fixResult.content], fileList, contractContent, currentRound,
    );
  }

  return report;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const planRouter = new Hono();
planRouter.use("/*", requireAuth);

// POST /api/plan/start
planRouter.post("/start", async (c) => {
  const authUser = c.get("authUser");

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = startBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  const { projectId, prompt } = parsed.data;

  // Validate project
  const pRows = await db.select().from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, authUser.id))).limit(1);
  const project = pRows[0];
  if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");
  if (project.mode !== "plan") throw new AppError(400, "Project is not in plan mode", "INVALID_MODE");
  if (project.isArchived) throw new AppError(400, "Project is archived", "PROJECT_ARCHIVED");
  if (project.status === "building") throw new AppError(409, "A build is already running", "BUILD_IN_PROGRESS");

  // Atomically deduct credits; refund on any subsequent failure
  await deductCredits(authUser.id, PLAN_CREDIT_ESTIMATE);

  const sessionId = randomUUID();
  try {
    await db.insert(buildSessions).values({
      id: sessionId,
      projectId,
      userId: authUser.id,
      prompt,
      mode: "plan",
      status: "running",
      phase: 0,
      planStatus: "interviewing",
    });
    await db.update(projects).set({ status: "building" }).where(eq(projects.id, projectId));
  } catch (err) {
    await refundCredits(authUser.id, PLAN_CREDIT_ESTIMATE);
    throw err;
  }

  // Dispatch planning agent to generate interview questions
  let questions: PlanQuestion[];
  try {
    const result = await getDispatcher().dispatch({
      agentType: "planning",
      task: {
        description: `The user wants to build: "${prompt}"\n\nGenerate 5–8 clarifying interview questions to understand their requirements. Return ONLY valid JSON:\n{"questions":[{"id":"q1","text":"...","type":"text|choice|multiChoice","options":["..."],"required":true}]}`,
        outputFormat: "json",
      },
      sessionId,
      userId: authUser.id,
      projectId,
    });

    const raw = extractJson(result.content);
    const validated = questionsResponseSchema.safeParse(raw);
    if (!validated.success) throw new Error("Invalid questions format");
    questions = validated.data.questions as PlanQuestion[];
  } catch (err) {
    // Graceful degradation: return sensible defaults if LLM fails
    logger.warn({ sessionId, err }, "Planning agent question generation failed, using defaults");
    questions = [
      { id: "q1", text: "Who is the target audience?", type: "choice", options: ["B2B", "B2C", "Internal team"], required: true },
      { id: "q2", text: "What is the primary technology stack preference?", type: "choice", options: ["React + Node.js", "Vue + Python", "Next.js full-stack"], required: true },
      { id: "q3", text: "Do you need user authentication?", type: "choice", options: ["Yes, email/password", "Yes, OAuth (Google/GitHub)", "No auth needed"], required: true },
      { id: "q4", text: "What database should be used?", type: "choice", options: ["PostgreSQL", "MySQL", "SQLite"], required: true },
      { id: "q5", text: "Any specific integrations required? (e.g. Stripe, SendGrid)", type: "text", required: false },
    ];
  }

  // Persist questions
  await db.update(buildSessions).set({
    interviewData: { questions, answers: [] },
  }).where(eq(buildSessions.id, sessionId));

  return c.json({ sessionId, status: "interviewing", questions }, 201);
});

// POST /api/plan/interview
planRouter.post("/interview", async (c) => {
  const authUser = c.get("authUser");

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = interviewBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  const { sessionId, answers } = parsed.data;

  const session = await getOwnedSession(sessionId, authUser.id);
  if (session.planStatus !== "interviewing") {
    throw new AppError(409, `Session is in status '${session.planStatus}', expected 'interviewing'`, "INVALID_STATE");
  }

  const interviewData = session.interviewData ?? { questions: [], answers: [] };
  const updatedAnswers: PlanAnswer[] = answers.map((a) => ({ questionId: a.questionId, answer: a.answer }));

  // Build Q&A context for the contract generator
  const qaContext = (interviewData.questions as PlanQuestion[]).map((q) => {
    const ans = updatedAnswers.find((a) => a.questionId === q.id);
    return `Q: ${q.text}\nA: ${ans?.answer ?? "(not answered)"}`;
  }).join("\n\n");

  await db.update(buildSessions).set({
    planStatus: "contracting",
    interviewData: { questions: interviewData.questions as PlanQuestion[], answers: updatedAnswers },
  }).where(eq(buildSessions.id, sessionId));

  // Dispatch planning agent to generate contract + tasks
  let contract: string;
  let tasks: PlanTask[];
  try {
    const result = await getDispatcher().dispatch({
      agentType: "planning",
      task: {
        description: `Project: "${session.prompt}"\n\nInterview Q&A:\n${qaContext}\n\nGenerate a complete CONTRACT.md and task breakdown. Return ONLY valid JSON:\n{"contract":"# BuildForge Contract\\n...","tasks":[{"agent":"db","task":"...","estimatedTokens":3000,"phase":"FOUNDATION"}]}`,
        outputFormat: "json",
      },
      sessionId,
      userId: authUser.id,
      projectId: session.projectId,
    });

    const raw = extractJson(result.content);
    const validated = contractResponseSchema.safeParse(raw);
    if (!validated.success) throw new Error("Invalid contract format");
    contract = validated.data.contract;
    tasks = validated.data.tasks as PlanTask[];
  } catch (err) {
    logger.warn({ sessionId, err }, "Planning agent contract generation failed, generating stub");
    contract = `# BuildForge Contract\n\n## Project\n${session.prompt}\n\n## Architecture\nTo be defined based on interview answers.\n\n## Q&A\n${qaContext}`;
    tasks = [
      { agent: "db",       task: "Design database schema",        estimatedTokens: 3_000, phase: "FOUNDATION" },
      { agent: "backend",  task: "Implement backend skeleton",    estimatedTokens: 4_000, phase: "FOUNDATION" },
      { agent: "frontend", task: "Build frontend UI",             estimatedTokens: 4_000, phase: "BUILD"      },
      { agent: "backend",  task: "Implement business logic",      estimatedTokens: 3_500, phase: "BUILD"      },
      { agent: "security", task: "Security audit",                estimatedTokens: 2_000, phase: "VERIFY"     },
      { agent: "deploy",   task: "Generate deployment config",    estimatedTokens: 1_500, phase: "DEPLOY"     },
    ];
  }

  // Write CONTRACT.md to workspace
  const contractDir = join(WORKSPACE_BASE, session.projectId, sessionId);
  await mkdir(contractDir, { recursive: true });
  await writeFile(join(contractDir, "CONTRACT.md"), contract, "utf8");

  // Auto-save CONTRACT.md to shared brain
  void getBrainManager().createVersion(session.projectId, "contract", contract, {
    agentType: "planning",
    sessionId,
  });

  await db.update(buildSessions).set({
    planStatus: "waiting_approval",
    contractContent: contract,
    planTasks: tasks,
    interviewData: { questions: interviewData.questions as PlanQuestion[], answers: updatedAnswers },
  }).where(eq(buildSessions.id, sessionId));

  return c.json({ sessionId, contract, tasks, status: "waiting_approval" });
});

// POST /api/plan/approve
planRouter.post("/approve", async (c) => {
  const authUser = c.get("authUser");

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = approveBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  const { sessionId, approved, modifications } = parsed.data;

  const session = await getOwnedSession(sessionId, authUser.id);
  if (session.planStatus !== "waiting_approval") {
    throw new AppError(409, `Session is in status '${session.planStatus}', expected 'waiting_approval'`, "INVALID_STATE");
  }

  // ── Modifications requested — revise the contract ─────────────────────────
  if (!approved && modifications) {
    const prevContract = session.contractContent ?? "";
    let contract: string;
    let tasks: PlanTask[];
    try {
      const result = await getDispatcher().dispatch({
        agentType: "planning",
        task: {
          description: `Revise the following contract based on user feedback.\n\nCurrent contract:\n${prevContract}\n\nFeedback:\n${modifications}\n\nReturn ONLY valid JSON:\n{"contract":"...","tasks":[...]}`,
          outputFormat: "json",
        },
        sessionId,
        userId: authUser.id,
        projectId: session.projectId,
      });
      const raw = extractJson(result.content);
      const validated = contractResponseSchema.safeParse(raw);
      if (!validated.success) throw new Error("Invalid contract format");
      contract = validated.data.contract;
      tasks = validated.data.tasks as PlanTask[];
    } catch (err) {
      logger.warn({ sessionId, err }, "Contract revision failed, keeping previous");
      contract = prevContract;
      tasks = (session.planTasks ?? []) as PlanTask[];
    }

    const contractDir = join(WORKSPACE_BASE, session.projectId, sessionId);
    await mkdir(contractDir, { recursive: true });
    await writeFile(join(contractDir, "CONTRACT.md"), contract, "utf8");

    // Auto-save revised contract to shared brain
    void getBrainManager().createVersion(session.projectId, "contract", contract, {
      agentType: "planning",
      sessionId,
    });

    await db.update(buildSessions).set({
      contractContent: contract,
      planTasks: tasks,
    }).where(eq(buildSessions.id, sessionId));

    return c.json({ sessionId, contract, tasks, status: "waiting_approval" });
  }

  if (!approved) {
    throw new AppError(400, "Must either approve or provide modifications", "VALIDATION_ERROR");
  }

  // ── Approved — start FOUNDATION phase ────────────────────────────────────
  await db.update(buildSessions).set({ planStatus: "approved" }).where(eq(buildSessions.id, sessionId));

  const contractContent = session.contractContent;
  if (!contractContent) {
    return c.json({
      error: "Contract generation failed. Please restart from /api/plan/start to regenerate the architecture plan.",
      code: "CONTRACT_MISSING",
    }, 409);
  }
  void runPlanPhase(
    sessionId,
    authUser.id,
    session.projectId,
    "FOUNDATION",
    contractContent,
  );

  return c.json({ sessionId, status: "running", phase: "FOUNDATION" });
});

// GET /api/plan/:sessionId/status
planRouter.get("/:sessionId/status", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const session = await getOwnedSession(sessionId, authUser.id);

  const tasks = await db.select({
    agentType: agentTasks.agentType,
    status: agentTasks.status,
    inputTokens: agentTasks.inputTokens,
    outputTokens: agentTasks.outputTokens,
    costUsd: agentTasks.costUsd,
    startedAt: agentTasks.startedAt,
    completedAt: agentTasks.completedAt,
    modelUsed: agentTasks.modelUsed,
    tierUsed: agentTasks.tierUsed,
    error: agentTasks.error,
  }).from(agentTasks).where(eq(agentTasks.sessionId, sessionId));

  // Enrich plan tasks with live status from agentTasks
  const planTasks = (session.planTasks ?? []) as PlanTask[];
  const enrichedTasks = planTasks.map((pt) => {
    const liveTask = tasks.find((t) => t.agentType === pt.agent);
    const tokens = (liveTask?.inputTokens ?? 0) + (liveTask?.outputTokens ?? 0);
    return {
      agent: pt.agent,
      task: pt.task,
      estimatedTokens: pt.estimatedTokens,
      phase: pt.phase,
      status: liveTask?.status ?? "pending",
      progress: liveTask?.status === "complete" ? 100 : liveTask?.status === "running" ? 50 : 0,
      tokensUsed: tokens,
      cost: liveTask?.costUsd ?? 0,
    };
  });

  const agents = tasks.map((t) => ({
    type: t.agentType,
    model: t.modelUsed,
    tier: t.tierUsed,
    status: t.status,
    lastAction: t.completedAt?.toISOString() ?? t.startedAt?.toISOString() ?? null,
    error: t.error,
  }));

  return c.json({
    sessionId,
    phase: session.phase,
    planPhase: session.currentPlanPhase,
    planStatus: session.planStatus,
    status: session.status,
    contract: {
      generated: session.contractContent !== null,
      content: session.contractContent ?? undefined,
    },
    tasks: enrichedTasks,
    agents,
    verifyRound: session.verifyRound,
    verifyReport: session.verifyReport,
    creditsUsed: session.creditsUsed,
    previewUrl: session.previewUrl,
    error: session.error,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  });
});

// POST /api/plan/:id/interview  (path-param variant)
planRouter.post("/:id/interview", async (c) => {
  const authUser = c.get("authUser");
  const { id: sessionId } = c.req.param();

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const answersSchema = z.object({
    answers: z.array(z.object({
      questionId: z.string().min(1),
      answer: z.string().min(1).max(2_000),
    })).min(1),
  });
  const parsed = answersSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  const { answers } = parsed.data;

  const session = await getOwnedSession(sessionId, authUser.id);
  if (session.planStatus !== "interviewing") {
    throw new AppError(409, `Session is in status '${session.planStatus}', expected 'interviewing'`, "INVALID_STATE");
  }

  const interviewData = session.interviewData ?? { questions: [], answers: [] };
  const updatedAnswers: PlanAnswer[] = answers.map((a) => ({ questionId: a.questionId, answer: a.answer }));

  const qaContext = (interviewData.questions as PlanQuestion[]).map((q) => {
    const ans = updatedAnswers.find((a) => a.questionId === q.id);
    return `Q: ${q.text}\nA: ${ans?.answer ?? "(not answered)"}`;
  }).join("\n\n");

  await db.update(buildSessions).set({
    planStatus: "contracting",
    interviewData: { questions: interviewData.questions as PlanQuestion[], answers: updatedAnswers },
  }).where(eq(buildSessions.id, sessionId));

  let contract: string;
  let tasks: PlanTask[];
  try {
    const result = await getDispatcher().dispatch({
      agentType: "planning",
      task: {
        description: `Project: "${session.prompt}"\n\nInterview Q&A:\n${qaContext}\n\nGenerate a complete CONTRACT.md and task breakdown. Return ONLY valid JSON:\n{"contract":"# BuildForge Contract\\n...","tasks":[{"agent":"db","task":"...","estimatedTokens":3000,"phase":"FOUNDATION"}]}`,
        outputFormat: "json",
      },
      sessionId,
      userId: authUser.id,
      projectId: session.projectId,
    });
    const raw = extractJson(result.content);
    const validated = contractResponseSchema.safeParse(raw);
    if (!validated.success) throw new Error("Invalid contract format");
    contract = validated.data.contract;
    tasks = validated.data.tasks as PlanTask[];
  } catch (err) {
    logger.warn({ sessionId, err }, "Contract generation failed, generating stub");
    contract = `# BuildForge Contract\n\n## Project\n${session.prompt}\n\n## Q&A\n${qaContext}`;
    tasks = [
      { agent: "db",       task: "Design database schema",     estimatedTokens: 3_000, phase: "FOUNDATION" },
      { agent: "backend",  task: "Implement backend skeleton", estimatedTokens: 4_000, phase: "FOUNDATION" },
      { agent: "frontend", task: "Build frontend UI",          estimatedTokens: 4_000, phase: "BUILD"      },
      { agent: "security", task: "Security audit",             estimatedTokens: 2_000, phase: "VERIFY"     },
      { agent: "deploy",   task: "Generate deployment config", estimatedTokens: 1_500, phase: "DEPLOY"     },
    ];
  }

  const contractDir = join(WORKSPACE_BASE, session.projectId, sessionId);
  await mkdir(contractDir, { recursive: true });
  await writeFile(join(contractDir, "CONTRACT.md"), contract, "utf8");

  await db.update(buildSessions).set({
    planStatus: "waiting_approval",
    contractContent: contract,
    planTasks: tasks,
  }).where(eq(buildSessions.id, sessionId));

  return c.json({ sessionId, contract, tasks, status: "waiting_approval" });
});

// POST /api/plan/:id/approve  (path-param variant)
planRouter.post("/:id/approve", async (c) => {
  const authUser = c.get("authUser");
  const { id: sessionId } = c.req.param();

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = approveBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  const { approved, modifications } = parsed.data;

  const session = await getOwnedSession(sessionId, authUser.id);
  if (session.planStatus !== "waiting_approval") {
    throw new AppError(409, `Session is in status '${session.planStatus}', expected 'waiting_approval'`, "INVALID_STATE");
  }

  if (!approved && modifications) {
    const prevContract = session.contractContent ?? "";
    let contract: string;
    let tasks: PlanTask[];
    try {
      const result = await getDispatcher().dispatch({
        agentType: "planning",
        task: {
          description: `Revise the following contract based on user feedback.\n\nCurrent contract:\n${prevContract}\n\nFeedback:\n${modifications}\n\nReturn ONLY valid JSON:\n{"contract":"...","tasks":[...]}`,
          outputFormat: "json",
        },
        sessionId,
        userId: authUser.id,
        projectId: session.projectId,
      });
      const raw = extractJson(result.content);
      const validated = contractResponseSchema.safeParse(raw);
      if (!validated.success) throw new Error("Invalid contract format");
      contract = validated.data.contract;
      tasks = validated.data.tasks as PlanTask[];
    } catch (err) {
      logger.warn({ sessionId, err }, "Contract revision failed, keeping previous");
      contract = prevContract;
      tasks = (session.planTasks ?? []) as PlanTask[];
    }

    const contractDir = join(WORKSPACE_BASE, session.projectId, sessionId);
    await mkdir(contractDir, { recursive: true });
    await writeFile(join(contractDir, "CONTRACT.md"), contract, "utf8");

    await db.update(buildSessions).set({
      contractContent: contract,
      planTasks: tasks,
      planStatus: "waiting_approval",
    }).where(eq(buildSessions.id, sessionId));

    return c.json({ sessionId, contract, tasks, status: "waiting_approval", revised: true });
  }

  if (!approved) {
    // Rejected with no modifications — cancel
    await db.update(buildSessions).set({ status: "cancelled", planStatus: "cancelled", completedAt: new Date() })
      .where(eq(buildSessions.id, sessionId));
    await db.update(projects).set({ status: "idle" }).where(eq(projects.id, session.projectId));
    return c.json({ sessionId, status: "cancelled" });
  }

  // Approved — kick off FOUNDATION phase in background
  void runPlanPhase(sessionId, authUser.id, session.projectId, "FOUNDATION", session.contractContent ?? session.prompt ?? "");

  return c.json({ sessionId, status: "building", message: "Build started. Monitor via GET /api/plan/:id/status" });
});

// POST /api/plan/:sessionId/phase/:phase/approve
planRouter.post("/:sessionId/phase/:phaseParam/approve", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId, phaseParam } = c.req.param();

  const validPhases: PlanPhase[] = ["FOUNDATION", "BUILD", "VERIFY", "DEPLOY"];
  const phase = phaseParam.toUpperCase() as PlanPhase;
  if (!validPhases.includes(phase)) {
    throw new AppError(400, `Invalid phase '${phaseParam}'. Valid: ${validPhases.join(", ")}`, "VALIDATION_ERROR");
  }

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = phaseApproveBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, "Body must be {approved: true}", "VALIDATION_ERROR");

  const session = await getOwnedSession(sessionId, authUser.id);
  if (session.planStatus !== "waiting_phase_approval") {
    throw new AppError(409, `Session is in status '${session.planStatus}', expected 'waiting_phase_approval'`, "INVALID_STATE");
  }
  if (session.currentPlanPhase !== phase) {
    throw new AppError(409, `Session is in phase '${session.currentPlanPhase}', expected '${phase}'`, "PHASE_MISMATCH");
  }

  const nextPhase = NEXT_PHASE[phase];
  if (nextPhase === null) {
    // DEPLOY was already the last — shouldn't normally reach here, but handle gracefully
    return c.json({ sessionId, status: "complete", nextPhase: null });
  }

  // Start next phase in background
  void runPlanPhase(
    sessionId,
    authUser.id,
    session.projectId,
    nextPhase,
    session.contractContent ?? session.prompt ?? "",
  );

  return c.json({ sessionId, status: "running", currentPhase: phase, nextPhase });
});
