import { Hono } from "hono";
import { z } from "zod";
import { and, eq, gte, sum } from "drizzle-orm";
import { mkdir, writeFile, readFile, readdir, rm, stat } from "fs/promises";
import { join, dirname, relative, extname } from "path";
import { db } from "../../db/client.js";
import {
  projects,
  buildSessions,
  agentTasks,
  type BuildSession,
} from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getDispatcher } from "../../agents/dispatcher.js";
import { parseFilesFromContent, type ParsedFile } from "../../agents/file-parser.js";
import { streamEvents, type StreamEventPayload } from "../../agents/stream-handler.js";
import { getWebSocketServer } from "../../websocket/server.js";
import { logger } from "../logger.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const WORKSPACE_BASE = join(process.cwd(), "workspace");

// Credit estimate for a single fast-mode frontend dispatch (credits = $0.001 each)
const FAST_BUILD_CREDIT_COST = 25;
// Free plan monthly limit in credits
const FREE_PLAN_CREDIT_LIMIT = 100;

// ── In-memory cancel registry ─────────────────────────────────────────────────

const cancelledSessions = new Set<string>();

// ── WS helper — never throws ──────────────────────────────────────────────────

function ws() {
  try { return getWebSocketServer(); }
  catch { return null; }
}

// ── Input schemas ─────────────────────────────────────────────────────────────

const fastBuildBodySchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(4_000),
  attachments: z.array(z.string()).max(10).optional(),
});

// ── File tree walker ──────────────────────────────────────────────────────────

interface FileEntry {
  path: string;
  content: string;
  sizeBytes: number;
  lines: number;
}

async function walkDirectory(base: string, dir: string): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  let items: string[];
  try {
    items = await readdir(dir);
  } catch {
    return entries;
  }
  for (const item of items) {
    const full = join(dir, item);
    let s;
    try { s = await stat(full); } catch { continue; }
    if (s.isDirectory()) {
      entries.push(...await walkDirectory(base, full));
    } else {
      try {
        const content = await readFile(full, "utf8");
        entries.push({
          path: relative(base, full),
          content,
          sizeBytes: s.size,
          lines: content.split("\n").length,
        });
      } catch { /* skip unreadable files */ }
    }
  }
  return entries;
}

// ── Credit check ──────────────────────────────────────────────────────────────

async function checkFastBuildCredits(userId: string): Promise<void> {
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({ totalCost: sum(agentTasks.costUsd) })
    .from(agentTasks)
    .where(
      and(
        eq(agentTasks.userId, userId),
        gte(agentTasks.startedAt, monthStart),
        eq(agentTasks.status, "complete"),
      ),
    );

  const usedUsd = parseFloat(rows[0]?.totalCost ?? "0") || 0;
  const usedCredits = usedUsd * 1_000; // 1 credit = $0.001
  const remaining = FREE_PLAN_CREDIT_LIMIT - usedCredits;

  if (remaining < FAST_BUILD_CREDIT_COST) {
    throw new AppError(
      402,
      `Insufficient credits. ${Math.floor(remaining)} remaining, ${FAST_BUILD_CREDIT_COST} required.`,
      "INSUFFICIENT_CREDITS",
    );
  }
}

// ── Background build runner ───────────────────────────────────────────────────

