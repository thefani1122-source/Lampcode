import { randomUUID } from "node:crypto";
import { join } from "path";
import { z } from "zod";
import {
  ModelGateway,
  GatewayError,
  tierModel,
  MODEL_TIERS,
  type AgentTaskType,
  type ChatMessage,
} from "./model-gateway.js";
import { TokenTracker } from "./token-tracker.js";
import { PromptBuilder, type TaskInput } from "./prompt-builder.js";
import { handleAgentStream, type StreamChunk as HandlerStreamChunk } from "./stream-handler.js";
import { getWebSocketServer } from "../websocket/server.js";
import { logger } from "../server/logger.js";

// Workspace root: one directory per project
const WORKSPACE_BASE = join(process.cwd(), "workspace");

// Max retries per tier before falling back to the next tier
const RETRIES_PER_TIER = 2;

// ── AgentTaskType re-exported for external consumers ─────────────────────────
export { type AgentTaskType } from "./model-gateway.js";

// ── Dispatch request / result ─────────────────────────────────────────────────

export const dispatchOptionsSchema = z.object({
  agentType: z.string() as z.ZodType<AgentTaskType>,
  task: z.object({
    description: z.string().min(1),
    requirements: z.array(z.string()).optional(),
    constraints: z.array(z.string()).optional(),
    outputFormat: z.enum(["prose", "json", "code", "markdown"]).default("prose"),
    targetFiles: z.array(z.string()).optional(),
  }),
  sessionId: z.string().uuid(),
  userId: z.string().optional(),
  projectId: z.string().optional(),
});

// contextFiles is injected internally after ContextManager.select() — not user-facing
export type DispatchOptions = z.infer<typeof dispatchOptionsSchema> & {
  contextFiles?: Array<{ path: string; content: string }> | undefined;
};

export interface DispatchResult {
  taskId: string;
  modelUsed: string;
  tierUsed: number;
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  outputPath: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

// Errors that allow falling back to the next tier
const FALLBACK_CODES = new Set(["RATE_LIMIT", "MODEL_DOWN"] as const);
type FallbackCode = "RATE_LIMIT" | "MODEL_DOWN";

function isFallbackCode(code: string): code is FallbackCode {
  return FALLBACK_CODES.has(code as FallbackCode);
}

// ── AgentDispatcher ───────────────────────────────────────────────────────────

export class AgentDispatcher {
  private readonly gateway: ModelGateway;
  private readonly tracker: TokenTracker;
  private readonly promptBuilder: PromptBuilder;

  constructor() {
    this.gateway = new ModelGateway();
    this.tracker = new TokenTracker();
    this.promptBuilder = new PromptBuilder();
  }

  /** Primary dispatch method — tries tier 1 → 2 → 3 on fallback errors, with per-tier retries. */
  async dispatch(options: DispatchOptions): Promise<DispatchResult> {
    const parsed = dispatchOptionsSchema.parse(options);
    const tiers = MODEL_TIERS[parsed.agentType];
    const task = parsed.task as TaskInput;
    // contextFiles is not in the Zod schema so read from original options
    const contextFiles = options.contextFiles;

    let lastError: Error | null = null;

    for (let tier = 1; tier <= tiers.length; tier++) {
      const model = tierModel(parsed.agentType, tier as 1 | 2 | 3);

      try {
        return await this.callModelWithRetry({ ...parsed, contextFiles }, task, model, tier as 1 | 2 | 3);
      } catch (err) {
        if (
          err instanceof GatewayError &&
          isFallbackCode(err.code) &&
          tier < tiers.length
        ) {
          const delay = err.retryAfterMs ?? 2_000;
          logger.warn(
            { agentType: parsed.agentType, model, tier, nextTier: tier + 1, delay },
            "Model fallback triggered",
          );
          await sleep(Math.min(delay, 10_000));
          lastError = err;
          continue;
        }
        throw err;
      }
    }

    throw lastError ?? new Error(`All tiers failed for ${parsed.agentType}`);
  }

