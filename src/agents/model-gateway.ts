import Anthropic from "@anthropic-ai/sdk";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import { bedrockStream } from "./bedrock-gateway.js";

// ── Model catalogue ───────────────────────────────────────────────────────────

// Tier arrays: [primary, fallback]
// Bare first-party model IDs. The Bedrock gateway maps these to Bedrock IDs;
// token-tracker.ts keys its pricing table on these same bare names.
export const MODEL_TIERS = {
  planning:   ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  frontend:   ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  backend:    ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  db:         ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  security:   ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  connection: ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  fix:        ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  deploy:     ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
  monitor:    ["claude-sonnet-5", "claude-sonnet-4-6"] as const,
} as const satisfies Record<string, readonly [string, string]>;

export type AgentTaskType = keyof typeof MODEL_TIERS;

export function tierModel(agentType: AgentTaskType, tier: 1 | 2): string {
  return MODEL_TIERS[agentType][tier - 1] as string;
}

// ── Wire types ────────────────────────────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant";

// A tool round-trip needs richer message content than plain text: the
// assistant turn that requested a tool must be replayed back with its
// tool_use block(s) intact, and the following turn carries the tool's result.
// Anthropic's Messages API accepts a bare string as shorthand for a single
// text block — MessageContentBlock covers the two additional shapes needed
// for tool-calling without pulling the full Anthropic SDK type in here.
export interface TextContentBlock { type: "text"; text: string }
export interface ToolUseContentBlock { type: "tool_use"; id: string; name: string; input: unknown }
export interface ToolResultContentBlock { type: "tool_result"; tool_use_id: string; content: string }
export type MessageContentBlock = TextContentBlock | ToolUseContentBlock | ToolResultContentBlock;

export interface ChatMessage {
  role: ChatRole;
  content: string | MessageContentBlock[];
}

// Anthropic tool-definition shape (also what Bedrock Converse's toolSpec
// wraps) — kept minimal since only load_skill/read_project_file exist today.
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
}

// Anthropic MCP connector (beta mcp-client-2025-11-20) shapes. Kept minimal —
// only the fields dispatcher.ts/mcp-tool-classifier.ts actually populate.
export interface McpServerDefinition {
  type: "url";
  url: string;
  name: string;
  authorization_token?: string;
}

export interface McpToolsetDefinition {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config?: { enabled?: boolean };
  configs?: Record<string, { enabled?: boolean }>;
}

export interface GatewayRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
  thinkingBudget?: number | undefined;
  tools?: ToolDefinition[] | undefined;
  // Presence of mcpServers switches this request onto the beta MCP connector
  // (client.beta.messages.create with mcp_servers + tools mixing ToolDefinition
  // and McpToolsetDefinition entries) instead of the stable endpoint.
  mcpServers?: McpServerDefinition[] | undefined;
  mcpToolsets?: McpToolsetDefinition[] | undefined;
}

// Parsed chunk yielded to callers — same shape as before, stream-handler unchanged.
export type StreamChunkType = "content" | "reasoning" | "tool_call" | "mcp_tool_call" | "usage" | "done";

export interface StreamChunk {
  type: StreamChunkType;
  content?: string | undefined;
  reasoning?: string | undefined;
  toolCall?: { id: string; name: string; arguments: string } | undefined;
  // Unlike toolCall (a local tool we must execute and answer), an MCP tool call
  // is already fully resolved server-side by the time it reaches us — mcp_tool_use
  // and mcp_tool_result are atomic within one response (confirmed against
  // Anthropic's docs: no interception point exists). This carries both the
  // request and its already-computed result for observability/logging only.
  mcpToolCall?: { id: string; name: string; serverName: string; input: unknown; result: string; isError: boolean } | undefined;
  usage?: { promptTokens: number; completionTokens: number } | undefined;
  stopReason?: string | undefined;
}

// ── Error types ───────────────────────────────────────────────────────────────

export type GatewayErrorCode =
  | "RATE_LIMIT"
  | "MODEL_DOWN"
  | "INVALID_KEY"
  | "CONTEXT_LENGTH"
  | "NETWORK"
  | "PAYMENT_REQUIRED"
  | "UNKNOWN";

