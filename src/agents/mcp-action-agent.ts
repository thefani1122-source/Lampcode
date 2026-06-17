import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaRequestMCPServerURLDefinition,
  BetaRawMessageStreamEvent,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { getWebSocketServer } from "../websocket/server.js";
import type { ConnectedRestProvider } from "../server/routes/integrations.js";

export interface McpServer {
  slug: string;
  name: string;
  url: string;
  /** null when the token is embedded in the URL (mcp_url authType) */
  authToken: string | null;
}

export interface McpActionOptions {
  sessionId: string;
  userId: string;
  prompt: string;
  mcpServers: McpServer[];
  /** REST-only providers whose creds are injected into the system prompt */
  restProviders?: ConnectedRestProvider[];
  /** True when the prompt contains a reference URL — instructs the agent to use Firecrawl */
  hasReferenceUrl?: boolean;
}

export async function runMcpAction(opts: McpActionOptions): Promise<string> {
  const anthropic = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

  // ── Platform-level internal MCP tools (always injected from env vars) ───────
  const platformDefs: BetaRequestMCPServerURLDefinition[] = [];
  if (config.FIRECRAWL_API_KEY) {
    platformDefs.push({
      type: "url" as const,
      name: "firecrawl",
      url: "https://mcp.firecrawl.dev",
      authorization_token: config.FIRECRAWL_API_KEY,
    });
  }
  if (config.EXA_API_KEY) {
    platformDefs.push({
      type: "url" as const,
      name: "exa",
      url: "https://mcp.exa.ai/mcp",
      authorization_token: config.EXA_API_KEY,
    });
  }

  // ── User-connected MCP servers ────────────────────────────────────────────
  const userMcpDefs: BetaRequestMCPServerURLDefinition[] = opts.mcpServers.map((s) => {
    const def: BetaRequestMCPServerURLDefinition = {
      type: "url" as const,
      name: s.slug,
      url: s.url,
    };
    if (s.authToken !== null) {
      def.authorization_token = s.authToken;
    }
    return def;
  });

  const mcpDefs = [...platformDefs, ...userMcpDefs];

  // ── Build REST provider context ───────────────────────────────────────────
  let restContext = "";
  if (opts.restProviders && opts.restProviders.length > 0) {
    const entries = opts.restProviders.map((rp) => {
      const hint = rp.restApiHint.replace(/\{(\w+)\}/g, (_match, key: string) => {
        return rp.creds[key] ?? `{${key}}`;
      });
      return `### ${rp.name}\n${hint}`;
    });
    restContext = `\n\nAvailable REST APIs (call these directly via fetch/HTTP — no MCP needed):\n${entries.join("\n\n")}`;
  }

  // ── URL-scraping hint ─────────────────────────────────────────────────────
  const urlHint = opts.hasReferenceUrl && config.FIRECRAWL_API_KEY
    ? "\n\nThe user's prompt contains a reference URL. Use the Firecrawl MCP tool to scrape it first and incorporate the content into your response or actions."
    : "";

  // ── Built-in platform tool names for system prompt ────────────────────────
  const platformNames: string[] = [];
  if (config.FIRECRAWL_API_KEY) platformNames.push("Firecrawl (web scraping & crawling)");
  if (config.EXA_API_KEY) platformNames.push("Exa (semantic web search)");

  const allServiceNames = [
    ...platformNames,
    ...opts.mcpServers.map((s) => s.name),
    ...(opts.restProviders?.map((r) => r.name) ?? []),
  ];

  const systemPrompt = `You are an automation agent with access to the user's connected services.

Always-available tools: ${platformNames.length > 0 ? platformNames.join(", ") : "none"}
Connected user services: ${opts.mcpServers.length > 0 || (opts.restProviders?.length ?? 0) > 0
    ? allServiceNames.slice(platformNames.length).join(", ")
    : "none"}

Execute the user's request by calling the appropriate MCP tools or REST APIs.
Be specific about what you did. Show results and IDs.
If creating code repos, create them with a proper README and initial structure.
If creating workflows, make them complete and production-ready.${urlHint}${restContext}`;

  let ws: ReturnType<typeof getWebSocketServer> | null = null;
  try {
    ws = getWebSocketServer();
  } catch {
    logger.warn({ sessionId: opts.sessionId }, "WebSocket server not available for MCP action events");
  }

  const emit = (event: string, data: Record<string, unknown>) => {
    if (ws) {
      try {
        ws.emitToRoom(opts.sessionId, event, data);
      } catch (err) {
        logger.warn({ err, event, sessionId: opts.sessionId }, "Failed to emit MCP event");
      }
    }
  };

  let finalText = "";

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = (await (anthropic.beta.messages as any).create(
    {
      model: "claude-sonnet-4-6",
      max_tokens: 8096,
      system: systemPrompt,
      messages: [{ role: "user", content: opts.prompt }],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      betas: ["mcp-client-2025-11-20"] as any,
      mcp_servers: mcpDefs,
      stream: true,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  )) as AsyncIterable<BetaRawMessageStreamEvent>;

  for await (const event of stream) {
    if (event.type === "content_block_start") {
      const block = event.content_block;

      if (block.type === "thinking") {
        // Will accumulate via thinking_delta — nothing to do here
      } else if (block.type === "mcp_tool_use") {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const mcpBlock = block as any;
        emit("mcp:tool_call", {
          tool: mcpBlock.name as string,
          server: mcpBlock.server_name as string,
          sessionId: opts.sessionId,
        });
        logger.info(
          { sessionId: opts.sessionId, tool: mcpBlock.name, server: mcpBlock.server_name },
          "MCP tool call",
        );
      } else if (block.type === "mcp_tool_result") {
        emit("mcp:tool_result", { success: true, sessionId: opts.sessionId });
      }
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;

      if (delta.type === "text_delta") {
        finalText += delta.text;
      } else if (delta.type === "thinking_delta") {
        emit("mcp:thinking", {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          text: (delta as any).thinking as string,
          sessionId: opts.sessionId,
        });
      }
    }
  }

  emit("mcp:done", { summary: finalText, sessionId: opts.sessionId });
  logger.info({ sessionId: opts.sessionId, userId: opts.userId, textLength: finalText.length }, "MCP action complete");

  return finalText;
}
