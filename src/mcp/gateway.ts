import { and, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import {
  integrations,
  type McpProvider as DbMcpProvider,
  type IntegrationCredentials as DbCreds,
} from "../db/schema.js";
import { logger } from "../server/logger.js";
import {
  McpError,
  TIER_FALLBACK_ERRORS,
  type McpProvider,
  type ConnectionTier,
  type ConnectionResult,
  type ToolResult,
  type IProvider,
  type IntegrationCredentials,
} from "./types.js";
import { VercelProvider }   from "./providers/vercel.js";
import { SupabaseProvider } from "./providers/supabase.js";
import { GithubProvider }   from "./providers/github.js";
import { RailwayProvider }  from "./providers/railway.js";

// ── Provider registry ─────────────────────────────────────────────────────────

const PROVIDERS = new Map<McpProvider, IProvider>([
  ["vercel",   new VercelProvider()],
  ["supabase", new SupabaseProvider()],
  ["github",   new GithubProvider()],
  ["railway",  new RailwayProvider()],
]);

// ── Proxy credentials (Tier 2) read from environment ─────────────────────────

function getProxyCreds(provider: McpProvider): IntegrationCredentials | null {
  const token = process.env[`${provider.toUpperCase()}_PROXY_TOKEN`]
    ?? process.env[`${provider.toUpperCase()}_PROXY_KEY`];
  return token ? { token } : null;
}

// ── McpGateway ────────────────────────────────────────────────────────────────

export class McpGateway {
  // ── Connect ────────────────────────────────────────────────────────────────

  /**
   * Test the connection and persist the integration.
   * Uses the provider's testConnection (Tier 1) first; falls back to noting
   * a proxy is available (Tier 2) if the user's token is missing.
   */
  async connect(
    projectId: string,
    userId: string,
    provider: McpProvider,
    credentials: IntegrationCredentials,
  ): Promise<ConnectionResult> {
    const impl = this.provider(provider);
    const t0 = Date.now();

    let tier: ConnectionTier = 1;
    let ok = false;
    let detail: string | undefined;

    // Tier 1: test user's own credentials
    if (credentials.token ?? credentials.apiKey) {
      const result = await impl.testConnection(credentials);
      ok = result.ok;
      detail = result.detail;
      if (!ok) {
        // Tier 2: check if proxy is available
        const proxyCreds = getProxyCreds(provider);
        if (proxyCreds) {
          const proxyResult = await impl.testConnection(proxyCreds);
          if (proxyResult.ok) { tier = 2; ok = true; detail = `(via proxy) ${proxyResult.detail ?? ""}`; }
        }
      }
    } else {
      // No user token — try proxy or fall to Tier 3
      const proxyCreds = getProxyCreds(provider);
      if (proxyCreds) {
        const result = await impl.testConnection(proxyCreds);
        ok = result.ok;
        tier = 2;
        detail = `(via proxy) ${result.detail ?? ""}`;
      } else {
        tier = 3;
        ok = true; // Tier 3 always "connects" — CLI fallback is always available
        detail = "CLI fallback mode — no credentials stored";
      }
    }

    // Upsert integration record
    await this.upsertIntegration(projectId, userId, provider, credentials, tier, ok ? "connected" : "error", ok ? undefined : detail);

    logger.info({ projectId, provider, tier, ok }, "MCP integration connected");
    return { ok, tier, provider, latencyMs: Date.now() - t0, detail };
  }

  // ── Disconnect ─────────────────────────────────────────────────────────────

  async disconnect(projectId: string, provider: McpProvider): Promise<void> {
    await db
      .update(integrations)
      .set({ status: "disconnected", config: {}, updatedAt: new Date() })
      .where(
        and(
          eq(integrations.projectId, projectId),
          eq(integrations.provider, provider as DbMcpProvider),
        ),
      );
    logger.info({ projectId, provider }, "MCP integration disconnected");
  }

  // ── Test connection ────────────────────────────────────────────────────────

  async testConnection(projectId: string, provider: McpProvider): Promise<ConnectionResult> {
    const impl = this.provider(provider);
    const integration = await this.loadIntegration(projectId, provider);
    const creds = (integration?.config ?? {}) as IntegrationCredentials;
    const t0 = Date.now();

    const result = await impl.testConnection(creds);
    const latencyMs = Date.now() - t0;

    if (integration) {
      await db
        .update(integrations)
        .set({
          status: result.ok ? "connected" : "error",
          lastTestedAt: new Date(),
          error: result.ok ? undefined : (result.detail ?? null),
          updatedAt: new Date(),
        })
        .where(eq(integrations.id, integration.id));
    }

    return { ok: result.ok, tier: 1 as ConnectionTier, provider, latencyMs, detail: result.detail };
  }

  // ── Execute tool ───────────────────────────────────────────────────────────

  /**
   * 3-tier tool execution:
   *   Tier 1 — user's own credentials (direct API call)
   *   Tier 2 — BuildForge proxy credentials (env vars)
   *   Tier 3 — return CLI commands the user can run manually
   */
  async executeTool(
    projectId: string,
    provider: McpProvider,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const impl = this.provider(provider);
    const integration = await this.loadIntegration(projectId, provider);
    const userCreds = (integration?.config ?? {}) as IntegrationCredentials;

    // ── Tier 1: user's credentials ────────────────────────────────────────
    if (userCreds.token ?? userCreds.apiKey) {
      try {
        const data = await impl.executeTool(toolName, args, userCreds);
        await this.markTier(integration?.id, 1);
        logger.info({ projectId, provider, toolName, tier: 1 }, "Tool executed (Tier 1)");
        return { success: true, tier: 1, data };
      } catch (err) {
        if (err instanceof McpError && TIER_FALLBACK_ERRORS.has(err.type)) {
          logger.warn({ projectId, provider, toolName, err: err.message }, "Tier 1 failed, trying Tier 2");
        } else {
          // Non-retriable error (wrong args, tool not found, etc.)
          const msg = err instanceof Error ? err.message : String(err);
          return { success: false, tier: 1, data: {}, error: msg };
        }
      }
    }

    // ── Tier 2: proxy credentials ─────────────────────────────────────────
    const proxyCreds = getProxyCreds(provider);
    if (proxyCreds) {
      try {
        const data = await impl.executeTool(toolName, args, proxyCreds);
        await this.markTier(integration?.id, 2);
        logger.info({ projectId, provider, toolName, tier: 2 }, "Tool executed (Tier 2 proxy)");
        return { success: true, tier: 2, data };
      } catch (err) {
        logger.warn({ projectId, provider, toolName, err: err instanceof Error ? err.message : err }, "Tier 2 failed, falling back to Tier 3");
      }
    }

    // ── Tier 3: CLI commands ──────────────────────────────────────────────
    const cliCommands = impl.cliCommands(toolName, args);
    await this.markTier(integration?.id, 3);
    logger.info({ projectId, provider, toolName, tier: 3 }, "Returning CLI commands (Tier 3)");
    return { success: true, tier: 3, data: {}, cliCommands };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private provider(name: McpProvider): IProvider {
    const p = PROVIDERS.get(name);
    if (!p) throw new Error(`Unknown provider: ${name}`);
    return p;
  }

  private async loadIntegration(projectId: string, provider: McpProvider) {
    const rows = await db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.projectId, projectId),
          eq(integrations.provider, provider as DbMcpProvider),
          eq(integrations.status, "connected"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  }

  private async upsertIntegration(
    projectId: string,
    userId: string,
    provider: McpProvider,
    credentials: IntegrationCredentials,
    tier: ConnectionTier,
    status: "connected" | "error",
    error?: string | undefined,
  ) {
    const existing = await db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.projectId, projectId),
          eq(integrations.provider, provider as DbMcpProvider),
        ),
      )
      .limit(1);

    const now = new Date();
    if (existing[0]) {
      await db
        .update(integrations)
        .set({
          config: credentials as DbCreds,
          status,
          lastError: error ?? null,
          updatedAt: now,
        })
        .where(eq(integrations.id, existing[0].id));
    } else {
      await db.insert(integrations).values({
        id: crypto.randomUUID(),
        projectId,
        userId,
        provider: provider as DbMcpProvider,
        config: credentials as DbCreds,
        status,
        lastError: error ?? null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }

  private async markTier(_integrationId: string | undefined, _tier: ConnectionTier) {
    // tier is no longer persisted separately; connection_type is set during upsert
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _gateway: McpGateway | null = null;

export function getGateway(): McpGateway {
  if (_gateway === null) _gateway = new McpGateway();
  return _gateway;
}
