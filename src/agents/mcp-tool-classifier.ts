import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { logger } from "../server/logger.js";
import type { ActiveMcpServer } from "../server/routes/integrations.js";
import { mapTool, type Capability } from "../mcp/capabilities.js";
import { describeTier, destructiveByName, needsApproval, strongestTier, tierFor, type Tier } from "../mcp/tiers.js";
import type { ToolDefinition } from "./model-gateway.js";
import { safeMcpFailureCategory } from "../mcp/health.js";
import { createMcpOAuthProvider } from "../mcp/oauth-client.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { secureMcpFetch } from "../mcp/secure-fetch.js";

// ── Read-only classification ──────────────────────────────────────────────────
// The Anthropic MCP connector (mcp_servers + mcp_toolset) has no mid-call
// approval mechanism — confirmed against platform.claude.com/docs/en/agents-
// and-tools/mcp-connector: tool execution is atomic and server-side, and the
// docs' own recommended pattern for wanting a confirmation step is denylisting
// the tool ahead of time. This module builds that denylist for real, per
// build, from each connected server's actual advertised tools — not a guess.

const READ_VERB_RE = /^(?:get|list|search|fetch|read|describe|find|query|check|inspect|show|view|count)(?:[A-Z_]|$)/i;

// Discovery must not hang a build waiting on a flaky/slow external MCP server.
const DISCOVERY_TIMEOUT_MS = 5_000;

function serverSecrets(server: ActiveMcpServer): string[] {
  const oauthValues = server.oauthSession
    ? Object.values(server.oauthSession.tokens ?? {}).concat(server.oauthSession.codeVerifier ? [server.oauthSession.codeVerifier] : [])
    : [];
  let urlValues: string[] = [];
  try { urlValues = [...new URL(server.url).searchParams.values()]; } catch { /* invalid endpoint will fail discovery */ }
  return [server.authToken, ...Object.values(server.authHeaders ?? {}), ...oauthValues, ...urlValues].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
}

function redactDiscoveredValue(value: unknown, secrets: string[]): unknown {
  if (typeof value === "string") return secrets.reduce((safe, secret) => safe.split(secret).join("[redacted credential]"), value);
  if (Array.isArray(value)) return value.map((item) => redactDiscoveredValue(item, secrets));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      secrets.reduce((safe, secret) => safe.split(secret).join("[redacted credential]"), key),
      redactDiscoveredValue(item, secrets),
    ]));
  }
  return value;
}

function safeDiscoveredToolName(name: string, secrets: string[]): boolean {
  return /^[a-zA-Z0-9_.-]{1,128}$/.test(name) && !secrets.some((secret) => name.includes(secret));
}

// Provider names and annotations are untrusted. Only app-owned, provider-scoped
// capabilities can establish an automatic read; provider signals can only
// escalate classification.
export interface ClassifiedTool {
  serverSlug: string;
  toolName: string;
  allowed: boolean;
  reason: "annotation-read-only" | "annotation-destructive" | "capability-read-only" | "name-pattern-match" | "name-pattern-no-match" | "discovery-failed";
  /** Raw inputSchema from MCP listTools — stored for write-proxy ToolDefinition generation. */
  inputSchema?: Record<string, unknown> | undefined;
}

// ── Write-proxy types ─────────────────────────────────────────────────────────

export interface WriteMcpMeta {
  serverSlug: string;
  serverUrl: string;
  /** null when the token is embedded in the URL (mcp_url authType). */
  authToken: string | null;
  authHeaders?: Record<string, string> | undefined;
  oauthSession?: ActiveMcpServer["oauthSession"];
  persistOAuthSession?: ActiveMcpServer["persistOAuthSession"];
  oauthRedirectUrl?: string | undefined;
  /** Original tool name on the MCP server (without the serverSlug__ prefix). */
  mcpToolName: string;
  /** How dangerous this call is taken to be (H2/H3). The strongest of what the
   *  classifier established and what the capability map says — escalation only,
   *  see strongestTier(). Read tools carry "read"; everything in the write
   *  registry carries "approval" or "strong-approval". */
  tier: Tier;
  /** The capability the map recognised, or null when it has never heard of this
   *  tool. Null does NOT remove the tool and does not weaken its tier. */
  capability: Capability | null;
}

/** Maps proxy tool name (e.g. "github__create_issue") → execution metadata. */
export type WriteProxyRegistry = Map<string, WriteMcpMeta>;

