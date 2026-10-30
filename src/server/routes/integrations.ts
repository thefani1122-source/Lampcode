import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { getDispatcher } from "../../agents/dispatcher.js";
import { classifyMcpQueryIntent } from "../../agents/mcp-query-intent.js";
import { serversForPrompt } from "../../agents/mcp-relevance.js";
import { assertHasBudget, getUserPlan } from "../../build/credits.js";
import { getConnectedRestIntegrations, parseRestConnection, REST_PROVIDER_SLUGS, testRestConnection, type RestProviderSlug } from "../../mcp/rest-integrations.js";
import { buildRestQueryTools, selectRestConnections } from "../../mcp/rest-query-tools.js";
import { z } from "zod";
import { eq, and, gt } from "drizzle-orm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { db } from "../../db/client.js";
import { mcpOAuthTransactions, userIntegrations, userMcpConnections } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { encrypt, decrypt } from "../env-crypto.js";
import { logger } from "../logger.js";
import { listSupabaseMcpTools, fetchSupabaseProjectCreds } from "../../mcp/supabase-mcp.js";
import { getProvider } from "../../mcp/providers/index.js";
import { getMcpProvider, resolveServerUrl } from "../../mcp/registry.js";
import { resolveCustomMcpAuth, resolveMcpAuth } from "../../mcp/connection.js";
import { secureMcpFetch } from "../../mcp/secure-fetch.js";
import { createMcpOAuthProvider, hashOAuthState, type McpOAuthSession } from "../../mcp/oauth-client.js";
import { checkMcpServer, safeMcpFailureCategory } from "../../mcp/health.js";
import { config } from "../config.js";

export const integrationsRouter = new Hono();
integrationsRouter.use("/*", requireAuth);

// This narrowly scoped callback is authenticated by its one-use, expiring
// OAuth state rather than a browser session. It is mounted before the private
// integrations router in index.ts.
export const mcpOAuthCallbackRouter = new Hono();
const OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

function encryptOAuthSession(session: McpOAuthSession) {
  return encrypt(JSON.stringify(session));
}

function decryptOAuthSession(row: { encryptedData: string; encryptedDataIv: string; encryptedDataTag: string }): McpOAuthSession {
  return JSON.parse(decrypt({ encrypted: row.encryptedData, iv: row.encryptedDataIv, tag: row.encryptedDataTag })) as McpOAuthSession;
}

function oauthCallbackUrl(): string {
  const value = config.MCP_OAUTH_REDIRECT_URL;
  if (!value) throw new AppError(503, "MCP OAuth callback is not configured", "OAUTH_UNAVAILABLE");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.pathname !== "/api/integrations/mcp/oauth/callback") {
    throw new AppError(503, "MCP OAuth callback URL must be the configured HTTPS callback endpoint", "OAUTH_UNAVAILABLE");
  }
  return url.toString();
}

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