  /** Trigger the fix agent after empty/malformed output from another agent. */
  async triggerFixAgent(
    failedAgentType: AgentTaskType,
    errorContext: string,
    sessionId: string,
    projectId?: string | undefined,
    userId?: string | undefined,
  ): Promise<DispatchResult> {
    logger.warn({ failedAgentType, sessionId }, "Auto-triggering fix agent");
    return this.dispatch({
      agentType: "fix",
      task: {
        description: `The ${failedAgentType} agent produced no valid output. Context: ${errorContext.slice(0, 1_000)}. Diagnose the issue and regenerate the expected output.`,
        outputFormat: "code",
      },
      sessionId,
      projectId,
      userId,
    });
  }

  // ── Private ─────────────────────────────────────────────────────────────────

  /** Retry up to RETRIES_PER_TIER times on NETWORK errors before re-throwing. */
  private async callModelWithRetry(
    options: DispatchOptions,
    task: TaskInput,
    model: string,
    tier: 1 | 2 | 3,
  ): Promise<DispatchResult> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt <= RETRIES_PER_TIER; attempt++) {
      try {
        return await this.callModel(options, task, model, tier);
      } catch (err) {
        if (err instanceof GatewayError && err.code === "NETWORK" && attempt < RETRIES_PER_TIER) {
          const delay = Math.pow(2, attempt) * 1_000; // 1 s, 2 s
          logger.warn({ model, tier, attempt: attempt + 1, delay }, "Network error — retrying");
          await sleep(delay);
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("All retries exhausted");
  }

  private async callModel(
    options: DispatchOptions,
    task: TaskInput,
    model: string,
    tier: 1 | 2 | 3,
  ): Promise<DispatchResult> {
    const { agentType, sessionId, userId, projectId, contextFiles } = options;

    logger.info({ agentType, model, tier, sessionId }, "Dispatching agent");

    // Resolve workspace directory for project-specific brain files
    const workspaceDir = projectId !== undefined
      ? join(WORKSPACE_BASE, projectId)
      : undefined;

    // Build prompt
    const { systemPrompt, userMessage, estimatedInputTokens } =
      await this.promptBuilder.build(agentType, task, {
        projectId: projectId ?? "unknown",
        userId: userId ?? "anonymous",
        mode: "fast",
        prompt: task.description,
      }, workspaceDir, contextFiles);

    // Create DB row (don't block on failure — tracking is best-effort)
    const taskId = await this.tracker
      .begin(sessionId, agentType, model, tier, userId, projectId)
      .catch((err) => {
        logger.warn({ err }, "Failed to record agent task start");
        return randomUUID();
      });

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    const stream = this.gateway.stream({ model, messages });
    const outputPath = join(WORKSPACE_BASE, ".sessions", sessionId, "agents", agentType, `${taskId}.md`);
    const startMs = Date.now();

    let content: string;
    try {
      content = await handleAgentStream(
        stream as unknown as AsyncGenerator<HandlerStreamChunk>,
        { sessionId, agentType, taskId, outputPath, wsServer: getWebSocketServer() },
      );
    } catch (err) {
      await this.tracker.fail(taskId, String(err)).catch(() => undefined);
      throw err;
    }

    await this.tracker.complete(taskId, { model, inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 }).catch((e) => {
      logger.warn({ err: e }, "Failed to record agent task completion");
    });

    return {
      taskId,
      modelUsed: model,
      tierUsed: tier,
      content,
      reasoning: "",
      toolCalls: [],
      outputPath,
      durationMs: Date.now() - startMs,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
  }

}

// ── Singleton factory ─────────────────────────────────────────────────────────

let _dispatcher: AgentDispatcher | null = null;

export function getDispatcher(): AgentDispatcher {
  if (_dispatcher === null) {
    _dispatcher = new AgentDispatcher();
  }
  return _dispatcher;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