async function runFastBuild(
  session: BuildSession,
  userId: string,
): Promise<void> {
  const { id: sessionId, projectId, prompt } = session;
  const server = ws();

  // Mark started
  await db
    .update(buildSessions)
    .set({ startedAt: new Date(), phase: 1 })
    .where(eq(buildSessions.id, sessionId));

  // ── Emit agent_start ──────────────────────────────────────────────────────
  server?.agentStart(sessionId, {
    taskId: sessionId,
    sessionId,
    agentType: "frontend",
    taskName: "Fast Build — Frontend (Kimi K2)",
    model: "moonshotai/kimi-k2",
    tier: 1,
    timestamp: new Date().toISOString(),
  });

  // ── Subscribe to stream chunks for WS forwarding ──────────────────────────
  let chunkCount = 0;
  const chunkHandler = (payload: StreamEventPayload): void => {
    if (payload.sessionId !== sessionId) return;
    chunkCount++;
    server?.agentProgress(sessionId, payload.taskId, "frontend", payload.chunk, chunkCount);

    // Emit coarse-grained progress (0–90%; final 10% reserved for file writes)
    const percent = Math.min(Math.floor((chunkCount / 150) * 90), 90);
    server?.progress(sessionId, {
      sessionId,
      percent,
      message: `Generating code… (${chunkCount} chunks received)`,
      timestamp: new Date().toISOString(),
    });
  };
  streamEvents.on("chunk", chunkHandler);

  try {
    // ── Dispatch frontend agent ─────────────────────────────────────────────
    const dispatcher = getDispatcher();
    const result = await dispatcher.dispatch({
      agentType: "frontend",
      task: {
        description: prompt,
        requirements: [
          "Generate complete, production-ready files.",
          "Each file must be preceded by its relative path (e.g. ## File: src/App.tsx).",
          "Include: index.html, CSS, and all JavaScript/TypeScript source files.",
          "Use React with TypeScript. Style with Tailwind CSS.",
        ],
        outputFormat: "code",
      },
      sessionId,
      userId,
      projectId,
    });

    streamEvents.off("chunk", chunkHandler);

    // ── Check for cancellation ──────────────────────────────────────────────
    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
      return;
    }

    // ── Parse and write files ───────────────────────────────────────────────
    let parsedFiles = parseFilesFromContent(result.content);

    // Auto-trigger fix agent if frontend produced no structured file output
    if (parsedFiles.length === 0 && result.content.trim().length < 200) {
      logger.warn({ sessionId }, "Frontend agent produced no structured output — triggering fix agent");
      try {
        const fixResult = await dispatcher.triggerFixAgent(
          "frontend",
          `Original prompt: ${prompt}\nAgent response: ${result.content.slice(0, 500)}`,
          sessionId, projectId, userId,
        );
        parsedFiles = parseFilesFromContent(fixResult.content);
      } catch (fixErr) {
        logger.error({ sessionId, fixErr }, "Fix agent also failed");
      }
    }

    const filesToWrite: ParsedFile[] =
      parsedFiles.length > 0
        ? parsedFiles
        : [{ path: "output.md", code: result.content }];

    const outputDir = join(WORKSPACE_BASE, projectId, sessionId, "frontend");
    await mkdir(outputDir, { recursive: true });

    const writtenPaths: string[] = [];
    const totalFiles = filesToWrite.length;

    for (let idx = 0; idx < filesToWrite.length; idx++) {
      if (cancelledSessions.has(sessionId)) break;

      const file = filesToWrite[idx];
      if (!file) continue;
      const { path: filePath, code } = file;

      // Sanitise path: strip leading slashes / traversal attempts
      const safePath = filePath.replace(/^[\\/]+/, "").replace(/\.\.\//g, "");
      const fullPath = join(outputDir, safePath);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, code, "utf8");
      writtenPaths.push(safePath);

      const linesChanged = code.split("\n").length;
      server?.fileUpdate(sessionId, {
        sessionId,
        path: safePath,
        content: code,
        linesChanged,
        timestamp: new Date().toISOString(),
      });

      const writePercent = 90 + Math.floor(((idx + 1) / totalFiles) * 10);
      server?.progress(sessionId, {
        sessionId,
        percent: writePercent,
        message: `Writing ${safePath}`,
        timestamp: new Date().toISOString(),
      });
    }

    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
      return;
    }

    // ── Update build session ────────────────────────────────────────────────
    const creditsUsed = Math.ceil(result.costUsd * 1_000);
    await db
      .update(buildSessions)
      .set({
        status: "success",
        phase: 2,
        outputDir,
        creditsUsed,
        completedAt: new Date(),
      })
      .where(eq(buildSessions.id, sessionId));

    await db
      .update(projects)
      .set({ status: "active" })
      .where(eq(projects.id, projectId));

    // ── Emit complete ───────────────────────────────────────────────────────
    server?.progress(sessionId, {
      sessionId,
      percent: 100,
      message: "Build complete",
      timestamp: new Date().toISOString(),
    });

    server?.phaseComplete(sessionId, {
      sessionId,
      phase: "BUILD",
      nextPhase: null,
      creditsUsed,
      timestamp: new Date().toISOString(),
    });

    logger.info({ sessionId, projectId, files: writtenPaths.length, creditsUsed }, "Fast build complete");
  } catch (err) {
    streamEvents.off("chunk", chunkHandler);

    if (cancelledSessions.has(sessionId)) {
      cancelledSessions.delete(sessionId);
      return;
    }

    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ sessionId, err: errorMsg }, "Fast build failed");

    await db
      .update(buildSessions)
      .set({ status: "failed", error: errorMsg, completedAt: new Date() })
      .where(eq(buildSessions.id, sessionId));

    await db
      .update(projects)
      .set({ status: "error" })
      .where(eq(projects.id, projectId));

    server?.buildFailed(sessionId, {
      sessionId,
      phase: "BUILD",
      reason: errorMsg,
      logs: "",
      timestamp: new Date().toISOString(),
    });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

export const buildRouter = new Hono();
buildRouter.use("/*", requireAuth);

