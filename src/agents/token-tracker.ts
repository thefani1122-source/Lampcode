import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { agentTasks, type UsageCategory } from "../db/schema.js";
import { logger } from "../server/logger.js";

// ── Pricing table (USD per 1M tokens) ────────────────────────────────────────

// What a provider charges for a prompt token it served from cache, as a share
// of its normal input rate. Anthropic reads cache at a tenth, and Kimi K3 is
// $0.30 against $3.00 — the same tenth — so this is the rate to assume when a
// model has no explicit entry.
const CACHED_INPUT_RATIO = 0.1;

// What a provider charges to WRITE a prompt token into its cache. Anthropic
// bills a cache write at 1.25x the normal input rate; providers that do not
// charge separately report no write tokens, so this never applies to them.
const CACHE_WRITE_RATIO = 1.25;

const MODEL_PRICING: Record<
  string,
  { inputPerM: number; outputPerM: number; cachedInputPerM?: number }
> = {
  // Claude 4.x
  "anthropic/claude-opus-4-6":   { inputPerM: 15.00, outputPerM: 75.00 },
  "anthropic/claude-sonnet-4-6": { inputPerM: 3.00,  outputPerM: 15.00 },
  "anthropic/claude-haiku-4-5":  { inputPerM: 0.25,  outputPerM: 1.25  },
  // Legacy 4.5 entries
  "anthropic/claude-opus-4-5":   { inputPerM: 15.00, outputPerM: 75.00 },
  "anthropic/claude-sonnet-4-5": { inputPerM: 3.00,  outputPerM: 15.00 },
  // Kimi
  // Rates as shown on the Modal Shared Endpoint's own usage page
  // (prompt $3.00 / cached prompt $0.30 / completion $15.00 per MTok).
  // Cached prompt IS modelled now: modal-gateway reads
  // `prompt_tokens_details.cached_tokens` and computeUsage bills it at
  // CACHED_INPUT_RATIO, which for Kimi K3 works out at exactly its published
  // $0.30. Before that, an agentic build — which resends the whole conversation
  // each round — was costed as if every repeated prefix token were fresh, and
  // overstated by several times: the provider dashboard read $0.42 across a day
  // of builds while this put a single build at $0.555.
  "moonshotai/kimi-k3":          { inputPerM: 3.00,  outputPerM: 15.00 },
  // The SAME model on Amazon Bedrock, keyed by its inference-profile ids.
  // The lookup below is an exact match on LLM_MODEL_NAME, and on Bedrock that
  // value is "global.moonshotai.kimi-k3", not "moonshotai/kimi-k3" — a miss
  // falls to DEFAULT_PRICING ($1.00/$4.00) with only a warning, so every build
  // would be costed at roughly a third of its real price. That understates the
  // MAX_BUILD_COST_USD guard and the credits deducted, in silence. This is the
  // same wrong-row failure as the 2026-09-28 modelUsed bug, one layer along.
  // Bedrock's published cache rates are exactly CACHED_INPUT_RATIO (1/10) and
  // CACHE_WRITE_RATIO (1.25x) of these, so no explicit cachedInputPerM is
  // needed — checked against the model card, not assumed.
  "global.moonshotai.kimi-k3":   { inputPerM: 3.00,  outputPerM: 15.00 }, // Global CRIS
  "moonshotai.kimi-k3":          { inputPerM: 3.00,  outputPerM: 15.00 },
  "us.moonshotai.kimi-k3":       { inputPerM: 3.30,  outputPerM: 16.50 }, // US CRIS
  "in.moonshotai.kimi-k3":       { inputPerM: 3.30,  outputPerM: 16.50 }, // IN CRIS
  "moonshotai/kimi-k2.7-code":   { inputPerM: 0.95,  outputPerM: 4.00  },
  "moonshotai/kimi-k2.6":        { inputPerM: 0.60,  outputPerM: 2.50  },
  "moonshotai/kimi-k2":          { inputPerM: 0.60,  outputPerM: 2.50  },
  // GLM (Z.ai rates)
  "zai-org/glm-5.3":             { inputPerM: 1.40,  outputPerM: 4.40  },
  "zai-org/glm-5.3-flash":       { inputPerM: 1.40,  outputPerM: 4.40  },
  // DeepSeek
  "deepseek/deepseek-v4-pro":    { inputPerM: 0.55,  outputPerM: 2.19  },
  "deepseek/deepseek-v4-flash":  { inputPerM: 0.14,  outputPerM: 0.28  },
  "deepseek/deepseek-r1":        { inputPerM: 0.55,  outputPerM: 2.19  },
  "deepseek/deepseek-chat":      { inputPerM: 0.27,  outputPerM: 1.10  },
  // OpenAI
  "openai/gpt-4o":               { inputPerM: 5.00,  outputPerM: 15.00 },
  "openai/gpt-4o-mini":          { inputPerM: 0.15,  outputPerM: 0.60  },
  // Bare format (no anthropic/ prefix) — matches model-gateway.ts dispatch
  // claude-sonnet-5 pricing: same per-token rate as claude-sonnet-4-6 (Anthropic
  // confirms per-token pricing is unchanged between the two; only the tokenizer
  // changed, producing ~30% more tokens for the same text).
  "claude-sonnet-5":              { inputPerM: 3.00,  outputPerM: 15.00 },
  "claude-opus-4-8":             { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-opus-4-7":             { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-opus-4-6":             { inputPerM: 15.00, outputPerM: 75.00 },
  "claude-sonnet-4-6":           { inputPerM: 3.00,  outputPerM: 15.00 },
  "claude-haiku-4-5":            { inputPerM: 0.25,  outputPerM: 1.25  },
  "claude-haiku-4-5-20251001":   { inputPerM: 0.25,  outputPerM: 1.25  },
};

const DEFAULT_PRICING: { inputPerM: number; outputPerM: number; cachedInputPerM?: number } =
  { inputPerM: 1.00, outputPerM: 4.00 };

// ── Result types ──────────────────────────────────────────────────────────────

export interface TokenUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  /** Part of inputTokens the provider served from its own cache. */
  cachedInputTokens?: number;
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
    usageCategory?: UsageCategory | undefined,
  ): Promise<string> {
    const id = randomUUID();
    await db.insert(agentTasks).values({
      id,
      sessionId,
      userId: userId ?? null,
      projectId: projectId ?? null,
      agentType,
      usageCategory: usageCategory ?? null,
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
    /** TOTAL prompt tokens, cache included. Both gateways normalise to this —
     *  see the usage chunk in model-gateway.ts for why that needs saying. */
    inputTokens: number,
    outputTokens: number,
    /** Prompt tokens the provider served from ITS cache, as reported in the
     *  usage response. Counted inside inputTokens, billed far cheaper. */
    cachedInputTokens = 0,
    /** Prompt tokens written INTO the provider's cache on this call. Also
     *  inside inputTokens, but billed ABOVE the normal rate, not below. */
    cacheWriteTokens = 0,
  ): TokenUsage {
    // Case-insensitive: model ids arrive from config and provider dashboards
    // with whatever casing they use there (e.g. "moonshotai/Kimi-K3"), and a
    // miss here silently falls back to DEFAULT_PRICING rather than failing —
    // so a casing difference becomes a wrong bill, not an error.
    const key = model.toLowerCase();
    const pricing = MODEL_PRICING[key] ?? DEFAULT_PRICING;
    if (MODEL_PRICING[key] === undefined) {
      logger.warn(
        { model },
        "No pricing entry for this model — billing at DEFAULT_PRICING, which is a guess. Add it to MODEL_PRICING.",
      );
    }
    // An agentic build resends the whole conversation every round, so most
    // input tokens are a prefix the provider already has and charges a
    // fraction for. Billing all of them at the full rate overstated a build by
    // several times over — enough that a 14-round build was aborted at a $3
    // "ceiling" it had probably not reached. Only tokens the provider itself
    // reports as cached are discounted; anything unreported is billed in full.
    const cached = Math.max(0, Math.min(cachedInputTokens, inputTokens));
    const written = Math.max(0, Math.min(cacheWriteTokens, inputTokens - cached));
    const fresh = Math.max(0, inputTokens - cached - written);
    const cachedPerM = pricing.cachedInputPerM ?? pricing.inputPerM * CACHED_INPUT_RATIO;
    const costUsd =
      (fresh / 1_000_000) * pricing.inputPerM +
      (cached / 1_000_000) * cachedPerM +
      (written / 1_000_000) * pricing.inputPerM * CACHE_WRITE_RATIO +
      (outputTokens / 1_000_000) * pricing.outputPerM;

    return {
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens: cached,
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
