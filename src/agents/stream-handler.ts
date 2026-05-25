import { appendFile, mkdir } from "fs/promises";
import { join } from "path";
import { EventEmitter } from "events";
import { type StreamChunk } from "./model-gateway.js";
import { type TokenUsage } from "./token-tracker.js";
import { logger } from "../server/logger.js";

// ── Broadcast interface ───────────────────────────────────────────────────────

export interface StreamBroadcaster {
  broadcast(sessionId: string, taskId: string, chunk: StreamChunk): void | Promise<void>;
}

// ── Result types ──────────────────────────────────────────────────────────────

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  usage: TokenUsage;
  outputPath: string;
  durationMs: number;
}

// ── Global event bus for in-process subscriptions ────────────────────────────

export const streamEvents = new EventEmitter();
streamEvents.setMaxListeners(100);

export type StreamEventPayload = {
  sessionId: string;
  taskId: string;
  chunk: StreamChunk;
};

// ── StreamHandler ─────────────────────────────────────────────────────────────

const BASE_DIR = join(process.cwd(), ".buildforge", "sessions");
const CHUNK_TIMEOUT_MS = 60_000; // wait up to 60s for the first/next chunk

export class StreamHandler {
  private readonly broadcaster: StreamBroadcaster | null;

  constructor(broadcaster?: StreamBroadcaster) {
    this.broadcaster = broadcaster ?? null;
  }

  /**
   * Consume an async generator of StreamChunks, write them to a file,
   * emit events, and return the fully assembled result.
   */
  async handle(
    source: AsyncGenerator<StreamChunk>,
    sessionId: string,
    taskId: string,
    agentType: string,
    tokenTracker: { computeUsage: (model: string, input: number, output: number) => TokenUsage },
    model: string,
    estimatedInputTokens: number,
  ): Promise<StreamResult> {
    const outputPath = await this.prepareOutputFile(sessionId, agentType, taskId);
    const startMs = Date.now();

    let content = "";
    let reasoning = "";
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    let promptTokens = estimatedInputTokens;
    let completionTokens = 0;
    let chunkCount = 0;

    try {
      for await (const chunk of this.withStallTimeout(source, CHUNK_TIMEOUT_MS)) {

        await this.processChunk(chunk, sessionId, taskId, outputPath, {
          content: (c) => { content += c; },
          reasoning: (r) => { reasoning += r; },
          toolCall: (tc) => { toolCalls.push(tc); },
          usage: (u) => {
            promptTokens = u.promptTokens;
            completionTokens = u.completionTokens;
          },
        });

        chunkCount++;
      }
    } catch (err) {
      logger.error({ sessionId, taskId, err }, "Stream error");
      // Write error marker to file
      await appendFile(outputPath, `\n\n<!-- STREAM ERROR: ${String(err)} -->\n`, "utf8");
      throw err;
    }

    const usage = tokenTracker.computeUsage(model, promptTokens, completionTokens);

    // Write usage footer to the output file
    await appendFile(
      outputPath,
      `\n\n---\n<!-- tokens: ${usage.inputTokens}+${usage.outputTokens} | cost: $${usage.costUsd.toFixed(6)} | chunks: ${chunkCount} -->\n`,
      "utf8",
    );

    const durationMs = Date.now() - startMs;
    logger.info(
      { sessionId, taskId, agentType, durationMs, tokens: usage.totalTokens },
      "Stream complete",
    );

    return { content, reasoning, toolCalls, usage, outputPath, durationMs };
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Wrap a generator so it throws if no chunk arrives within `ms` milliseconds. */
  private async *withStallTimeout<T>(
    source: AsyncGenerator<T>,
    ms: number,
  ): AsyncGenerator<T> {
    while (true) {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Stream stalled: no data for ${ms}ms`)), ms),
      );
      const result = await Promise.race([source.next(), timeoutPromise]);
      if (result.done) return;
      yield result.value;
    }
  }

  private async processChunk(
    chunk: StreamChunk,
    sessionId: string,
    taskId: string,
    outputPath: string,
    handlers: {
      content: (c: string) => void;
      reasoning: (r: string) => void;
      toolCall: (tc: { id: string; name: string; arguments: string }) => void;
      usage: (u: { promptTokens: number; completionTokens: number }) => void;
    },
  ): Promise<void> {
    // Accumulate into memory
    if (chunk.type === "content" && chunk.content !== undefined) {
      handlers.content(chunk.content);
      await appendFile(outputPath, chunk.content, "utf8");
    } else if (chunk.type === "reasoning" && chunk.reasoning !== undefined) {
      handlers.reasoning(chunk.reasoning);
      // Reasoning goes to a comment block in the file
      await appendFile(outputPath, `<!-- REASONING: ${chunk.reasoning} -->`, "utf8");
    } else if (chunk.type === "tool_call" && chunk.toolCall !== undefined) {
      handlers.toolCall(chunk.toolCall);
      await appendFile(
        outputPath,
        `\n<!-- TOOL_CALL: ${JSON.stringify(chunk.toolCall)} -->\n`,
        "utf8",
      );
    } else if (chunk.type === "usage" && chunk.usage !== undefined) {
      handlers.usage(chunk.usage);
    }

    // Emit to in-process subscribers (e.g. WebSocket handler)
    const payload: StreamEventPayload = { sessionId, taskId, chunk };
    streamEvents.emit("chunk", payload);

    // Broadcast via external broadcaster if provided
    if (this.broadcaster !== null) {
      await this.broadcaster.broadcast(sessionId, taskId, chunk);
    }
  }

  private async prepareOutputFile(
    sessionId: string,
    agentType: string,
    taskId: string,
  ): Promise<string> {
    const dir = join(BASE_DIR, sessionId, "agents", agentType);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${taskId}.md`);
    // Write header
    await appendFile(
      path,
      `# Agent Output\n<!-- session: ${sessionId} | task: ${taskId} | agent: ${agentType} -->\n\n`,
      "utf8",
    );
    return path;
  }
}
