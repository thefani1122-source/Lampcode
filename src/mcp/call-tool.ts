import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { logger } from "../server/logger.js";
import { safeMcpFailureCategory, sanitizeMcpError } from "./health.js";
import { createMcpOAuthProvider } from "./oauth-client.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { secureMcpFetch } from "./secure-fetch.js";

/**
 * Executing one tool on one connected MCP server.
 *
 * This was inline in tools.ts, reachable only from the write-proxy path, which
 * was fine while Anthropic was the only gateway that could reach MCP at all:
 * Anthropic runs read-only tools itself, server-side, so our side only ever
 * had to execute the writes it had denied to the connector.
 *
 * The OpenAI-compatible gateway has no MCP concept, so on that path NOBODY
 * executes a read tool unless we do. Same transport, same timeout, same error
 * shape — the only difference upstream is that a read needs no approval gate.
 * Extracted rather than duplicated so a fix to one is a fix to both.
 *
 * It never throws. A tool failure is a result the model should see and work
 * around, not an exception that kills a build that is otherwise fine.
 */

/** How long to wait for a callTool() response before giving up. */
export const CALL_TOOL_TIMEOUT_MS = 30_000;

export interface McpCallTarget {
  serverSlug: string;
  serverUrl: string;
  /** null when the token is embedded in the URL (mcp_url authType). */
  authToken: string | null;
  authHeaders?: Record<string, string> | undefined;
  oauthSession?: import("./oauth-client.js").McpOAuthSession | undefined;
  persistOAuthSession?: ((session: import("./oauth-client.js").McpOAuthSession) => Promise<void>) | undefined;
  oauthRedirectUrl?: string | undefined;
  /** The tool's real name on the server, without the serverSlug__ prefix. */
  mcpToolName: string;
}

function redactTargetCredentials(value: string, target: McpCallTarget): string {
  let querySecrets: string[] = [];
  try { querySecrets = [...new URL(target.serverUrl).searchParams.values()]; } catch { /* malformed target is handled by transport */ }
  const oauthValues = target.oauthSession
    ? Object.values(target.oauthSession.tokens ?? {}).concat(target.oauthSession.codeVerifier ? [target.oauthSession.codeVerifier] : [])
    : [];
  const secrets = [target.authToken, ...Object.values(target.authHeaders ?? {}), ...querySecrets, ...oauthValues].filter(
    (secret): secret is string => typeof secret === "string" && secret.length >= 4,
  );
  let safe = sanitizeMcpError(value);
  for (const secret of new Set(secrets)) safe = safe.split(secret).join("[redacted credential]");
  return safe;
}

export async function callMcpTool(
  target: McpCallTarget,
  args: Record<string, unknown>,
  clientName = "lampcode-mcp",
  fetchImpl: FetchLike = secureMcpFetch,
): Promise<string> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const headers: Record<string, string> = { ...(target.authHeaders ?? {}) };
  if (target.authToken !== null) headers["Authorization"] = `Bearer ${target.authToken}`;
  const oauth = target.oauthSession && target.oauthRedirectUrl
    ? createMcpOAuthProvider({
        serverUrl: target.serverUrl,
        redirectUrl: target.oauthRedirectUrl,
        session: target.oauthSession,
        persist: target.persistOAuthSession ?? (async () => undefined),
        saveStateHash: async () => undefined,
      })
    : null;
  const isSse = target.serverUrl.toLowerCase().endsWith("/sse");
  const transport = isSse
    ? new SSEClientTransport(new URL(target.serverUrl), {
        requestInit: { headers },
        fetch: fetchImpl,
        ...(oauth ? { authProvider: oauth.provider } : {}),
      })
    : new StreamableHTTPClientTransport(new URL(target.serverUrl), {
        requestInit: { headers },
        fetch: fetchImpl,
        redirectPolicy: "same-origin",
        ...(oauth ? { authProvider: oauth.provider } : {}),
      });

  try {
    // The SDK's transport doesn't structurally satisfy its own Transport
    // interface under exactOptionalPropertyTypes — a type-only friction point
    // between the SDK and this tsconfig, not a real mismatch. Same cast as
    // mcp-tool-classifier.ts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);

    const callTimeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("callTool timed out")), CALL_TOOL_TIMEOUT_MS),
    );
    const callResult = await Promise.race([
      client.callTool({ name: target.mcpToolName, arguments: args }),
      callTimeout,
    ]);

    const blocks = callResult.content as Array<{ type: string; text?: string }>;
    const text = blocks.map((b) => b.text ?? `[${b.type}]`).join("\n");

    if (callResult.isError) {
      logger.warn(
        { serverSlug: target.serverSlug, category: "mcp_tool_error" },
        "[mcp] callTool returned isError",
      );
      return `Error from ${target.serverSlug}: ${redactTargetCredentials(text, target)}`;
    }
    return redactTargetCredentials(text, target) || "(tool returned no content)";
  } catch (err) {
    const category = safeMcpFailureCategory(err);
    logger.warn(
      { category, serverSlug: target.serverSlug },
      "[mcp] callTool failed",
    );
    return `Error: could not execute ${target.mcpToolName} on ${target.serverSlug} (${category}): ${redactTargetCredentials(err instanceof Error ? err.message : String(err), target)}`;
  } finally {
    await client.close().catch(() => undefined);
  }
}