// Test an existing Supabase PAT without inserting/upserting or mutating a connection.
integrationsRouter.post("/supabase/mcp/test", async (c) => {
  const { id: userId } = c.get("authUser");
  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR"); });
  const parsed = connectSupabaseMcpSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, parsed.error.issues.map((issue) => issue.message).join("; "), "VALIDATION_ERROR");
  try {
    const tools = await listSupabaseMcpTools({ accessToken: parsed.data.accessToken, projectRef: parsed.data.projectRef });
    if (tools.length === 0) throw new AppError(422, "Supabase MCP returned no tools", "MCP_NO_TOOLS");
    logger.info({ userId, provider: "supabase", stage: "test", toolCount: tools.length }, "Supabase MCP test passed");
    return c.json({ slug: "supabase", status: "verified", toolCount: tools.length });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const category = safeMcpFailureCategory(err);
    logger.warn({ userId, provider: "supabase", stage: "test", category }, "Supabase MCP test failed");
    throw new AppError(422, "Supabase MCP test failed (" + category + ")", "MCP_CONNECT_FAILED");
  }
});
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
    const category = safeMcpFailureCategory(err);
    logger.warn({ provider: "supabase", stage: "list_tools", category }, "Supabase MCP validation failed");
    throw new AppError(422, `Could not connect to Supabase MCP (${category})`, "MCP_CONNECT_FAILED");
  }
  if (toolCount === 0) {
    throw new AppError(422, "Connected but the MCP server returned no tools — check the token's scope", "MCP_NO_TOOLS");
  }

  // The project's public URL + anon key. NOT best-effort any more.
  //
  // MEASURED 2026-10-18. A row existed with provider=supabase, status=connected
  // and a config holding NO supabaseUrl and NO anon key — because `projectRef`
  // was absent, so this block never ran, and the row was written as "connected"
  // regardless. The result was the worst shape available: the UI showed the
  // integration as connected, `getUserSupabasePreviewCreds` correctly returned
  // null, and every build logged `ownSupabase=false` and told the person to
  // connect a database they had already connected. Nobody could see why.
  //
  // A Supabase connection that cannot give a preview its URL and anon key does
  // not do the job it was connected for, so it no longer claims to.
  let creds: { url: string | null; anonKey: string | null; error?: string } = { url: null, anonKey: null };
  let credsError: string | null = null;
  if (projectRef) {
    creds = await fetchSupabaseProjectCreds({ accessToken, projectRef }).catch((err: unknown) => {
      credsError = err instanceof Error ? err.message : String(err);
      return creds;
    });
  }
  if (creds.error) credsError = creds.error;
  if (!creds.url || !creds.anonKey) {
    // The token itself is fine — it just listed tools. What is missing is the
    // project, so the message says exactly that and exactly what to do, rather
    // than "connection failed", which would send someone to regenerate a token
    // that was never the problem.
    const why = !projectRef
      ? "no project was selected"
      : credsError
        ? `the project's API settings could not be read (${credsError})`
        : "the project returned no URL or anon key";
    logger.warn({ userId, projectRef, why }, "Supabase MCP connect refused: no preview credentials");
    throw new AppError(
      422,
      `Your token works, but ${why}, so previews cannot use this project yet. ` +
        `Pick the Supabase project you want your apps to use and connect again.`,
      "MCP_NO_PROJECT_CREDS",
    );
  }

  const anonEnc = creds.anonKey ? encrypt(creds.anonKey) : null;
  const now = new Date();
  const id = randomUUID();
  const mcpEnc = encrypt(JSON.stringify({ accessToken, projectRef }));

  const config = {
    projectRef: projectRef ?? undefined,
    supabaseUrl: creds.url ?? undefined,
    // anon key (public) — encrypted at rest too; injected into previews.
    encryptedAnonKey: anonEnc?.encrypted,
    encryptedAnonKeyIv: anonEnc?.iv,
    encryptedAnonKeyTag: anonEnc?.tag,
  };

  await db.transaction(async (tx) => {
    await tx.insert(userMcpConnections).values({
      id: randomUUID(), userId, providerSlug: "supabase",
      encryptedCreds: mcpEnc.encrypted, encryptedCredsIv: mcpEnc.iv, encryptedCredsTag: mcpEnc.tag,
      meta: { projectRef: projectRef ?? "", url: new URL(creds.url!).host }, connectedAt: now,
    }).onConflictDoUpdate({
      target: [userMcpConnections.userId, userMcpConnections.providerSlug],
      set: { encryptedCreds: mcpEnc.encrypted, encryptedCredsIv: mcpEnc.iv, encryptedCredsTag: mcpEnc.tag, meta: { projectRef: projectRef ?? "", url: new URL(creds.url!).host }, connectedAt: now },
    });
    await tx.insert(userIntegrations)
      .values({ id, userId, provider: "supabase", status: "connected", config, lastTestedAt: now, lastError: null, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [userIntegrations.userId, userIntegrations.provider],
        set: { status: "connected", config, lastTestedAt: now, lastError: null, updatedAt: now },
      });
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
    .select({ id: userIntegrations.id, provider: userIntegrations.provider })
    .from(userIntegrations)
    .where(and(eq(userIntegrations.id, id), eq(userIntegrations.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(404, "Integration not found", "NOT_FOUND");

  await db.transaction(async (tx) => {
    await tx.delete(userIntegrations).where(eq(userIntegrations.id, id));
    if (rows[0]?.provider === "supabase") {
      await tx.delete(userMcpConnections).where(and(eq(userMcpConnections.userId, userId), eq(userMcpConnections.providerSlug, "supabase")));
    }
  });

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
/**
 * The Vercel token `deploy_app` needs, read straight from the stored
 * credential.
 *
 * MEASURED 2026-10-21. Vercel's registry entry became `authType: "oauth"` with
 * no credential fields (its MCP server does not accept a static token), and
 * `ActiveMcpServer.authToken` is now null on every path. build.ts built the
 * deploy context from that field, so `deploy_app` could never receive a token
 * again — the tool stayed in the model's list and would have failed for lack of
 * one. The owner's Vercel connection from 16 Oct holds a perfectly good REST
 * token.
 *
 * This is deliberately NOT the MCP auth path: `deployToVercel` talks to
 * Vercel's REST API, where an account token is exactly right, while the MCP
 * server wants OAuth. Two different credentials for two different endpoints —
 * conflating them is what broke this.
 */
export async function getUserVercelDeployToken(userId: string): Promise<string | null> {
  const read = (row: { encryptedCreds: string; encryptedCredsIv: string; encryptedCredsTag: string }): string | null => {
    try {
      const creds = JSON.parse(decrypt({
        encrypted: row.encryptedCreds, iv: row.encryptedCredsIv, tag: row.encryptedCredsTag,
      })) as Record<string, unknown>;
      const inner = unwrapCreds(creds);
      for (const key of ["vercel_token", "token", "accessToken", "oauth_access_token"]) {
        const value = inner[key];
        if (typeof value === "string" && value.trim()) return value.trim();
      }
    } catch {
      logger.warn({ userId, stage: "vercel_token_decrypt" }, "Stored Vercel credential could not be read");
    }
    return null;
  };

  const rows = await db.select().from(userMcpConnections).where(and(
    eq(userMcpConnections.userId, userId), eq(userMcpConnections.providerSlug, "vercel"),
  )).limit(1);
  const row = rows[0];
  if (row) {
    const token = read(row);
    if (token) return token;
  }

  // Older releases stored it in user_integrations. Same reason the MCP server
  // list still reads those: a connection someone made months ago must not stop
  // working because the storage moved.
  const legacy = await db.select().from(userIntegrations).where(and(
    eq(userIntegrations.userId, userId), eq(userIntegrations.provider, "vercel"),
  )).limit(1);
  const cfg = legacy[0]?.config;
  if (cfg?.encryptedCreds && cfg.encryptedCredsIv && cfg.encryptedCredsTag) {
    return read({ encryptedCreds: cfg.encryptedCreds, encryptedCredsIv: cfg.encryptedCredsIv, encryptedCredsTag: cfg.encryptedCredsTag });
  }
  return null;
}

export async function getUserSupabaseMcpAuth(
  userId: string,
): Promise<{ accessToken: string; projectRef?: string } | null> {
  const mcpRows = await db.select().from(userMcpConnections).where(and(
    eq(userMcpConnections.userId, userId), eq(userMcpConnections.providerSlug, "supabase"),
  )).limit(1);
  const mcpRow = mcpRows[0];
  if (mcpRow) {
    try {
      const creds = JSON.parse(decrypt({
        encrypted: mcpRow.encryptedCreds,
        iv: mcpRow.encryptedCredsIv,
        tag: mcpRow.encryptedCredsTag,
      })) as Record<string, unknown>;
      if (typeof creds["accessToken"] === "string") {
        return {
          accessToken: creds["accessToken"],
          ...(typeof creds["projectRef"] === "string" ? { projectRef: creds["projectRef"] } : {}),
        };
      }
    } catch {
      logger.warn({ userId, provider: "supabase", stage: "credential_decrypt" }, "Supabase MCP credential could not be read");
      return null;
    }
  }

  // Legacy Supabase PATs remain readable until their next successful reconnect.
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
  } catch {
    logger.warn({ userId, provider: "supabase", stage: "legacy_credential_decrypt" }, "Failed to decrypt legacy Supabase PAT");
    return null;
  }
}

// ── Custom MCP routes (must be before /mcp/:slug to avoid route collision) ────

const customConnectSchema = z.object({
  name: z.string().min(1, "Name is required"),
  slug: z.string().min(1),
  description: z.string().default(""),
  mcpServerUrl: z.string().min(1).refine(u => u.startsWith("https://"), "URL must start with https://"),
  authType: z.enum(["bearer_token", "api_key", "none"]),
  authHeader: z.string().min(1).max(100).optional(),
  creds: z.object({ token: z.string().optional() }).default({}),
});

// POST /api/integrations/mcp/custom/connect
integrationsRouter.post("/mcp/custom/connect", async (c) => {
  const { id: userId } = c.get("authUser");
  const raw = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const parsed = customConnectSchema.safeParse(raw);
  if (!parsed.success) throw new AppError(400, parsed.error.issues[0]?.message ?? "Validation failed", "VALIDATION_ERROR");

  const { name, slug, description, mcpServerUrl, authType, authHeader, creds } = parsed.data;

  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(slug)) throw new AppError(400, "Custom MCP name is invalid", "VALIDATION_ERROR");
  const resolved = resolveCustomMcpAuth({ url: mcpServerUrl, authType, token: creds.token, headerName: authHeader });
  if (!resolved) throw new AppError(400, "Custom MCP URL or authentication is invalid", "VALIDATION_ERROR");
  const health = await checkMcpServer(resolved);
  if (!health.ok) {
    logger.warn({ provider: "custom", stage: health.stage, category: health.category }, "Custom MCP validation failed");
    throw new AppError(422, `MCP connection failed during ${health.stage} (${health.category})`, "MCP_CONNECT_FAILED");
  }

  const credsBlob = { token: creds.token ?? "", mcpServerUrl: resolved.url, authType, authHeader, name, description };
  const enc = encrypt(JSON.stringify(credsBlob));

  let urlHost = "";
  try { urlHost = new URL(mcpServerUrl).host; } catch { urlHost = mcpServerUrl; }

  const id = randomUUID();
  const now = new Date();
  await db.insert(userMcpConnections).values({
    id,
    userId,
    providerSlug: slug,
    encryptedCreds: enc.encrypted,
    encryptedCredsIv: enc.iv,
    encryptedCredsTag: enc.tag,
    meta: { name, url: urlHost },
    isCustom: true,
    connectedAt: now,
  }).onConflictDoUpdate({
    target: [userMcpConnections.userId, userMcpConnections.providerSlug],
    set: {
      encryptedCreds: enc.encrypted,
      encryptedCredsIv: enc.iv,
      encryptedCredsTag: enc.tag,
      meta: { name, url: urlHost },
      connectedAt: now,
    },
  });

  logger.info({ userId, slug }, "Custom MCP connected");
  return c.json({ slug, status: "connected" }, 201);
});

// GET /api/integrations/mcp/custom — list user's custom MCPs
integrationsRouter.get("/mcp/custom", async (c) => {
  const { id: userId } = c.get("authUser");
  const rows = await db
    .select({
      providerSlug: userMcpConnections.providerSlug,
      meta: userMcpConnections.meta,
      connectedAt: userMcpConnections.connectedAt,
    })
    .from(userMcpConnections)
    .where(and(eq(userMcpConnections.userId, userId), eq(userMcpConnections.isCustom, true)));
  return c.json({ custom: rows.map(r => ({ slug: r.providerSlug, meta: r.meta ?? {}, connectedAt: r.connectedAt })) });
});

// DELETE /api/integrations/mcp/custom/:slug
integrationsRouter.delete("/mcp/custom/:slug", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  await db
    .delete(userMcpConnections)
    .where(and(eq(userMcpConnections.userId, userId), eq(userMcpConnections.providerSlug, slug), eq(userMcpConnections.isCustom, true)));
  return c.json({ success: true });
});

// ── Read-only MCP query route ──────────────────────────────────────────────────
// This endpoint never enters runFastBuild. Its dispatcher mode exposes only
// discovered, conservatively classified read tools and rejects all other tool
// names again at execution time. Frontend errors must not fall through to build.
const mcpQuerySchema = z.object({
  prompt: z.string().trim().min(1).max(6_000),
  projectId: z.string().min(1).max(200).optional(),
});

integrationsRouter.post("/mcp/query", async (c) => {
  const { id: userId } = c.get("authUser");
  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR");
  });
  const parsed = mcpQuerySchema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(400, parsed.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }

  const { prompt, projectId } = parsed.data;
  const intent = classifyMcpQueryIntent(prompt);
  if (!intent.handled) return c.json({ handled: false, reason: intent.reason });

  // Read-only queries consume model budget too; use the same pre-flight gate as
  // builds, then apply a much smaller per-dispatch ceiling.
  await assertHasBudget(userId);

  try {
    const connected = await getConnectedMcpServers(userId);
    const { kept, dropped } = serversForPrompt(prompt, connected);
    const restConnections = await getConnectedRestIntegrations(userId);
    const selectedRest = selectRestConnections(prompt, restConnections, kept.map((server) => server.slug));
    const restQuery = buildRestQueryTools(selectedRest);
    const selectedProviders = [
      ...kept.map((server) => ({ slug: server.slug, name: server.name })),
      ...restQuery.providers,
    ];
    logger.info(
      {
        userId,
        projectId,
        selectedMcpProviders: kept.map((server) => server.slug),
        selectedRestProviders: restQuery.providers.map((provider) => provider.slug),
        droppedMcpProviders: dropped,
        droppedRestProviders: restConnections.filter((connection) => !selectedRest.some((chosen) => chosen.slug === connection.slug)).map((connection) => connection.slug),
        intent: intent.reason,
      },
      "[mcp-query] provider selection",
    );

    if (kept.length === 0 && restQuery.tools.length === 0) {
      return c.json({
        handled: true,
        verified: false,
        answer: "I couldn't find a connected, query-capable provider for this request, so I couldn't verify live service data. No project files were changed.",
        providers: [],
        tools: [],
      });
    }

    const provider: "anthropic" | "modal" =
      config.LLM_PROVIDER_MODE === "openai"
        ? "modal"
        : config.LLM_PROVIDER_MODE === "anthropic"
          ? "anthropic"
          : await getUserPlan(userId)
              .then((plan) => (plan === "free" ? "modal" : "anthropic"))
              .catch(() => "anthropic");

    // Record actual tool executions in order. Arguments and provider responses
    // are deliberately excluded from logs/API diagnostics to avoid leaking data.
    const toolEvents: Array<{ name: string; success?: boolean }> = [];
    const dispatch = await getDispatcher().dispatch({
      agentType: "connection",
      task: { description: prompt, outputFormat: "prose" },
      sessionId: randomUUID(),
      userId,
      ...(projectId ? { projectId } : {}),
      provider,
      enableTools: true,
      costGuard: { cumulativeUsd: 0, maxUsd: 0.15 },
      mcpServers: kept,
      mcpQueryOnly: true,
      mcpQueryTools: restQuery.tools,
      mcpQueryExecutors: restQuery.executors,
      userPrompt: prompt,
      onEvent: (event) => {
        const record = event as unknown as Record<string, unknown>;
        if (record.type === "tool/call" && typeof record.name === "string") {
          toolEvents.push({ name: record.name });
        } else if (record.type === "tool/result" && typeof record.name === "string") {
          for (let index = toolEvents.length - 1; index >= 0; index--) {
            if (toolEvents[index]?.name === record.name && toolEvents[index]?.success === undefined) {
              toolEvents[index]!.success = record.ok === true;
              break;
            }
          }
        }
      },
    });

    // Only names tied to a selected provider are shown as MCP tool activity;
    // the dispatcher additionally guarantees that only its read registry ran.
    const providerSlugs = new Set(selectedProviders.map((provider) => provider.slug));
    const tools = toolEvents
      .filter((event) => [...providerSlugs].some((slug) => event.name.startsWith(slug + "__")))
      .map((event) => {
        const separator = event.name.indexOf("__");
        const slug = separator > 0 ? event.name.slice(0, separator) : "";
        return {
          name: event.name.slice(separator + 2),
          provider: slug,
          success: event.success === true,
        };
      });
    const verified = tools.some((tool) => tool.success);
    const answer = verified
      ? (dispatch.finalContent.trim() || dispatch.content.trim() || "The provider returned live data, but the model did not produce a summary.")
      : "I couldn't verify current service data because no read-only MCP tool completed successfully. No project files were changed and no external write action was performed."; 

    logger.info(
      {
        userId,
        projectId,
        providers: selectedProviders.map((provider) => provider.slug),
        tools: tools.map(({ provider: slug, name, success }) => ({ provider: slug, name, success })),
        verified,
        rounds: dispatch.rounds,
      },
      "[mcp-query] completed",
    );

    return c.json({
      handled: true,
      verified,
      answer,
      providers: selectedProviders,
      tools,
    });
  } catch (err) {
    logger.warn(
      { userId, projectId, category: safeMcpFailureCategory(err) },
      "[mcp-query] unable to verify service data",
    );
    return c.json({
      handled: true,
      verified: false,
      answer: "I couldn't verify live service data because the connected-service query failed. No project files were changed and no external write action was performed. Check the provider connection and try again.",
      providers: [],
      tools: [],
    });
  }
});

