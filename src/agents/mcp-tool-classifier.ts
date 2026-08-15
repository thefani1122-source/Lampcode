import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../server/logger.js";
import type { ActiveMcpServer } from "../server/routes/integrations.js";

// ── Read-only classification ──────────────────────────────────────────────────
// The Anthropic MCP connector (mcp_servers + mcp_toolset) has no mid-call
// approval mechanism — confirmed against platform.claude.com/docs/en/agents-
// and-tools/mcp-connector: tool execution is atomic and server-side, and the
// docs' own recommended pattern for wanting a confirmation step is denylisting
// the tool ahead of time. This module builds that denylist for real, per
// build, from each connected server's actual advertised tools — not a guess.

// Discovery must not hang a build waiting on a flaky/slow external MCP server.
const DISCOVERY_TIMEOUT_MS = 5_000;

// MCP's tool annotations (readOnlyHint/destructiveHint) are optional per the
// spec — servers may not set them. When absent, fall back to a conventional
// read-verb prefix. Anything that matches neither an explicit safe signal nor
// this prefix is treated as write/unknown and denied — fail closed, not open.
const READ_VERB_RE = /^(get|list|search|read|fetch|query|find|show|describe|view|check)_/i;

export interface ClassifiedTool {
  serverSlug: string;
  toolName: string;
  allowed: boolean;
  reason: "annotation-read-only" | "annotation-destructive" | "name-pattern-match" | "name-pattern-no-match" | "discovery-failed";
}

export interface McpToolsetConfig {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config: { enabled: boolean };
  configs: Record<string, { enabled: boolean }>;
}

export interface McpClassificationResult {
  toolsets: McpToolsetConfig[];
  report: ClassifiedTool[];
}

async function discoverServerTools(server: ActiveMcpServer): Promise<ClassifiedTool[]> {
  const client = new Client({ name: "lampcode-discovery", version: "1.0.0" });
  const headers: Record<string, string> = {};
  if (server.authToken) headers["Authorization"] = `Bearer ${server.authToken}`;

  const transport = new StreamableHTTPClientTransport(new URL(server.url), {
    requestInit: { headers },
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

    return tools.map((tool): ClassifiedTool => {
      const annotations = tool.annotations as { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined;
      if (annotations?.readOnlyHint === true) {
        return { serverSlug: server.slug, toolName: tool.name, allowed: true, reason: "annotation-read-only" };
      }
      if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) {
        return { serverSlug: server.slug, toolName: tool.name, allowed: false, reason: "annotation-destructive" };
      }
      const matchesReadVerb = READ_VERB_RE.test(tool.name);
      return {
        serverSlug: server.slug,
        toolName: tool.name,
        allowed: matchesReadVerb,
        reason: matchesReadVerb ? "name-pattern-match" : "name-pattern-no-match",
      };
    });
  } catch (err) {
    logger.warn(
      { server: server.slug, err: err instanceof Error ? err.message : String(err) },
      "[mcp-tool-classifier] tool discovery failed — server's tools denied by default (fail closed)",
    );
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
export async function classifyMcpServers(servers: ActiveMcpServer[]): Promise<McpClassificationResult> {
  const perServer = await Promise.all(servers.map((s) => discoverServerTools(s)));
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

  return { toolsets, report };
}
