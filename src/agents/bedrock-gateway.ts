import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { type GatewayRequest, type StreamChunk, GatewayError, splitSystemPrompt } from "./model-gateway.js";
import { logger } from "../server/logger.js";

const DEFAULT_MODEL_ID = "anthropic.claude-sonnet-5";
const REGION = process.env.AWS_REGION || "us-east-1";

// Inference-profile / region prefixes Bedrock model IDs may already carry.
// If req.model is a bare first-party ID (e.g. "claude-sonnet-5") it needs the
// "anthropic." prefix; if it already has one of these, leave it as-is.
const BEDROCK_ID_PREFIXES = ["anthropic.", "us.", "eu.", "apac."];

/**
 * Resolve which model ID actually goes on the wire.
 * BEDROCK_MODEL_ID is an explicit operator override (highest priority — lets
 * the exact Bedrock ID be corrected via env var without a code change).
 * Otherwise req.model (the tier the dispatcher picked) is mapped to its
 * Bedrock form. Falls back to DEFAULT_MODEL_ID only if req.model is empty.
 */
function resolveModelId(requestedModel: string | undefined): string {
  const override = process.env.BEDROCK_MODEL_ID;
  if (override) return override;
  if (!requestedModel) return DEFAULT_MODEL_ID;
  if (BEDROCK_ID_PREFIXES.some((p) => requestedModel.startsWith(p))) return requestedModel;
  return `anthropic.${requestedModel}`;
}

function mapBedrockError(err: unknown): GatewayError {
  if (err instanceof Error) {
    const msg = err.message ?? String(err);
    const name = err.name ?? "";

    // Invalid model ID — mapped to UNKNOWN (not INVALID_KEY) so the dispatcher's
    // tier-fallback treats a bad ID like a down model and tries the next tier,
    // instead of aborting the build outright.
    if (name === "ValidationException" || msg.includes("Could not validate model")) {
      return new GatewayError(
        "UNKNOWN",
        `Invalid Bedrock model ID. Check BEDROCK_MODEL_ID env var — verify exact model ID in AWS Console. Error: ${msg.slice(0, 150)}`,
      );
    }

    // Access/auth errors
    if (name === "AccessDeniedException" || name === "UnauthorizedException") {
      return new GatewayError(
        "INVALID_KEY",
        "AWS credentials invalid or insufficient permissions. Check AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, and IAM permissions for bedrock:InvokeModelWithResponseStream",
      );
    }

    // Rate limiting
    if (name === "ThrottlingException" || msg.includes("rate") || msg.includes("quota")) {
      return new GatewayError("RATE_LIMIT", `Bedrock rate limit exceeded: ${msg.slice(0, 150)}`, 60_000);
    }

    // Model unavailable
    if (name === "ModelNotReadyException" || msg.includes("model is not available")) {
      return new GatewayError("MODEL_DOWN", `Bedrock model unavailable: ${msg.slice(0, 150)}`);
    }

    // Context length
    if (msg.includes("context") && msg.includes("length")) {
      return new GatewayError("CONTEXT_LENGTH", msg.slice(0, 300));
    }

    // Network errors
    if (name === "NetworkingError" || name === "AbortError" || msg.includes("timed out")) {
      return new GatewayError("NETWORK", `Bedrock connection failed: ${msg}`);
    }

    return new GatewayError("UNKNOWN", `Bedrock error (${name}): ${msg.slice(0, 200)}`);
  }

  return new GatewayError("UNKNOWN", String(err));
}

function supportsThinking(model: string): boolean {
  return model.includes("sonnet-5") || model.includes("opus");
}

/**
 * AWS Bedrock gateway using ConverseStream API.
 * Active when AWS_ACCESS_KEY_ID is set.
 */
export async function* bedrockStream(req: GatewayRequest): AsyncGenerator<StreamChunk> {
  const modelId = resolveModelId(req.model);
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";

  if (!accessKeyId || !secretAccessKey) {
    throw new GatewayError(
      "INVALID_KEY",
      "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
    );
  }

  logger.debug({ modelId, requestedModel: req.model, region: REGION }, "ModelGateway: Bedrock stream");

  const client = new BedrockRuntimeClient({
    region: REGION,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const systemMsg = req.messages.find((m) => m.role === "system");
  const chatMessages = req.messages.filter((m) => m.role !== "system");

  // Converse requires content as a ContentBlock[], not a raw string.
  const messages = chatMessages.map((m) => ({
    role: m.role === "system" ? "user" : (m.role as "user" | "assistant"),
    content: [{ text: m.content }],
  }));

  // Cache the stable base system prompt separately from the variable skills
  // block, mirroring the split used on the direct-Anthropic path — a build
  // whose skill set differs still hits cache on the shared base. Each text
  // segment is followed by its own cache point (Bedrock allows up to 4 per
  // request; splitSystemPrompt yields at most 2 segments today).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const systemBlocks: any[] | undefined = systemMsg
    ? splitSystemPrompt(systemMsg.content).flatMap((text) => [
        { text },
        { cachePoint: { type: "default" } },
      ])
    : undefined;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const converseParams: any = {
    modelId,
    messages,
    inferenceConfig: {
      maxTokens: req.maxTokens ?? 16_000,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    ...(systemBlocks ? { system: systemBlocks } : {}),
  };

  // Converse has no top-level thinkingConfig field — model-specific params go
  // in additionalModelRequestFields. Claude Sonnet 5 removed manual
  // budget_tokens; adaptive thinking is the current shape.
  if (supportsThinking(modelId) && req.thinkingBudget) {
    converseParams.additionalModelRequestFields = {
      thinking: { type: "adaptive" },
    };
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;

  try {
    const command = new ConverseStreamCommand(converseParams);
    const response = await client.send(command);

    if (!response.stream) {
      throw new GatewayError("NETWORK", "Bedrock: no response stream");
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const event of response.stream as any) {
      if (!event) continue;

      // ContentBlockDelta — Converse's delta is a property-keyed union
      // ({ text } | { reasoningContent } | { toolUse } | ...), not the
      // discriminated-by-`type` shape used by Anthropic's raw SSE format.
      if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta;
        if (delta?.text) {
          yield { type: "content", content: delta.text };
        } else if (delta?.reasoningContent?.text) {
          yield { type: "reasoning", reasoning: delta.reasoningContent.text };
        }
      }

      // MessageStart — initial usage tokens
      if (event.messageStart) {
        const usage = event.messageStart.message?.usage;
        if (usage) {
          inputTokens = usage.inputTokens ?? 0;
        }
      }

      // MessageStop — final usage and stop reason
      if (event.messageStop) {
        const usage = event.messageStop.message?.usage;
        if (usage) {
          inputTokens = usage.inputTokens ?? 0;
          outputTokens = usage.outputTokens ?? 0;
        }
        const message = event.messageStop.message;
        if (message?.stopReason) {
          stopReason = message.stopReason;
        }
      }

      // Error event
      if (event.messageStreamError) {
        throw new GatewayError(
          "UNKNOWN",
          `Bedrock stream error: ${event.messageStreamError.error?.message ?? "unknown"}`,
        );
      }
    }
  } catch (err) {
    if (err instanceof GatewayError) throw err;
    throw mapBedrockError(err);
  } finally {
    client.destroy();
  }

  yield {
    type: "usage",
    usage: { promptTokens: inputTokens, completionTokens: outputTokens },
  };
  yield { type: "done", stopReason: stopReason ?? "end_turn" };
}
