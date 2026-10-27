import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { secureMcpFetch } from "./secure-fetch.js";

export type McpTransportKind = "streamable-http" | "sse";

export interface McpClientOptions {
  url: string;
  clientName: string;
  headers?: Record<string, string>;
  authProvider?: OAuthClientProvider;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/**
 * Connect and validate using the same transport-selection logic everywhere.
 *
 * Validation is part of an attempt, not a later step: some servers accept
 * initialize on Streamable HTTP but fail tools/list, while their SSE endpoint
 * works. Callers therefore validate what they actually need before accepting
 * a transport. Never retry a tool call here; this helper only connects and
 * performs a caller-supplied, non-mutating validation operation.
 */
export async function connectMcpClient<T>(
  options: McpClientOptions,
  validate: (client: Client) => Promise<T>,
): Promise<{ client: Client; validation: T; transport: McpTransportKind }> {
  const parsed = new URL(options.url);
  const ssePath = /\/sse\/?$/i.test(parsed.pathname);
  const attempts: McpTransportKind[] = ssePath
    ? ["sse", "streamable-http"]
    : ["streamable-http", "sse"];
  const headers = options.headers ?? {};
  const fetchImpl = options.fetch ?? secureMcpFetch;
  let lastError: unknown;

  for (const kind of attempts) {
    const client = new Client({ name: options.clientName, version: "1.0.0" });
    const transport = kind === "sse"
      ? new SSEClientTransport(parsed, {
          requestInit: { headers },
          fetch: fetchImpl,
          ...(options.authProvider ? { authProvider: options.authProvider } : {}),
        })
      : new StreamableHTTPClientTransport(parsed, {
          requestInit: { headers },
          fetch: fetchImpl,
          redirectPolicy: "same-origin",
          ...(options.authProvider ? { authProvider: options.authProvider } : {}),
        });

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const attempt = async () => {
        // SDK transport types differ slightly from the project's strict optional types.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await client.connect(transport as any);
        return await validate(client);
      };
      const validation = options.timeoutMs
        ? await Promise.race([
            attempt(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("MCP connect or validation timed out")),
                options.timeoutMs,
              );
            }),
          ])
        : await attempt();
      return { client, validation, transport: kind };
    } catch (error) {
      lastError = error;
      await client.close().catch(() => undefined);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  throw lastError ?? new Error("MCP connection failed for supported transports");
}
