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
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    // OpenAI-compatible providers report the part of the prompt they
    // served from cache here. It was never read, so every resent round of
    // an agentic build was billed as if it were new.
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
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

/**
 * How long a 429 says to wait, from the standard header.
 *
 * `Retry-After` is either a number of seconds or an HTTP date. Honouring it
 * matters because the hardcoded 60 s guess is wrong in both directions: a
 * per-second throttle clears far sooner, and a quota that resets hourly does
 * not clear at all — so waiting 60 s and retrying just burns the attempt. On
 * 2026-10-08 this account was refused for over an hour and three separate runs
 * each waited 60 s and died, with nothing anywhere saying how long to wait.
 *
 * Exported for its own cases. Returns undefined when the header is absent or
 * unparseable, and the caller keeps its default.
 */
export function parseRetryAfter(header: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!header) return undefined;
  const raw = header.trim();
  if (/^\d+$/.test(raw)) return Number(raw) * 1_000;
  // Date.parse is permissive enough to accept junk — it reads "1.5" as a date
  // and yields a time in the past, which would then clamp to 0 and mean "retry
  // immediately" on a header we did not understand. Every HTTP-date form
  // carries a weekday or month name, so requiring a letter is a sound guard.
  if (!/[A-Za-z]/.test(raw)) return undefined;
  const at = Date.parse(raw);
  if (Number.isNaN(at)) return undefined;
  const delta = at - nowMs;
  return delta > 0 ? delta : 0;
}

/** A 429 body that is about billing rather than load. Deliberately narrow —
 *  these are the words providers actually use for money — because misreading a
 *  genuine throttle as unpayable would stop a build that waiting would fix. */
const BILLING_RE =
  /payment method|spend limit|credit|billing|insufficient funds|quota exceeded|subscription/i;

/**
 * Map fetch/HTTP failures to our GatewayError codes — same codes
 * model-gateway.ts uses.
 *
 * The provider's own message is kept on every branch now. It used to be
 * discarded on exactly the two that most need it: a 429 became the fixed string
 * "Modal rate limit exceeded" and a 401 became "Invalid Modal proxy token",
 * with the response body thrown away. So when the endpoint refused this
 * account for over an hour on 2026-10-08 — every build, down to a one-file
 * counter, failing with no spend — there was no way to tell a spend cap from a
 * concurrency throttle from a revoked token, and the body saying which was
 * already in hand and deleted. An error that hides the provider's reason costs
 * hours of guessing.
 */
export function mapModalError(
  status: number | undefined,
  message: string,
  retryAfter?: string | null,
): GatewayError {
  const detail = message.trim().slice(0, 300);
  if (status === 401 || status === 403) {
    return new GatewayError(
      "INVALID_KEY",
      `Modal rejected the proxy token (HTTP ${status})${detail ? `: ${detail}` : ""}`,
    );
  }
  if (status === 429) {
    // A 429 whose body is about MONEY is not a rate limit, and treating it as
    // one is strictly harmful: it can never clear by waiting, so every retry is
    // spent and the real cause stays hidden. Measured on 2026-10-08 — four runs
    // over more than an hour, each waiting and failing, until the body was
    // finally surfaced and read:
    //
    //   {"error":"Plan credits cannot be applied to shared endpoint usage.
    //             Add a payment method or increase your spend limit"}
    //
    // That is the note already in CLAUDE.md — Modal plan credits do not cover
    // shared-endpoint usage — arriving as an HTTP status that means something
    // else. PAYMENT_REQUIRED is NOT in FALLBACK_CODES, so this now fails in one
    // second with the provider's own words instead of 75 s of pointless waiting.
    if (BILLING_RE.test(detail)) {
      return new GatewayError(
        "PAYMENT_REQUIRED",
        `The model provider refused the request for billing reasons, not load: ${detail}`,
      );
    }
    return new GatewayError(
      "RATE_LIMIT",
      `Modal rate limit exceeded${detail ? `: ${detail}` : ""}`,
      parseRetryAfter(retryAfter) ?? 60_000,
    );
  }
  if (status !== undefined && status >= 500) {
    return new GatewayError("MODEL_DOWN", `Modal endpoint unavailable (${status})${detail ? `: ${detail}` : ""}`);
  }
  if (status !== undefined) return new GatewayError("UNKNOWN", `HTTP ${status}: ${detail}`);
  return new GatewayError("NETWORK", message);
}