// ── Existing REST/API catalogue providers ──────────────────────────────────────
// These adapters are not MCP servers. They verify a provider-specific,
// non-mutating API call and store credentials in the same per-user encrypted
// connection table. Provider-specific adapters never accept arbitrary URLs
// from the model; only WordPress uses a user-supplied public HTTPS site URL.

integrationsRouter.post("/rest/:slug/test", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  if (!REST_PROVIDER_SLUGS.includes(slug as RestProviderSlug)) throw new AppError(404, "Unknown REST integration", "UNKNOWN_PROVIDER");
  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR"); });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Invalid credential object", "VALIDATION_ERROR");
  const creds = unwrapCreds(body as Record<string, unknown>);
  const result = await testRestConnection(slug, creds);
  if (!result.ok) throw new AppError(422, result.error ?? "REST connection test failed", "REST_CONNECT_FAILED");
  logger.info({ userId, slug, stage: "test", verified: true }, "REST integration credentials verified");
  return c.json({ slug, status: "verified", meta: result.meta });
});

integrationsRouter.post("/rest/:slug/connect", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  if (!REST_PROVIDER_SLUGS.includes(slug as RestProviderSlug)) throw new AppError(404, "Unknown REST integration", "UNKNOWN_PROVIDER");
  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR"); });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Invalid credential object", "VALIDATION_ERROR");
  const creds = unwrapCreds(body as Record<string, unknown>);
  const result = await testRestConnection(slug, creds);
  if (!result.ok) throw new AppError(422, result.error ?? "REST connection test failed", "REST_CONNECT_FAILED");
  const parsed = parseRestConnection(slug, creds, result.meta);
  if (!parsed) throw new AppError(422, "The credentials did not match this provider's supported fields", "REST_CREDENTIALS_INVALID");
  const enc = encrypt(JSON.stringify(parsed.credentials));
  await db.insert(userMcpConnections).values({
    id: randomUUID(), userId, providerSlug: parsed.slug,
    encryptedCreds: enc.encrypted, encryptedCredsIv: enc.iv, encryptedCredsTag: enc.tag,
    meta: result.meta, isCustom: false, connectedAt: new Date(),
  }).onConflictDoUpdate({
    target: [userMcpConnections.userId, userMcpConnections.providerSlug],
    set: {
      encryptedCreds: enc.encrypted, encryptedCredsIv: enc.iv, encryptedCredsTag: enc.tag,
      meta: result.meta, isCustom: false, connectedAt: new Date(),
    },
  });
  logger.info({ userId, slug, verified: true }, "REST integration connected");
  return c.json({ slug, status: "connected", meta: result.meta }, 201);
});