export interface McpToolsetConfig {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config: { enabled: boolean };
  configs: Record<string, { enabled: boolean }>;
}

export interface McpDiscoveryFailure {
  serverSlug: string;
  /** The transport/server error, for the build log the user actually reads. */
  message: string;
}

export interface McpClassificationResult {
  toolsets: McpToolsetConfig[];
  report: ClassifiedTool[];
  /** Servers that are connected but could not be reached or refused auth.
   *  Surfaced to the user: "connected" in the UI plus zero tools in the build
   *  is exactly the kind of silent nothing this codebase keeps paying for. */
  failures: McpDiscoveryFailure[];
}

async function discoverServerTools(
  server: ActiveMcpServer,
  failures: McpDiscoveryFailure[],
  fetchImpl: FetchLike,
): Promise<ClassifiedTool[]> {
  const client = new Client({ name: "lampcode-discovery", version: "1.0.0" });
  const headers: Record<string, string> = { ...(server.authHeaders ?? {}) };
  if (server.authToken) headers["Authorization"] = `Bearer ${server.authToken}`;

  const oauth = server.oauthSession && server.oauthRedirectUrl
    ? createMcpOAuthProvider({
        serverUrl: server.url,
        redirectUrl: server.oauthRedirectUrl,
        session: server.oauthSession,
        persist: server.persistOAuthSession ?? (async () => undefined),
        saveStateHash: async () => undefined,
      })
    : null;
  const isSse = server.url.toLowerCase().endsWith("/sse");
  const transport = isSse
    ? new SSEClientTransport(new URL(server.url), {
        requestInit: { headers },
        fetch: fetchImpl,
        ...(oauth ? { authProvider: oauth.provider } : {}),
      })
    : new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers },
        fetch: fetchImpl,
        redirectPolicy: "same-origin",
        ...(oauth ? { authProvider: oauth.provider } : {}),
      });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`discovery timed out after ${DISCOVERY_TIMEOUT_MS}ms`)), DISCOVERY_TIMEOUT_MS),
  );

  try {
    // The SDK's own transport class doesn't structurally satisfy its Transport
    // interface under this project's exactOptionalPropertyTypes setting
    // (sessionId: string vs the interface's string | undefined) — a type-only
    // friction point between the SDK and this tsconfig, not a real mismatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await Promise.race([client.connect(transport as any), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);

    const secrets = serverSecrets(server);
    const safeTools = tools.filter((tool) => safeDiscoveredToolName(tool.name, secrets));
    if (safeTools.length !== tools.length) {
      logger.warn({ server: server.slug, category: "invalid_tool_metadata", omitted: tools.length - safeTools.length }, "[mcp-tool-classifier] unsafe tool metadata omitted");
    }
    return safeTools.map((tool): ClassifiedTool => {
      const annotations = tool.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
      const inputSchema = redactDiscoveredValue(tool.inputSchema, secrets) as Record<string, unknown> | undefined;
      if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) {
        return { serverSlug: server.slug, toolName: tool.name, allowed: false, reason: "annotation-destructive", inputSchema };
      }
      const capability = mapTool(server.slug, tool.name);
      const capabilityIsRead = capability !== null && (capability.endsWith(".read") || capability === "db.query");
      if (capabilityIsRead && !destructiveByName(tool.name)) {
        return { serverSlug: server.slug, toolName: tool.name, allowed: true, reason: "capability-read-only", inputSchema };
      }
      // A remote provider's readOnlyHint is untrusted metadata. It cannot
      // grant approval-free execution; only app-owned capability mappings or
      // conservative name checks can establish a read.
      if (READ_VERB_RE.test(tool.name) && !destructiveByName(tool.name)) {
        return { serverSlug: server.slug, toolName: tool.name, allowed: true, reason: "name-pattern-match", inputSchema };
      }
      return {
        serverSlug: server.slug,
        toolName: tool.name,
        allowed: false,
        reason: destructiveByName(tool.name) ? "annotation-destructive" : "name-pattern-no-match",
        inputSchema,
      };
    });
  } catch (err) {
    const category = safeMcpFailureCategory(err);
    logger.warn(
      { server: server.slug, category },
      "[mcp-tool-classifier] tool discovery failed — server's tools denied by default (fail closed)",
    );
    failures.push({
      serverSlug: server.slug,
      message: category,
    });
    return [];
  } finally {
    await client.close().catch(() => undefined);
  }
}

