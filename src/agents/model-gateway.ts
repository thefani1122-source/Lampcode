import { z } from "zod";
import { config } from "../server/config.js";
import { logger } from "../server/logger.js";

// ── Model catalogue ───────────────────────────────────────────────────────────

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

// Tier arrays: [tier1, tier2, tier3]
export const MODEL_TIERS = {
  planning:   ["anthropic/claude-opus-4-6",    "anthropic/claude-sonnet-4-6",  "openai/gpt-4o"] as const,
  frontend:   ["moonshotai/kimi-k2.6",          "anthropic/claude-sonnet-4-6",  "deepseek/deepseek-chat"] as const,
  backend:    ["anthropic/claude-sonnet-4-6",   "anthropic/claude-haiku-4-5",   "deepseek/deepseek-chat"] as const,
  db:         ["anthropic/claude-sonnet-4-6",   "anthropic/claude-haiku-4-5",   "deepseek/deepseek-chat"] as const,
  security:   ["deepseek/deepseek-v4-pro",      "anthropic/claude-sonnet-4-6",  "openai/gpt-4o-mini"] as const,
  connection: ["deepseek/deepseek-v4-flash",    "anthropic/claude-haiku-4-5",   "openai/gpt-4o-mini"] as const,
  fix:        ["anthropic/claude-sonnet-4-6",   "anthropic/claude-haiku-4-5",   "deepseek/deepseek-chat"] as const,
  deploy:     ["deepseek/deepseek-v4-flash",    "anthropic/claude-haiku-4-5",   "openai/gpt-4o-mini"] as const,
  monitor:    ["deepseek/deepseek-v4-flash",    "anthropic/claude-haiku-4-5",   "openai/gpt-4o-mini"] as const,
} as const satisfies Record<string, readonly [string, string, string]>;

export type AgentTaskType = keyof typeof MODEL_TIERS;

export function tierModel(agentType: AgentTaskType, tier: 1 | 2 | 3): string {
  return MODEL_TIERS[agentType][tier - 1] as string;
}

// ── Wire types ────────────────────────────────────────────────────────────────

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GatewayRequest {
  model: string;
  messages: ChatMessage[];
  temperature?: number | undefined;
  maxTokens?: number | undefined;
}

// Parsed chunk yielded to callers
export type StreamChunkType = "content" | "reasoning" | "tool_call" | "usage" | "done";

export interface StreamChunk {
  type: StreamChunkType;
  content?: string | undefined;
  reasoning?: string | undefined;
  toolCall?: { id: string; name: string; arguments: string } | undefined;
  usage?: { promptTokens: number; completionTokens: number } | undefined;
}

// ── Error types ───────────────────────────────────────────────────────────────

export type GatewayErrorCode =
  | "RATE_LIMIT"
  | "MODEL_DOWN"
  | "INVALID_KEY"
  | "CONTEXT_LENGTH"
  | "NETWORK"
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

// ── SSE payload schemas ───────────────────────────────────────────────────────

const toolCallDeltaSchema = z.object({
  index: z.number().int(),
  id: z.string().optional(),
  function: z
    .object({
      name: z.string().optional(),
      arguments: z.string().optional(),
    })
    .optional(),
});

const deltaSchema = z.object({
  content: z.string().nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
  tool_calls: z.array(toolCallDeltaSchema).optional(),
});

const sseChunkSchema = z.object({
  choices: z
    .array(
      z.object({
        index: z.number().int(),
        delta: deltaSchema,
        finish_reason: z.string().nullable().optional(),
      }),
    )
    .optional(),
  usage: z
    .object({
      prompt_tokens: z.number().int().optional(),
      completion_tokens: z.number().int().optional(),
    })
    .optional(),
});

// ── ModelGateway ──────────────────────────────────────────────────────────────

export class ModelGateway {
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(apiKey: string = config.OPENROUTER_API_KEY, timeoutMs = 120_000) {
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
  }

