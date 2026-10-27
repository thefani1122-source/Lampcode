import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { secureMcpFetch } from "./secure-fetch.js";
import { connectMcpClient } from "./client.js";

export type McpHealthResult =
  | { ok: true; toolCount: number }
  | { ok: false; stage: "connect" | "list_tools"; category: string };

export function safeMcpFailureCategory(error: unknown): string {
  if (error instanceof StreamableHTTPError && error.code) return `http_${error.code}`;
  if (error instanceof Error && /time(?:d out|out)/i.test(error.message)) return "timeout";
  return "transport_error";
}

export function sanitizeMcpError(value: string): string {
  return value
    .replace(/\bBearer\s+[^\s,;"']+/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]")
    .replace(/\b(?:sb_publishable_|sk_live_|rk_live_|fc-|gh[pousr]_)\S+/gi, "[redacted token]")
    .replace(/([?&](?:access_token|api_key|token|key)=)[^&#\s]+/gi, "$1[redacted]")
    .slice(0, 400);
}

/** Do not mark a connection usable until MCP initialize and listTools succeed. */
export async function checkMcpServer(input: {
  url: string;
  headers?: Record<string, string> | undefined;
  timeoutMs?: number | undefined;
  fetch?: FetchLike | undefined;
}): Promise<McpHealthResult> {
  let stage: "connect" | "list_tools" = "connect";
  let client: Client | undefined;
  try {
    const connected = await connectMcpClient({
      url: input.url,
      clientName: "lampcode-connect-check",
      headers: input.headers,
      fetch: input.fetch ?? secureMcpFetch,
      timeoutMs: input.timeoutMs ?? 8_000,
    }, async (activeClient) => {
      stage = "list_tools";
      const { tools } = await activeClient.listTools();
      return tools;
    });
    client = connected.client;
    if (connected.validation.length === 0) {
      return { ok: false, stage: "list_tools", category: "empty_tool_list" };
    }
    return { ok: true, toolCount: connected.validation.length };
  } catch (error) {
    return { ok: false, stage, category: safeMcpFailureCategory(error) };
  } finally {
    await client?.close().catch(() => undefined);
  }
}