/**
 * Discover and classify every tool on each connected server, in parallel,
 * and build the mcp_toolset configs that deny everything except tools
 * confirmed read-only (by annotation or name convention). A server whose
 * discovery fails contributes zero enabled tools — not "allow everything" —
 * so a flaky server degrades to "unavailable this build," never to "open."
 */
export async function classifyMcpServers(servers: ActiveMcpServer[], fetchImpl: FetchLike = secureMcpFetch): Promise<McpClassificationResult> {
  const failures: McpDiscoveryFailure[] = [];
  const perServer = await Promise.all(servers.map((s) => discoverServerTools(s, failures, fetchImpl)));
  const report = perServer.flat();

  const toolsets: McpToolsetConfig[] = servers.map((server) => {
    const configs: Record<string, { enabled: boolean }> = {};
    for (const t of report) {
      if (t.serverSlug === server.slug) configs[t.toolName] = { enabled: t.allowed };
    }
    return {
      type: "mcp_toolset",
      mcp_server_name: server.slug,
      default_config: { enabled: false }, // fail closed for any tool discovery didn't classify
      configs,
    };
  });

  return { toolsets, report, failures };
}

/**
 * The read half of the same idea, for gateways that cannot reach MCP themselves.
 *
 * Anthropic's connector executes read-only tools server-side, so on that path
 * the enabled `mcp_toolset` config above IS the wiring and nothing else is
 * needed. An OpenAI-compatible endpoint has no MCP concept at all — it only
 * knows function tools — so on that path a read tool that is "enabled" is
 * enabled for nobody. These definitions are what make it callable: the same
 * tools the toolset would have permitted, offered as ordinary functions and
 * executed by us.
 *
 * The allow/deny decision is NOT re-made here. It reuses `allowed` exactly as
 * classifyMcpServers computed it, so the two gateways permit the identical set
 * and a change to the classification cannot drift between them. A tool whose
 * discovery failed never appears in the report at all, so it stays blocked.
 */
export function buildReadToolDefinitions(
  report: ClassifiedTool[],
  servers: ActiveMcpServer[],
): { toolDefs: ToolDefinition[]; registry: WriteProxyRegistry; escalated: string[] } {
  const serversBySlug = new Map(servers.map((s) => [s.slug, s]));
  const toolDefs: ToolDefinition[] = [];
  const registry: WriteProxyRegistry = new Map();
  const escalated: string[] = [];

  for (const t of report) {
    if (!t.allowed) continue;

    // ── H2/H3: escalation only ────────────────────────────────────────────
    // This tool reached here because the server annotated it read-only or its
    // name matched a read verb. If the capability map independently says it is
    // destructive — `deploy.rollback`, or a name carrying delete/drop/destroy/
    // rollback/force — then one of the two is wrong about a call that cannot be
    // undone, and the safe reading wins: it leaves the auto-executed read path
    // and goes behind the approval gate instead.
    //
    // An UNMAPPED tool is left exactly as the classifier had it. `tierFor`
    // answers "approval" for a null capability, which is right as its own
    // contract — nothing proved the tool safe — but applying that here would
    // put an approval prompt in front of every `get_*` on every connected
    // service, because the map covers four tools. That is a fact about the map.
    const capability = mapTool(t.serverSlug, t.toolName);
    const escalation = capability === null ? "read" : tierFor(capability, t.toolName);
    const tier = strongestTier(escalation, destructiveByName(t.toolName) ? "strong-approval" : "read");
    if (needsApproval(tier)) {
      escalated.push(`${t.serverSlug}__${t.toolName}:${tier}`);
      continue;
    }
    const server = serversBySlug.get(t.serverSlug);
    if (!server) continue;

    // Same serverSlug__tool naming as the write proxies, for the same reason
    // (collisions across servers) and so one lookup covers both registries.
    const toolName = `${t.serverSlug}__${t.toolName}`;
    registry.set(toolName, {
      serverSlug: t.serverSlug,
      serverUrl: server.url,
      authToken: server.authToken,
      authHeaders: server.authHeaders,
      oauthSession: server.oauthSession,
      persistOAuthSession: server.persistOAuthSession,
      oauthRedirectUrl: server.oauthRedirectUrl,
      mcpToolName: t.toolName,
      tier: "read",
      capability,
    });
    toolDefs.push({
      name: toolName,
      description: `Read-only. Run ${t.toolName} on the connected ${t.serverSlug} service.`,
      input_schema: {
        type: "object",
        ...(t.inputSchema ?? {}),
      },
    });
  }

  if (escalated.length > 0) {
    logger.warn(
      { count: escalated.length },
      "[mcp-tool-classifier] read-classified tool(s) escalated behind the approval gate by capability/tier",
    );
  }
  return { toolDefs, registry, escalated };
}

