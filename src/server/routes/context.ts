import { Hono } from "hono";
import { z } from "zod";
import { join } from "path";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getContextManager } from "../../context/manager.js";

const WORKSPACE_BASE = join(process.cwd(), "workspace");

const COST_PER_1K_TOKENS_USD = 0.001;

const selectBodySchema = z.object({
  projectId: z.string().min(1),
  prompt: z.string().min(1).max(4_000),
  maxTokens: z.number().int().positive().max(32_000).optional(),
});

export const contextRouter = new Hono();
contextRouter.use("/*", requireAuth);

// POST /api/context/select
contextRouter.post("/select", async (c) => {
  const bodyRaw = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = selectBodySchema.safeParse(bodyRaw);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  const { projectId, prompt, maxTokens } = parsed.data;
  const authUser = c.get("authUser");
  const ownedProject = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, authUser.id)))
    .limit(1);
  if (ownedProject.length === 0) throw new AppError(404, "Project not found", "NOT_FOUND");

  const ctx = await getContextManager().select({
    projectId,
    prompt,
    workspaceBase: WORKSPACE_BASE,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
  });

  const estimatedCost = parseFloat(
    ((ctx.tokenEstimate / 1_000) * COST_PER_1K_TOKENS_USD).toFixed(6),
  );

  return c.json({
    files: ctx.relevantFiles.map((f) => ({ path: f.path, content: f.content })),
    totalTokens: ctx.tokenEstimate,
    estimatedCost,
  });
});
