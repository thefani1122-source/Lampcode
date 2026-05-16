import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects, buildSessions, integrations, type McpProvider as DbMcpProvider } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getGateway } from "../../mcp/gateway.js";
import { getDeployPipeline } from "../../deploy/pipeline.js";
import { runSmokeTests } from "../../deploy/smoke.js";
import { type McpProvider } from "../../mcp/types.js";
import { logger } from "../logger.js";

// ── Validation ────────────────────────────────────────────────────────────────

const MCP_PROVIDERS = ["vercel", "supabase", "github", "railway"] as const;

const connectBodySchema = z.object({
  provider: z.enum(MCP_PROVIDERS),
  credentials: z.object({
    token:      z.string().min(1).optional(),
    apiKey:     z.string().min(1).optional(),
    teamId:     z.string().optional(),
    orgId:      z.string().optional(),
    projectRef: z.string().optional(),
    serviceId:  z.string().optional(),
    repoOwner:  z.string().optional(),
  }),
});

const executeToolBodySchema = z.object({
  toolName: z.string().min(1),
  args:     z.record(z.string(), z.unknown()).default({}),
});

const deployBodySchema = z.object({
  env: z.record(z.string(), z.string()).optional(),
});

const smokeQuerySchema = z.object({
  url: z.string().url("url must be a valid URL"),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectOwner(projectId: string, userId: string) {
  const rows = await db
    .select({ id: projects.id, slug: projects.slug })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(403, "Not authorized", "FORBIDDEN");
  return rows[0];
}

async function requireSession(sessionId: string, userId: string) {
  const rows = await db
    .select()
    .from(buildSessions)
    .where(and(eq(buildSessions.id, sessionId), eq(buildSessions.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(404, "Build session not found", "NOT_FOUND");
  return rows[0];
}

function parseProvider(raw: string): McpProvider {
  const r = z.enum(MCP_PROVIDERS).safeParse(raw);
  if (!r.success) {
    throw new AppError(400, `Invalid provider '${raw}'. Must be one of: ${MCP_PROVIDERS.join(", ")}`, "VALIDATION_ERROR");
  }
  return r.data;
}

// ── Integrations router (mounted at /api/projects/:id/integrations) ───────────

export const integrationsRouter = new Hono();
integrationsRouter.use("/*", requireAuth);

// GET /api/projects/:id/integrations
integrationsRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const rows = await db
    .select({
      id:            integrations.id,
      provider:      integrations.provider,
      status:        integrations.status,
      tier:          integrations.tier,
      lastTestedAt:  integrations.lastTestedAt,
      lastDeployedAt: integrations.lastDeployedAt,
      error:         integrations.error,
      createdAt:     integrations.createdAt,
    })
    .from(integrations)
    .where(eq(integrations.projectId, projectId));

  return c.json({ projectId, integrations: rows });
});

// POST /api/projects/:id/integrations
integrationsRouter.post("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = connectBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }

  const { provider, credentials } = parsed.data;
  const gateway = getGateway();
  const result = await gateway.connect(projectId, authUser.id, provider, credentials);

  return c.json(result, result.ok ? 201 : 200);
});

// DELETE /api/projects/:id/integrations/:provider
integrationsRouter.delete("/:provider", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider") ?? "");
  const gateway = getGateway();
  await gateway.disconnect(projectId, provider);

  return c.json({ ok: true, provider, projectId });
});

// POST /api/projects/:id/integrations/:provider/test
integrationsRouter.post("/:provider/test", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider") ?? "");
  const gateway = getGateway();
  const result = await gateway.testConnection(projectId, provider);

  return c.json(result);
});

// POST /api/projects/:id/integrations/:provider/execute
integrationsRouter.post("/:provider/execute", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider") ?? "");
  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = executeToolBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }

  const gateway = getGateway();
  const result = await gateway.executeTool(projectId, provider, parsed.data.toolName, parsed.data.args as Record<string, unknown>);

  return c.json(result);
});

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
