import { type GatewayRequest, type StreamChunk, GatewayError } from "./model-gateway.js";
import { logger } from "../server/logger.js";

const DEEPSEEK_MODEL = "deepseek-v4-flash";
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

const RETRY_DELAYS_MS = [3_000, 8_000, 15_000];

function isRateLimit(status: number, body: string): boolean {
  return status === 429 || /insufficient.balance|rate.limit|quota/i.test(body);
}

function mapDeepseekError(status: number, body: string): GatewayError {
  if (status === 401 || status === 403) return new GatewayError("INVALID_KEY", "Invalid DeepSeek API key");
  if (status === 429 || /rate.limit|quota/i.test(body)) return new GatewayError("RATE_LIMIT", "DeepSeek rate limit exceeded", 60_000);
  if (/insufficient.balance/i.test(body)) return new GatewayError("PAYMENT_REQUIRED", "DeepSeek balance exhausted");
  if (status === 503 || status === 529) return new GatewayError("MODEL_DOWN", `DeepSeek unavailable (${status})`);
  if (status === 400 && /context|token/i.test(body)) return new GatewayError("CONTEXT_LENGTH", body.slice(0, 200));
  return new GatewayError("UNKNOWN", `DeepSeek HTTP ${status}: ${body.slice(0, 200)}`);
}

/**
 * Drop-in replacement for ModelGateway.stream() that routes to DeepSeek.
 * Active only when DEEPSEEK_API_KEY env var is set.
 * thinkingBudget and prompt caching are silently ignored.
 */
export async function* deepseekStream(req: GatewayRequest): AsyncGenerator<StreamChunk> {
  const apiKey = process.env.DEEPSEEK_API_KEY ?? "";

  logger.debug({ model: DEEPSEEK_MODEL }, "ModelGateway: DeepSeek stream");

  const body = JSON.stringify({
    model: DEEPSEEK_MODEL,
    messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: req.maxTokens ?? 16_000,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  });

  // Fetch with retry for rate-limit errors
  let response: Response | undefined;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      response = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new GatewayError("NETWORK", `DeepSeek fetch failed: ${msg}`);
    }

    if (response.ok) break;

    lastStatus = response.status;
    lastBody = await response.text();

    if (!isRateLimit(lastStatus, lastBody) || attempt === RETRY_DELAYS_MS.length) {
      throw mapDeepseekError(lastStatus, lastBody);
    }

    const delayMs = RETRY_DELAYS_MS[attempt] ?? 3_000;
    logger.warn({ attempt: attempt + 1, status: lastStatus, delayMs }, "DeepSeek rate limit — retrying");
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!response?.ok) throw mapDeepseekError(lastStatus, lastBody);

  // Parse OpenAI-compatible SSE stream
  const reader = response.body?.getReader();
  if (!reader) throw new GatewayError("NETWORK", "DeepSeek: no response body");

  const decoder = new TextDecoder();
  let buffer = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let stopReason: string | undefined;
  let done = false;

  try {
    while (!done) {
      const { done: streamDone, value } = await reader.read();
      if (streamDone) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (data === "[DONE]") { done = true; break; }

        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
            usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
          };

          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield { type: "content", content };

          const fr = parsed.choices?.[0]?.finish_reason;
          if (fr) stopReason = fr;

          // DeepSeek sends usage in the final chunk when stream_options.include_usage=true
          if (parsed.usage) {
            promptTokens = parsed.usage.prompt_tokens ?? 0;
            completionTokens = parsed.usage.completion_tokens ?? 0;
          }
        } catch {
          // Malformed SSE chunk — skip
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  yield { type: "usage", usage: { promptTokens, completionTokens } };
  yield { type: "done", stopReason: stopReason ?? "end_turn" };
}