integrationsRouter.delete("/rest/:slug", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  if (!REST_PROVIDER_SLUGS.includes(slug as RestProviderSlug)) throw new AppError(404, "Unknown REST integration", "UNKNOWN_PROVIDER");
  await db.delete(userMcpConnections).where(and(
    eq(userMcpConnections.userId, userId),
    eq(userMcpConnections.providerSlug, slug),
    eq(userMcpConnections.isCustom, false),
  ));
  // Remove legacy records stored by the earlier generic integration route.
  if (slug === "wordpress") await db.delete(userIntegrations).where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, "wordpress")));
  if (slug === "shopify") await db.delete(userIntegrations).where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, "shopify")));
  if (slug === "railway") await db.delete(userIntegrations).where(and(eq(userIntegrations.userId, userId), eq(userIntegrations.provider, "railway")));
  return c.json({ success: true });
});

// ── MCP Provider routes ────────────────────────────────────────────────────────

integrationsRouter.post("/mcp/:slug/oauth/start", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  const provider = getMcpProvider(slug);
  if (!provider || !provider.supportsRealMCP) throw new AppError(404, "Unknown MCP provider", "UNKNOWN_PROVIDER");
  if (provider.authType !== "oauth") throw new AppError(400, "This provider does not use OAuth", "AUTH_METHOD_MISMATCH");
  const redirectUrl = oauthCallbackUrl();
  const serverUrl = resolveServerUrl(provider, {});
  if (!serverUrl) throw new AppError(422, "Provider MCP URL is not configured", "INVALID_MCP_URL");

  const transactionId = randomUUID();
  const initial = encryptOAuthSession({});
  await db.insert(mcpOAuthTransactions).values({
    id: transactionId,
    userId,
    providerSlug: slug,
    serverUrl,
    stateHash: hashOAuthState(randomUUID()),
    encryptedData: initial.encrypted,
    encryptedDataIv: initial.iv,
    encryptedDataTag: initial.tag,
    expiresAt: new Date(Date.now() + OAUTH_PENDING_TTL_MS),
  });

  const session: McpOAuthSession = {};
  const saveSession = async (value: McpOAuthSession) => {
    const enc = encryptOAuthSession(value);
    await db.update(mcpOAuthTransactions).set({
      encryptedData: enc.encrypted,
      encryptedDataIv: enc.iv,
      encryptedDataTag: enc.tag,
    }).where(eq(mcpOAuthTransactions.id, transactionId));
  };
  const oauth = createMcpOAuthProvider({
    serverUrl,
    redirectUrl,
    session,
    persist: saveSession,
    saveStateHash: async (stateHash) => {
      await db.update(mcpOAuthTransactions).set({ stateHash }).where(eq(mcpOAuthTransactions.id, transactionId));
    },
  });
  const client = new Client({ name: "lampcode-oauth-connect", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), { authProvider: oauth.provider, fetch: secureMcpFetch, redirectPolicy: "same-origin" });
  try {
    // The MCP SDK performs protected-resource discovery, client registration,
    // state and PKCE generation. Redirect interception returns control to the UI.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);
    const { tools } = await client.listTools();
    if (tools.length === 0) throw new Error("empty_tool_list");
    // Public MCP tools may be discoverable without authentication. That alone
    // must not create a green authenticated OAuth connection.
    if (!session.tokens?.access_token) throw new Error("oauth_token_missing");
    const enc = encrypt(JSON.stringify({ ...session, oauth_access_token: session.tokens.access_token }));
    await db.insert(userMcpConnections).values({
      id: randomUUID(), userId, providerSlug: slug,
      encryptedCreds: enc.encrypted, encryptedCredsIv: enc.iv, encryptedCredsTag: enc.tag,
      meta: { auth: "OAuth", url: new URL(serverUrl).host }, connectedAt: new Date(),
    }).onConflictDoUpdate({
      target: [userMcpConnections.userId, userMcpConnections.providerSlug],
      set: { encryptedCreds: enc.encrypted, encryptedCredsIv: enc.iv, encryptedCredsTag: enc.tag, meta: { auth: "OAuth", url: new URL(serverUrl).host }, connectedAt: new Date() },
    });
    await db.delete(mcpOAuthTransactions).where(eq(mcpOAuthTransactions.id, transactionId));
    return c.json({ slug, status: "connected", toolCount: tools.length }, 201);
  } catch {
    const authorizationUrl = oauth.authorizationUrl();
    if (authorizationUrl) return c.json({ slug, status: "authorization_required", authorizationUrl: authorizationUrl.toString() }, 200);
    await db.delete(mcpOAuthTransactions).where(eq(mcpOAuthTransactions.id, transactionId));
    logger.warn({ provider: slug, category: "oauth_start_failed" }, "MCP OAuth start failed");
    throw new AppError(422, "The provider could not start MCP authorization", "OAUTH_START_FAILED");
  } finally {
    await client.close().catch(() => undefined);
  }
});