/**
 * From classifier results, build Anthropic ToolDefinitions and a registry for
 * every explicitly-annotated write tool (reason "annotation-destructive").
 * Ambiguous tools (name-pattern-no-match, discovery-failed) are NOT included —
 * they stay fully blocked regardless of approval-gate availability.
 */
export function buildWriteProxyDefinitions(
  report: ClassifiedTool[],
  servers: ActiveMcpServer[],
): { toolDefs: ToolDefinition[]; registry: WriteProxyRegistry } {
  const serversBySlug = new Map(servers.map((s) => [s.slug, s]));
  const toolDefs: ToolDefinition[] = [];
  const registry: WriteProxyRegistry = new Map();

  for (const t of report) {
    // Anything not confirmed read-only belongs here, behind approval — not
    // only the tools a server bothered to annotate as destructive.
    //
    // THE BUG THIS FIXES, reported by the owner repeatedly over two months and
    // measured on 2026-10-16. A build asked to "create a repo, push the code,
    // deploy to Vercel" spent NINE MINUTES calling `create_repository` four
    // times, never pushed, never called deploy_app, and ended by writing
    // prose to output.md.
    //
    // `create_repository` worked because GitHub's MCP annotates it as
    // destructive. `push_files` does not match READ_VERB_RE and — on a server
    // that leaves annotations off, which this file's own comment notes is
    // allowed by the spec and common — classified as `name-pattern-no-match`.
    // That reason was denied as a read AND skipped here, so the tool did not
    // appear anywhere. The model was not refusing to push; it could not see
    // any way to.
    //
    // Fail-closed is still the rule: an unclassified tool does not become
    // automatically callable. It becomes callable WITH the user's approval,
    // which is what the gate is for. Vanishing is not a safer default than
    // asking — it is the same denial with the reason hidden from everyone.
    if (t.reason === "annotation-read-only" || t.reason === "capability-read-only" || t.reason === "name-pattern-match") continue;
    if (t.reason === "discovery-failed") continue;
    const server = serversBySlug.get(t.serverSlug);
    if (!server) continue;

    // Prefix with serverSlug to prevent name collisions across servers.
    const proxyName = `${t.serverSlug}__${t.toolName}`;
    // Everything here already requires approval. The capability map can only
    // make that STRONGER: `deploy.rollback`, or a name carrying delete/drop/
    // destroy/rollback/force, is a call that may not be undoable, and the
    // record and the approval payload both say so. There is no weaker outcome
    // available on this path — an unmapped tool stays at "approval", which is
    // exactly where it already was.
    const capability = mapTool(t.serverSlug, t.toolName);
    // `tierFor` short-circuits on a null capability before it looks at the
    // name, so the name is asked separately — an unmapped `rollback_deployment`
    // must not read like an unmapped `create_label`.
    const tier = strongestTier(
      strongestTier("approval", tierFor(capability, t.toolName)),
      destructiveByName(t.toolName) ? "strong-approval" : "approval",
    );
    registry.set(proxyName, {
      serverSlug: t.serverSlug,
      serverUrl: server.url,
      authToken: server.authToken,
      authHeaders: server.authHeaders,
      oauthSession: server.oauthSession,
      persistOAuthSession: server.persistOAuthSession,
      oauthRedirectUrl: server.oauthRedirectUrl,
      mcpToolName: t.toolName,
      tier,
      capability,
    });
    toolDefs.push({
      name: proxyName,
      description:
        (tier === "strong-approval"
          ? `[Requires explicit user approval — POSSIBLY IRREVERSIBLE] `
          : `[Requires user approval] `) +
        `Execute ${t.toolName} on the ${t.serverSlug} connected service. ` +
        `You will be paused until the user approves or denies this action.` +
        (tier === "strong-approval"
          ? ` ${describeTier(tier)} Say what it will do and why before you call it.`
          : ""),
      input_schema: {
        type: "object",
        ...(t.inputSchema ?? {}),
      },
    });
  }

  return { toolDefs, registry };
}