/**
 * Translate OpenAI's `finish_reason` vocabulary into the Anthropic `stop_reason`
 * vocabulary the rest of the codebase is written against.
 *
 * Everything downstream compares against Anthropic's words — dispatcher.ts's
 * tool loop tests `stopReason === "tool_use"` to decide whether to execute
 * tools and continue, and stream-handler.ts tests `"max_tokens"` to detect a
 * truncated response. An OpenAI-compatible endpoint says "tool_calls" and
 * "length" for those same two states, so passing the raw value through meant
 * neither check ever fired on this path: the model could ask for a tool and
 * the loop would just stop, and a cut-off response looked like a clean finish.
 *
 * Mapping here, at the boundary, keeps the one vocabulary everywhere else
 * rather than teaching every call site to know which provider it came from.
 */
function toAnthropicStopReason(finishReason: string | undefined): string | undefined {
  if (finishReason === "tool_calls") return "tool_use";
  if (finishReason === "length") return "max_tokens";
  if (finishReason === "stop") return "end_turn";
  return finishReason; // unknown / provider-specific — pass through unchanged
}

/** Yield parsed chunks from a Modal (OpenAI-compatible) streaming completion. */
export async function* modalStream(req: GatewayRequest, overrideTimeoutMs?: number): AsyncGenerator<StreamChunk> {
  // LLM_* is the preferred spelling; MODAL_* is the original name and still
  // works, so an existing deployment keeps running untouched.
  const endpointUrl = config.LLM_ENDPOINT_URL ?? config.MODAL_ENDPOINT_URL;
  const apiKey = config.LLM_API_KEY ?? config.MODAL_PROXY_TOKEN;
  const modelName = config.LLM_MODEL_NAME ?? config.MODAL_MODEL_NAME;

  if (!endpointUrl || !apiKey || !modelName) {
    throw new GatewayError(
      "UNKNOWN",
      "OpenAI-compatible gateway called without LLM_ENDPOINT_URL/LLM_API_KEY/LLM_MODEL_NAME (or the legacy MODAL_* equivalents) configured",
    );
  }

  logger.debug({ model: modelName }, "OpenAI-compatible stream");

  const body = {
    model: modelName,
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
    // ...but "reasoning_effort" is not a standard OpenAI-compatible field, and
    // what a server does with an unknown one differs — most ignore it, some
    // reject the request. Baking a GLM-tuned value in meant every future model
    // swap carried it. Configurable now, still "low" by default so the GLM
    // behaviour above is unchanged; set MODAL_REASONING_EFFORT=off to send no
    // reasoning field at all.
    ...(config.MODAL_REASONING_EFFORT === "off"
      ? {}
      : { reasoning_effort: config.MODAL_REASONING_EFFORT }),
    ...(req.tools && req.tools.length > 0 ? { tools: toOpenAiTools(req.tools) } : {}),
  };

  const controller = new AbortController();
  const timeoutMs = overrideTimeoutMs ?? 180_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(`${endpointUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
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
    throw mapModalError(
      response.status,
      text || response.statusText,
      response.headers.get("retry-after"),
    );
  }

  // Per-index tool-call accumulation (OpenAI streams tool_calls as deltas
  // keyed by index; id/name arrive on the first delta for that index, args
  // arrive incrementally) — same accumulation pattern model-gateway.ts uses
  // for Anthropic's content_block_start/delta/stop tool-call buffering.
  const toolBuffers = new Map<number, { id: string; name: string; args: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedInputTokens = 0;
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
          cachedInputTokens =
            event.usage.prompt_tokens_details?.cached_tokens ?? cachedInputTokens;
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
  let emittedToolCall = false;
  for (const buf of toolBuffers.values()) {
    if (buf.id && buf.name) {
      emittedToolCall = true;
      yield { type: "tool_call", toolCall: { id: buf.id, name: buf.name, arguments: buf.args } };
    }
  }

  // Some OpenAI-compatible servers report finish_reason "stop" on a turn that
  // did request tools. The caller's loop only continues when it sees BOTH a
  // tool-use stop reason and at least one tool call, so trusting the server's
  // word there would drop the tools it just asked us to run. Actual tool calls
  // on the wire are the stronger signal — believe those.
  const finalStopReason = emittedToolCall ? "tool_use" : toAnthropicStopReason(stopReason);

  yield {
    type: "usage",
    usage: {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      cachedPromptTokens: cachedInputTokens,
    },
  };
  yield { type: "done", stopReason: finalStopReason };
}