function mcpOAuthReturnUrl(status: "connected" | "error", provider?: string, reason?: string): string {
  const target = new URL("/mcp", config.FRONTEND_URL ?? config.FRONTEND_ORIGIN);
  target.searchParams.set("mcp_oauth", status);
  if (provider) target.searchParams.set("provider", provider);
  if (reason) target.searchParams.set("reason", reason);
  return target.toString();
}

mcpOAuthCallbackRouter.get("/mcp/oauth/callback", async (c) => {
  const state = c.req.query("state");
  const code = c.req.query("code");
  if (!state) return c.redirect(mcpOAuthReturnUrl("error", undefined, "invalid_state"), 302);
  const now = new Date();
  const rows = await db.delete(mcpOAuthTransactions).where(and(
    eq(mcpOAuthTransactions.stateHash, hashOAuthState(state)),
    gt(mcpOAuthTransactions.expiresAt, now),
  )).returning();
  const pending = rows[0];
  if (!pending) return c.redirect(mcpOAuthReturnUrl("error", undefined, "invalid_state"), 302);
  if (c.req.query("error") || !code) return c.redirect(mcpOAuthReturnUrl("error", undefined, "cancelled"), 302);
  const provider = getMcpProvider(pending.providerSlug);
  if (!provider || provider.authType !== "oauth") return c.redirect(mcpOAuthReturnUrl("error", pending.providerSlug, "provider_unavailable"), 302);
  const session = decryptOAuthSession(pending);
  const redirectUrl = oauthCallbackUrl();
  const oauth = createMcpOAuthProvider({
    serverUrl: pending.serverUrl,
    redirectUrl,
    session,
    persist: async () => undefined,
    saveStateHash: async () => undefined,
  });
  const client = new Client({ name: "lampcode-oauth-callback", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(pending.serverUrl), { authProvider: oauth.provider, fetch: secureMcpFetch, redirectPolicy: "same-origin" });
  try {
    await transport.finishAuth(code);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);
    const { tools } = await client.listTools();
    if (tools.length === 0 || !session.tokens?.access_token) {
      return c.redirect(mcpOAuthReturnUrl("error", pending.providerSlug, "no_tools"), 302);
    }
    const enc = encrypt(JSON.stringify({ ...session, oauth_access_token: session.tokens.access_token }));
    await db.insert(userMcpConnections).values({
      id: randomUUID(), userId: pending.userId, providerSlug: pending.providerSlug,
      encryptedCreds: enc.encrypted, encryptedCredsIv: enc.iv, encryptedCredsTag: enc.tag,
      meta: { auth: "OAuth", url: new URL(pending.serverUrl).host }, connectedAt: new Date(),
    }).onConflictDoUpdate({
      target: [userMcpConnections.userId, userMcpConnections.providerSlug],
      set: { encryptedCreds: enc.encrypted, encryptedCredsIv: enc.iv, encryptedCredsTag: enc.tag, meta: { auth: "OAuth", url: new URL(pending.serverUrl).host }, connectedAt: new Date() },
    });
    return c.redirect(mcpOAuthReturnUrl("connected", pending.providerSlug), 302);
  } catch {
    logger.warn({ provider: pending.providerSlug, category: "oauth_callback_failed" }, "MCP OAuth callback failed");
    return c.redirect(mcpOAuthReturnUrl("error", undefined, "authorization_failed"), 302);
  } finally {
    await client.close().catch(() => undefined);
  }
});

