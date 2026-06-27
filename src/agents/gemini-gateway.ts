import { GoogleGenerativeAI, GoogleGenerativeAIFetchError } from "@google/generative-ai";
import { type GatewayRequest, type StreamChunk, GatewayError } from "./model-gateway.js";
import { logger } from "../server/logger.js";

// Gemini model — no thinking budget support, silently ignored.
const GEMINI_MODEL = "gemini-2.5-flash";

const RETRY_DELAYS_MS = [5_000, 15_000, 30_000];

function isRateLimit(err: unknown): boolean {
  if (err instanceof GoogleGenerativeAIFetchError) {
    return err.status === 429 || /quota|rate|limit/i.test(err.message ?? "");
  }
  if (err instanceof Error) {
    return /quota|rate|limit/i.test(err.message);
  }
  return false;
}

async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRateLimit(err) || attempt === RETRY_DELAYS_MS.length) break;
      const delayMs = RETRY_DELAYS_MS[attempt] ?? 5_000;
      logger.warn({ attempt: attempt + 1, delayMs }, "Gemini rate limit — retrying");
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}

function mapGeminiError(err: unknown): GatewayError {
  if (err instanceof GoogleGenerativeAIFetchError) {
    const status = err.status ?? 0;
    const msg = err.message ?? String(err);
    if (status === 401 || status === 403 || msg.includes("API_KEY_INVALID")) {
      return new GatewayError("INVALID_KEY", "Invalid Gemini API key");
    }
    if (status === 429 || msg.includes("RESOURCE_EXHAUSTED")) {
      return new GatewayError("RATE_LIMIT", "Gemini rate limit exceeded", 60_000);
    }
    if (status === 503 || status === 529 || msg.includes("UNAVAILABLE")) {
      return new GatewayError("MODEL_DOWN", `Gemini model unavailable (${status})`);
    }
    if (status === 400 && (msg.includes("context") || msg.includes("token"))) {
      return new GatewayError("CONTEXT_LENGTH", msg);
    }
    return new GatewayError("UNKNOWN", `Gemini HTTP ${status}: ${msg.slice(0, 200)}`);
  }
  if (err instanceof Error) {
    if (err.name === "AbortError" || err.message.includes("timed out")) {
      return new GatewayError("NETWORK", err.message);
    }
    return new GatewayError("NETWORK", `Gemini fetch failed: ${err.message}`);
  }
  return new GatewayError("UNKNOWN", String(err));
}

/**
 * Drop-in replacement for ModelGateway.stream() that routes to Gemini.
 * Active only when GEMINI_API_KEY env var is set.
 * thinkingBudget and prompt caching are silently ignored (not supported by Gemini Flash-Lite).
 */
export async function* geminiStream(req: GatewayRequest): AsyncGenerator<StreamChunk> {
  const apiKey = process.env.GEMINI_API_KEY ?? "";
  const genAI = new GoogleGenerativeAI(apiKey);

  const systemMsg = req.messages.find((m) => m.role === "system");
  const chatMessages = req.messages.filter((m) => m.role !== "system");

  logger.debug({ model: GEMINI_MODEL }, "ModelGateway: Gemini stream (fallback)");

  const model = genAI.getGenerativeModel({
    model: GEMINI_MODEL,
    ...(systemMsg ? { systemInstruction: systemMsg.content } : {}),
  });

  // Gemini roles: "user" | "model" (not "assistant")
  const contents = chatMessages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));

  let streamResult: Awaited<ReturnType<typeof model.generateContentStream>>;
  try {
    streamResult = await withRetry(() =>
      model.generateContentStream({
        contents,
        generationConfig: {
          maxOutputTokens: req.maxTokens ?? 16_000,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        },
      }),
    );
  } catch (err) {
    throw mapGeminiError(err);
  }

  try {
    for await (const chunk of streamResult.stream) {
      const text = chunk.text();
      if (text) {
        yield { type: "content", content: text };
      }
    }
  } catch (err) {
    throw mapGeminiError(err);
  }

  // Emit usage from the final aggregated response
  try {
    const final = await streamResult.response;
    const usage = final.usageMetadata;
    yield {
      type: "usage",
      usage: {
        promptTokens: usage?.promptTokenCount ?? 0,
        completionTokens: usage?.candidatesTokenCount ?? 0,
      },
    };
  } catch {
    // Usage unavailable — emit zeros rather than crashing
    yield { type: "usage", usage: { promptTokens: 0, completionTokens: 0 } };
  }

  yield { type: "done", stopReason: "end_turn" };
}
