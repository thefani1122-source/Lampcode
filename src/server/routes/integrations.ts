import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { eq, and } from "drizzle-orm";
import { db } from "../../db/client.js";
import { userIntegrations, userMcpConnections } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { encrypt, decrypt } from "../env-crypto.js";
import { logger } from "../logger.js";
import { listSupabaseMcpTools, fetchSupabaseProjectCreds } from "../../mcp/supabase-mcp.js";
import { getProvider } from "../../mcp/providers/index.js";
import { getMcpProvider, resolveServerUrl } from "../../mcp/registry.js";

export const integrationsRouter = new Hono();
integrationsRouter.use("/*", requireAuth);

// ── Schemas ───────────────────────────────────────────────────────────────────

const connectSupabaseSchema = z.object({
  supabaseUrl: z.string().url("Must be a valid URL, e.g. https://xxx.supabase.co"),
  serviceRoleKey: z.string().min(20, "Service role key looks too short"),
});

const connectSupabaseMcpSchema = z.object({
  // Supabase Personal Access Token from https://supabase.com/dashboard/account/tokens
  accessToken: z.string().min(20, "Access token looks too short"),
  projectRef: z.string().min(10, "project ref looks too short").optional(),
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
        ...((cfg["meta"] as Record<string, string> | undefined) ?? {}),
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

// ── POST /api/integrations/supabase/mcp ──────────────────────────────────────
// Connect the user's OWN Supabase via the hosted MCP server using a Personal
// Access Token. We verify the PAT by listing tools, then (best-effort) fetch the
// project's public URL + anon key so the preview can target the user's project.
// The PAT + service key never leave the backend; only the anon key (public,
// RLS-safe) is ever injected into a preview.

integrationsRouter.post("/supabase/mcp", async (c) => {
  const { id: userId } = c.get("authUser");

  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = connectSupabaseMcpSchema.safeParse(body);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => i.message).join("; ");
    throw new AppError(400, msg, "VALIDATION_ERROR");
  }
  const { accessToken, projectRef } = parsed.data;

  // Verify the PAT against the public MCP server (this is the "does it work
  // publicly" check) by opening a session and listing tools.
  let toolCount = 0;
  try {
    const tools = await listSupabaseMcpTools({ accessToken, projectRef });
    toolCount = tools.length;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new AppError(422, `Could not connect to Supabase MCP: ${msg}`, "MCP_CONNECT_FAILED");
  }
  if (toolCount === 0) {
    throw new AppError(422, "Connected but the MCP server returned no tools — check the token's scope", "MCP_NO_TOOLS");
  }

  // Best-effort: fetch the project's public URL + anon key for previews.
  let creds: { url: string | null; anonKey: string | null } = { url: null, anonKey: null };
  if (projectRef) {
    creds = await fetchSupabaseProjectCreds({ accessToken, projectRef }).catch(() => creds);
  }

  const patEnc = encrypt(accessToken);
  const anonEnc = creds.anonKey ? encrypt(creds.anonKey) : null;
  const now = new Date();
  const id = randomUUID();

  const config = {
    projectRef: projectRef ?? undefined,
    supabaseUrl: creds.url ?? undefined,
    // PAT (admin) — encrypted, backend-only.
    encryptedToken: patEnc.encrypted,
    encryptedTokenIv: patEnc.iv,
    encryptedTokenTag: patEnc.tag,
    // anon key (public) — encrypted at rest too; injected into previews.
    encryptedAnonKey: anonEnc?.encrypted,
    encryptedAnonKeyIv: anonEnc?.iv,
    encryptedAnonKeyTag: anonEnc?.tag,
  };

  await db
    .insert(userIntegrations)
    .values({
      id, userId, provider: "supabase", status: "connected",
      config, lastTestedAt: now, lastError: null, createdAt: now, updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userIntegrations.userId, userIntegrations.provider],
      set: { status: "connected", config, lastTestedAt: now, lastError: null, updatedAt: now },
    });

  logger.info({ userId, projectRef, toolCount, hasAnonKey: Boolean(creds.anonKey) }, "Supabase MCP connected");

  return c.json({
    provider: "supabase",
    status: "connected",
    toolCount,
    projectRef: projectRef ?? null,
    supabaseUrl: creds.url,
    anonKeyResolved: Boolean(creds.anonKey),
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

// ── POST /api/integrations/provider/:id ──────────────────────────────────────
// Generic connect for registry providers (wordpress, shopify, make, n8n,
// zapier). Validates with the provider's Zod schema, runs testConnection, then
// stores the full creds object ENCRYPTED (one blob) + a few non-secret fields
// for display. Credentials never leave the backend.

integrationsRouter.post("/provider/:id", async (c) => {
  const { id: userId } = c.get("authUser");
  const providerId = c.req.param("id");

  const provider = getProvider(providerId);
  if (!provider) throw new AppError(404, `Unknown provider: ${providerId}`, "UNKNOWN_PROVIDER");

  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = provider.schema.safeParse(body);
  if (!parsed.success) {
    const zerr = parsed as { error: { issues: { message: string }[] } };
    throw new AppError(400, zerr.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  const params = parsed.data as Record<string, unknown>;

  const test = await provider.testConnection(params);
  if (!test.ok) throw new AppError(422, test.error ?? "Could not verify credentials", "INTEGRATION_TEST_FAILED");

  // Encrypt the whole creds object as one blob.
  const enc = encrypt(JSON.stringify(params));

  // Non-secret display fields (skip passwords; show host for URLs).
  const meta: Record<string, string> = {};
  for (const f of provider.fields) {
    if (f.type === "password") continue;
    const v = params[f.key];
    if (typeof v !== "string" || !v) continue;
    if (f.type === "url") {
      try { meta[f.key] = new URL(v).host; } catch { /* skip malformed */ }
    } else {
      meta[f.key] = v;
    }
  }

  const now = new Date();
  const id = randomUUID();
  const config = {
    encryptedCreds: enc.encrypted,
    encryptedCredsIv: enc.iv,
    encryptedCredsTag: enc.tag,
    meta,
  };

  await db
    .insert(userIntegrations)
    .values({
      id, userId,
      provider: providerId as typeof userIntegrations.$inferInsert.provider,
      status: "connected", config, lastTestedAt: now, lastError: null, createdAt: now, updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [userIntegrations.userId, userIntegrations.provider],
      set: { status: "connected", config, lastTestedAt: now, lastError: null, updatedAt: now },
    });

  logger.info({ userId, provider: providerId }, "Provider integration connected");
  return c.json({ provider: providerId, status: "connected", meta }, 201);
});

// ── Helpers for the build/preview flow ────────────────────────────────────────

async function loadSupabaseIntegration(userId: string) {
  const rows = await db
    .select()
    .from(userIntegrations)
    .where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, "supabase")))
    .limit(1);
  const row = rows[0];
  if (!row || row.status !== "connected") return null;
  return row;
}

/**
 * The user's own Supabase project URL + anon key (decrypted) for injecting into
 * a preview, when they've connected via MCP. anon key is public/RLS-safe. Null
 * if not connected or the anon key wasn't resolved.
 */
export async function getUserSupabasePreviewCreds(
  userId: string,
): Promise<{ url: string; anonKey: string; serviceKey?: string } | null> {
  const row = await loadSupabaseIntegration(userId);
  if (!row) return null;
  const cfg = row.config;
  if (!cfg.supabaseUrl || !cfg.encryptedAnonKey || !cfg.encryptedAnonKeyIv || !cfg.encryptedAnonKeyTag) {
    return null;
  }
  try {
    const anonKey = decrypt({
      encrypted: cfg.encryptedAnonKey,
      iv: cfg.encryptedAnonKeyIv,
      tag: cfg.encryptedAnonKeyTag,
    });
    // Service key (RLS-bypass) only if the user connected via the service-key
    // flow. Backend-only — never returned to the frontend.
    let serviceKey: string | undefined;
    if (cfg.encryptedServiceKey && cfg.encryptedServiceKeyIv && cfg.encryptedServiceKeyTag) {
      try {
        serviceKey = decrypt({
          encrypted: cfg.encryptedServiceKey,
          iv: cfg.encryptedServiceKeyIv,
          tag: cfg.encryptedServiceKeyTag,
        });
      } catch { /* ignore */ }
    }
    return { url: cfg.supabaseUrl, anonKey, ...(serviceKey ? { serviceKey } : {}) };
  } catch (err) {
    logger.warn({ userId, err }, "Failed to decrypt user Supabase anon key");
    return null;
  }
}

/**
 * The user's Supabase MCP auth (PAT + projectRef), decrypted, for running their
 * generated schema against their own project. Backend-only — never exposed.
 */
export async function getUserSupabaseMcpAuth(
  userId: string,
): Promise<{ accessToken: string; projectRef?: string } | null> {
  const row = await loadSupabaseIntegration(userId);
  if (!row) return null;
  const cfg = row.config;
  if (!cfg.encryptedToken || !cfg.encryptedTokenIv || !cfg.encryptedTokenTag) return null;
  try {
    const accessToken = decrypt({
      encrypted: cfg.encryptedToken,
      iv: cfg.encryptedTokenIv,
      tag: cfg.encryptedTokenTag,
    });
    return { accessToken, ...(cfg.projectRef ? { projectRef: cfg.projectRef } : {}) };
  } catch (err) {
    logger.warn({ userId, err }, "Failed to decrypt user Supabase PAT");
    return null;
  }
}

// ── MCP Provider routes ────────────────────────────────────────────────────────

// POST /api/integrations/mcp/:slug/connect
integrationsRouter.post("/mcp/:slug/connect", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  const provider = getMcpProvider(slug);
  if (!provider) throw new AppError(404, `Unknown provider: ${slug}`, "UNKNOWN_PROVIDER");

  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR");
  }) as Record<string, string>;

  // Encrypt all creds as one blob
  const enc = encrypt(JSON.stringify(body));

  // Extract non-secret display fields
  const meta: Record<string, string> = {};
  for (const field of provider.credentialFields) {
    if (field.type === "password") continue;
    const v = body[field.key];
    if (typeof v === "string" && v) {
      if (field.type === "url") {
        try {
          meta[field.key] = new URL(v).host;
        } catch {
          meta[field.key] = v;
        }
      } else {
        meta[field.key] = v;
      }
    }
  }

  const id = randomUUID();
  const now = new Date();
  await db.insert(userMcpConnections).values({
    id,
    userId,
    providerSlug: slug,
    encryptedCreds: enc.encrypted,
    encryptedCredsIv: enc.iv,
    encryptedCredsTag: enc.tag,
    meta,
    connectedAt: now,
  }).onConflictDoUpdate({
    target: [userMcpConnections.userId, userMcpConnections.providerSlug],
    set: {
      encryptedCreds: enc.encrypted,
      encryptedCredsIv: enc.iv,
      encryptedCredsTag: enc.tag,
      meta,
      connectedAt: now,
    },
  });

  logger.info({ userId, slug }, "MCP provider connected");
  return c.json({ slug, status: "connected", meta }, 201);
});

