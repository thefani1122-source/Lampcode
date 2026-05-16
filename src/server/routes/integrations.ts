/**
 * Integration management routes.
 * Supersedes the integrationsRouter from deploy.ts — that export is kept only
 * for the legacy /execute endpoint consumed by the pipeline internally.
 *
 * Mounts:
 *   /api/projects/:id/integrations  (integrationsRouter)
 *   /api/integrations               (providersRouter)
 */

import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db } from "../../db/client.js";
import { projects, integrations } from "../../db/schema.js";
import { requireAuth } from "../../auth/middleware.js";
import { AppError } from "../middleware/error-handler.js";
import { getGateway } from "../../mcp/gateway.js";
import { type McpProvider } from "../../mcp/types.js";

// ── Provider catalogue ────────────────────────────────────────────────────────

interface ProviderInfo {
  id: McpProvider;
  name: string;
  description: string;
  authFields: string[];       // credential keys the user must supply
  tier2Available: boolean;    // BuildForge proxy token exists in env
  docsUrl: string;
}

const MCP_PROVIDERS: McpProvider[] = ["vercel", "supabase", "github", "railway"];

function buildProviderCatalogue(): ProviderInfo[] {
  return [
    {
      id: "vercel",
      name: "Vercel",
      description: "Deploy your frontend and serverless functions to Vercel.",
      authFields: ["token", "teamId"],
      tier2Available: Boolean(process.env["VERCEL_PROXY_TOKEN"]),
      docsUrl: "https://vercel.com/docs/rest-api",
    },
    {
      id: "supabase",
      name: "Supabase",
      description: "PostgreSQL database with auth, realtime, and storage.",
      authFields: ["apiKey", "projectRef"],
      tier2Available: Boolean(process.env["SUPABASE_PROXY_TOKEN"]),
      docsUrl: "https://supabase.com/docs/reference/api",
    },
    {
      id: "github",
      name: "GitHub",
      description: "Host your code and trigger CI/CD workflows.",
      authFields: ["token", "orgId", "repoOwner"],
      tier2Available: Boolean(process.env["GITHUB_PROXY_TOKEN"]),
      docsUrl: "https://docs.github.com/rest",
    },
    {
      id: "railway",
      name: "Railway",
      description: "Deploy backend services and databases on Railway.",
      authFields: ["token", "serviceId"],
      tier2Available: Boolean(process.env["RAILWAY_PROXY_TOKEN"]),
      docsUrl: "https://docs.railway.app/reference/public-api",
    },
  ];
}

// ── Validation ────────────────────────────────────────────────────────────────

const PROVIDER_ENUM = ["vercel", "supabase", "github", "railway"] as const;

const credentialsSchema = z.object({
  token:      z.string().min(1).optional(),
  apiKey:     z.string().min(1).optional(),
  teamId:     z.string().optional(),
  orgId:      z.string().optional(),
  projectRef: z.string().optional(),
  serviceId:  z.string().optional(),
  repoOwner:  z.string().optional(),
});

const executeBodySchema = z.object({
  toolName: z.string().min(1),
  args:     z.record(z.string(), z.unknown()).default({}),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function requireProjectOwner(projectId: string, userId: string) {
  const rows = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
    .limit(1);
  if (!rows[0]) throw new AppError(403, "Not authorized", "FORBIDDEN");
}

function parseProvider(raw: string | undefined): McpProvider {
  const r = z.enum(PROVIDER_ENUM).safeParse(raw ?? "");
  if (!r.success) {
    throw new AppError(
      400,
      `Invalid provider '${raw ?? ""}'. Must be one of: ${PROVIDER_ENUM.join(", ")}`,
      "VALIDATION_ERROR",
    );
  }
  return r.data;
}

function parseBody<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new AppError(400, r.error.issues.map((i) => i.message).join("; "), "VALIDATION_ERROR");
  }
  return r.data;
}

// ── Per-project integrations router ──────────────────────────────────────────
// Mounted at /api/projects/:id/integrations

export const integrationsRouter = new Hono();
integrationsRouter.use("/*", requireAuth);

// GET /api/projects/:id/integrations
integrationsRouter.get("/", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const rows = await db
    .select({
      id:             integrations.id,
      provider:       integrations.provider,
      status:         integrations.status,
      tier:           integrations.tier,
      lastTestedAt:   integrations.lastTestedAt,
      lastDeployedAt: integrations.lastDeployedAt,
      error:          integrations.error,
      createdAt:      integrations.createdAt,
    })
    .from(integrations)
    .where(eq(integrations.projectId, projectId));

  // Annotate each with provider catalogue info
  const catalogue = buildProviderCatalogue();
  const enriched = rows.map((r) => {
    const info = catalogue.find((p) => p.id === r.provider);
    return { ...r, name: info?.name, tier2Available: info?.tier2Available };
  });

  return c.json({ projectId, integrations: enriched });
});

// POST /api/projects/:id/integrations/:provider/connect
integrationsRouter.post("/:provider/connect", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider"));
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const credentials = parseBody(credentialsSchema, body.credentials ?? body);

  const gateway = getGateway();
  const result = await gateway.connect(projectId, authUser.id, provider, credentials);

  return c.json(result, result.ok ? 201 : 200);
});

// POST /api/projects/:id/integrations/:provider/test
integrationsRouter.post("/:provider/test", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider"));
  const result = await getGateway().testConnection(projectId, provider);
  return c.json(result);
});

// DELETE /api/projects/:id/integrations/:provider
integrationsRouter.delete("/:provider", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider"));
  await getGateway().disconnect(projectId, provider);
  return c.json({ ok: true, provider, projectId });
});

// POST /api/projects/:id/integrations/:provider/execute  (internal / power-user)
integrationsRouter.post("/:provider/execute", async (c) => {
  const authUser = c.get("authUser");
  const projectId = c.req.param("id") ?? "";
  await requireProjectOwner(projectId, authUser.id);

  const provider = parseProvider(c.req.param("provider"));
  const body = await c.req.json().catch(() => { throw new AppError(400, "Invalid JSON", "VALIDATION_ERROR"); });
  const { toolName, args } = parseBody(executeBodySchema, body);

  const result = await getGateway().executeTool(projectId, provider, toolName, args as Record<string, unknown>);
  return c.json(result);
});

// ── Global providers router ───────────────────────────────────────────────────
// Mounted at /api/integrations

export const providersRouter = new Hono();
providersRouter.use("/*", requireAuth);

// GET /api/integrations/providers
providersRouter.get("/providers", (c) => {
  return c.json({ providers: buildProviderCatalogue() });
});

// Also expose a convenience list of providers a project already has connected
// GET /api/integrations/providers/:provider — single provider details
providersRouter.get("/providers/:provider", (c) => {
  const provider = parseProvider(c.req.param("provider"));
  const info = buildProviderCatalogue().find((p) => p.id === provider);
  if (!info) throw new AppError(404, "Provider not found", "NOT_FOUND");
  return c.json({ provider: info });
});
