/**
 * Environment variable management routes.
 * Values are encrypted with AES-256-GCM before storage.
 * Sync pushes decrypted values to connected MCP platforms.
 *
 * Mounted at /api/projects/:id/env
 */

import { Hono } from "hono";
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects, projectEnvVars, integrations } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { logger } from "../logger.js";
import { encrypt, decrypt } from "../env-crypto.js";

export { encrypt, decrypt, type EncryptedValue } from "../env-crypto.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const ENVIRONMENTS = ["development", "preview", "production"] as const;
type Env = (typeof ENVIRONMENTS)[number];

// ── Validation ────────────────────────────────────────────────────────────────

const envQuerySchema = z.object({
  environment: z.enum(ENVIRONMENTS).default("production"),
});

const createEnvSchema = z.object({
  key:         z.string().min(1).max(200).regex(/^[A-Z_][A-Z0-9_]*$/, "Key must be uppercase letters, digits, and underscores"),
  value:       z.string().max(32_768),
  environment: z.enum(ENVIRONMENTS).default("production"),
});

const updateEnvSchema = z.object({
  value:       z.string().max(32_768),
  environment: z.enum(ENVIRONMENTS).default("production"),
});

const syncBodySchema = z.object({
  environment: z.enum(ENVIRONMENTS).default("production"),
  providers:   z.array(z.enum(["vercel", "supabase", "github", "railway"])).optional(),
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

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError(400, r.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  return r.data;
}

function safeId(): string {
  return randomBytes(16).toString("hex");
}

// ── Router ────────────────────────────────────────────────────────────────────

export const envRouter = new Hono();
envRouter.use("/*", requireAuth);

// GET /api/projects/:id/env?environment=production
envRouter.get("/", async (c) => {
  const authUser  = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const { environment } = parseBody(envQuerySchema, c.req.query());

  const rows = await db
    .select({
      id:          projectEnvVars.id,
      key:         projectEnvVars.key,
      environment: projectEnvVars.environment,
      createdAt:   projectEnvVars.createdAt,
      updatedAt:   projectEnvVars.updatedAt,
    })
    .from(projectEnvVars)
    .where(and(
      eq(projectEnvVars.projectId, projectId),
      eq(projectEnvVars.environment, environment),
    ));

  // Never return raw values in list — only keys + metadata
  return c.json({ projectId, environment, vars: rows });
});

// POST /api/projects/:id/env — add a variable
envRouter.post("/", async (c) => {
  const authUser  = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const body = parseBody(createEnvSchema, await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); }));

  // Check for duplicate key in this environment
  const existing = await db
    .select({ id: projectEnvVars.id })
    .from(projectEnvVars)
    .where(and(
      eq(projectEnvVars.projectId, projectId),
      eq(projectEnvVars.environment, body.environment),
      eq(projectEnvVars.key, body.key),
    ))
    .limit(1);

  if (existing.length > 0) {
    throw new AppError(409, `Key '${body.key}' already exists in ${body.environment}`, "CONFLICT");
  }

  const { encrypted, iv, tag } = encrypt(body.value);

  const [row] = await db
    .insert(projectEnvVars)
    .values({
      id:             safeId(),
      projectId,
      environment:    body.environment,
      key:            body.key,
      encryptedValue: encrypted,
      iv,
      tag,
    })
    .returning({
      id:          projectEnvVars.id,
      key:         projectEnvVars.key,
      environment: projectEnvVars.environment,
      createdAt:   projectEnvVars.createdAt,
    });

  return c.json({ var: row }, 201);
});

// PATCH /api/projects/:id/env/:key — update a variable's value
envRouter.patch("/:key", async (c) => {
  const authUser  = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const varKey = c.req.param("key") ?? "";
  const body   = parseBody(updateEnvSchema, await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); }));

  const { encrypted, iv, tag } = encrypt(body.value);

  const result = await db
    .update(projectEnvVars)
    .set({ encryptedValue: encrypted, iv, tag, updatedAt: new Date() })
    .where(and(
      eq(projectEnvVars.projectId, projectId),
      eq(projectEnvVars.environment, body.environment),
      eq(projectEnvVars.key, varKey),
    ))
    .returning({ id: projectEnvVars.id, key: projectEnvVars.key, updatedAt: projectEnvVars.updatedAt });

  if (result.length === 0) {
    throw new AppError(404, `Key '${varKey}' not found in ${body.environment}`, "NOT_FOUND");
  }

  return c.json({ var: result[0] });
});

// DELETE /api/projects/:id/env/:key
envRouter.delete("/:key", async (c) => {
  const authUser  = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const varKey      = c.req.param("key") ?? "";
  const environment = (c.req.query("environment") ?? "production") as Env;

  const result = await db
    .delete(projectEnvVars)
    .where(and(
      eq(projectEnvVars.projectId, projectId),
      eq(projectEnvVars.environment, environment),
      eq(projectEnvVars.key, varKey),
    ))
    .returning({ id: projectEnvVars.id });

  if (result.length === 0) {
    throw new AppError(404, `Key '${varKey}' not found in ${environment}`, "NOT_FOUND");
  }

  return c.json({ ok: true, key: varKey, environment });
});

// POST /api/projects/:id/env/sync — push vars to connected platforms
envRouter.post("/sync", async (c) => {
  const authUser  = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  const project   = await requireProjectOwner(projectId, authUser.id);

  const body = parseBody(syncBodySchema, await c.req.json().catch(() => ({})));
  const { environment, providers: requestedProviders } = body;

  // Load all env vars for this environment
  const rows = await db
    .select()
    .from(projectEnvVars)
    .where(and(
      eq(projectEnvVars.projectId, projectId),
      eq(projectEnvVars.environment, environment),
    ));

  if (rows.length === 0) {
    return c.json({ ok: true, synced: [], skipped: [], message: "No variables to sync" });
  }

  // Decrypt all values
  const envMap: Record<string, string> = {};
  for (const row of rows) {
    try {
      envMap[row.key] = decrypt({ encrypted: row.encryptedValue, iv: row.iv, tag: row.tag });
    } catch (err) {
      logger.warn({ projectId, key: row.key, err }, "Failed to decrypt env var during sync");
    }
  }

  logger.warn({ projectId }, "Env sync not available — deploy gateway removed");
  return c.json({ ok: false, environment, synced: [], skipped: [], message: "Env sync not configured" }, 501);
});
