import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { logger } from "../server/logger.js";

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
  /** The tool's real name on the server, without the serverSlug__ prefix. */
  mcpToolName: string;
}

export async function callMcpTool(
  target: McpCallTarget,
  args: Record<string, unknown>,
  clientName = "lampcode-mcp",
): Promise<string> {
  const client = new Client({ name: clientName, version: "1.0.0" });
  const headers: Record<string, string> = {};
  if (target.authToken !== null) headers["Authorization"] = `Bearer ${target.authToken}`;
  const transport = new StreamableHTTPClientTransport(new URL(target.serverUrl), {
    requestInit: { headers },
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
        { toolName: target.mcpToolName, serverSlug: target.serverSlug, text },
        "[mcp] callTool returned isError",
      );
      return `Error from ${target.serverSlug}: ${text}`;
    }
    return text || "(tool returned no content)";
  } catch (err) {
    logger.warn(
      {
        err: err instanceof Error ? err.message : String(err),
        toolName: target.mcpToolName,
        serverSlug: target.serverSlug,
      },
      "[mcp] callTool failed",
    );
    return `Error: could not execute ${target.mcpToolName} on ${target.serverSlug}: ${
      err instanceof Error ? err.message : String(err)
    }`;
  } finally {
    await client.close().catch(() => undefined);
  }
}
