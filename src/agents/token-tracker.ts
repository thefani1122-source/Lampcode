import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentTasks } from "../db/schema.js";
import { logger } from "../server/logger.js";

// ── Pricing table (USD per 1M tokens) ────────────────────────────────────────

const MODEL_PRICING: Record<string, { inputPerM: number; outputPerM: number }> = {
  "anthropic/claude-opus-4-5":   { inputPerM: 15.00, outputPerM: 75.00 },
  "anthropic/claude-sonnet-4-5": { inputPerM: 3.00,  outputPerM: 15.00 },
  "anthropic/claude-haiku-4-5":  { inputPerM: 0.25,  outputPerM: 1.25  },
  "moonshotai/kimi-k2":          { inputPerM: 0.60,  outputPerM: 2.50  },
  "deepseek/deepseek-r1":        { inputPerM: 0.55,  outputPerM: 2.19  },
  "deepseek/deepseek-chat":      { inputPerM: 0.27,  outputPerM: 1.10  },
  "openai/gpt-4o":               { inputPerM: 5.00,  outputPerM: 15.00 },
  "openai/gpt-4o-mini":          { inputPerM: 0.15,  outputPerM: 0.60  },
};

const DEFAULT_PRICING = { inputPerM: 1.00, outputPerM: 4.00 };

// ── Result types ──────────────────────────────────────────────────────────────

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

export interface SessionUsage {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  taskCount: number;
}

// Credit alert threshold: warn when a single task costs more than this
const ALERT_THRESHOLD_USD = 0.50;

// ── TokenTracker ──────────────────────────────────────────────────────────────

export class TokenTracker {
  /** Create an agent_tasks row before the API call starts. Returns the task ID. */
  async begin(
    sessionId: string,
    agentType: string,
    modelUsed: string,
    tierUsed: number,
    userId?: string | undefined,
    projectId?: string | undefined,
  ): Promise<string> {
    const id = crypto.randomUUID();
    await db.insert(agentTasks).values({
      id,
      sessionId,
      userId: userId ?? null,
      projectId: projectId ?? null,
      agentType,
      modelUsed,
      tierUsed,
      status: "running",
      startedAt: new Date(),
    });
    return id;
  }

  /** Update the agent_tasks row once the stream is complete. */
  async complete(
    taskId: string,
    usage: TokenUsage,
  ): Promise<void> {
    await db
      .update(agentTasks)
      .set({
        status: "complete",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        costUsd: usage.costUsd,
        completedAt: new Date(),
      })
      .where(eq(agentTasks.id, taskId));

    if (usage.costUsd >= ALERT_THRESHOLD_USD) {
      logger.warn(
        { taskId, costUsd: usage.costUsd, model: usage.model },
        "Agent task cost alert: approaching credit limit",
      );
    }
  }

  /** Mark a task as failed with an error message. */
  async fail(taskId: string, error: string): Promise<void> {
    await db
      .update(agentTasks)
      .set({ status: "failed", error, completedAt: new Date() })
      .where(eq(agentTasks.id, taskId));
  }

  /** Compute usage from raw token counts + model name. */
  computeUsage(
    model: string,
    inputTokens: number,
    outputTokens: number,
  ): TokenUsage {
    const pricing = MODEL_PRICING[model] ?? DEFAULT_PRICING;
    const costUsd =
      (inputTokens / 1_000_000) * pricing.inputPerM +
      (outputTokens / 1_000_000) * pricing.outputPerM;

    return {
      model,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd: Math.round(costUsd * 1_000_000) / 1_000_000, // 6 decimal places
    };
  }

  /** Approximate token count for a string (4 chars ≈ 1 token). */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /** Aggregate all agent task usage for a session from the database. */
  async getSessionUsage(sessionId: string): Promise<SessionUsage> {
    const rows = await db
      .select({
        inputTokens: agentTasks.inputTokens,
        outputTokens: agentTasks.outputTokens,
        costUsd: agentTasks.costUsd,
      })
      .from(agentTasks)
      .where(eq(agentTasks.sessionId, sessionId));

    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalCostUsd = 0;

    for (const row of rows) {
      totalInputTokens += row.inputTokens ?? 0;
      totalOutputTokens += row.outputTokens ?? 0;
      totalCostUsd += row.costUsd ?? 0;
    }

    return {
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd: Math.round(totalCostUsd * 1_000_000) / 1_000_000,
      taskCount: rows.length,
    };
  }
}