// POST /api/build/fast
buildRouter.post("/fast", async (c) => {
  const authUser = c.get("authUser");

  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = fastBuildBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }
  const { projectId, prompt, attachments } = parsed.data;

  // ── Verify project ownership ───────────────────────────────────────────────
  const projectRows = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, authUser.id)))
    .limit(1);
  const project = projectRows[0];
  if (!project) throw new AppError(404, "Project not found", "NOT_FOUND");

  if (project.mode !== "fast") {
    throw new AppError(400, "Project is not in fast mode", "INVALID_MODE");
  }

  if (project.isArchived) {
    throw new AppError(400, "Project is archived", "PROJECT_ARCHIVED");
  }

  if (project.status === "building") {
    throw new AppError(409, "A build is already running for this project", "BUILD_IN_PROGRESS");
  }

  // ── Credit check ──────────────────────────────────────────────────────────
  await checkFastBuildCredits(authUser.id);

  // ── Create build session ──────────────────────────────────────────────────
  const sessionId = crypto.randomUUID();
  await db.insert(buildSessions).values({
    id: sessionId,
    projectId,
    userId: authUser.id,
    prompt,
    mode: "fast",
    status: "running",
    phase: 0,
    attachments: attachments ?? null,
  });

  // Mark project as building
  await db
    .update(projects)
    .set({ status: "building" })
    .where(eq(projects.id, projectId));

  // ── Fire background build (do not await) ──────────────────────────────────
  void runFastBuild(
    {
      id: sessionId,
      projectId,
      userId: authUser.id,
      prompt,
      mode: "fast",
      status: "running",
      phase: 0,
      outputDir: null,
      previewUrl: null,
      creditsUsed: 0,
      attachments: attachments ?? null,
      error: null,
      planStatus: null,
      currentPlanPhase: null,
      interviewData: null,
      contractContent: null,
      planTasks: null,
      verifyRound: 0,
      verifyReport: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
    },
    authUser.id,
  );

  return c.json({ sessionId, status: "running", previewUrl: null }, 202);
});

// GET /api/build/:sessionId/status
buildRouter.get("/:sessionId/status", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const sessionRows = await db
    .select()
    .from(buildSessions)
    .where(
      and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, authUser.id)),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AppError(404, "Build session not found", "NOT_FOUND");

  // Fetch agent tasks for this session
  const tasks = await db
    .select({
      agentType: agentTasks.agentType,
      status: agentTasks.status,
      inputTokens: agentTasks.inputTokens,
      outputTokens: agentTasks.outputTokens,
    })
    .from(agentTasks)
    .where(eq(agentTasks.sessionId, sessionId));

  const agents = tasks.map((t) => ({
    type: t.agentType,
    status: t.status,
    progress: t.status === "complete" ? 100 : t.status === "failed" ? 0 : 50,
    tokens: (t.inputTokens ?? 0) + (t.outputTokens ?? 0),
  }));

  return c.json({
    sessionId,
    phase: session.phase,
    status: session.status,
    agents,
    creditsUsed: session.creditsUsed,
    outputDir: session.outputDir,
    previewUrl: session.previewUrl,
    error: session.error,
    createdAt: session.createdAt,
    startedAt: session.startedAt,
    completedAt: session.completedAt,
  });
});

// POST /api/build/:sessionId/cancel
buildRouter.post("/:sessionId/cancel", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const sessionRows = await db
    .select()
    .from(buildSessions)
    .where(
      and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, authUser.id)),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AppError(404, "Build session not found", "NOT_FOUND");

  if (session.status !== "running") {
    throw new AppError(409, `Build is already ${session.status}`, "BUILD_NOT_RUNNING");
  }

  // Signal the background runner to stop before writing the next file
  cancelledSessions.add(sessionId);

  // Update DB immediately
  await db
    .update(buildSessions)
    .set({ status: "cancelled", completedAt: new Date() })
    .where(eq(buildSessions.id, sessionId));

  await db
    .update(projects)
    .set({ status: "active" })
    .where(eq(projects.id, session.projectId));

  // Best-effort: delete partial workspace files
  const partialDir = join(WORKSPACE_BASE, session.projectId, sessionId);
  rm(partialDir, { recursive: true, force: true }).catch(() => undefined);

  ws()?.buildFailed(sessionId, {
    sessionId,
    phase: "BUILD",
    reason: "Cancelled by user",
    logs: "",
    timestamp: new Date().toISOString(),
  });

  return c.json({ sessionId, status: "cancelled" });
});

// GET /api/build/:sessionId/files
buildRouter.get("/:sessionId/files", async (c) => {
  const authUser = c.get("authUser");
  const { sessionId } = c.req.param();

  const sessionRows = await db
    .select()
    .from(buildSessions)
    .where(
      and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, authUser.id)),
    )
    .limit(1);
  const session = sessionRows[0];
  if (!session) throw new AppError(404, "Build session not found", "NOT_FOUND");

  if (session.outputDir === null) {
    return c.json({ sessionId, files: [], message: "No files written yet" });
  }

  const workspaceBase = join(WORKSPACE_BASE, session.projectId, sessionId);
  const files = await walkDirectory(workspaceBase, workspaceBase);

  // Group by subdirectory (frontend / backend)
  const grouped: Record<string, typeof files> = {};
  for (const f of files) {
    const segments = f.path.split("/");
    const bucket = segments.length > 1 ? (segments[0] ?? "root") : "root";
    const existing = grouped[bucket];
    if (existing) {
      existing.push(f);
    } else {
      grouped[bucket] = [f];
    }
  }

  return c.json({
    sessionId,
    totalFiles: files.length,
    totalSizeBytes: files.reduce((acc, f) => acc + f.sizeBytes, 0),
    groups: grouped,
  });
});
