import {
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { type GatewayRequest, type StreamChunk, GatewayError } from "./model-gateway.js";
import { logger } from "../server/logger.js";

const DEFAULT_MODEL_ID = "anthropic.claude-sonnet-5";
const REGION = process.env.AWS_REGION || "us-east-1";

function mapBedrockError(err: unknown): GatewayError {
  if (err instanceof Error) {
    const msg = err.message ?? String(err);
    const name = err.name ?? "";

    // Invalid model ID
    if (name === "ValidationException" || msg.includes("Could not validate model")) {
      return new GatewayError(
        "INVALID_KEY",
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
  const modelId = process.env.BEDROCK_MODEL_ID || DEFAULT_MODEL_ID;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID ?? "";
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY ?? "";

  if (!accessKeyId || !secretAccessKey) {
    throw new GatewayError(
      "INVALID_KEY",
      "AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.",
    );
  }

  logger.debug({ modelId, region: REGION }, "ModelGateway: Bedrock stream");

  const client = new BedrockRuntimeClient({
    region: REGION,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });

  const systemMsg = req.messages.find((m) => m.role === "system");
  const chatMessages = req.messages.filter((m) => m.role !== "system");

  const messages = chatMessages.map((m) => ({
    role: m.role === "system" ? "user" : (m.role as "user" | "assistant"),
    content: m.content,
  }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const converseParams: any = {
    modelId,
    messages,
    inferenceConfig: {
      maxTokens: req.maxTokens ?? 16_000,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    ...(systemMsg ? { system: [{ text: systemMsg.content }] } : {}),
  };

  if (supportsThinking(modelId) && req.thinkingBudget) {
    converseParams.thinkingConfig = {
      type: "enabled",
      budgetTokens: req.thinkingBudget,
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

      // ContentBlockDelta — text or thinking chunks
      if (event.contentBlockDelta) {
        const delta = event.contentBlockDelta.delta;
        if (delta.type === "text_delta" && delta.text) {
          yield { type: "content", content: delta.text };
        } else if (delta.type === "thinking_delta" && delta.thinking) {
          yield { type: "reasoning", reasoning: delta.thinking };
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
