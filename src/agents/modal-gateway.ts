/**
 * Modal-hosted open-weight model gateway (GLM-5.3 on a Modal Shared Endpoint,
 * OpenAI-compatible Chat Completions API) — routed to free-tier builds only.
 * Verified live against the real deployed endpoint (2026-09-08): a request
 * with `tools` set returns `choices[0].message.tool_calls[].function.{name,
 * arguments}` and `finish_reason: "tool_calls"`, matching OpenAI's standard
 * streaming tool-call shape. Not a guess.
 *
 * Kept as a fully separate gateway (own file, own stream() shape) rather than
 * a branch inside ModelGateway.stream() — the AWS_ACCESS_KEY_ID branch that
 * used to live there silently dropped tool-calling with only a logger.warn
 * when Bedrock was active; provider selection now happens once, explicitly,
 * at the dispatcher level (see dispatcher.ts), not as a hidden internal path.
 */

import { config } from "../server/config.js";
import { logger } from "../server/logger.js";
import {
  GatewayError,
  type GatewayRequest,
  type StreamChunk,
  type ChatMessage,
  type MessageContentBlock,
  type ToolDefinition,
} from "./model-gateway.js";

// ── OpenAI Chat Completions wire types (minimal — only fields we read) ─────

interface OpenAiToolCallDelta {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  tool_calls?: OpenAiToolCallDelta[];
}

interface OpenAiStreamChoice {
  delta: OpenAiStreamDelta;
  finish_reason?: string | null;
}

interface OpenAiStreamEvent {
  choices?: OpenAiStreamChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

// ── Message / tool translation ──────────────────────────────────────────────

/** Anthropic ToolDefinition.input_schema and OpenAI's function.parameters are
 * the same JSON-schema shape — only the key name differs. */
function toOpenAiTools(tools: ToolDefinition[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }));
}

/**
 * Translate our internal ChatMessage[] (Anthropic-shaped: assistant turns
 * carry tool_use blocks, user turns carry tool_result blocks) into OpenAI's
 * flat role-per-message shape (assistant.tool_calls[], role:"tool" messages).
 * Mirrors exactly the message construction dispatcher.ts's tool round-trip
 * loop does (assistantBlocks/resultBlocks — see dispatcher.ts:429-473).
 */
function toOpenAiMessages(messages: ChatMessage[]): unknown[] {
  const out: unknown[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content });
      continue;
    }

    const blocks = m.content as MessageContentBlock[];

    if (m.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: unknown[] = [];
      for (const b of blocks) {
        if (b.type === "text") textParts.push(b.text);
        else if (b.type === "tool_use") {
          toolCalls.push({
            id: b.id,
            type: "function",
            function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
          });
        }
      }
      out.push({
        role: "assistant",
        content: textParts.length > 0 ? textParts.join("") : null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      continue;
    }

    // user turn: tool_result blocks become one "tool" message each; any text
    // blocks (not produced by dispatcher.ts today, handled defensively) become
    // a plain user message appended after.
    const textParts: string[] = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: b.content });
      } else if (b.type === "text") {
        textParts.push(b.text);
      }
    }
    if (textParts.length > 0) out.push({ role: "user", content: textParts.join("") });
  }

  return out;
}

/** Map fetch/HTTP failures to our GatewayError codes — same codes model-gateway.ts uses. */
function mapModalError(status: number | undefined, message: string): GatewayError {
  if (status === 401 || status === 403) return new GatewayError("INVALID_KEY", "Invalid Modal proxy token");
  if (status === 429) return new GatewayError("RATE_LIMIT", "Modal rate limit exceeded", 60_000);
  if (status !== undefined && status >= 500) return new GatewayError("MODEL_DOWN", `Modal endpoint unavailable (${status})`);
  if (status !== undefined) return new GatewayError("UNKNOWN", `HTTP ${status}: ${message.slice(0, 200)}`);
  return new GatewayError("NETWORK", message);
}

