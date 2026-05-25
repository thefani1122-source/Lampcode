import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects, type BrainFileType } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getBrainManager } from "../../brain/manager.js";

// ── Validation ────────────────────────────────────────────────────────────────

const BRAIN_FILE_TYPES = [
  "contract", "db_schema", "api_contracts", "current_state",
  "deploy_checklist", "security_checklist", "connection_checklist", "provenance_log",
] as const;

const fileTypeSchema = z.enum(BRAIN_FILE_TYPES);

const createVersionBodySchema = z.object({
  fileType: fileTypeSchema,
  content: z.string().min(1).max(500_000),
  agentType: z.string().optional(),
  modelUsed: z.string().optional(),
  sessionId: z.string().uuid().optional(),
});

const compareQuerySchema = z.object({
  to: z.string().regex(/^\d+$/, "to must be a positive integer"),
  from: z.string().regex(/^\d+$/, "from must be a positive integer").optional(),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectAccess(projectId: string, userId: string) {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (rows.length === 0) throw new AppError(403, "Not authorized", "FORBIDDEN");
}

function parseFileType(raw: string): BrainFileType {
  const result = fileTypeSchema.safeParse(raw.toUpperCase());
  if (!result.success) {
    throw new AppError(
      400,
      `Invalid file type '${raw}'. Must be one of: ${BRAIN_FILE_TYPES.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  return result.data;
}

// ── Router ────────────────────────────────────────────────────────────────────

export const brainRouter = new Hono();
brainRouter.use("/*", requireAuth);

// GET /api/projects/:id/brain?type=CONTRACT
brainRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectAccess(projectId, authUser.id);

  const rawType = c.req.query("type");
  if (!rawType) throw new AppError(400, "Query param 'type' is required", "VALIDATION_ERROR");
  const fileType = parseFileType(rawType);

  const brain = getBrainManager();
  const latest = await brain.getLatest(projectId, fileType);
  if (!latest) throw new AppError(404, `No ${fileType} found for this project`, "NOT_FOUND");

  return c.json({
    id: latest.id,
    fileType: latest.fileType,
    version: latest.version,
    content: latest.content,
    agentType: latest.agentType,
    modelUsed: latest.modelUsed,
    sessionId: latest.sessionId,
    createdAt: latest.createdAt.toISOString(),
  });
});

// POST /api/projects/:id/brain
brainRouter.post("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectAccess(projectId, authUser.id);

  const body = await c.req
    .json()
    .catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = createVersionBodySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(
      400,
      parsed.error.issues.map((i) => i.message).join("; "),
      "VALIDATION_ERROR",
    );
  }

  const { fileType, content, agentType, modelUsed, sessionId } = parsed.data;
  const brain = getBrainManager();
  const record = await brain.createVersion(projectId, fileType, content, {
    agentType,
    modelUsed,
    sessionId,
  });

  return c.json(
    {
      id: record.id,
      fileType: record.fileType,
      version: record.version,
      agentType: record.agentType,
      modelUsed: record.modelUsed,
      sessionId: record.sessionId,
      createdAt: record.createdAt.toISOString(),
    },
    201,
  );
});

// GET /api/projects/:id/brain/:fileId/history
// :fileId is the file type (e.g., CONTRACT, DB_SCHEMA)
brainRouter.get("/:fileId/history", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectAccess(projectId, authUser.id);

  const fileType = parseFileType(c.req.param("fileId") ?? "");
  const brain = getBrainManager();
  const history = await brain.getHistory(projectId, fileType);

  return c.json({
    fileType,
    projectId,
    totalVersions: history.length,
    versions: history.map((r) => ({
      id: r.id,
      version: r.version,
      agentType: r.agentType,
      modelUsed: r.modelUsed,
      sessionId: r.sessionId,
      contentLength: r.content.length,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// GET /api/projects/:id/brain/:fileId/compare?from=1&to=2
// :fileId is the file type; defaults from=latest when omitted
brainRouter.get("/:fileId/compare", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectAccess(projectId, authUser.id);

  const fileType = parseFileType(c.req.param("fileId") ?? "");

  const q = compareQuerySchema.safeParse({
    to:   c.req.query("to"),
    from: c.req.query("from"),
  });
  if (!q.success) {
    throw new AppError(
      400,
      q.error.issues.map((i) => i.message).join("; "),
      "VALIDATION_ERROR",
    );
  }

  const toVersion = parseInt(q.data.to, 10);
  let fromVersion: number;

  if (q.data.from !== undefined) {
    fromVersion = parseInt(q.data.from, 10);
  } else {
    const brain = getBrainManager();
    const latest = await brain.getLatest(projectId, fileType);
    if (!latest) throw new AppError(404, `No ${fileType} found for this project`, "NOT_FOUND");
    fromVersion = latest.version;
  }

  if (fromVersion === toVersion) {
    throw new AppError(400, "from and to versions must differ", "VALIDATION_ERROR");
  }

  const brain = getBrainManager();
  let result;
  try {
    result = await brain.compareVersions(projectId, fileType, fromVersion, toVersion);
  } catch (err) {
    throw new AppError(404, err instanceof Error ? err.message : "Version not found", "NOT_FOUND");
  }

  return c.json({
    fileType: result.fileType,
    fromVersion: result.fromVersion,
    toVersion: result.toVersion,
    insertions: result.insertions,
    deletions: result.deletions,
    diff: result.diff,
  });
});