export class GatewayError extends Error {
  constructor(
    public readonly code: GatewayErrorCode,
    message: string,
    public readonly retryAfterMs?: number | undefined,
  ) {
    super(message);
    this.name = "GatewayError";
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Whether a model supports extended thinking (budget_tokens). */
function supportsThinking(model: string): boolean {
  // Haiku does not support thinking; Sonnet and Opus do.
  return !model.includes("haiku");
}

/**
 * Marker that begins the variable skills block appended by prompt-builder
 * (`\n\n---\n## Skill: <name>\n<content>`). Splitting here separates the stable
 * base prompt from the per-build skills so each can get its own cache
 * breakpoint — without it, one breakpoint spans base+skills and any change to
 * the skill set misses the base too.
 */
const SKILLS_BLOCK_MARKER = "\n\n---\n## Skill: ";

/**
 * Split an assembled system prompt into [stable base] and [variable skills].
 * Returns a single segment when no skills block is present, so callers can map
 * segments to cache points uniformly.
 */
export function splitSystemPrompt(systemPrompt: string): string[] {
  const idx = systemPrompt.indexOf(SKILLS_BLOCK_MARKER);
  if (idx <= 0) return [systemPrompt];
  return [systemPrompt.slice(0, idx), systemPrompt.slice(idx)];
}

/** Convert our internal ChatMessage[] to Anthropic's messages + system param. */
function splitMessages(messages: ChatMessage[]): {
  systemBlocks: Anthropic.TextBlockParam[] | undefined;
  anthropicMessages: Anthropic.MessageParam[];
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const rest = messages.filter((m) => m.role !== "system");
  // The system message is always assembled as plain text (prompt-builder.ts
  // never produces tool_use/tool_result blocks for it) — narrow defensively
  // rather than assume, since ChatMessage.content is now a union.
  const systemText = typeof systemMsg?.content === "string" ? systemMsg.content : "";
  return {
    systemBlocks: systemMsg
      ? splitSystemPrompt(systemText).map((text) => ({
          type: "text" as const,
          text,
          cache_control: { type: "ephemeral" as const },
        }))
      : undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    anthropicMessages: rest.map((m) => ({
      role: m.role as "user" | "assistant",
      content: m.content as any,
    })),
  };
}

/** Map Anthropic SDK errors to our GatewayError codes. */
function mapAnthropicError(err: unknown): GatewayError {
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const msg = err.message ?? String(err);
    if (status === 401 || status === 403) return new GatewayError("INVALID_KEY", "Invalid Anthropic API key");
    if (status === 429) {
      const retryAfter = err.headers?.["retry-after"];
      const retryMs = retryAfter ? parseInt(String(retryAfter), 10) * 1000 : 60_000;
      return new GatewayError("RATE_LIMIT", "Rate limit exceeded", retryMs);
    }
    if (status === 529 || status === 503) return new GatewayError("MODEL_DOWN", `Model unavailable (${status})`);
    if (status === 402) return new GatewayError("PAYMENT_REQUIRED", "Anthropic credits exhausted");
    if (status === 400 && msg.includes("context_length")) return new GatewayError("CONTEXT_LENGTH", msg);
    return new GatewayError("UNKNOWN", `HTTP ${status}: ${msg.slice(0, 200)}`);
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.includes("timed out")) {
      return new GatewayError("NETWORK", err.message);
    }
    return new GatewayError("NETWORK", `Fetch failed: ${err.message}`);
  }
  return new GatewayError("UNKNOWN", String(err));
}

// ── ModelGateway ──────────────────────────────────────────────────────────────

export class ModelGateway {
  private readonly client: Anthropic;
  private readonly timeoutMs: number;

  constructor(apiKey: string = config.ANTHROPIC_API_KEY, timeoutMs = 180_000) {
    this.client = new Anthropic({ apiKey, timeout: timeoutMs });
    this.timeoutMs = timeoutMs;
  }