// DELETE /api/integrations/mcp/:slug
integrationsRouter.delete("/mcp/:slug", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  await db
    .delete(userMcpConnections)
    .where(and(eq(userMcpConnections.userId, userId), eq(userMcpConnections.providerSlug, slug)));
  return c.json({ success: true });
});

// GET /api/integrations/mcp — list connected providers
integrationsRouter.get("/mcp", async (c) => {
  const { id: userId } = c.get("authUser");
  const rows = await db
    .select({
      providerSlug: userMcpConnections.providerSlug,
      meta: userMcpConnections.meta,
      connectedAt: userMcpConnections.connectedAt,
    })
    .from(userMcpConnections)
    .where(eq(userMcpConnections.userId, userId));
  return c.json({ connected: rows });
});

// ── Helper: get connected MCP servers ready for Anthropic beta ────────────────

export interface ActiveMcpServer {
  slug: string;
  name: string;
  url: string;
  authToken: string;
}

/**
 * Returns all connected MCP providers for a user with decrypted creds,
 * ready to pass directly to Anthropic's beta mcp_servers param.
 * Only returns providers that supportsRealMCP = true AND have a resolvable URL.
 */
export async function getConnectedMcpServers(userId: string): Promise<ActiveMcpServer[]> {
  const rows = await db
    .select()
    .from(userMcpConnections)
    .where(eq(userMcpConnections.userId, userId));

  const servers: ActiveMcpServer[] = [];

  for (const row of rows) {
    try {
      const provider = getMcpProvider(row.providerSlug);
      if (!provider?.supportsRealMCP) continue;

      const creds = JSON.parse(
        decrypt({
          encrypted: row.encryptedCreds,
          iv: row.encryptedCredsIv,
          tag: row.encryptedCredsTag,
        }),
      ) as Record<string, string>;

      const url = resolveServerUrl(provider, creds);
      if (!url) continue;

      // Determine the bearer token from creds based on authType
      const tokenKey =
        provider.credentialFields.find((f) => f.type === "password")?.key ?? "api_key";
      const authToken = creds[tokenKey] ?? "";
      if (!authToken) continue;

      servers.push({ slug: row.providerSlug, name: provider.name, url, authToken });
    } catch (err) {
      logger.warn({ userId, slug: row.providerSlug, err }, "Failed to decrypt MCP creds");
    }
  }

  return servers;
}
