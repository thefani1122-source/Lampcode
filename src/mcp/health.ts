import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { secureMcpFetch } from "./secure-fetch.js";

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
  const isSse = input.url.toLowerCase().endsWith("/sse");
  const client = new Client({ name: "lampcode-connect-check", version: "1.0.0" });
  const transport = isSse
    ? new SSEClientTransport(new URL(input.url), {
        requestInit: { headers: input.headers ?? {}, signal: AbortSignal.timeout(input.timeoutMs ?? 8_000) },
        fetch: input.fetch ?? secureMcpFetch,
      })
    : new StreamableHTTPClientTransport(new URL(input.url), {
        requestInit: { headers: input.headers ?? {}, signal: AbortSignal.timeout(input.timeoutMs ?? 8_000) },
        fetch: input.fetch ?? secureMcpFetch,
        redirectPolicy: "same-origin",
      });
  let stage: "connect" | "list_tools" = "connect";
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.connect(transport as any);
    stage = "list_tools";
    const { tools } = await client.listTools();
    if (tools.length === 0) return { ok: false, stage: "list_tools", category: "empty_tool_list" };
    return { ok: true, toolCount: tools.length };
  } catch (error) {
    if (!isSse) {
      try {
        const sseClient = new Client({ name: "lampcode-connect-check-sse", version: "1.0.0" });
        const sseTransport = new SSEClientTransport(new URL(input.url), {
          requestInit: { headers: input.headers ?? {}, signal: AbortSignal.timeout(input.timeoutMs ?? 8_000) },
          fetch: input.fetch ?? secureMcpFetch,
        });
        await sseClient.connect(sseTransport as any);
        const { tools } = await sseClient.listTools();
        await sseClient.close().catch(() => undefined);
        if (tools.length > 0) return { ok: true, toolCount: tools.length };
      } catch {
        // SSE fallback failed, fall through to reporting original error
      }
    }
    return { ok: false, stage, category: safeMcpFailureCategory(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}

