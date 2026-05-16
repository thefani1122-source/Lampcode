/**
 * Deploy routes only.
 * Integration management has moved to src/server/routes/integrations.ts.
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects, buildSessions, integrations } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getDeployPipeline } from "../../deploy/pipeline.js";
import { runSmokeTests } from "../../deploy/smoke.js";
import { logger } from "../logger.js";

// ── Validation ────────────────────────────────────────────────────────────────

const deployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
});

const smokeQuerySchema = z.object({
  url: z.string().url("url must be a valid URL"),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(buildSessions)
    .where(and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(404, "Build session not found", "NOT_FOUND");
  return rows[0];
}

// ── Deploy router (mounted at /api/deploy) ────────────────────────────────────

export const deployRouter = new Hono();
deployRouter.use("/*", requireAuth);

// POST /api/deploy/:sessionId
deployRouter.post("/:sessionId", async (c) => {
  const authUser = c.get("authUser");
  const sessionId = c.req.param("sessionId") ?? "";
  const session = await requireSession(sessionId, authUser.id);

  if (session.status === "running") {
    throw new AppError(409, "A deploy is already in progress", "DEPLOY_IN_PROGRESS");
  }

  const body = await c.req.json().catch(() => ({}));
  const parsed = deployBodySchema.safeParse(body);
  const extraEnv = parsed.success ? (parsed.data.env ?? {}) : {};

  // Merge extra env into project settings (fire-and-forget friendly)
  if (Object.keys(extraEnv).length > 0) {
    const pRows = await db.select({ settings: projects.settings }).from(projects)
      .where(eq(projects.id, session.projectId)).limit(1);
    const existing = pRows[0]?.settings?.envVars ?? {};
    await db.update(projects).set({
      settings: { envVars: { ...existing, ...extraEnv } },
    }).where(eq(projects.id, session.projectId));
  }

  // Fire-and-forget deploy
  const pipeline = getDeployPipeline();
  void pipeline.deploy(sessionId, authUser.id).catch((err: unknown) => {
    logger.error({ sessionId, err }, "Deploy pipeline failed");
  });

  return c.json({ sessionId, status: "deploying", projectId: session.projectId }, 202);
});

// GET /api/deploy/:sessionId/status
deployRouter.get("/:sessionId/status", async (c) => {
  const authUser = c.get("authUser");
  const sessionId = c.req.param("sessionId") ?? "";
  const session = await requireSession(sessionId, authUser.id);

  const providerRows = await db
    .select({ provider: integrations.provider, status: integrations.status, tier: integrations.tier, lastDeployedAt: integrations.lastDeployedAt })
    .from(integrations)
    .where(eq(integrations.projectId, session.projectId));

  return c.json({
    sessionId,
    projectId: session.projectId,
    status:     session.status,
    planStatus: session.planStatus,
    previewUrl: session.previewUrl,
    phase:      session.phase,
    integrations: providerRows,
    completedAt: session.completedAt?.toISOString(),
    error:       session.error,
  });
});

// POST /api/deploy/:sessionId/rollback
deployRouter.post("/:sessionId/rollback", async (c) => {
  const authUser = c.get("authUser");
  const sessionId = c.req.param("sessionId") ?? "";
  const session = await requireSession(sessionId, authUser.id);

  const pipeline = getDeployPipeline();
  const step = await pipeline.rollback(session.projectId);

  return c.json({ sessionId, projectId: session.projectId, rollback: step });
});

// POST /api/deploy/smoke
deployRouter.post("/smoke", async (c) => {
  const authUser = c.get("authUser");
  void authUser; // auth required but not used in smoke tests

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = smokeQuerySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }

  const result = await runSmokeTests(parsed.data.url);
  return c.json(result, result.ok ? 200 : 207);
});