  /** Yield parsed chunks from an Anthropic streaming completion. */
  async *stream(req: GatewayRequest, overrideTimeoutMs?: number): AsyncGenerator<StreamChunk> {
    // AWS Bedrock gateway — uses AWS_ACCESS_KEY_ID to activate
    if (process.env.AWS_ACCESS_KEY_ID) {
      yield* bedrockStream(req);
      return;
    }

    // MCP connector requests need mcp_servers/tools-as-mcp_toolset and the
    // beta client — kept as a fully separate path so the already-verified
    // plain-tools (load_skill/read_project_file) route below is untouched
    // when no MCP servers are attached, which is still the common case.
    if (req.mcpServers && req.mcpServers.length > 0) {
      yield* this.streamWithMcp(req, overrideTimeoutMs);
      return;
    }

    const { systemBlocks, anthropicMessages } = splitMessages(req.messages);
    const model = req.model;
    const maxTokens = req.maxTokens ?? 16_000;
    const effectiveTimeout = overrideTimeoutMs ?? this.timeoutMs;

    logger.debug({ model }, "ModelGateway: Anthropic stream");

    // Extended thinking — enabled for models that support it.
    const thinkingParam: Anthropic.ThinkingConfigParam | undefined = supportsThinking(model)
      ? { type: "enabled", budget_tokens: req.thinkingBudget ?? 4_000 }
      : undefined;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      // Use a per-request client with the correct timeout so overrides work.
      const client = effectiveTimeout === this.timeoutMs
        ? this.client
        : new Anthropic({ apiKey: this.client.apiKey as string, timeout: effectiveTimeout });

      stream = await client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        stream: true,
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(thinkingParam ? { thinking: thinkingParam } : {}),
        ...(req.tools && req.tools.length > 0 ? { tools: req.tools } : {}),
      });
    } catch (err) {
      throw mapAnthropicError(err);
    }

    // Track per-content-block state for tool-call input accumulation.
    const toolInputBuffers = new Map<number, { id: string; name: string; args: string }>();
    let currentBlockIndex = -1;
    let currentBlockType: string = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage?.input_tokens ?? 0;
            break;

          case "content_block_start":
            currentBlockIndex = event.index;
            currentBlockType = event.content_block.type;
            if (event.content_block.type === "tool_use") {
              toolInputBuffers.set(event.index, {
                id: event.content_block.id,
                name: event.content_block.name,
                args: "",
              });
            }
            break;

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "content", content: delta.text };
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              yield { type: "reasoning", reasoning: delta.thinking };
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const buf = toolInputBuffers.get(currentBlockIndex);
              if (buf) buf.args += delta.partial_json;
            }
            break;
          }

          case "content_block_stop":
            // Flush completed tool call when its block ends.
            if (currentBlockType === "tool_use") {
              const buf = toolInputBuffers.get(currentBlockIndex);
              if (buf) {
                yield {
                  type: "tool_call",
                  toolCall: { id: buf.id, name: buf.name, arguments: buf.args },
                };
                toolInputBuffers.delete(currentBlockIndex);
              }
            }
            break;

          case "message_delta":
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            stopReason = event.delta.stop_reason ?? stopReason;
            break;

          case "message_stop":
            break;
        }
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }

    yield {
      type: "usage",
      usage: { promptTokens: inputTokens, completionTokens: outputTokens },
    };
    yield { type: "done", stopReason };
  }

  /**
   * MCP-connector variant of stream() — same event-loop shape, but against
   * the beta client with mcp_servers/betas attached, and recognizing the two
   * additional block types (mcp_tool_use, mcp_tool_result) the connector adds.
   * Unverified against a live Bedrock or Anthropic call in development (no API
   * key available there) — mirrors the plain-tools loop's proven structure and
   * the documented block shapes, but hasn't been exercised against a real API
   * response.
   */
  private async *streamWithMcp(req: GatewayRequest, overrideTimeoutMs?: number): AsyncGenerator<StreamChunk> {
    const { systemBlocks, anthropicMessages } = splitMessages(req.messages);
    const model = req.model;
    const maxTokens = req.maxTokens ?? 16_000;
    const effectiveTimeout = overrideTimeoutMs ?? this.timeoutMs;

    logger.debug({ model, mcpServerCount: req.mcpServers?.length ?? 0 }, "ModelGateway: Anthropic stream (MCP connector)");

    const thinkingParam: Anthropic.ThinkingConfigParam | undefined = supportsThinking(model)
      ? { type: "enabled", budget_tokens: req.thinkingBudget ?? 4_000 }
      : undefined;

    // Local function tools (load_skill etc.) and MCP toolsets share one `tools`
    // array per the connector's documented shape — BetaToolUnion includes both.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const combinedTools: any[] = [
      ...(req.tools ?? []),
      ...(req.mcpToolsets ?? []),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let stream: AsyncIterable<any>;
    try {
      const client = effectiveTimeout === this.timeoutMs
        ? this.client
        : new Anthropic({ apiKey: this.client.apiKey as string, timeout: effectiveTimeout });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const createResult: any = await client.beta.messages.create({
        model,
        max_tokens: maxTokens,
        messages: anthropicMessages,
        stream: true as const,
        betas: ["mcp-client-2025-11-20"],
        mcp_servers: req.mcpServers,
        ...(systemBlocks ? { system: systemBlocks } : {}),
        ...(thinkingParam ? { thinking: thinkingParam } : {}),
        ...(combinedTools.length > 0 ? { tools: combinedTools } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      stream = createResult as AsyncIterable<any>;
    } catch (err) {
      throw mapAnthropicError(err);
    }

    const toolInputBuffers = new Map<number, { id: string; name: string; args: string }>();
    const mcpToolUseBuffers = new Map<number, { id: string; name: string; serverName: string; args: string }>();
    const mcpToolUsesById = new Map<string, { name: string; serverName: string; input: unknown }>();
    let currentBlockIndex = -1;
    let currentBlockType = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let stopReason: string | undefined;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            inputTokens = event.message.usage?.input_tokens ?? 0;
            break;

          case "content_block_start": {
            currentBlockIndex = event.index;
            currentBlockType = event.content_block.type;
            const block = event.content_block;

            if (block.type === "tool_use") {
              toolInputBuffers.set(event.index, { id: block.id, name: block.name, args: "" });
            } else if (block.type === "mcp_tool_use") {
              mcpToolUseBuffers.set(event.index, {
                id: block.id, name: block.name, serverName: block.server_name, args: "",
              });
            } else if (block.type === "mcp_tool_result") {
              // Arrives fully formed (not streamed via deltas) per the API's
              // documented block shape — resolve and yield immediately.
              const use = mcpToolUsesById.get(block.tool_use_id);
              const resultText = Array.isArray(block.content)
                ? block.content.map((c: { text?: string }) => c.text ?? "").join("")
                : String(block.content ?? "");
              yield {
                type: "mcp_tool_call",
                mcpToolCall: {
                  id: block.tool_use_id,
                  name: use?.name ?? "unknown",
                  serverName: use?.serverName ?? "unknown",
                  input: use?.input ?? {},
                  result: resultText,
                  isError: block.is_error === true,
                },
              };
            }
            break;
          }

          case "content_block_delta": {
            const delta = event.delta;
            if (delta.type === "text_delta" && delta.text) {
              yield { type: "content", content: delta.text };
            } else if (delta.type === "thinking_delta" && delta.thinking) {
              yield { type: "reasoning", reasoning: delta.thinking };
            } else if (delta.type === "input_json_delta" && delta.partial_json) {
              const buf = toolInputBuffers.get(currentBlockIndex);
              if (buf) buf.args += delta.partial_json;
              const mcpBuf = mcpToolUseBuffers.get(currentBlockIndex);
              if (mcpBuf) mcpBuf.args += delta.partial_json;
            }
            break;
          }

          case "content_block_stop":
            if (currentBlockType === "tool_use") {
              const buf = toolInputBuffers.get(currentBlockIndex);
              if (buf) {
                yield { type: "tool_call", toolCall: { id: buf.id, name: buf.name, arguments: buf.args } };
                toolInputBuffers.delete(currentBlockIndex);
              }
            } else if (currentBlockType === "mcp_tool_use") {
              const buf = mcpToolUseBuffers.get(currentBlockIndex);
              if (buf) {
                let input: unknown = {};
                try { input = buf.args ? JSON.parse(buf.args) : {}; } catch { /* leave as {} — mcp_tool_result still resolves */ }
                mcpToolUsesById.set(buf.id, { name: buf.name, serverName: buf.serverName, input });
                mcpToolUseBuffers.delete(currentBlockIndex);
              }
            }
            break;

          case "message_delta":
            outputTokens = event.usage?.output_tokens ?? outputTokens;
            stopReason = event.delta.stop_reason ?? stopReason;
            break;

          case "message_stop":
            break;
        }
      }
    } catch (err) {
      throw mapAnthropicError(err);
    }

    yield { type: "usage", usage: { promptTokens: inputTokens, completionTokens: outputTokens } };
    yield { type: "done", stopReason };
  }
}
