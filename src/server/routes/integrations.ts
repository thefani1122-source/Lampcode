import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userIntegrations } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { encrypt, decrypt } from "../env-crypto.js";
import { logger } from "../logger.js";

export const integrationsRouter = new Hono();
integrationsRouter.use("/*", requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────

const connectSupabaseSchema = z.object({
  supabaseUrl: z.string().url("Must be a valid URL, e.g. https://xxx.supabase.co"),
  serviceRoleKey: z.string().min(20, "Service role key looks too short"),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function testSupabaseConnection(
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<{ ok: boolean; projectRef: string | null; error: string | null }> {
  const url = supabaseUrl.replace(/\/$/, "");
  const projectRef = url.match(/https:\/\/([^.]+)\.supabase\.co/)?.[1] ?? null;

  try {
    // Verify credentials by calling the Supabase REST API health endpoint
    const res = await fetch(`${url}/rest/v1/`, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      signal: AbortSignal.timeout(8_000),
    });

    if (res.ok || res.status === 200) {
      return { ok: true, projectRef, error: null };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, projectRef, error: "Invalid service role key" };
    }
    return { ok: false, projectRef, error: `Supabase responded with HTTP ${res.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, projectRef, error: `Connection failed: ${msg}` };
  }
}

// ── GET /api/integrations ─────────────────────────────────────────────────────

integrationsRouter.get("/", async (c) => {
  const { id: userId } = c.get("authUser");

  const rows = await db
    .select({
      id: userIntegrations.id,
      provider: userIntegrations.provider,
      status: userIntegrations.status,
      lastTestedAt: userIntegrations.lastTestedAt,
      lastError: userIntegrations.lastError,
      createdAt: userIntegrations.createdAt,
      // expose non-secret config fields only
      supabaseUrl: userIntegrations.config,
    })
    .from(userIntegrations)
    .where(eq(userIntegrations.userId, userId));

  const integrations = rows.map((r) => {
    const cfg = r.supabaseUrl as Record<string, unknown>;
    return {
      id: r.id,
      provider: r.provider,
      status: r.status,
      lastTestedAt: r.lastTestedAt,
      lastError: r.lastError,
      createdAt: r.createdAt,
      // only expose safe public fields — never return encrypted key material
      meta: {
        supabaseUrl: cfg["supabaseUrl"] ?? null,
        projectRef: cfg["projectRef"] ?? null,
      },
    };
  });

  return c.json({ integrations });
});

// ── POST /api/integrations/supabase ──────────────────────────────────────────

integrationsRouter.post("/supabase", async (c) => {
  const { id: userId } = c.get("authUser");

  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = connectSupabaseSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }

  const { supabaseUrl, serviceRoleKey } = parsed.data;
  const cleanUrl = supabaseUrl.replace(/\/$/, "");

  // Test the credentials before storing
  const test = await testSupabaseConnection(cleanUrl, serviceRoleKey);
  if (!test.ok) {
    throw new AppError(422, test.error ?? "Could not verify Supabase credentials", "INTEGRATION_TEST_FAILED");
  }

  // Encrypt the service role key at rest
  const enc = encrypt(serviceRoleKey);

  const now = new Date();
  const id = randomUUID();

  await db
    .insert(userIntegrations)
    .values({
      id,
      userId,
      provider: "supabase",
      status: "connected",
      config: {
        supabaseUrl: cleanUrl,
        projectRef: test.projectRef ?? undefined,
        encryptedServiceKey: enc.encrypted,
        encryptedServiceKeyIv: enc.iv,
        encryptedServiceKeyTag: enc.tag,
      },
      lastTestedAt: now,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userIntegrations.userId, userIntegrations.provider],
      set: {
        status: "connected",
        config: {
          supabaseUrl: cleanUrl,
          projectRef: test.projectRef ?? undefined,
          encryptedServiceKey: enc.encrypted,
          encryptedServiceKeyIv: enc.iv,
          encryptedServiceKeyTag: enc.tag,
        },
        lastTestedAt: now,
        lastError: null,
        updatedAt: now,
      },
    });

  logger.info({ userId, provider: "supabase", projectRef: test.projectRef }, "Integration connected");

  return c.json({
    id,
    provider: "supabase",
    status: "connected",
    projectRef: test.projectRef,
    supabaseUrl: cleanUrl,
  }, 201);
});

// ── POST /api/integrations/:id/test ──────────────────────────────────────────

integrationsRouter.post("/:id/test", async (c) => {
  const { id: userId } = c.get("authUser");
  const { id } = c.req.param();

  const rows = await db
    .select()
    .from(userIntegrations)
    .where(and(eq(userIntegrations.id, id), eq(userIntegrations.userId, userId)))
    .limit(1);
  const row = rows[0];
  if (!row) throw new AppError(404, "Integration not found", "NOT_FOUND");

  if (row.provider !== "supabase") {
    throw new AppError(400, "Test not yet supported for this provider", "NOT_SUPPORTED");
  }

  const cfg = row.config;
  if (!cfg.supabaseUrl || !cfg.encryptedServiceKey || !cfg.encryptedServiceKeyIv || !cfg.encryptedServiceKeyTag) {
    throw new AppError(422, "Integration credentials are incomplete — reconnect", "INCOMPLETE_CREDENTIALS");
  }

  const serviceRoleKey = decrypt({
    encrypted: cfg.encryptedServiceKey,
    iv: cfg.encryptedServiceKeyIv,
    tag: cfg.encryptedServiceKeyTag,
  });

  const test = await testSupabaseConnection(cfg.supabaseUrl, serviceRoleKey);
  const now = new Date();

  await db
    .update(userIntegrations)
    .set({
      status: test.ok ? "connected" : "error",
      lastTestedAt: now,
      lastError: test.error,
      updatedAt: now,
    })
    .where(eq(userIntegrations.id, id));

  return c.json({ ok: test.ok, error: test.error });
});

// ── DELETE /api/integrations/:id ─────────────────────────────────────────────

integrationsRouter.delete("/:id", async (c) => {
  const { id: userId } = c.get("authUser");
  const { id } = c.req.param();

  const rows = await db
    .select({ id: userIntegrations.id })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.id, id), eq(userIntegrations.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(404, "Integration not found", "NOT_FOUND");

  await db.delete(userIntegrations).where(eq(userIntegrations.id, id));

  logger.info({ userId, integrationId: id }, "Integration disconnected");
  return c.json({ success: true });
});