  /** Yield parsed SSE chunks from an OpenAI-compatible streaming completion. */
  async *stream(req: GatewayRequest): AsyncGenerator<StreamChunk> {
    const baseUrl = OPENROUTER_BASE;
    const apiKey = this.apiKey;
    const resolvedModel = req.model;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    logger.debug({ model: resolvedModel, baseUrl }, "ModelGateway routing");

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env["FRONTEND_URL"] ?? "https://lampcode.dev",
          "X-Title": "Lampcode",
        },
        body: JSON.stringify({
          model: resolvedModel,
          messages: req.messages,
          stream: true,
          temperature: req.temperature ?? 0.2,
          ...(req.maxTokens !== undefined ? { max_tokens: req.maxTokens } : {}),
        }),
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      if (err instanceof Error && err.name === "AbortError") {
        throw new GatewayError("NETWORK", `Request timed out after ${this.timeoutMs}ms`);
      }
      throw new GatewayError("NETWORK", `Fetch failed: ${String(err)}`);
    }

    if (!response.ok) {
      clearTimeout(timeoutId);
      throw await this.parseHttpError(response);
    }

    const body = response.body;
    if (body === null) {
      clearTimeout(timeoutId);
      throw new GatewayError("NETWORK", "Empty response body");
    }

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    // Accumulate tool call argument fragments keyed by call index
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

    try {
      outer: while (true) {
        let result: Awaited<ReturnType<typeof reader.read>>;
        try {
          result = await reader.read();
        } catch (err) {
          if (err instanceof Error && err.name === "AbortError") {
            throw new GatewayError("NETWORK", "Stream timed out");
          }
          throw new GatewayError("NETWORK", `Stream read error: ${String(err)}`);
        }

        if (result.done) break;

        const raw = decoder.decode(result.value, { stream: true });
        buffer += raw;

        // SSE events are delimited by \n\n
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          for (const line of event.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;

            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") break outer;
            if (payload.length === 0) continue;

            const chunks = this.parseSSEPayload(payload, toolCallBuffers);
            for (const chunk of chunks) yield chunk;
          }
        }
      }
    } finally {
      clearTimeout(timeoutId);
      reader.releaseLock();
    }

    yield { type: "done" };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  private parseSSEPayload(
    payload: string,
    toolCallBuffers: Map<number, { id: string; name: string; args: string }>,
  ): StreamChunk[] {
    let raw: unknown;
    try {
      raw = JSON.parse(payload);
    } catch {
      logger.debug({ payload }, "Non-JSON SSE payload, skipping");
      return [];
    }

    const result = sseChunkSchema.safeParse(raw);
    if (!result.success) {
      logger.debug({ payload }, "SSE payload failed schema validation");
      return [];
    }

    const data = result.data;
    const chunks: StreamChunk[] = [];

    // Usage (may appear on last chunk or standalone)
    if (data.usage !== undefined) {
      chunks.push({
        type: "usage",
        usage: {
          promptTokens: data.usage.prompt_tokens ?? 0,
          completionTokens: data.usage.completion_tokens ?? 0,
        },
      });
    }

    const choice = data.choices?.[0];
    if (choice === undefined) return chunks;

    const delta = choice.delta;

    if (delta.content !== null && delta.content !== undefined && delta.content.length > 0) {
      chunks.push({ type: "content", content: delta.content });
    }

    if (
      delta.reasoning_content !== null &&
      delta.reasoning_content !== undefined &&
      delta.reasoning_content.length > 0
    ) {
      chunks.push({ type: "reasoning", reasoning: delta.reasoning_content });
    }

    for (const tc of delta.tool_calls ?? []) {
      const existing = toolCallBuffers.get(tc.index) ?? {
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        args: "",
      };
      existing.args += tc.function?.arguments ?? "";
      if (tc.id !== undefined) existing.id = tc.id;
      if (tc.function?.name !== undefined) existing.name = tc.function.name;
      toolCallBuffers.set(tc.index, existing);

      // Flush complete tool calls (when finish_reason is "tool_calls")
      if (choice.finish_reason === "tool_calls") {
        chunks.push({
          type: "tool_call",
          toolCall: { id: existing.id, name: existing.name, arguments: existing.args },
        });
      }
    }

    return chunks;
  }

  private async parseHttpError(response: Response): Promise<GatewayError> {
    const retryAfter = response.headers.get("Retry-After");
    const retryMs = retryAfter !== null ? parseInt(retryAfter, 10) * 1000 : undefined;

    let body = "";
    try {
      body = await response.text();
    } catch {
      // ignore
    }

    logger.warn({ status: response.status, body }, "LLM API HTTP error");

    switch (response.status) {
      case 401:
      case 403:
        return new GatewayError("INVALID_KEY", "Invalid OpenRouter API key");
      case 429:
        return new GatewayError("RATE_LIMIT", "Rate limit exceeded", retryMs ?? 60_000);
      case 503:
      case 529:
        return new GatewayError("MODEL_DOWN", `Model unavailable (${response.status})`);
      case 400:
        if (body.includes("context_length")) {
          return new GatewayError("CONTEXT_LENGTH", "Prompt exceeds model context length");
        }
        return new GatewayError("UNKNOWN", `Bad request: ${body.slice(0, 200)}`);
      default:
        return new GatewayError("UNKNOWN", `HTTP ${response.status}: ${body.slice(0, 200)}`);
    }
  }
}