/** Yield parsed chunks from a Modal (OpenAI-compatible) streaming completion. */
export async function* modalStream(req: GatewayRequest, overrideTimeoutMs?: number): AsyncGenerator<StreamChunk> {
  if (!config.MODAL_ENDPOINT_URL || !config.MODAL_PROXY_TOKEN || !config.MODAL_MODEL_NAME) {
    throw new GatewayError("UNKNOWN", "Modal gateway called without MODAL_ENDPOINT_URL/MODAL_PROXY_TOKEN/MODAL_MODEL_NAME configured");
  }

  logger.debug({ model: config.MODAL_MODEL_NAME }, "ModalGateway: OpenAI-compatible stream");

  const body = {
    model: config.MODAL_MODEL_NAME,
    messages: toOpenAiMessages(req.messages),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens ?? 16_000,
    // GLM-5.3 forces reasoning on and cannot disable it (confirmed against
    // Z.ai's own docs) — reasoning_effort defaults to "max" when omitted,
    // and Z.ai's own benchmarks show max-effort reasoning alone can run
    // ~75K output tokens on a real coding task. Left at default, a real
    // build exhausted our whole max_tokens budget on reasoning_content and
    // never reached actual code (stopReason: "length", zero content chunks
    // — confirmed via live logs, not a guess). "low" trades some reasoning
    // depth for actually leaving room to produce the file content within
    // this budget, and reduces latency too (the same live test also hit
    // our 5-minute per-request timeout with max effort).
    reasoning_effort: "low",
    ...(req.tools && req.tools.length > 0 ? { tools: toOpenAiTools(req.tools) } : {}),
  };

  const controller = new AbortController();
  const timeoutMs = overrideTimeoutMs ?? 180_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${config.MODAL_ENDPOINT_URL}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.MODAL_PROXY_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    if (err instanceof Error && err.name === "AbortError") {
      throw new GatewayError("NETWORK", `Modal request timed out after ${timeoutMs}ms`);
    }
    throw mapModalError(undefined, err instanceof Error ? err.message : String(err));
  }

  if (!response.ok || !response.body) {
    clearTimeout(timeout);
    const text = await response.text().catch(() => "");
    throw mapModalError(response.status, text || response.statusText);
  }

  // Per-index tool-call accumulation (OpenAI streams tool_calls as deltas
  // keyed by index; id/name arrive on the first delta for that index, args
  // arrive incrementally) — same accumulation pattern model-gateway.ts uses
  // for Anthropic's content_block_start/delta/stop tool-call buffering.
  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;

        let event: OpenAiStreamEvent;
        try {
          event = JSON.parse(payload);
        } catch {
          continue; // malformed/partial line — skip rather than crash the stream
        }

        if (event.usage) {
          inputTokens = event.usage.prompt_tokens ?? inputTokens;
          outputTokens = event.usage.completion_tokens ?? outputTokens;
        }

        const choice = event.choices?.[0];
        if (!choice) continue;

        if (choice.delta.content) {
          yield { type: "content", content: choice.delta.content };
        }
        if (choice.delta.reasoning_content) {
          yield { type: "reasoning", reasoning: choice.delta.reasoning_content };
        }
        for (const tc of choice.delta.tool_calls ?? []) {
          const buf = toolBuffers.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name = tc.function.name;
          if (tc.function?.arguments) buf.args += tc.function.arguments;
          toolBuffers.set(tc.index, buf);
        }
        if (choice.finish_reason) stopReason = choice.finish_reason;
      }
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new GatewayError("NETWORK", `Modal stream timed out after ${timeoutMs}ms`);
    }
    throw mapModalError(undefined, err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }

  // Flush accumulated tool calls once the stream ends — mirrors
  // model-gateway.ts's content_block_stop flush, just batched at stream end
  // since OpenAI's delta shape (unlike Anthropic's) has no per-call stop event.
  for (const buf of toolBuffers.values()) {
    if (buf.id && buf.name) {
      yield { type: "tool_call", toolCall: { id: buf.id, name: buf.name, arguments: buf.args } };
    }
  }

  yield { type: "usage", usage: { promptTokens: inputTokens, completionTokens: outputTokens } };
  yield { type: "done", stopReason };
}