// Test provider credentials and perform authenticated initialize + tools/list.
// This route is deliberately non-persistent; tests must never overwrite a good connection.
integrationsRouter.post("/mcp/:slug/test", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  const provider = getMcpProvider(slug);
  if (!provider || !provider.supportsRealMCP) throw new AppError(404, "Unknown remote MCP provider", "UNKNOWN_PROVIDER");
  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON body", "VALIDATION_ERROR"); });
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError(400, "Invalid credentials object", "VALIDATION_ERROR");
  const creds = unwrapCreds(body as Record<string, unknown>);
  if (provider.authType === "oauth") {
    // Test the already-authorized, per-user OAuth session without accepting an
    // arbitrary token in the form or saving a new connection as a side effect.
    const active = (await getConnectedMcpServers(userId)).find((server) => server.slug === slug);
    const session = active?.oauthSession;
    if (!active || !session?.tokens?.access_token || !active.oauthRedirectUrl) {
      throw new AppError(422, "Connect this provider with OAuth before testing it.", "OAUTH_REQUIRED");
    }
    const oauth = createMcpOAuthProvider({
      serverUrl: active.url,
      redirectUrl: active.oauthRedirectUrl,
      session,
      persist: active.persistOAuthSession ?? (async () => undefined),
      saveStateHash: async () => undefined,
    });
    const oauthClient = new Client({ name: "lampcode-oauth-test", version: "1.0.0" });
    const oauthTransport = new StreamableHTTPClientTransport(new URL(active.url), {
      authProvider: oauth.provider,
      fetch: secureMcpFetch,
      redirectPolicy: "same-origin",
    });
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await oauthClient.connect(oauthTransport as any);
      const { tools } = await oauthClient.listTools();
      if (tools.length === 0) throw new AppError(422, "OAuth authorized but the MCP server returned no tools.", "MCP_NO_TOOLS");
      logger.info({ userId, provider: slug, stage: "oauth_test", toolCount: tools.length }, "OAuth MCP connection test passed");
      return c.json({ slug, status: "verified", toolCount: tools.length });
    } catch (error) {
      if (error instanceof AppError) throw error;
      const category = safeMcpFailureCategory(error);
      logger.warn({ userId, provider: slug, stage: "oauth_test", category }, "OAuth MCP test failed");
      throw new AppError(422, "OAuth MCP test failed (" + category + "). Reconnect if authorization has expired.", "MCP_CONNECT_FAILED");
    } finally {
      await oauthClient.close().catch(() => undefined);
    }
  }
  const resolved = resolveMcpAuth(provider, creds);
  if (!resolved) throw new AppError(422, "Provider credentials or MCP endpoint are incomplete", "MCP_CREDENTIALS_INCOMPLETE");
  const health = await checkMcpServer(resolved);
  if (!health.ok) {
    logger.warn({ userId, provider: slug, stage: health.stage, category: health.category }, "MCP credentials test failed");
    throw new AppError(422, "MCP test failed during " + health.stage + " (" + health.category + ")", "MCP_CONNECT_FAILED");
  }
  logger.info({ userId, provider: slug, stage: "test", toolCount: health.toolCount }, "MCP credentials test passed");
  return c.json({ slug, status: "verified", toolCount: health.toolCount });
});
// POST /api/integrations/mcp/:slug/connect
integrationsRouter.post("/mcp/:slug/connect", async (c) => {
  const { id: userId } = c.get("authUser");
  const slug = c.req.param("slug");
  const provider = getMcpProvider(slug);
  if (!provider) throw new AppError(404, `Unknown provider: ${slug}`, "UNKNOWN_PROVIDER");

  const body = await c.req.json().catch(() => {
    throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR");
  }) as Record<string, unknown>;

  // Normalise before storing so new rows never carry the envelope that made
  // the owner's GitHub connection invisible to every build.
  const creds = unwrapCreds(body);

  if (provider.authType === "oauth") {
    throw new AppError(400, "Start the provider's OAuth flow instead", "OAUTH_REQUIRED");
  }

  const resolved = resolveMcpAuth(provider, creds);
  if (!resolved) throw new AppError(422, "Provider credentials or MCP endpoint are incomplete", "MCP_CREDENTIALS_INCOMPLETE");
  const health = await checkMcpServer(resolved);
  if (!health.ok) {
    logger.warn({ provider: slug, stage: health.stage, category: health.category }, "MCP provider validation failed");
    throw new AppError(422, `MCP connection failed during ${health.stage} (${health.category})`, "MCP_CONNECT_FAILED");
  }

  // Encrypt all creds as one blob
  const enc = encrypt(JSON.stringify(creds));

  // Extract non-secret display fields
  const meta: Record<string, string> = {};
  for (const field of provider.credentialFields) {
    if (field.type === "password") continue;
    const v = creds[field.key];
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
  return c.json({ slug, status: "connected", toolCount: health.toolCount, meta }, 201);
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
  /** null for mcp_url authType — the token is already embedded in the URL */
  authToken: string | null;
  /** Fully resolved auth headers shared by discovery and local execution. */
  authHeaders?: Record<string, string> | undefined;
  oauthSession?: McpOAuthSession | undefined;
  persistOAuthSession?: ((session: McpOAuthSession) => Promise<void>) | undefined;
  oauthRedirectUrl?: string | undefined;
}

/**
 * Returns all connected MCP providers for a user with decrypted creds,
 * ready to pass directly to Anthropic's beta mcp_servers param.
 * Only returns providers that supportsRealMCP = true AND have a resolvable URL.
 *
 * For mcp_url authType the token is embedded in the URL — authToken is null.
 */
/**
 * Unwrap a `{ creds: { ... } }` envelope.
 *
 * The connect handler encrypts the request body verbatim, and a client that
 * posts `{ creds: { github_token: "..." } }` instead of `{ github_token: "..." }`
 * therefore stores the envelope. Measured on 2026-10-04: the owner's GitHub
 * connection had `storedKeys: ["creds"]` while the registry expected
 * `github_token`, so every lookup missed and the server silently never reached
 * a build — connected in the UI, absent from every dispatch.
 *
 * Unwrapping on READ fixes rows already stored, which matters because the
 * alternative is asking every affected user to reconnect. No provider declares
 * a credential field named `creds`, so a lone `creds` key holding an object is
 * unambiguously the envelope and never a real credential.
 */
function unwrapCreds(parsed: Record<string, unknown>): Record<string, string> {
  const keys = Object.keys(parsed);
  const inner = parsed["creds"];
  if (keys.length === 1 && keys[0] === "creds" && inner !== null && typeof inner === "object") {
    return inner as Record<string, string>;
  }
  return parsed as Record<string, string>;
}

export async function getConnectedMcpServers(userId: string): Promise<ActiveMcpServer[]> {
  const rows = await db
    .select()
    .from(userMcpConnections)
    .where(eq(userMcpConnections.userId, userId));

  const servers: ActiveMcpServer[] = [];

  for (const row of rows) {
    try {
      const creds = unwrapCreds(
        JSON.parse(
          decrypt({
            encrypted: row.encryptedCreds,
            iv: row.encryptedCredsIv,
            tag: row.encryptedCredsTag,
          }),
        ) as Record<string, unknown>,
      );

      // Custom MCPs: metadata is stored in encrypted creds
      if (row.isCustom) {
        const url = creds["mcpServerUrl"];
        if (!url) continue;
        const resolved = resolveCustomMcpAuth({
          url,
          authType: creds["authType"],
          token: creds["token"],
          headerName: creds["authHeader"],
        });
        if (!resolved) continue;
        servers.push({
          slug: row.providerSlug,
          name: creds["name"] ?? row.providerSlug,
          url: resolved.url,
          authToken: null,
          authHeaders: resolved.headers,
        });
        continue;
      }

      const provider = getMcpProvider(row.providerSlug);
      if (!provider) {
        logger.warn({ userId, slug: row.providerSlug }, "[mcp] connected provider is not in the registry — skipped");
        continue;
      }
      if (!provider.supportsRealMCP) {
        logger.info({ userId, slug: row.providerSlug }, "[mcp] provider is REST-only, not an MCP server — skipped");
        continue;
      }

      const resolved = resolveMcpAuth(provider, creds);
      if (!resolved) {
        logger.warn({ userId, slug: row.providerSlug }, "[mcp] could not resolve a server URL — skipped");
        continue;
      }
      const isOAuth = provider.authType === "oauth";
      servers.push({
        slug: row.providerSlug,
        name: provider.name,
        url: resolved.url,
        authToken: null,
        authHeaders: isOAuth ? {} : resolved.headers,
        ...(isOAuth ? {
          oauthSession: creds as McpOAuthSession,
          oauthRedirectUrl: config.MCP_OAUTH_REDIRECT_URL,
          persistOAuthSession: async (session: McpOAuthSession) => {
            const enc = encrypt(JSON.stringify({ ...session, oauth_access_token: session.tokens?.access_token }));
            await db.update(userMcpConnections).set({
              encryptedCreds: enc.encrypted,
              encryptedCredsIv: enc.iv,
              encryptedCredsTag: enc.tag,
            }).where(eq(userMcpConnections.id, row.id));
          },
        } : {}),
      });
    } catch (err) {
      logger.warn({ userId, slug: row.providerSlug, err }, "Failed to decrypt MCP creds");
    }
  }

  // Older releases stored some provider credentials in user_integrations.
  // Keep those connections usable, while the MCP table wins when both exist.
  const resolvedSlugs = new Set(servers.map((server) => server.slug));
  const legacyRows = await db.select().from(userIntegrations).where(eq(userIntegrations.userId, userId));
  for (const row of legacyRows) {
    if (row.status !== "connected" || resolvedSlugs.has(row.provider)) continue;
    const provider = getMcpProvider(row.provider);
    const cfg = row.config;
    if (!provider?.supportsRealMCP || !cfg.encryptedCreds || !cfg.encryptedCredsIv || !cfg.encryptedCredsTag) continue;
    try {
      const creds = JSON.parse(decrypt({ encrypted: cfg.encryptedCreds, iv: cfg.encryptedCredsIv, tag: cfg.encryptedCredsTag })) as Record<string, string>;
      const resolved = resolveMcpAuth(provider, creds);
      if (!resolved) continue;
      servers.push({ slug: row.provider, name: provider.name, url: resolved.url, authToken: null, authHeaders: resolved.headers });
      resolvedSlugs.add(row.provider);
    } catch {
      logger.warn({ userId, provider: row.provider, stage: "legacy_credential_decrypt" }, "Legacy MCP credential could not be read");
    }
  }

  logger.info(
    { userId, resolved: servers.map((s) => s.slug), rows: rows.length },
    "[mcp] connected servers resolved for this request",
  );
  return servers;
}

